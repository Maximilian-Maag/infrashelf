import { describe, it, expect, vi, beforeEach } from 'vitest'
import { eq } from 'drizzle-orm'
import { db } from '@/lib/db/client'
import { orders, infrastructureElements } from '@/lib/db/schema'
import {
  createUser,
  createCategory,
  createProduct,
  createCiSource,
  createEnvironment,
  createProject,
  createOrder,
  createInfraElement,
} from '@/test/helpers'
import { settleOrderIfComplete, settleElementIfComplete } from './settle'

vi.mock('@/lib/ci', () => ({
  fetchJobTraces: vi.fn().mockResolvedValue([]),
  parseTofuOutputs: vi.fn().mockReturnValue({}),
  supportsJobTrace: vi.fn().mockReturnValue(true),
  triggerPipeline: vi.fn(),
}))

vi.mock('@/lib/notification/index', () => ({
  sendProvisioningCompleted: vi.fn().mockResolvedValue(undefined),
  sendProvisioningFailed: vi.fn().mockResolvedValue(undefined),
  sendDecommissioned: vi.fn().mockResolvedValue(undefined),
}))

const scenario = async () => {
  const user = await createUser({ email: 'settle@test.dev' })
  const category = await createCategory()
  const product = await createProduct(category.id)
  const ci = await createCiSource()
  const environment = await createEnvironment(ci.id)
  const project = await createProject(user.id)
  return { user, product, environment, project }
}

beforeEach(() => {
  vi.spyOn(console, 'error').mockImplementation(() => {})
})

/*
 * The gap between deciding and swapping (#195, finding 7).
 *
 * `settleOrderIfComplete` reads `pipeline_status`, decides the order is done,
 * then makes one network call per element before it swaps. #175 made that gap
 * proportional to quantity. In it a `canceled` event can fail the order and an
 * admin can hit Retry, putting it back to 'provisioning' with a NEW pipeline
 * set — and a swap that guards only `status` cannot tell the retry's
 * 'provisioning' from the one it decided on.
 *
 * The stale caller is modelled by handing the function a snapshot that no longer
 * matches the row, which is exactly what it is holding after a retry rewrote the
 * column.
 */
