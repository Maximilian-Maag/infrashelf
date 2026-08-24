import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { SessionUser } from '@open-hybrid-cloud/types'

vi.mock('@/lib/ci/webhooks', () => ({
  triggerProductWebhooksTracked: vi.fn(),
  triggerPipelineStacksTracked: vi.fn(),
}))

vi.mock('@/lib/ci', () => ({
  fetchJobTraces: vi.fn().mockResolvedValue([]),
  parseTofuOutputs: vi.fn().mockReturnValue({}),
  supportsJobTrace: vi.fn().mockReturnValue(true),
  triggerPipeline: vi.fn(),
}))

vi.mock('@/lib/notification', () => ({
  sendOrderCreated: vi.fn().mockResolvedValue(undefined),
  sendApprovalRequest: vi.fn().mockResolvedValue(undefined),
  sendOrderApproved: vi.fn().mockResolvedValue(undefined),
  sendOrderRejected: vi.fn().mockResolvedValue(undefined),
  sendProvisioningCompleted: vi.fn().mockResolvedValue(undefined),
  sendProvisioningFailed: vi.fn().mockResolvedValue(undefined),
  sendDecommissioned: vi.fn().mockResolvedValue(undefined),
}))

import { createOrder } from './orders'
import { sweepDueDecommissions, decommissionInfra } from './infrastructure'
import { handlePipelineEvent } from '@/lib/webhook/handler'
import { triggerProductWebhooksTracked, triggerPipelineStacksTracked } from '@/lib/ci/webhooks'
import { fetchJobTraces, parseTofuOutputs } from '@/lib/ci'
import { sendProvisioningCompleted } from '@/lib/notification'
import { db } from '@/lib/db/client'
import { orders, infrastructureElements } from '@/lib/db/schema'
import { eq, sql } from 'drizzle-orm'
import {
  createUser,
  createCategory,
  createProduct,
  createCiSource,
  createEnvironment,
  createProject,
  createOrder as seedOrder,
  createInfraElement,
  linkProductEnvironment,
} from '@/test/helpers'

/**
 * The five ways the portal and the CI system disagreed about ordering
 * (issues #132–#136).
 *
 * They are one file because they are one assumption: that nothing the CI system
 * does can be observed before the portal has finished writing down what it just
 * asked for. Every test here is a callback, a sweep or a cascade arriving inside
 * that window, and none of them uses wall-clock timing to get there — the racing
 * caller is invoked from inside the mock of the call it is racing, which is the
 * only way these stay deterministic on a loaded machine.
 */

const mockedWebhooks = vi.mocked(triggerProductWebhooksTracked)
const mockedStacks = vi.mocked(triggerPipelineStacksTracked)
const mockedTraces = vi.mocked(fetchJobTraces)
const mockedParse = vi.mocked(parseTofuOutputs)
const mockedCompleted = vi.mocked(sendProvisioningCompleted)

const session = (u: { id: number; email: string; name: string; role: string }): SessionUser =>
  ({ id: u.id, email: u.email, name: u.name, role: u.role as SessionUser['role'] })

const started = (...pipelineIds: string[]) => ({ pipelineIds, failures: [] as string[] })
const none = { pipelineIds: [] as string[], failures: [] as string[] }

beforeEach(() => {
  mockedWebhooks.mockReset().mockResolvedValue(started('pipe-1'))
  mockedStacks.mockReset().mockResolvedValue(none)
  mockedTraces.mockReset().mockResolvedValue([])
  mockedParse.mockReset().mockReturnValue({})
  mockedCompleted.mockReset().mockResolvedValue(undefined)
})

const build = async () => {
  const admin = await createUser({ role: 'admin', email: 'admin@test.dev', name: 'Admin' })
  const cat = await createCategory()
  const product = await createProduct(cat.id, 'Product')
  const ci = await createCiSource()
  const env = await createEnvironment(ci.id)
  await linkProductEnvironment(product.id, env.id)
  const project = await createProject(admin.id)
  return { admin, product, env, project }
}

const orderRow = async (id: number) => (await db.select().from(orders).where(eq(orders.id, id)))[0]
const elementRows = async (orderId: number) =>
  db
    .select()
    .from(infrastructureElements)
    .where(eq(infrastructureElements.orderId, orderId))
    .orderBy(infrastructureElements.sequence)

