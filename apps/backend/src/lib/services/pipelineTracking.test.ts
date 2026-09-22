import { describe, it, expect, vi } from 'vitest'
import { eq } from 'drizzle-orm'
import { db } from '@/lib/db/client'
import { orders, infrastructureElements } from '@/lib/db/schema'
import { TRIGGERING_KEY, TRIGGERING_VALUE } from '@/lib/webhook/settle'
import {
  beginOrderTriggerRun,
  recordOrderPipelineId,
  finishOrderTriggerRun,
  clearOrderTriggerRun,
  beginElementTriggerRun,
  recordElementPipelineId,
  finishElementTriggerRun,
  restoreElementTriggerRun,
} from './pipelineTracking'
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

/*
 * The tracking bracket a run hangs inside, which the whole webhook path depends on
 * and which had no test of its own (#132, #134, #136, #206 were all regressions
 * here).
 *
 * Nothing in this file needs a CI call: the order tests use an order with no
 * elements, because `settleOrderIfComplete` reads Terraform outputs per element
 * and that is a network read — the fan-out bookkeeping is what is under test here,
 * not the outputs. The notifications that settling sends are mocked for the same
 * reason (the pattern the route tests use).
 */
vi.mock('@/lib/notification', () => ({
  sendProvisioningCompleted: vi.fn(),
  sendDecommissioned: vi.fn(),
}))

const setup = async (over: { orderStatus?: string } = {}) => {
  const user = await createUser({ email: `track-${Math.random()}@test.dev` })
  const category = await createCategory()
  const product = await createProduct(category.id)
  const ci = await createCiSource()
  const environment = await createEnvironment(ci.id)
  const project = await createProject(user.id)
  const order = await createOrder(project.id, product.id, environment.id, user.id, {
    status: over.orderStatus ?? 'provisioning',
  })
  return { user, product, environment, project, order }
}

const orderRow = async (id: number) => {
  const [row] = await db.select().from(orders).where(eq(orders.id, id)).limit(1)
  return row
}

const elementRow = async (id: number) => {
  const [row] = await db.select().from(infrastructureElements).where(eq(infrastructureElements.id, id)).limit(1)
  return row
}

describe('beginOrderTriggerRun', () => {
  it("clears an earlier attempt's ids and takes ownership of the tracking", async () => {
    const { order } = await setup()
    // What a previous, retried attempt left behind — an id from a run that no
    // longer exists. Appending to it would leave the order waiting forever.
    await db
      .update(orders)
      .set({ pipelineId: ['old-1'], pipelineStatus: { 'old-1': 'success' } })
      .where(eq(orders.id, order.id))

    await beginOrderTriggerRun(order.id)

    const row = await orderRow(order.id)
    expect(row.pipelineId).toEqual([])
    expect(row.pipelineStatus).toEqual({ [TRIGGERING_KEY]: TRIGGERING_VALUE })
  })

  it('leaves an order another caller has already taken terminal alone', async () => {
    const { order } = await setup({ orderStatus: 'completed' })
    await db
      .update(orders)
      .set({ pipelineId: ['p1'], pipelineStatus: { p1: 'success' } })
      .where(eq(orders.id, order.id))

    await beginOrderTriggerRun(order.id)

    const row = await orderRow(order.id)
    expect(row.pipelineId).toEqual(['p1'])
    expect(row.pipelineStatus).toEqual({ p1: 'success' })
  })
})

describe('recordOrderPipelineId', () => {
  it('appends each id in the order the triggers returned', async () => {
    const { order } = await setup()
    await beginOrderTriggerRun(order.id)

    await recordOrderPipelineId(order.id, 'p1')
    await recordOrderPipelineId(order.id, 'p2')

    expect((await orderRow(order.id)).pipelineId).toEqual(['p1', 'p2'])
  })
})

