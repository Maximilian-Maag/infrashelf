import { describe, it, expect, vi, beforeEach } from 'vitest'
import { handlePipelineEvent } from './handler'
import { fetchJobTraces, parseTofuOutputs, supportsJobTrace } from '@/lib/ci'
import { sendProvisioningFailed } from '@/lib/notification/index'
import { db } from '@/lib/db/client'
import { orders, infrastructureElements, deploymentEnvironments } from '@/lib/db/schema'
import { eq } from 'drizzle-orm'
import {
  createUser,
  createCategory,
  createProduct,
  createCiSource,
  createEnvironment,
  createProject,
  createOrder,
  createInfraElement,
  linkProductEnvironment,
} from '@/test/helpers'

// Prevent real HTTP calls and email sending during tests
vi.mock('@/lib/ci', () => ({
  fetchJobTraces: vi.fn().mockResolvedValue([]),
  parseTofuOutputs: vi.fn().mockReturnValue({}),
  // Must be mocked too: without it the handler calls undefined, the surrounding
  // try/catch swallows the TypeError, and outputs silently stop being recorded.
  supportsJobTrace: vi.fn().mockReturnValue(true),
  triggerPipeline: vi.fn(),
}))

vi.mock('@/lib/notification/index', () => ({
  sendProvisioningCompleted: vi.fn().mockResolvedValue(undefined),
  sendProvisioningFailed: vi.fn().mockResolvedValue(undefined),
  sendDecommissioned: vi.fn().mockResolvedValue(undefined),
  sendOrderCreated: vi.fn().mockResolvedValue(undefined),
  sendOrderApproved: vi.fn().mockResolvedValue(undefined),
  sendOrderRejected: vi.fn().mockResolvedValue(undefined),
}))

// Helpers to build a minimal full scenario
const buildScenario = async () => {
  const user = await createUser({ email: 'wh@test.dev' })
  const cat = await createCategory()
  const product = await createProduct(cat.id, 'Infra Product')
  const ci = await createCiSource()
  const env = await createEnvironment(ci.id)
  const project = await createProject(user.id)
  return { user, product, env, project }
}

describe('handlePipelineEvent — success', () => {
  it('transitions a provisioning order to completed', async () => {
    const { user, product, env, project } = await buildScenario()
    const order = await createOrder(project.id, product.id, env.id, user.id, {
      status: 'provisioning',
      pipelineId: ['pipe-1'],
    })

    await handlePipelineEvent({ provider: 'gitlab', pipelineId: 'pipe-1', status: 'success' }, env.id)

    const [updated] = await db.select().from(orders).where(eq(orders.id, order.id))
    expect(updated.status).toBe('completed')
  })

  it('does not modify orders that do not match the pipeline ID', async () => {
    const { user, product, env, project } = await buildScenario()
    const order = await createOrder(project.id, product.id, env.id, user.id, {
      status: 'provisioning',
      pipelineId: ['pipe-99'],
    })

    await handlePipelineEvent({ provider: 'gitlab', pipelineId: 'pipe-other', status: 'success' }, env.id)

    const [unchanged] = await db.select().from(orders).where(eq(orders.id, order.id))
    expect(unchanged.status).toBe('provisioning')
  })

  it('transitions a decommissioning infra element to decommissioned', async () => {
    const { user, product, env, project } = await buildScenario()
    const order = await createOrder(project.id, product.id, env.id, user.id, {
      status: 'completed',
    })
    const el = await createInfraElement(order.id, project.id, env.id, product.id, {
      status: 'decommissioning',
      pipelineId: ['pipe-dc-1'],
    })

    await handlePipelineEvent({ provider: 'gitlab', pipelineId: 'pipe-dc-1', status: 'success' }, env.id)

    const [updated] = await db
      .select()
      .from(infrastructureElements)
      .where(eq(infrastructureElements.id, el.id))
    expect(updated.status).toBe('decommissioned')
  })
})

