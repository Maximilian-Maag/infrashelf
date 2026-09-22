import { describe, it, expect, vi, beforeEach } from 'vitest'
import { NextRequest } from 'next/server'
import { eq } from 'drizzle-orm'
import { POST } from './route'
import { db } from '@/lib/db/client'
import { orders, costCenters, projects } from '@/lib/db/schema'
import {
  createUser, createCategory, createProduct, createCiSource,
  createEnvironment, createProject, createOrder, makeAuthHeader,
  createCostCenter, linkProductEnvironment,
} from '@/test/helpers'
import type * as OrdersService from '@/lib/services/orders'

vi.mock('@/lib/services/orders', async (importOriginal) => ({
  ...(await importOriginal<typeof OrdersService>()),
  provisionOrderElements: vi.fn(),
}))
import { provisionOrderElements } from '@/lib/services/orders'

/**
 * Root deploying a scheduled order early (#330).
 *
 * Root, not admin. Approving decides that an order should happen; this decides
 * it should happen NOW, outside the hours the company said it watches its own
 * systems — which is the guarantee the feature exists to make.
 */
const makeReq = (auth?: string, body?: unknown) =>
  new NextRequest('http://localhost/api/orders/1/deploy-now', {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(auth ? { authorization: auth } : {}) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  })

const params = (id: number | string) => ({ params: Promise.resolve({ id: String(id) }) })

const scheduled = async () => {
  const user = await createUser({ email: `dn-${Math.random()}@test.dev` })
  const category = await createCategory()
  const product = await createProduct(category.id)
  const ci = await createCiSource()
  const environment = await createEnvironment(ci.id)
  const project = await createProject(user.id)
  const order = await createOrder(project.id, product.id, environment.id, user.id, { status: 'pending' })
  await db
    .update(orders)
    .set({ status: 'scheduled', scheduledFor: new Date('2026-09-03T06:00:00Z') })
    .where(eq(orders.id, order.id))
  return order
}

beforeEach(() => {
  vi.mocked(provisionOrderElements).mockReset()
  vi.mocked(provisionOrderElements).mockResolvedValue({ elementIds: [1], pipelineIds: ['p1'], failures: [] } as never)
  vi.spyOn(console, 'error').mockImplementation(() => {})
})