describe('a pipeline that reports before the fan-out is finished (issue #132)', () => {
  it('finds its order when the callback arrives during the trigger call that started it', async () => {
    const { admin, product, env, project } = await build()

    // GitLab accepting the trigger and the pipeline failing on a `rules:` mismatch
    // can be a sub-second round trip, so the callback is delivered from inside the
    // trigger — before `createOrder` has returned, let alone written anything at
    // the end of the fan-out.
    mockedWebhooks.mockImplementation(async (_p, _e, _v, onStarted) => {
      await onStarted?.('pipe-instant')
      await handlePipelineEvent(
        { provider: 'gitlab', pipelineId: 'pipe-instant', status: 'failed' },
        env.id,
      )
      return started('pipe-instant')
    })

    const created = await createOrder(session(admin), {
      projectId: project.id,
      productId: product.id,
      environmentId: env.id,
      parameters: {},
    })
    expect(created.ok).toBe(true)
    if (!created.ok) return

    // Not 'provisioning': an order the callback could not match sat there forever —
    // retryProvisioning refuses anything but a failed order, and nothing polls.
    const row = await orderRow(created.data.id)
    expect(row.status).toBe('failed')
    expect(row.pipelineStatus).toMatchObject({ 'pipe-instant': 'failed' })
  })

  it('does not complete an order on the pipelines started so far while the rest are still firing', async () => {
    const { admin, product, env, project } = await build()

    // Two elements. Element 1's pipeline succeeds while element 2 has not been
    // triggered yet — the window that recording ids one at a time opens, and that
    // the `triggering` entry is there to hold shut.
    let element = 0
    // Read inside the fan-out and asserted outside it: an expectation that throws
    // in there is caught by the per-element try/catch and recorded as a trigger
    // failure instead of failing the test.
    let statusAfterFirstSuccess = ''
    mockedWebhooks.mockImplementation(async (_p, _e, variables, onStarted) => {
      element += 1
      const pipelineId = `pipe-${element}`
      await onStarted?.(pipelineId)
      if (element === 1) {
        await handlePipelineEvent({ provider: 'gitlab', pipelineId, status: 'success' }, env.id)
        statusAfterFirstSuccess = (await orderRow(Number(variables.ORDER_ID))).status
      }
      return started(pipelineId)
    })

    const created = await createOrder(session(admin), {
      projectId: project.id,
      productId: product.id,
      environmentId: env.id,
      parameters: {},
      quantity: 2,
    })
    expect(created.ok).toBe(true)
    if (!created.ok) return

    // Element 2 had not been triggered yet, so completing there would have reported
    // an order half of which was never provisioned at all.
    expect(statusAfterFirstSuccess).toBe('provisioning')

    // Element 2's pipeline is the one that finishes it, and only now.
    expect((await orderRow(created.data.id)).status).toBe('provisioning')
    await handlePipelineEvent({ provider: 'gitlab', pipelineId: 'pipe-2', status: 'success' }, env.id)
    expect((await orderRow(created.data.id)).status).toBe('completed')
  })

  it('completes an order whose pipelines all reported before the fan-out returned', async () => {
    const { admin, product, env, project } = await build()

    // Nobody is left to ask the question the callback was refused: the fan-out
    // removes the `triggering` entry, so the fan-out has to ask it.
    mockedWebhooks.mockImplementation(async (_p, _e, _v, onStarted) => {
      await onStarted?.('pipe-fast')
      await handlePipelineEvent({ provider: 'gitlab', pipelineId: 'pipe-fast', status: 'success' }, env.id)
      return started('pipe-fast')
    })

    const created = await createOrder(session(admin), {
      projectId: project.id,
      productId: product.id,
      environmentId: env.id,
      parameters: {},
    })
    expect(created.ok).toBe(true)
    if (!created.ok) return

    expect((await orderRow(created.data.id)).status).toBe('completed')
    expect(mockedCompleted).toHaveBeenCalledTimes(1)
  })

  it('finds its element when a destroy callback arrives during the teardown fan-out', async () => {
    const { admin, product, env, project } = await build()
    const order = await seedOrder(project.id, product.id, env.id, admin.id, { status: 'completed' })
    const el = await createInfraElement(order.id, project.id, env.id, product.id, {
      // The ids of the apply that created it: what the element still listed while
      // its destroy was being fired.
      pipelineId: ['pipe-apply'],
    })

    mockedWebhooks.mockImplementation(async (_p, _e, _v, onStarted) => {
      await onStarted?.('pipe-destroy')
      await handlePipelineEvent({ provider: 'gitlab', pipelineId: 'pipe-destroy', status: 'success' }, env.id)
      return started('pipe-destroy')
    })

    expect((await decommissionInfra(session(admin), el.id)).ok).toBe(true)

    // Not 'decommissioning': that state is skipped permanently by both the sweep
    // and claimAndDestroy, so an unmatched destroy callback stranded the element.
    const [updated] = await db
      .select()
      .from(infrastructureElements)
      .where(eq(infrastructureElements.id, el.id))
    expect(updated.status).toBe('decommissioned')
    expect(updated.pipelineId).toEqual(['pipe-destroy'])
  })
})