describe('handlePipelineEvent — failure', () => {
  it('transitions a provisioning order to failed on pipeline failure', async () => {
    const { user, product, env, project } = await buildScenario()
    const order = await createOrder(project.id, product.id, env.id, user.id, {
      status: 'provisioning',
      pipelineId: ['pipe-fail'],
    })

    await handlePipelineEvent({ provider: 'gitlab', pipelineId: 'pipe-fail', status: 'failed' }, env.id)

    const [updated] = await db.select().from(orders).where(eq(orders.id, order.id))
    expect(updated.status).toBe('failed')
  })

  it('transitions a provisioning order to failed on pipeline cancel', async () => {
    const { user, product, env, project } = await buildScenario()
    const order = await createOrder(project.id, product.id, env.id, user.id, {
      status: 'provisioning',
      pipelineId: ['pipe-cancel'],
    })

    await handlePipelineEvent({ provider: 'gitlab', pipelineId: 'pipe-cancel', status: 'canceled' }, env.id)

    const [updated] = await db.select().from(orders).where(eq(orders.id, order.id))
    expect(updated.status).toBe('failed')
  })

  it('leaves decommissioning infra status unchanged on failure', async () => {
    const { user, product, env, project } = await buildScenario()
    const order = await createOrder(project.id, product.id, env.id, user.id)
    const el = await createInfraElement(order.id, project.id, env.id, product.id, {
      status: 'decommissioning',
      pipelineId: ['pipe-dc-fail'],
    })

    await handlePipelineEvent({
      provider: 'gitlab',
      pipelineId: 'pipe-dc-fail',
      status: 'failed',
    }, env.id)

    const [unchanged] = await db
      .select()
      .from(infrastructureElements)
      .where(eq(infrastructureElements.id, el.id))
    expect(unchanged.status).toBe('decommissioning')
  })
})

describe('handlePipelineEvent — multi-pipeline orders', () => {
  it('stays provisioning after only the first of two pipelines succeeds', async () => {
    const { user, product, env, project } = await buildScenario()
    const order = await createOrder(project.id, product.id, env.id, user.id, {
      status: 'provisioning',
      pipelineId: ['pipe-A', 'pipe-B'],
    })

    await handlePipelineEvent({ provider: 'gitlab', pipelineId: 'pipe-A', status: 'success' }, env.id)

    const [afterA] = await db.select().from(orders).where(eq(orders.id, order.id))
    expect(afterA.status).toBe('provisioning')
    expect(afterA.pipelineStatus).toEqual({ 'pipe-A': 'success' })
  })

  it('becomes completed only after ALL pipelines have succeeded', async () => {
    const { user, product, env, project } = await buildScenario()
    const order = await createOrder(project.id, product.id, env.id, user.id, {
      status: 'provisioning',
      pipelineId: ['pipe-A', 'pipe-B'],
    })

    await handlePipelineEvent({ provider: 'gitlab', pipelineId: 'pipe-A', status: 'success' }, env.id)
    await handlePipelineEvent({ provider: 'gitlab', pipelineId: 'pipe-B', status: 'success' }, env.id)

    const [done] = await db.select().from(orders).where(eq(orders.id, order.id))
    expect(done.status).toBe('completed')
    expect(done.pipelineStatus).toEqual({ 'pipe-A': 'success', 'pipe-B': 'success' })
  })

  it('becomes failed if any sibling pipeline fails after another succeeded', async () => {
    const { user, product, env, project } = await buildScenario()
    const order = await createOrder(project.id, product.id, env.id, user.id, {
      status: 'provisioning',
      pipelineId: ['pipe-A', 'pipe-B'],
    })

    await handlePipelineEvent({ provider: 'gitlab', pipelineId: 'pipe-A', status: 'success' }, env.id)
    await handlePipelineEvent({ provider: 'gitlab', pipelineId: 'pipe-B', status: 'failed' }, env.id)

    const [failed] = await db.select().from(orders).where(eq(orders.id, order.id))
    expect(failed.status).toBe('failed')
    expect(failed.pipelineStatus).toMatchObject({ 'pipe-A': 'success', 'pipe-B': 'failed' })
  })

  it('a stale success after a terminal failure does not resurrect the order', async () => {
    const { user, product, env, project } = await buildScenario()
    const order = await createOrder(project.id, product.id, env.id, user.id, {
      status: 'provisioning',
      pipelineId: ['pipe-A', 'pipe-B'],
    })

    // B fails first → order is terminally failed.
    await handlePipelineEvent({ provider: 'gitlab', pipelineId: 'pipe-B', status: 'failed' }, env.id)
    // A late/duplicate success for the sibling must NOT flip it back to completed
    // (the transition is guarded on the order still being 'provisioning').
    await handlePipelineEvent({ provider: 'gitlab', pipelineId: 'pipe-A', status: 'success' }, env.id)

    const [after] = await db.select().from(orders).where(eq(orders.id, order.id))
    expect(after.status).toBe('failed')
  })

  it('does not complete an order that carries a trigger-failed sentinel', async () => {
    // A trigger that never started contributes no pipeline id but does leave a
    // `trigger-failed:*` entry (see retryProvisioning). Checking only the
    // pipeline ids would complete the order as soon as the pipelines that DID
    // start succeed — reporting a fully provisioned order while one webhook or
    // stack was never fired at all.
    const { user, product, env, project } = await buildScenario()
    const order = await createOrder(project.id, product.id, env.id, user.id, {
      status: 'provisioning',
      pipelineId: ['pipe-A'],
    })
    await db
      .update(orders)
      .set({ pipelineStatus: { 'trigger-failed:0': 'product webhook "b" (#2): boom' } })
      .where(eq(orders.id, order.id))

    await handlePipelineEvent({ provider: 'gitlab', pipelineId: 'pipe-A', status: 'success' }, env.id)

    const [after] = await db.select().from(orders).where(eq(orders.id, order.id))
    expect(after.status).toBe('provisioning')
    expect(after.pipelineStatus).toMatchObject({
      'pipe-A': 'success',
      'trigger-failed:0': 'product webhook "b" (#2): boom',
    })
  })
})