describe('finishOrderTriggerRun', () => {
  it('reconciles the ids recorded during the run without duplicating them', async () => {
    const { order } = await setup()
    await beginOrderTriggerRun(order.id)
    // Recorded one at a time as the triggers returned, then re-applied by the
    // fan-out at the end — the id that landed must not appear twice.
    await recordOrderPipelineId(order.id, 'p1')

    await finishOrderTriggerRun(order.id, ['p1', 'p2'], [], 'reason')

    const row = await orderRow(order.id)
    expect(row.pipelineId).toEqual(['p1', 'p2'])
    expect(row.pipelineStatus[TRIGGERING_KEY]).toBeUndefined()
  })

  it('completes the order a callback was refused the decision on (#132)', async () => {
    const { order } = await setup()
    await beginOrderTriggerRun(order.id)
    await recordOrderPipelineId(order.id, 'p1')
    // What the callback handler merges while `triggering` holds the decision shut.
    await db.update(orders).set({ pipelineStatus: { p1: 'success' } }).where(eq(orders.id, order.id))

    await finishOrderTriggerRun(order.id, ['p1'], [], 'reason')

    expect((await orderRow(order.id)).status).toBe('completed')
  })

  it('keeps a run with a trigger that never started from completing', async () => {
    const { order } = await setup()
    await beginOrderTriggerRun(order.id)
    await recordOrderPipelineId(order.id, 'p1')
    await db.update(orders).set({ pipelineStatus: { p1: 'success' } }).where(eq(orders.id, order.id))

    await finishOrderTriggerRun(order.id, ['p1'], ['element 1: webhook 502'], 'reason')

    const row = await orderRow(order.id)
    expect(row.status).toBe('provisioning')
    // The sentinel is what holds it: `isSettled` refuses any entry that is not a
    // success, the same mechanism `triggering` uses.
    expect(row.pipelineStatus['trigger-failed:0']).toBe('element 1: webhook 502')
    expect(row.pipelineStatus[TRIGGERING_KEY]).toBeUndefined()
  })
})

describe('clearOrderTriggerRun', () => {
  it('leaves an order that started nothing with nothing recorded', async () => {
    const { order } = await setup()
    await beginOrderTriggerRun(order.id)
    await recordOrderPipelineId(order.id, 'p1')

    await clearOrderTriggerRun(order.id)

    const row = await orderRow(order.id)
    expect(row.pipelineId).toEqual([])
    expect(row.pipelineStatus).toEqual({})
  })
})

describe("an element's teardown run", () => {
  const teardown = async (over: { pipelineStatus?: Record<string, string> } = {}) => {
    const { user, product, environment, project, order } = await setup()
    const element = await createInfraElement(order.id, project.id, environment.id, product.id, {
      status: 'decommissioning',
      pipelineId: ['prov-1'],
      pipelineStatus: over.pipelineStatus ?? { 'prov-1': 'success' },
    })
    void user
    return { element }
  }

  it('switches the phase and hands the provisioning run back', async () => {
    const { element } = await teardown()

    const previous = await beginElementTriggerRun(element.id)

    // Handed back so a teardown that starts nothing can put it back: those ids
    // are what the detail page shows for an active element.
    expect(previous).toEqual({ pipelineId: ['prov-1'], pipelineStatus: { 'prov-1': 'success' } })
    const row = await elementRow(element.id)
    expect(row.pipelineId).toEqual([])
    expect(row.pipelineStatus).toEqual({ [TRIGGERING_KEY]: TRIGGERING_VALUE })
  })

  it('records the destroy ids and completes the teardown when they all succeed', async () => {
    const { element } = await teardown()
    await beginElementTriggerRun(element.id)

    await recordElementPipelineId(element.id, 'destroy-1')
    expect((await elementRow(element.id)).pipelineId).toEqual(['destroy-1'])

    await db
      .update(infrastructureElements)
      .set({ pipelineStatus: { 'destroy-1': 'success' } })
      .where(eq(infrastructureElements.id, element.id))
    await finishElementTriggerRun(element.id, ['destroy-1'], [], 'reason')

    expect((await elementRow(element.id)).status).toBe('decommissioned')
  })

  it('leaves an element decommissioning when a destroy trigger never started', async () => {
    const { element } = await teardown()
    await beginElementTriggerRun(element.id)

    await finishElementTriggerRun(element.id, [], ['Could not reach the CI system'], 'reason')

    const row = await elementRow(element.id)
    expect(row.status).toBe('decommissioning')
    expect(row.pipelineStatus['trigger-failed:0']).toBe('Could not reach the CI system')
  })

  it('restores the provisioning run when the teardown started nothing', async () => {
    const { element } = await teardown()
    const previous = await beginElementTriggerRun(element.id)

    await restoreElementTriggerRun(element.id, previous)

    const row = await elementRow(element.id)
    expect(row.pipelineId).toEqual(['prov-1'])
    expect(row.pipelineStatus).toEqual({ 'prov-1': 'success' })
  })
})