describe('settleOrderIfComplete — the completion swap', () => {
  it('completes the order when the snapshot it decided on is still the one on the row', async () => {
    const { user, product, environment, project } = await scenario()
    const tracking = { pipelineId: ['100'], pipelineStatus: { '100': 'success' } }
    const order = await createOrder(project.id, product.id, environment.id, user.id, {
      status: 'provisioning',
      pipelineId: tracking.pipelineId,
    })
    await db.update(orders).set({ pipelineStatus: tracking.pipelineStatus }).where(eq(orders.id, order.id))
    await createInfraElement(order.id, project.id, environment.id, product.id, { status: 'provisioning' })

    expect(await settleOrderIfComplete(order, tracking, 'all pipelines succeeded')).toBe(true)

    const [row] = await db.select({ status: orders.status }).from(orders).where(eq(orders.id, order.id))
    expect(row.status).toBe('completed')
  })

  it('does not complete an order a retry has moved on from', async () => {
    const { user, product, environment, project } = await scenario()
    // What this caller decided on, before it went off to record outputs.
    const decided = { pipelineId: ['100'], pipelineStatus: { '100': 'success' } }
    const order = await createOrder(project.id, product.id, environment.id, user.id, {
      status: 'provisioning',
      pipelineId: decided.pipelineId,
    })
    await createInfraElement(order.id, project.id, environment.id, product.id, { status: 'provisioning' })

    // Meanwhile: a cancel failed the order and an admin retried it. Back to
    // 'provisioning' — but a different run, with a different pipeline.
    await db
      .update(orders)
      .set({ status: 'provisioning', pipelineId: ['200'], pipelineStatus: { '200': 'success' } })
      .where(eq(orders.id, order.id))

    expect(await settleOrderIfComplete(order, decided, 'all pipelines succeeded')).toBe(false)

    // Still provisioning, so the RETRY's own callback can finish it. Completing
    // here would stamp the previous run's outputs and mail "ready" for a run
    // that is still going.
    const [row] = await db.select({ status: orders.status }).from(orders).where(eq(orders.id, order.id))
    expect(row.status).toBe('provisioning')
  })

  // The status guard still has to work on its own: a snapshot can match while
  // the order has already gone terminal by another route. `completed` and
  // `rejected` are the two that must stay untouchable — `failed` deliberately is
  // no longer one of them (#500, see the two tests below).
  it('does not complete an order that has already been completed', async () => {
    const { user, product, environment, project } = await scenario()
    const tracking = { pipelineId: ['100'], pipelineStatus: { '100': 'success' } }
    const order = await createOrder(project.id, product.id, environment.id, user.id, {
      status: 'completed',
      pipelineId: tracking.pipelineId,
    })
    await db.update(orders).set({ pipelineStatus: tracking.pipelineStatus }).where(eq(orders.id, order.id))

    expect(await settleOrderIfComplete(order, tracking, 'all pipelines succeeded')).toBe(false)

    const [row] = await db.select({ status: orders.status }).from(orders).where(eq(orders.id, order.id))
    expect(row.status).toBe('completed')
  })

  it('does not complete a rejected order', async () => {
    const { user, product, environment, project } = await scenario()
    const tracking = { pipelineId: ['100'], pipelineStatus: { '100': 'success' } }
    const order = await createOrder(project.id, product.id, environment.id, user.id, {
      status: 'rejected',
      pipelineId: tracking.pipelineId,
    })
    await db.update(orders).set({ pipelineStatus: tracking.pipelineStatus }).where(eq(orders.id, order.id))

    expect(await settleOrderIfComplete(order, tracking, 'all pipelines succeeded')).toBe(false)

    const [row] = await db.select({ status: orders.status }).from(orders).where(eq(orders.id, order.id))
    expect(row.status).toBe('rejected')
  })

  /*
   * The other half of #500: `failed` used to sit in the same predicate as the two
   * statuses above, which left a restart in CI unable to repair anything. It is
   * the status an operator acts on, and it is now the one terminal-looking status
   * a matching success may leave.
   */
  it('completes an order that a restart has moved out of failed', async () => {
    const { user, product, environment, project } = await scenario()
    const tracking = { pipelineId: ['100'], pipelineStatus: { '100': 'success' } }
    const order = await createOrder(project.id, product.id, environment.id, user.id, {
      status: 'failed',
      pipelineId: tracking.pipelineId,
    })
    // The restart's own success, already merged into the map by the handler.
    await db.update(orders).set({ pipelineStatus: tracking.pipelineStatus }).where(eq(orders.id, order.id))
    await createInfraElement(order.id, project.id, environment.id, product.id, { status: 'provisioning' })

    expect(await settleOrderIfComplete(order, tracking, 'Pipeline 100 succeeded')).toBe(true)

    const [row] = await db.select({ status: orders.status }).from(orders).where(eq(orders.id, order.id))
    expect(row.status).toBe('completed')
  })

  it('refuses a failed order whose snapshot a retry has replaced', async () => {
    // The `pipeline_status` half of the compare is what keeps a concurrent Retry
    // winning: the retry rewrites the column, so this caller's snapshot matches
    // nothing — whichever status the retry left behind.
    const { user, product, environment, project } = await scenario()
    const decided = { pipelineId: ['100'], pipelineStatus: { '100': 'success' } }
    const order = await createOrder(project.id, product.id, environment.id, user.id, {
      status: 'failed',
      pipelineId: ['200'],
      pipelineStatus: { '200': 'success' },
    })

    expect(await settleOrderIfComplete(order, decided, 'Pipeline 100 succeeded')).toBe(false)

    const [row] = await db.select({ status: orders.status }).from(orders).where(eq(orders.id, order.id))
    expect(row.status).toBe('failed')
  })

  // jsonb, not text: Postgres does not promise key order in a jsonb round trip,
  // and comparing as text would make two equal snapshots miss each other.
  it('matches a snapshot whose keys come back in a different order', async () => {
    const { user, product, environment, project } = await scenario()
    const tracking = {
      pipelineId: ['100', '200'],
      pipelineStatus: { '100': 'success', '200': 'success' },
    }
    const order = await createOrder(project.id, product.id, environment.id, user.id, {
      status: 'provisioning',
      pipelineId: tracking.pipelineId,
    })
    await db
      .update(orders)
      .set({ pipelineStatus: { '200': 'success', '100': 'success' } })
      .where(eq(orders.id, order.id))
    await createInfraElement(order.id, project.id, environment.id, product.id, { status: 'provisioning' })

    expect(await settleOrderIfComplete(order, tracking, 'all pipelines succeeded')).toBe(true)
  })
})

describe('settleElementIfComplete — the teardown swap', () => {
  it('decommissions the element when the snapshot still matches', async () => {
    const { user, product, environment, project } = await scenario()
    const tracking = { pipelineId: ['300'], pipelineStatus: { '300': 'success' } }
    const order = await createOrder(project.id, product.id, environment.id, user.id, { status: 'completed' })
    const infra = await createInfraElement(order.id, project.id, environment.id, product.id, {
      status: 'decommissioning',
      pipelineId: tracking.pipelineId,
      pipelineStatus: tracking.pipelineStatus,
    })

    expect(await settleElementIfComplete(infra, tracking, 'teardown finished')).toBe(true)

    const [row] = await db
      .select({ status: infrastructureElements.status })
      .from(infrastructureElements)
      .where(eq(infrastructureElements.id, infra.id))
    expect(row.status).toBe('decommissioned')
  })

  it('does not decommission on a snapshot a re-triggered teardown has replaced', async () => {
    const { user, product, environment, project } = await scenario()
    const decided = { pipelineId: ['300'], pipelineStatus: { '300': 'success' } }
    const order = await createOrder(project.id, product.id, environment.id, user.id, { status: 'completed' })
    const infra = await createInfraElement(order.id, project.id, environment.id, product.id, {
      status: 'decommissioning',
      pipelineId: ['400'],
      pipelineStatus: { '400': 'success' },
    })

    expect(await settleElementIfComplete(infra, decided, 'teardown finished')).toBe(false)

    const [row] = await db
      .select({ status: infrastructureElements.status })
      .from(infrastructureElements)
      .where(eq(infrastructureElements.id, infra.id))
    expect(row.status).toBe('decommissioning')
  })
})