describe('handlePipelineEvent — environment scoping', () => {
  it('does not transition an order that belongs to a different environment', async () => {
    const { user, product, env, project } = await buildScenario()
    // A second environment whose callback secret is what authenticated the event.
    const ci2 = await createCiSource({ name: 'CI-2' })
    const envB = await createEnvironment(ci2.id, 'wh-secret-b')
    await linkProductEnvironment(product.id, envB.id)

    // Order lives in env A, but the event is scoped to env B's id.
    const order = await createOrder(project.id, product.id, env.id, user.id, {
      status: 'provisioning',
      pipelineId: ['pipe-shared'],
    })

    await handlePipelineEvent({ provider: 'gitlab', pipelineId: 'pipe-shared', status: 'success' }, envB.id)

    const [unchanged] = await db.select().from(orders).where(eq(orders.id, order.id))
    expect(unchanged.status).toBe('provisioning')

    // Same event scoped to the order's own environment DOES transition it.
    await handlePipelineEvent({ provider: 'gitlab', pipelineId: 'pipe-shared', status: 'success' }, env.id)
    const [completed] = await db.select().from(orders).where(eq(orders.id, order.id))
    expect(completed.status).toBe('completed')
  })

  it('does not transition a decommissioning infra element from another environment', async () => {
    const { user, product, env, project } = await buildScenario()
    const ci2 = await createCiSource({ name: 'CI-2' })
    const envB = await createEnvironment(ci2.id, 'wh-secret-b')

    const order = await createOrder(project.id, product.id, env.id, user.id, { status: 'completed' })
    const el = await createInfraElement(order.id, project.id, env.id, product.id, {
      status: 'decommissioning',
      pipelineId: ['pipe-dc-shared'],
    })

    await handlePipelineEvent({ provider: 'gitlab', pipelineId: 'pipe-dc-shared', status: 'success' }, envB.id)

    const [unchanged] = await db
      .select()
      .from(infrastructureElements)
      .where(eq(infrastructureElements.id, el.id))
    expect(unchanged.status).toBe('decommissioning')
  })
})