describe('a partially-triggered order (issue #134)', () => {
  it('does not complete when one trigger failed without throwing', async () => {
    const { admin, product, env, project } = await build()

    // The exact shape from the issue: one webhook, one stack. The webhook 502s —
    // which the *Tracked variants report rather than throw — and the stack starts.
    mockedWebhooks.mockResolvedValue({
      pipelineIds: [],
      failures: ['product webhook "deploy" (#1): GitLab trigger failed: 502'],
    })
    mockedStacks.mockResolvedValue(started('stack-1'))

    const created = await createOrder(session(admin), {
      projectId: project.id,
      productId: product.id,
      environmentId: env.id,
      parameters: {},
    })
    expect(created.ok).toBe(true)
    if (!created.ok) return

    const row = await orderRow(created.data.id)
    expect(row.pipelineStatus).toMatchObject({
      'trigger-failed:0': expect.stringContaining('502'),
    })

    await handlePipelineEvent({ provider: 'gitlab', pipelineId: 'stack-1', status: 'success' }, env.id)

    // Half the components were never deployed, so "provisioning completed" would
    // be a lie — and it is the only mail the customer gets about this order.
    expect((await orderRow(created.data.id)).status).toBe('provisioning')
    expect(mockedCompleted).not.toHaveBeenCalled()
  })

  it('reports a failure when no trigger started, instead of leaving the order in provisioning', async () => {
    const { admin, product, env, project } = await build()
    mockedWebhooks.mockResolvedValue({
      pipelineIds: [],
      failures: ['product webhook "deploy" (#1): GitLab trigger failed: 502'],
    })

    const created = await createOrder(session(admin), {
      projectId: project.id,
      productId: product.id,
      environmentId: env.id,
      parameters: {},
    })

    expect(created.ok).toBe(false)
    if (created.ok) return
    expect(created.status).toBe(502)

    // The order says what happened rather than claiming to be in flight, and the
    // element rows go with it — an 'active' element with no pipeline is counted in
    // inventory and fires a destroy at infrastructure that never existed.
    const [row] = await db.select().from(orders)
    expect(row.status).toBe('failed')
    expect(await elementRows(row.id)).toHaveLength(0)
  })
})

