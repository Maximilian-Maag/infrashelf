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
   * Root's escapes at this moment (#519).
   *
   * The refusal that a deploy-early can hit here is the same one an approval hits a
   * day later, and until #519 it was the only one of the three paths with no way
   * past it — on the path where the operator is mid-incident with an order that is
   * approved, waiting for a window, and wanted now.
   */
  describe('the escapes from a refusal (#519)', () => {
    /** A scheduled order whose ceiling was lowered under it while it waited. */
    const overspent = async () => {
      const user = await createUser({ email: `dn-over-${Math.random()}@test.dev` })
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
          budgetAmount: '500.00', budgetCurrency: 'EUR', budgetPeriod: 'total', budgetBehaviour: 'block',
        })
        .where(eq(costCenters.id, centre.id))
      await db.update(projects).set({ costCenterId: centre.id }).where(eq(projects.id, project.id))
      const order = await createOrder(project.id, product.id, environment.id, user.id, { status: 'pending' })
      await db
        .update(orders)
        .set({ status: 'scheduled', scheduledFor: new Date('2026-09-03T06:00:00Z') })
        .where(eq(orders.id, order.id))
      await db.update(costCenters).set({ budgetAmount: '100.00' }).where(eq(costCenters.id, centre.id))
      return order
    }

    it('refuses it with a code, so the control can offer the escape it names', async () => {
      const order = await overspent()
      const root = await createUser({ role: 'root', email: `dn-root-${Math.random()}@test.dev` })

      const res = await POST(makeReq(await makeAuthHeader(root)), params(order.id))

      expect(res.status).toBe(409)
      const body = await res.json()
      expect(body.code).toBe('budget_blocked')
      expect(body.error).toMatch(/over budget/i)
    })

    it('carries the waiver off the body, so a root who asked for it gets the deployment', async () => {
      const order = await overspent()
      const root = await createUser({ role: 'root', email: `dn-root-${Math.random()}@test.dev` })

      const res = await POST(
        makeReq(await makeAuthHeader(root), { overrideBudget: true }),
        params(order.id),
      )

      expect(res.status).toBe(200)
      const [row] = await db.select().from(orders).where(eq(orders.id, order.id))
      expect(row.status).toBe('provisioning')
      expect(row.windowOverrideBy).toBe(root.id)
    })

    it('takes `true` and nothing else as the waiver', async () => {
      // The body is caller-supplied: a string, a 1, a truthy object — none of them
      // is an instruction to step over a ceiling.
      const order = await overspent()
      const root = await createUser({ role: 'root', email: `dn-root-${Math.random()}@test.dev` })

      const res = await POST(
        makeReq(await makeAuthHeader(root), { overrideBudget: 'yes' }),
        params(order.id),
      )

      expect(res.status).toBe(409)
      expect((await db.select().from(orders).where(eq(orders.id, order.id)))[0].status).toBe('scheduled')
    })

    it('does not read the flag as a substitute for the role', async () => {
      // An admin cannot deploy early at all, and no body changes that.
      const order = await overspent()
      const admin = await createUser({ role: 'admin', email: `dn-admin-${Math.random()}@test.dev` })

      const res = await POST(
        makeReq(await makeAuthHeader(admin), { overrideBudget: true, overridePolicy: true }),
        params(order.id),
      )

      expect(res.status).toBe(403)
      expect((await db.select().from(orders).where(eq(orders.id, order.id)))[0].status).toBe('scheduled')
    })
  })
})