describe('handlePipelineEvent — infra decommission completion', () => {
  it('waits for EVERY destroy pipeline before marking the element decommissioned', async () => {
    const { user, product, env, project } = await buildScenario()
    const order = await createOrder(project.id, product.id, env.id, user.id, { status: 'completed' })
    // Teardown fanned out to a product webhook AND a pipeline stack.
    const el = await createInfraElement(order.id, project.id, env.id, product.id, {
      status: 'decommissioning',
      pipelineId: ['pipe-wh', 'pipe-stack'],
    })

    await handlePipelineEvent({ provider: 'gitlab', pipelineId: 'pipe-wh', status: 'success' }, env.id)

    const [partial] = await db
      .select()
      .from(infrastructureElements)
      .where(eq(infrastructureElements.id, el.id))
    // One of two done — the stack is still running, so the teardown is NOT complete.
    expect(partial.status).toBe('decommissioning')
    expect(partial.pipelineStatus).toEqual({ 'pipe-wh': 'success' })

    await handlePipelineEvent({ provider: 'gitlab', pipelineId: 'pipe-stack', status: 'success' }, env.id)

    const [complete] = await db
      .select()
      .from(infrastructureElements)
      .where(eq(infrastructureElements.id, el.id))
    expect(complete.status).toBe('decommissioned')
    expect(complete.pipelineStatus).toEqual({ 'pipe-wh': 'success', 'pipe-stack': 'success' })
  })

  it('a failed destroy pipeline keeps a later sibling success from reporting completion', async () => {
    const { user, product, env, project } = await buildScenario()
    const order = await createOrder(project.id, product.id, env.id, user.id, { status: 'completed' })
    const el = await createInfraElement(order.id, project.id, env.id, product.id, {
      status: 'decommissioning',
      pipelineId: ['pipe-wh', 'pipe-stack'],
    })

    await handlePipelineEvent({ provider: 'gitlab', pipelineId: 'pipe-stack', status: 'failed' }, env.id)
    await handlePipelineEvent({ provider: 'gitlab', pipelineId: 'pipe-wh', status: 'success' }, env.id)

    const [row] = await db
      .select()
      .from(infrastructureElements)
      .where(eq(infrastructureElements.id, el.id))
    // One stack was never destroyed — reporting 'decommissioned' here would
    // hide leaked infrastructure.
    expect(row.status).toBe('decommissioning')
    expect(row.pipelineStatus).toEqual({ 'pipe-stack': 'failed', 'pipe-wh': 'success' })
  })

  it('a trigger-failed sentinel blocks completion even when every started pipeline succeeds', async () => {
    const { user, product, env, project } = await buildScenario()
    const order = await createOrder(project.id, product.id, env.id, user.id, { status: 'completed' })
    // A destroy trigger that never started contributes no pipeline id, only the
    // sentinel written by fireDestroyTriggers.
    const el = await createInfraElement(order.id, project.id, env.id, product.id, {
      status: 'decommissioning',
      pipelineId: ['pipe-wh'],
      pipelineStatus: { 'trigger-failed:0': 'pipeline stack "stack-1" (#1): boom' },
    })

    await handlePipelineEvent({ provider: 'gitlab', pipelineId: 'pipe-wh', status: 'success' }, env.id)

    const [row] = await db
      .select()
      .from(infrastructureElements)
      .where(eq(infrastructureElements.id, el.id))
    expect(row.status).toBe('decommissioning')
  })

  it('a stale duplicate success does not re-run the terminal transition', async () => {
    const { user, product, env, project } = await buildScenario()
    const order = await createOrder(project.id, product.id, env.id, user.id, { status: 'completed' })
    const el = await createInfraElement(order.id, project.id, env.id, product.id, {
      status: 'decommissioning',
      pipelineId: ['pipe-only'],
    })

    await handlePipelineEvent({ provider: 'gitlab', pipelineId: 'pipe-only', status: 'success' }, env.id)
    await handlePipelineEvent({ provider: 'gitlab', pipelineId: 'pipe-only', status: 'success' }, env.id)

    const [row] = await db
      .select()
      .from(infrastructureElements)
      .where(eq(infrastructureElements.id, el.id))
    expect(row.status).toBe('decommissioned')
  })
})

/*
 * Issue #500. An order that failed can be repaired in two places, and only one
 * of them reached the portal: Retry here moves it back to 'provisioning' and the
 * callbacks land, while a restart in the CI UI succeeds, POSTs the same webhook,
 * and matches nothing — the order stays 'failed' for ever, with no record that
 * the event ever arrived.
 *
 * The rule these pin: a SUCCESS for a pipeline the order already records may move
 * it out of 'failed', and completes it only when every recorded pipeline is now a
 * success. 'completed' and 'rejected' stay untouchable, and a second failure
 * teaches an already-failed order nothing.
 */