describe('a trial that comes due while its own apply is running (issue #135)', () => {
  const dueElement = async (orderStatus: string) => {
    const { admin, product, env, project } = await build()
    const order = await seedOrder(project.id, product.id, env.id, admin.id, { status: orderStatus })
    const el = await createInfraElement(order.id, project.id, env.id, product.id)
    await db
      .update(infrastructureElements)
      .set({ scheduledDecommissionAt: new Date(Date.now() - 60_000) })
      .where(eq(infrastructureElements.id, el.id))
    return { admin, el, order }
  }

  it('is not swept while the order that provisions it is still provisioning', async () => {
    const { el } = await dueElement('provisioning')

    const result = await sweepDueDecommissions()

    expect(result.decommissioned).toEqual([])
    expect(result.failed).toEqual([])
    expect(mockedWebhooks).not.toHaveBeenCalled()
    const [row] = await db
      .select()
      .from(infrastructureElements)
      .where(eq(infrastructureElements.id, el.id))
    expect(row.status).toBe('active')
  })

  it('is swept by the first run after that order completes', async () => {
    const { el, order } = await dueElement('provisioning')
    expect((await sweepDueDecommissions()).decommissioned).toEqual([])

    await db.update(orders).set({ status: 'completed' }).where(eq(orders.id, order.id))

    expect((await sweepDueDecommissions()).decommissioned).toEqual([el.id])
  })

  it('refuses an interactive decommission of an element whose order is mid-provision', async () => {
    // In the claim and not only in the sweep's query: the sweep reads its due rows
    // and claims them one at a time, and a retry started in between puts the order
    // back to 'provisioning' underneath it.
    const { admin, el } = await dueElement('provisioning')

    const result = await decommissionInfra(session(admin), el.id)

    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.status).toBe(409)
    expect(mockedWebhooks).not.toHaveBeenCalled()
  })

  it('still sweeps an element of a failed order, which is real infrastructure with a clock on it', async () => {
    const { el } = await dueElement('failed')
    expect((await sweepDueDecommissions()).decommissioned).toEqual([el.id])
  })
})

describe('terminal webhook effects and the point of no return (issue #136)', () => {
  /**
   * A database that refuses to store Terraform outputs, for as long as the callback
   * runs. Cheaper and far more precise than trying to time a real outage: the write
   * that #136 is about is the only one it breaks.
   */
  const blockOutputWrites = async (): Promise<() => Promise<void>> => {
    await db.execute(sql`
      DROP TRIGGER IF EXISTS ohc_test_block_outputs ON infrastructure_elements;
      CREATE OR REPLACE FUNCTION ohc_test_block_outputs() RETURNS trigger AS $$
      BEGIN RAISE EXCEPTION 'simulated database outage'; END;
      $$ LANGUAGE plpgsql;
      CREATE TRIGGER ohc_test_block_outputs
        BEFORE UPDATE OF outputs ON infrastructure_elements
        FOR EACH ROW EXECUTE FUNCTION ohc_test_block_outputs();
    `)
    return async () => {
      await db.execute(sql`
        DROP TRIGGER IF EXISTS ohc_test_block_outputs ON infrastructure_elements;
        DROP FUNCTION IF EXISTS ohc_test_block_outputs();
      `)
    }
  }

  it('leaves the order findable when the outputs write fails, and records them on redelivery', async () => {
    const { admin, product, env, project } = await build()
    const order = await seedOrder(project.id, product.id, env.id, admin.id, {
      status: 'provisioning',
      pipelineId: ['pipe-1'],
    })
    const el = await createInfraElement(order.id, project.id, env.id, product.id, {
      pipelineId: ['pipe-1'],
    })
    mockedTraces.mockResolvedValue(['Outputs:\nip_address = "10.0.0.7"'])
    mockedParse.mockReturnValue({ ip_address: '10.0.0.7' })

    const restore = await blockOutputWrites()
    try {
      await expect(
        handlePipelineEvent({ provider: 'gitlab', pipelineId: 'pipe-1', status: 'success' }, env.id),
      ).rejects.toThrow()

      // The order has NOT been taken past the point where the callback route's
      // selection predicate can find it again.
      expect((await orderRow(order.id)).status).toBe('provisioning')
      expect(mockedCompleted).not.toHaveBeenCalled()
    } finally {
      await restore()
    }

    // GitLab does not retry, but a sibling pipeline's event, a manual redelivery or
    // the end of the fan-out all reach the same code — and now they can finish it.
    await handlePipelineEvent({ provider: 'gitlab', pipelineId: 'pipe-1', status: 'success' }, env.id)

    expect((await orderRow(order.id)).status).toBe('completed')
    const [updated] = await db
      .select()
      .from(infrastructureElements)
      .where(eq(infrastructureElements.id, el.id))
    // Outputs are the only channel by which a deployment reports its endpoint to
    // the portal (#121); losing them is losing the point of the whole path.
    expect(updated.outputs).toEqual({ ip_address: '10.0.0.7' })
  })
})