describe('POST /api/orders/[id]/deploy-now', () => {
  it('refuses an anonymous caller', async () => {
    const order = await scheduled()
    expect((await POST(makeReq(), params(order.id))).status).toBe(401)
  })

  // The point of the route: an admin can approve, only root can skip the window.
  it.each(['admin', 'project_manager'] as const)('refuses %s', async (role) => {
    const order = await scheduled()
    const auth = await makeAuthHeader(await createUser({ role, email: `dn-${role}-${Math.random()}@test.dev` }))

    expect((await POST(makeReq(auth), params(order.id))).status).toBe(403)
    expect((await db.select().from(orders).where(eq(orders.id, order.id)))[0].status).toBe('scheduled')
  })

  it('lets root deploy it now', async () => {
    const order = await scheduled()
    const root = await createUser({ role: 'root', email: `dn-root-${Math.random()}@test.dev` })

    const res = await POST(makeReq(await makeAuthHeader(root)), params(order.id))

    expect(res.status).toBe(200)
    const [row] = await db.select().from(orders).where(eq(orders.id, order.id))
    expect(row.status).toBe('provisioning')
    expect(row.windowOverrideBy).toBe(root.id)
  })

  it('is a 400 for an order that is not scheduled', async () => {
    const order = await scheduled()
    // `scheduled_for` has to go with it: `orders_scheduled_consistency` refuses
    // a pending order that still carries a release time, which is the point of
    // the constraint — this state cannot be constructed by accident either.
    await db
      .update(orders)
      .set({ status: 'pending', scheduledFor: null })
      .where(eq(orders.id, order.id))
    const root = await createUser({ role: 'root', email: `dn-root-${Math.random()}@test.dev` })

    const res = await POST(makeReq(await makeAuthHeader(root)), params(order.id))

    expect(res.status).toBe(400)
    expect((await res.json()).error).toContain('pending')
  })

  it('is a 404 for an order that does not exist', async () => {
    const root = await createUser({ role: 'root', email: `dn-root-${Math.random()}@test.dev` })
    expect((await POST(makeReq(await makeAuthHeader(root)), params(999_999))).status).toBe(404)
  })

  it('refuses an id that is not a number', async () => {
    const root = await createUser({ role: 'root', email: `dn-root-${Math.random()}@test.dev` })
    expect((await POST(makeReq(await makeAuthHeader(root)), params('not-an-id'))).status).toBe(400)
  })

  it('reports a provisioning failure as a 502 and puts the order back', async () => {
    const order = await scheduled()
    const root = await createUser({ role: 'root', email: `dn-root-${Math.random()}@test.dev` })
    vi.mocked(provisionOrderElements).mockRejectedValue(new Error('CI unreachable'))

    const res = await POST(makeReq(await makeAuthHeader(root)), params(order.id))

    expect(res.status).toBe(502)
    expect((await db.select().from(orders).where(eq(orders.id, order.id)))[0].status).toBe('scheduled')
  })

  /*
   * The budget refusal here, and root's escape from it (#514).
   *
   * The same gates run before the claim on this path as at an approval, so root
   * met the same dead end: a spent `block` ceiling refuses the deploy, and the
   * button that could act on it could not act. The escape is read from the body
   * because this route is root-only; the flag asks, the session decides.
   */
  const overspent = async () => {
    const user = await createUser({ email: `dn-cc-${Math.random()}@test.dev` })
    const category = await createCategory()
    const product = await createProduct(category.id)
    const ci = await createCiSource()
    const environment = await createEnvironment(ci.id)
    const project = await createProject(user.id)
    await linkProductEnvironment(product.id, environment.id, { price: '400.00', currency: 'EUR' })
    const centre = await createCostCenter()
    await db
      .update(costCenters)
      .set({
        budgetAmount: '100.00',
        budgetCurrency: 'EUR',
        budgetPeriod: 'total',
        budgetBehaviour: 'block',
      })
      .where(eq(costCenters.id, centre.id))
    await db.update(projects).set({ costCenterId: centre.id }).where(eq(projects.id, project.id))
    const order = await createOrder(project.id, product.id, environment.id, user.id, {
      status: 'pending',
    })
    await db
      .update(orders)
      .set({ status: 'scheduled', scheduledFor: new Date('2026-09-03T06:00:00Z') })
      .where(eq(orders.id, order.id))
    return order
  }

  it('refuses the deploy when the budget no longer covers it, in a code', async () => {
    const order = await overspent()
    const root = await createUser({ role: 'root', email: `dn-root-${Math.random()}@test.dev` })

    const res = await POST(makeReq(await makeAuthHeader(root)), params(order.id))

    expect(res.status).toBe(409)
    expect((await res.json()).code).toBe('budget_blocked')
    expect((await db.select().from(orders).where(eq(orders.id, order.id)))[0].status).toBe('scheduled')
  })

  it('lets root deploy past the spent budget when the body asks for the waiver', async () => {
    const order = await overspent()
    const root = await createUser({ role: 'root', email: `dn-root-${Math.random()}@test.dev` })

    const res = await POST(
      makeReq(await makeAuthHeader(root), { overrideBudget: true }),
      params(order.id),
    )

    expect(res.status).toBe(200)
    expect((await db.select().from(orders).where(eq(orders.id, order.id)))[0].status).not.toBe('scheduled')
  })

  it('treats a body that merely mentions the waiver as no waiver at all', async () => {
    // Truthy, but not `true`: the flag is a decision the client states, not a
    // value the server coerces.
    const order = await overspent()
    const root = await createUser({ role: 'root', email: `dn-root-${Math.random()}@test.dev` })

    const res = await POST(
      makeReq(await makeAuthHeader(root), { overrideBudget: 'yes' }),
      params(order.id),
    )

    expect(res.status).toBe(409)
  })
})