describe('handlePipelineEvent — a restarted pipeline un-fails its order (#500)', () => {
  it('completes a failed order when its restarted pipeline reports success', async () => {
    const { user, product, env, project } = await buildScenario()
    const order = await createOrder(project.id, product.id, env.id, user.id, {
      status: 'failed',
      pipelineId: ['pipe-restart'],
      pipelineStatus: { 'pipe-restart': 'failed' },
    })

    await handlePipelineEvent({ provider: 'gitlab', pipelineId: 'pipe-restart', status: 'success' }, env.id)

    const [done] = await db.select().from(orders).where(eq(orders.id, order.id))
    expect(done.status).toBe('completed')
    expect(done.pipelineStatus).toEqual({ 'pipe-restart': 'success' })
  })

  it('records the success but stays failed while a sibling is still failed', async () => {
    // One pipeline of two was restarted. The order is not fixed by half of it.
    const { user, product, env, project } = await buildScenario()
    const order = await createOrder(project.id, product.id, env.id, user.id, {
      status: 'failed',
      pipelineId: ['pipe-A', 'pipe-B'],
      pipelineStatus: { 'pipe-A': 'failed', 'pipe-B': 'failed' },
    })

    await handlePipelineEvent({ provider: 'gitlab', pipelineId: 'pipe-A', status: 'success' }, env.id)

    const [after] = await db.select().from(orders).where(eq(orders.id, order.id))
    expect(after.status).toBe('failed')
    expect(after.pipelineStatus).toEqual({ 'pipe-A': 'success', 'pipe-B': 'failed' })
  })

  it('completes on the last outstanding pipeline of a failed order', async () => {
    const { user, product, env, project } = await buildScenario()
    const order = await createOrder(project.id, product.id, env.id, user.id, {
      status: 'failed',
      pipelineId: ['pipe-A', 'pipe-B'],
      pipelineStatus: { 'pipe-A': 'failed', 'pipe-B': 'success' },
    })

    await handlePipelineEvent({ provider: 'gitlab', pipelineId: 'pipe-A', status: 'success' }, env.id)

    const [done] = await db.select().from(orders).where(eq(orders.id, order.id))
    expect(done.status).toBe('completed')
    expect(done.pipelineStatus).toEqual({ 'pipe-A': 'success', 'pipe-B': 'success' })
  })

  it('completes an order written off before its pipeline ever reported (#206)', async () => {
    // markOrderFailed guesses 'failed' in the absence of information; the write-off
    // touches no pipeline status. A pipeline that was in fact fine and reports late
    // must be able to say so.
    const { user, product, env, project } = await buildScenario()
    const order = await createOrder(project.id, product.id, env.id, user.id, {
      status: 'failed',
      pipelineId: ['pipe-late'],
    })

    await handlePipelineEvent({ provider: 'gitlab', pipelineId: 'pipe-late', status: 'success' }, env.id)

    const [done] = await db.select().from(orders).where(eq(orders.id, order.id))
    expect(done.status).toBe('completed')
    expect(done.pipelineStatus).toEqual({ 'pipe-late': 'success' })
  })

  it('keeps a trigger-failed sentinel in the way of a failed order too', async () => {
    // The sentinel stands for a trigger that never started. A restart of the
    // pipelines that DID start does not provision the one that did not.
    const { user, product, env, project } = await buildScenario()
    const order = await createOrder(project.id, product.id, env.id, user.id, {
      status: 'failed',
      pipelineId: ['pipe-A'],
      pipelineStatus: { 'trigger-failed:0': 'product webhook "b" (#2): boom' },
    })

    await handlePipelineEvent({ provider: 'gitlab', pipelineId: 'pipe-A', status: 'success' }, env.id)

    const [after] = await db.select().from(orders).where(eq(orders.id, order.id))
    expect(after.status).toBe('failed')
    expect(after.pipelineStatus).toMatchObject({
      'pipe-A': 'success',
      'trigger-failed:0': 'product webhook "b" (#2): boom',
    })
  })

  it('does not touch a completed order', async () => {
    const { user, product, env, project } = await buildScenario()
    const order = await createOrder(project.id, product.id, env.id, user.id, {
      status: 'completed',
      pipelineId: ['pipe-A'],
    })

    await handlePipelineEvent({ provider: 'gitlab', pipelineId: 'pipe-A', status: 'success' }, env.id)

    const [after] = await db.select().from(orders).where(eq(orders.id, order.id))
    expect(after.status).toBe('completed')
    expect(after.pipelineStatus).toEqual({})
  })

  it('does not touch a rejected order', async () => {
    const { user, product, env, project } = await buildScenario()
    const order = await createOrder(project.id, product.id, env.id, user.id, {
      status: 'rejected',
      pipelineId: ['pipe-A'],
    })

    await handlePipelineEvent({ provider: 'gitlab', pipelineId: 'pipe-A', status: 'success' }, env.id)

    const [after] = await db.select().from(orders).where(eq(orders.id, order.id))
    expect(after.status).toBe('rejected')
    expect(after.pipelineStatus).toEqual({})
  })

  it('lets a second failure of an already-failed order change nothing', async () => {
    // The failure branch keeps its 'provisioning'-only guard on purpose: the order
    // is already failed, so there is nothing to learn and nobody to tell twice.
    const { user, product, env, project } = await buildScenario()
    const order = await createOrder(project.id, product.id, env.id, user.id, {
      status: 'failed',
      pipelineId: ['pipe-A', 'pipe-B'],
      pipelineStatus: { 'pipe-A': 'failed' },
    })
    vi.mocked(sendProvisioningFailed).mockClear()

    await handlePipelineEvent({ provider: 'gitlab', pipelineId: 'pipe-B', status: 'failed' }, env.id)

    const [after] = await db.select().from(orders).where(eq(orders.id, order.id))
    expect(after.status).toBe('failed')
    expect(after.pipelineStatus).toEqual({ 'pipe-A': 'failed' })
    expect(sendProvisioningFailed).not.toHaveBeenCalled()
  })

  it('cannot be un-failed from another environment', async () => {
    // Widening the status must not widen who may move the row.
    const { user, product, env, project } = await buildScenario()
    const ci2 = await createCiSource({ name: 'CI-2' })
    const envB = await createEnvironment(ci2.id, 'wh-secret-b')
    const order = await createOrder(project.id, product.id, env.id, user.id, {
      status: 'failed',
      pipelineId: ['pipe-shared'],
      pipelineStatus: { 'pipe-shared': 'failed' },
    })

    await handlePipelineEvent({ provider: 'gitlab', pipelineId: 'pipe-shared', status: 'success' }, envB.id)

    const [unchanged] = await db.select().from(orders).where(eq(orders.id, order.id))
    expect(unchanged.status).toBe('failed')
    expect(unchanged.pipelineStatus).toEqual({ 'pipe-shared': 'failed' })
  })
})

describe('handlePipelineEvent — no-ops', () => {
  it('does nothing when no matching order exists', async () => {
    await expect(
      handlePipelineEvent({ provider: 'gitlab', pipelineId: 'nonexistent', status: 'success' }, 999_999),
    ).resolves.toBeUndefined()
  })
})


// Issues #97 and #121. The apply log is the only channel by which a deployment
// reports its Terraform outputs, so where they land — and whether anything says why
// they did not — is worth pinning down.
describe('handlePipelineEvent — Terraform outputs', () => {
  // The mocks are module-level, so call counts accumulate across tests in this
  // file unless they are cleared per test.
  beforeEach(() => {
    vi.mocked(fetchJobTraces).mockClear().mockResolvedValue([])
    vi.mocked(parseTofuOutputs).mockClear().mockReturnValue({})
    vi.mocked(supportsJobTrace).mockClear().mockReturnValue(true)
  })

  const outputsOf = async (id: number) =>
    (await db.select({ outputs: infrastructureElements.outputs }).from(infrastructureElements).where(eq(infrastructureElements.id, id)))[0]
      .outputs

  // `pipelineIds` are the ORDER's. By default every element carries all of them,
  // which is the one-element-several-pipelines shape (#121). Pass `perElement` to
  // give each element pipelines of its own, which is what provisioning writes now
  // that one order provisions N elements (#104).
  const seedOrderWithElements = async (
    count: number,
    pipelineIds: string[] = ['pipe-1'],
    perElement?: string[][],
  ) => {
    const pm = await createUser({ role: 'project_manager', email: `out-pm-${Math.random()}@test.dev` })
    const cat = await createCategory()
    const product = await createProduct(cat.id, 'Gateway')
    const ci = await createCiSource()
    const env = await createEnvironment(ci.id)
    await linkProductEnvironment(product.id, env.id)
    const project = await createProject(pm.id)
    const order = await createOrder(project.id, product.id, env.id, pm.id, {
      status: 'provisioning',
      pipelineId: pipelineIds,
    })
    // Every pipeline but the last already reported: the order completes on the
    // event for the last one, which is the moment the outputs are collected.
    const alreadySucceeded = Object.fromEntries(pipelineIds.slice(0, -1).map((id) => [id, 'success']))
    if (Object.keys(alreadySucceeded).length > 0) {
      await db.update(orders).set({ pipelineStatus: alreadySucceeded }).where(eq(orders.id, order.id))
    }
    const elements = []
    for (let i = 0; i < count; i++) {
      elements.push(
        await createInfraElement(order.id, project.id, env.id, product.id, {
          pipelineId: perElement?.[i] ?? pipelineIds,
          sequence: i + 1,
        }),
      )
    }
    return { order, env, elements }
  }

  it('records each element with the outputs of its OWN pipeline', async () => {
    // Issue #104: each of the N elements is a separate machine reporting its own
    // ip_address. Merging the order's pipelines into one map made every element
    // report element 1's address — silent, confidently wrong operational data.
    const { elements } = await seedOrderWithElements(2, ['pipe-el1', 'pipe-el2'], [
      ['pipe-el1'],
      ['pipe-el2'],
    ])
    vi.mocked(fetchJobTraces).mockImplementation(async (_ci, pipelineId) =>
      pipelineId === 'pipe-el1' ? ['trace-el1'] : ['trace-el2'],
    )
    vi.mocked(parseTofuOutputs).mockImplementation(
      (trace): Record<string, string> =>
        trace === 'trace-el1' ? { ip: '203.0.113.7' } : { ip: '203.0.113.8' },
    )

    await handlePipelineEvent(
      { provider: 'gitlab', pipelineId: 'pipe-el2', status: 'success' },
      elements[0].environmentId,
    )

    expect(await outputsOf(elements[0].id)).toEqual({ ip: '203.0.113.7' })
    expect(await outputsOf(elements[1].id)).toEqual({ ip: '203.0.113.8' })
  })

  it('does not call the same-key collision a collision when it is two elements', async () => {
    // Two elements reporting `ip` with different values is the normal case, not a
    // template naming clash: warning about it trained operators to ignore the
    // warning that does mean one.
    const { elements } = await seedOrderWithElements(2, ['pipe-el1', 'pipe-el2'], [
      ['pipe-el1'],
      ['pipe-el2'],
    ])
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    vi.mocked(fetchJobTraces).mockImplementation(async (_ci, pipelineId) =>
      pipelineId === 'pipe-el1' ? ['trace-el1'] : ['trace-el2'],
    )
    vi.mocked(parseTofuOutputs).mockImplementation(
      (trace): Record<string, string> =>
        trace === 'trace-el1' ? { ip: '203.0.113.7' } : { ip: '203.0.113.8' },
    )

    await handlePipelineEvent(
      { provider: 'gitlab', pipelineId: 'pipe-el2', status: 'success' },
      elements[0].environmentId,
    )

    expect(warn).not.toHaveBeenCalledWith(expect.stringContaining('more than one'))
    warn.mockRestore()
  })

  it('records nothing for an element whose triggers never fired, and says so', async () => {
    // An element with no pipeline of its own has unknown outputs. Taking a
    // sibling's is what this whole loop exists to stop.
    const { elements } = await seedOrderWithElements(2, ['pipe-el1'], [['pipe-el1'], []])
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    vi.mocked(fetchJobTraces).mockResolvedValue(['trace-el1'])
    vi.mocked(parseTofuOutputs).mockReturnValue({ ip: '203.0.113.7' })

    await handlePipelineEvent(
      { provider: 'gitlab', pipelineId: 'pipe-el1', status: 'success' },
      elements[0].environmentId,
    )

    expect(await outputsOf(elements[0].id)).toEqual({ ip: '203.0.113.7' })
    expect(await outputsOf(elements[1].id)).toEqual({})
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('no pipeline of its own'))
    warn.mockRestore()
  })

  it('says why there are no outputs when the provider cannot be read', async () => {
    // GitHub and Bitbucket have no trace endpoint implemented, and silence made it
    // look like the template had declared no outputs.
    const { elements } = await seedOrderWithElements(1)
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    vi.mocked(supportsJobTrace).mockReturnValueOnce(false)

    await handlePipelineEvent(
      { provider: 'gitlab', pipelineId: 'pipe-1', status: 'success' },
      elements[0].environmentId,
    )

    expect(warn).toHaveBeenCalledWith(expect.stringContaining('not implemented'))
    expect(await outputsOf(elements[0].id)).toEqual({})
    expect(fetchJobTraces).not.toHaveBeenCalled()
    warn.mockRestore()
  })

  // Issue #121 from here down.
  it('reads every pipeline of the order and merges what they report', async () => {
    // An order fans out over the product webhooks and pipeline stacks. Reading only
    // the pipeline whose event completed the order dropped the rest — and which set
    // survived was decided by CI timing.
    const { elements } = await seedOrderWithElements(1, ['pipe-1', 'pipe-2'])
    vi.mocked(fetchJobTraces)
      .mockResolvedValueOnce(['trace-1'])
      .mockResolvedValueOnce(['trace-2'])
    vi.mocked(parseTofuOutputs).mockImplementation(
      (trace): Record<string, string> =>
        trace === 'trace-1' ? { vm_ip: '10.0.0.4' } : { fqdn: 'web-01.example.com' },
    )

    await handlePipelineEvent(
      { provider: 'gitlab', pipelineId: 'pipe-2', status: 'success' },
      elements[0].environmentId,
    )

    expect(vi.mocked(fetchJobTraces).mock.calls.map((call) => call[1])).toEqual(['pipe-1', 'pipe-2'])
    expect(await outputsOf(elements[0].id)).toEqual({ vm_ip: '10.0.0.4', fqdn: 'web-01.example.com' })
  })

  it('keeps the first pipeline\'s value when two report the same key, and says so', async () => {
    // Picking by CI timing would make the recorded value change from run to run.
    const { elements } = await seedOrderWithElements(1, ['pipe-1', 'pipe-2'])
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    vi.mocked(fetchJobTraces)
      .mockResolvedValueOnce(['trace-1'])
      .mockResolvedValueOnce(['trace-2'])
    vi.mocked(parseTofuOutputs).mockImplementation(
      (trace): Record<string, string> => (trace === 'trace-1' ? { ip: '10.0.0.4' } : { ip: '10.0.0.9' }),
    )

    await handlePipelineEvent(
      { provider: 'gitlab', pipelineId: 'pipe-2', status: 'success' },
      elements[0].environmentId,
    )

    expect(await outputsOf(elements[0].id)).toEqual({ ip: '10.0.0.4' })
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('more than one'))
    warn.mockRestore()
  })

  it('still records what the readable pipelines reported when one log cannot be read', async () => {
    const { elements } = await seedOrderWithElements(1, ['pipe-1', 'pipe-2'])
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    vi.mocked(fetchJobTraces)
      .mockRejectedValueOnce(new Error('GitLab jobs fetch failed: 500'))
      .mockResolvedValueOnce(['trace-2'])
    vi.mocked(parseTofuOutputs).mockReturnValue({ fqdn: 'web-01.example.com' })

    await handlePipelineEvent(
      { provider: 'gitlab', pipelineId: 'pipe-2', status: 'success' },
      elements[0].environmentId,
    )

    expect(await outputsOf(elements[0].id)).toEqual({ fqdn: 'web-01.example.com' })
    expect(error).toHaveBeenCalledWith(expect.stringContaining('pipe-1'), expect.anything())
    error.mockRestore()
  })

  it('names the misconfigured environment when the project cannot be derived from its webhook URL', async () => {
    // GitLab's job endpoints are project-scoped and the project is named only in the
    // environment's trigger URL. An operator can fix a URL of another shape, but
    // only if the portal says so.
    const { env, elements } = await seedOrderWithElements(1)
    await db
      .update(deploymentEnvironments)
      .set({ webhookUrl: 'https://gitlab.example.com/api/v4/trigger/pipeline' })
      .where(eq(deploymentEnvironments.id, env.id))
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})

    await handlePipelineEvent(
      { provider: 'gitlab', pipelineId: 'pipe-1', status: 'success' },
      elements[0].environmentId,
    )

    expect(warn).toHaveBeenCalledWith(expect.stringContaining('/projects/<id>/'))
    expect(fetchJobTraces).not.toHaveBeenCalled()
    expect(await outputsOf(elements[0].id)).toEqual({})
    warn.mockRestore()
  })
})
