import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import type { SessionUser } from '@infrashelf/types'

vi.mock('@/lib/notification', () => ({
  sendOrderCreated: vi.fn().mockResolvedValue(undefined),
  sendApprovalRequest: vi.fn().mockResolvedValue(undefined),
}))

vi.mock('@/lib/ci/webhooks', () => ({
  triggerProductWebhooksTracked: vi.fn().mockResolvedValue({ pipelineIds: ['pipe-1'], failures: [] }),
  triggerPipelineStacksTracked: vi.fn().mockResolvedValue({ pipelineIds: [], failures: [] }),
}))

import { listOrders, getOrderById, createOrder, markOrderFailed, STUCK_ORDER_SILENCE_MS } from './orders'
import { createIntegration } from '@/lib/services/admin/integrations'
import { sendOrderCreated, sendApprovalRequest } from '@/lib/notification'
import { triggerProductWebhooksTracked, triggerPipelineStacksTracked } from '@/lib/ci/webhooks'
import { db } from '@/lib/db/client'
import { orders, infrastructureElements, parameters, productEnvironments, products, auditLog, costCenters, projects } from '@/lib/db/schema'
import { STATE_KEY_NAMESPACE_VAR, stateKeyNamespaceFor } from '@/lib/ci/stateKey'
import { LIST_MAX_LIMIT } from '@/lib/services/page'
import { eq, desc } from 'drizzle-orm'
import {
  createUser,
  createCategory,
  createProduct,
  createCiSource,
  createEnvironment,
  createProject,
  linkProductEnvironment,
  createSize,
  createOrder as seedOrder,
  createInfraElement,
  createCostCenter,
  createDelegation as seedDelegation,
} from '@/test/helpers'

const makeSession = (u: { id: number; email: string; name: string; role: string }): SessionUser =>
  ({ id: u.id, email: u.email, name: u.name, role: u.role as SessionUser['role'] })

const mockedTriggerWebhooks = vi.mocked(triggerProductWebhooksTracked)
const mockedTriggerStacks = vi.mocked(triggerPipelineStacksTracked)
const mockedSendOrderCreated = vi.mocked(sendOrderCreated)
const mockedSendApprovalRequest = vi.mocked(sendApprovalRequest)

beforeEach(() => {
  mockedTriggerWebhooks.mockReset().mockResolvedValue({ pipelineIds: ['pipe-1'], failures: [] })
  mockedTriggerStacks.mockReset().mockResolvedValue({ pipelineIds: [], failures: [] })
  mockedSendOrderCreated.mockReset().mockResolvedValue(undefined)
  mockedSendApprovalRequest.mockReset().mockResolvedValue(undefined)
})

const buildBase = async () => {
  const admin = await createUser({ role: 'admin', email: 'admin@test.dev', name: 'Admin' })
  const pm = await createUser({ role: 'project_manager', email: 'pm@test.dev', name: 'PM' })
  const cat = await createCategory()
  const product = await createProduct(cat.id, 'Product A')
  const ci = await createCiSource()
  const env = await createEnvironment(ci.id)
  await linkProductEnvironment(product.id, env.id)
  const project = await createProject(pm.id)
  return { admin, pm, cat, product, ci, env, project }
}

/**
 * The approver's budget notice on the pending list (#325).
 *
 * The approvals screen reads `/api/orders?status=pending`, not `/api/approvals`,
 * so this is the path that actually reaches a human. Both are covered, because
 * a notice that shows up depending on which endpoint the page happens to call
 * is not a notice.
 */
describe('listOrders — budget on the approvals queue', () => {
  const scene = async (over?: { amount?: string; behaviour?: 'warn' | 'block' }) => {
    const base = await buildBase()
    await db.update(productEnvironments)
      .set({ price: '600.00', currency: 'EUR' })
      .where(eq(productEnvironments.productId, base.product.id))
    const centre = await createCostCenter()
    await db.update(costCenters).set({
      budgetAmount: over?.amount ?? '500.00',
      budgetCurrency: 'EUR',
      budgetPeriod: 'total',
      budgetBehaviour: over?.behaviour ?? 'block',
    }).where(eq(costCenters.id, centre.id))
    await db.update(projects).set({ costCenterId: centre.id }).where(eq(projects.id, base.project.id))
    await seedOrder(base.project.id, base.product.id, base.env.id, base.pm.id, { status: 'pending' })
    return { ...base, centre }
  }

  it('gives an admin the budget of the order\'s cost centre', async () => {
    const base = await scene()
    const result = await listOrders(makeSession(base.admin), 'en', { status: 'pending' })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.data.items[0].budget?.amount).toBe(500)
    expect(result.data.items[0].budget?.committed).toBe(600)
    expect(result.data.items[0].budget?.exhausted).toBe(true)
  })

  it("follows the project's cost centre, not orders.cost_center_id alone", async () => {
    // The default 'project' mode stores no centre on the order, so a lookup that
    // read only `orders.cost_center_id` would report no budget for most of the
    // queue — the trap costs.ts documents.
    const base = await scene()
    const result = await listOrders(makeSession(base.admin), 'en', { status: 'pending' })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.data.items[0].costCenterId).toBeNull()
    expect(result.data.items[0].budget?.costCenterLabel).toContain(base.centre.code)
  })

  it('does not give a project manager the budget of their own pending order', async () => {
    // A budget is a root-level figure. The approver needs it to decide; the
    // person who placed the order has no business reading the cost centre's
    // remaining spend off their own orders page.
    const base = await scene()
    const result = await listOrders(makeSession(base.pm), 'en', { status: 'pending' })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.data.items[0].budget).toBeUndefined()
  })

  it('does not attach a budget to a list that is not the approvals queue', async () => {
    // The lookup aggregates committed spend per cost centre. Every other list
    // would pay for it and no reader would use it.
    const base = await scene()
    const result = await listOrders(makeSession(base.admin), 'en', {})
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.data.items[0].budget).toBeUndefined()
  })

  it('never leaks the project cost centre it looked up', async () => {
    // It is a lookup input, not part of the contract — shipping it would invite
    // a client to read it instead of `budget`.
    const base = await scene()
    for (const [session, filters] of [
      [base.admin, { status: 'pending' as const }],
      [base.pm, {}],
    ] as const) {
      const result = await listOrders(makeSession(session), 'en', filters)
      expect(result.ok).toBe(true)
      if (!result.ok) return
      expect(result.data.items[0]).not.toHaveProperty('projectCostCenterId')
    }
  })

  it('leaves the budget null when the cost centre has no limit', async () => {
    const base = await buildBase()
    const centre = await createCostCenter()
    await db.update(projects).set({ costCenterId: centre.id }).where(eq(projects.id, base.project.id))
    await seedOrder(base.project.id, base.product.id, base.env.id, base.pm.id, { status: 'pending' })

    const result = await listOrders(makeSession(base.admin), 'en', { status: 'pending' })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.data.items[0].budget).toBeNull()
  })
})

describe('listOrders', () => {
  /*
   * #158. This list used to return every order the caller could see, and the
   * row is not small — `parameters` and `productSnapshot` are both jsonb, and a
   * snapshot carrying ten parameter definitions is around 1.5 KB. For an
   * administrator of a busy installation that was tens of megabytes assembled
   * whole in Node, on the page people land on after login.
   */
  describe('pages instead of returning everything (#158)', () => {
    const seedMany = async (count: number) => {
      const base = await buildBase()
      for (let i = 0; i < count; i++) {
        await seedOrder(base.project.id, base.product.id, base.env.id, base.pm.id)
      }
      return base
    }

    it('returns one window and says how many rows there are behind it', async () => {
      const { admin } = await seedMany(5)

      const result = await listOrders(makeSession(admin), 'en', { limit: 2 })
      expect(result.ok).toBe(true)
      if (!result.ok) return

      expect(result.data.items).toHaveLength(2)
      // The count is of MATCHES, not of the window — it is what "page 1 of 3"
      // is computed from, so counting the rows in hand would say one page.
      expect(result.data.total).toBe(5)
      expect(result.data.limit).toBe(2)
      expect(result.data.offset).toBe(0)
    })

    it('walks the whole list across pages without repeating or skipping a row', async () => {
      const { admin } = await seedMany(5)

      const seen: number[] = []
      for (let offset = 0; offset < 5; offset += 2) {
        const page = await listOrders(makeSession(admin), 'en', { limit: 2, offset })
        if (page.ok) seen.push(...page.data.items.map((o) => o.id))
      }

      // The reason the sort is tie-broken on id: `created_at` is not unique, and
      // seeded orders land in the same millisecond. Without the tie-break
      // Postgres may order two equal keys differently between two queries, and
      // then a row appears on both page 1 and page 2 while another appears on
      // neither.
      expect(seen).toHaveLength(5)
      expect(new Set(seen).size).toBe(5)
    })

    it('caps a limit that would put the unbounded read straight back', async () => {
      const { admin } = await seedMany(2)

      const result = await listOrders(makeSession(admin), 'en', { limit: 1_000_000 })
      expect(result.ok).toBe(true)
      if (result.ok) expect(result.data.limit).toBe(LIST_MAX_LIMIT)
    })

    it('counts only what the caller may see', async () => {
      const { pm, product, env, project } = await buildBase()
      const otherPm = await createUser({ role: 'project_manager', email: 'other@test.dev' })
      const otherProject = await createProject(otherPm.id)
      await seedOrder(project.id, product.id, env.id, pm.id)
      await seedOrder(otherProject.id, product.id, env.id, otherPm.id)

      const result = await listOrders(makeSession(pm), 'en', { limit: 1 })
      expect(result.ok).toBe(true)
      // Not 2. A total that ignored the visibility scope would tell a project
      // manager how many orders exist in projects they cannot see.
      if (result.ok) expect(result.data.total).toBe(1)
    })
  })

  /*
   * `/projects/7` has always fetched `/api/orders?projectId=7`, and the route
   * has never read a query string — so the card headed "Orders in this project"
   * listed every order the viewer could see. For an administrator that is the
   * whole installation, each row linking off into somebody else's project. A
   * filter nobody applies is indistinguishable from one that matched everything
   * (#158).
   */
  describe('filters in SQL rather than in the caller (#158)', () => {
    it('narrows to one project', async () => {
      const { admin, pm, product, env, project } = await buildBase()
      const otherProject = await createProject(pm.id)
      await seedOrder(project.id, product.id, env.id, pm.id)
      await seedOrder(otherProject.id, product.id, env.id, pm.id)

      const result = await listOrders(makeSession(admin), 'en', { projectId: project.id })
      expect(result.ok).toBe(true)
      if (!result.ok) return

      expect(result.data.items).toHaveLength(1)
      expect(result.data.items[0].projectId).toBe(project.id)
      // Counted under the filter too, or "page 1 of 40" on a one-page list.
      expect(result.data.total).toBe(1)
    })

    it('narrows to one status, which is what the approvals page needs', async () => {
      const { admin, pm, product, env, project } = await buildBase()
      const pending = await seedOrder(project.id, product.id, env.id, pm.id)
      const done = await seedOrder(project.id, product.id, env.id, pm.id)
      await db.update(orders).set({ status: 'completed' }).where(eq(orders.id, done.id))

      const result = await listOrders(makeSession(admin), 'en', { status: 'pending' })
      expect(result.ok).toBe(true)
      if (!result.ok) return

      expect(result.data.items.map((o) => o.id)).toEqual([pending.id])
      expect(result.data.total).toBe(1)
    })

    /*
     * A filter must narrow what the caller may see, never widen it. Passing
     * another manager's project id has to come back empty rather than granting
     * a look at it.
     */
    it('cannot be used to reach past the caller\'s own scope', async () => {
      const { pm, product, env } = await buildBase()
      const otherPm = await createUser({ role: 'project_manager', email: 'other@test.dev' })
      const otherProject = await createProject(otherPm.id)
      await seedOrder(otherProject.id, product.id, env.id, otherPm.id)

      const result = await listOrders(makeSession(pm), 'en', { projectId: otherProject.id })
      expect(result.ok).toBe(true)
      if (result.ok) {
        expect(result.data.items).toEqual([])
        expect(result.data.total).toBe(0)
      }
    })
  })

  it('admin sees orders from all users', async () => {
    const { admin, pm, product, env, project } = await buildBase()
    const otherPm = await createUser({ role: 'project_manager', email: 'other@test.dev' })
    const otherProject = await createProject(otherPm.id)

    await seedOrder(project.id, product.id, env.id, pm.id)
    await seedOrder(otherProject.id, product.id, env.id, otherPm.id)

    const result = await listOrders(makeSession(admin))
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.data.items.length).toBe(2)
    }
  })

  it('project manager sees only their own orders', async () => {
    const { pm, product, env, project } = await buildBase()
    const otherPm = await createUser({ role: 'project_manager', email: 'other@test.dev' })
    const otherProject = await createProject(otherPm.id)

    await seedOrder(project.id, product.id, env.id, pm.id)
    await seedOrder(otherProject.id, product.id, env.id, otherPm.id)

    const result = await listOrders(makeSession(pm))
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.data.items.length).toBe(1)
      expect(result.data.items[0].userId).toBe(pm.id)
    }
  })

  it('returns joined productName, environmentName, userName fields', async () => {
    const { pm, product, env, project } = await buildBase()
    await seedOrder(project.id, product.id, env.id, pm.id)

    const result = await listOrders(makeSession(pm))
    expect(result.ok).toBe(true)
    if (result.ok) {
      const row = result.data.items[0]
      expect(row.productName).toBe('Product A')
      expect(row.environmentName).toBe('Test Env')
      expect(row.userName).toBe('PM')
    }
  })
})

describe('getOrderById', () => {
  it('returns the order when found and admin calls', async () => {
    const { admin, pm, product, env, project } = await buildBase()
    const order = await seedOrder(project.id, product.id, env.id, pm.id)

    const result = await getOrderById(makeSession(admin), order.id)
    expect(result.ok).toBe(true)
    if (result.ok) expect(result.data.id).toBe(order.id)
  })

  it('returns the order when PM is the owner', async () => {
    const { pm, product, env, project } = await buildBase()
    const order = await seedOrder(project.id, product.id, env.id, pm.id)

    const result = await getOrderById(makeSession(pm), order.id)
    expect(result.ok).toBe(true)
    if (result.ok) expect(result.data.id).toBe(order.id)
  })

  it('returns 403 when PM tries to access another user\'s order', async () => {
    const { pm, product, env, project } = await buildBase()
    const otherPm = await createUser({ role: 'project_manager', email: 'other@test.dev' })
    const order = await seedOrder(project.id, product.id, env.id, pm.id)

    const result = await getOrderById(makeSession(otherPm), order.id)
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.status).toBe(403)
  })

  it('returns 404 for a non-existent order', async () => {
    const { admin } = await buildBase()
    const result = await getOrderById(makeSession(admin), 999_999)
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.status).toBe(404)
  })

  // The webhook handler has written `orders.pipeline_status` since #133 and this
  // projection never selected it, so the order detail page listed pipeline ids
  // with nothing beside them — a run that looks like it never reported.
  it('returns the per-pipeline status the webhook handler recorded', async () => {
    const { admin, pm, product, env, project } = await buildBase()
    const order = await seedOrder(project.id, product.id, env.id, pm.id, {
      pipelineId: ['pipe-a', 'pipe-b'],
    })
    await db
      .update(orders)
      .set({ pipelineStatus: { 'pipe-a': 'success', 'pipe-b': 'failed' } })
      .where(eq(orders.id, order.id))

    const result = await getOrderById(makeSession(admin), order.id)
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.data.pipelineStatus).toEqual({ 'pipe-a': 'success', 'pipe-b': 'failed' })
    }
  })

  it('reports an empty status map rather than undefined for an order with no pipelines', async () => {
    // The page renders "pending" per id from an absent key; an undefined map
    // would make that a crash instead.
    const { admin, pm, product, env, project } = await buildBase()
    const order = await seedOrder(project.id, product.id, env.id, pm.id)

    const result = await getOrderById(makeSession(admin), order.id)
    expect(result.ok).toBe(true)
    if (result.ok) expect(result.data.pipelineStatus).toEqual({})
  })

  // Terraform outputs live on the ELEMENT, and the order had no route to them:
  // you had to know to go to Infrastructure and find the right row.
  it('returns the order\'s elements, with their Terraform outputs', async () => {
    const { admin, pm, product, env, project } = await buildBase()
    const order = await seedOrder(project.id, product.id, env.id, pm.id, { quantity: 2 })
    await createInfraElement(order.id, project.id, env.id, product.id, {
      sequence: 1,
      outputs: { endpoint: 'https://vm-1.example.com', ip: '10.0.0.1' },
    })
    await createInfraElement(order.id, project.id, env.id, product.id, {
      sequence: 2,
      outputs: { endpoint: 'https://vm-2.example.com' },
    })

    const result = await getOrderById(makeSession(admin), order.id)
    expect(result.ok).toBe(true)
    if (!result.ok) return

    // In sequence order, because "the order's second element" has to mean the
    // same thing here as it does everywhere else.
    expect(result.data.elements?.map((e) => e.sequence)).toEqual([1, 2])
    expect(result.data.elements?.[0].outputs).toEqual({
      endpoint: 'https://vm-1.example.com',
      ip: '10.0.0.1',
    })
    expect(result.data.elements?.[1].outputs).toEqual({ endpoint: 'https://vm-2.example.com' })
  })

  it('returns an empty element list for an order that has provisioned nothing', async () => {
    const { admin, pm, product, env, project } = await buildBase()
    const order = await seedOrder(project.id, product.id, env.id, pm.id)

    const result = await getOrderById(makeSession(admin), order.id)
    expect(result.ok).toBe(true)
    if (result.ok) expect(result.data.elements).toEqual([])
  })

  it('does not carry elements on the list endpoint', async () => {
    // One query per row for something the list does not render. If this ever
    // needs them, it needs a join, not N+1.
    const { admin, pm, product, env, project } = await buildBase()
    const order = await seedOrder(project.id, product.id, env.id, pm.id)
    await createInfraElement(order.id, project.id, env.id, product.id, {
      outputs: { endpoint: 'https://vm.example.com' },
    })

    const result = await listOrders(makeSession(admin))
    expect(result.ok).toBe(true)
    if (result.ok) expect(result.data.items.find((o) => o.id === order.id)?.elements).toBeUndefined()
  })

  it('still gives a project manager their own order, elements and all', async () => {
    const { pm, product, env, project } = await buildBase()
    const order = await seedOrder(project.id, product.id, env.id, pm.id)
    await createInfraElement(order.id, project.id, env.id, product.id, {
      outputs: { endpoint: 'https://vm.example.com' },
    })

    const result = await getOrderById(makeSession(pm), order.id)
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.data.elements?.[0].outputs).toEqual({ endpoint: 'https://vm.example.com' })
    }
  })
})

describe('createOrder (admin path)', () => {
  it('creates order with status provisioning, triggers webhooks with ORDER_ID, creates infra, notifies, returns infraId', async () => {
    const { admin, product, env, project } = await buildBase()
    mockedTriggerWebhooks.mockResolvedValueOnce({ pipelineIds: ['pipe-admin-1'], failures: [] })
    await db.insert(parameters).values({
      scope: 'product',
      scopeId: product.id,
      name: 'FOO',
      type: 'string',
      required: false,
    })

    const input = {
      projectId: project.id,
      productId: product.id,
      environmentId: env.id,
      parameters: { FOO: 'bar' },
    }

    const result = await createOrder(makeSession(admin), input)
    expect(result.ok).toBe(true)
    if (!result.ok) return

    expect(result.data.status).toBe('provisioning')
    expect(result.data.infraId).toBeDefined()

    // Verify in DB
    const [dbOrder] = await db.select().from(orders).where(eq(orders.id, result.data.id))
    expect(dbOrder.status).toBe('provisioning')
    expect(dbOrder.pipelineId).toEqual(['pipe-admin-1'])

    const infraRows = await db
      .select()
      .from(infrastructureElements)
      .where(eq(infrastructureElements.orderId, result.data.id))
    expect(infraRows.length).toBe(1)
    expect(infraRows[0].id).toBe(result.data.infraId)

    expect(mockedTriggerWebhooks).toHaveBeenCalledTimes(1)
    const [pid, eid, vars] = mockedTriggerWebhooks.mock.calls[0]
    expect(pid).toBe(product.id)
    expect(eid).toBe(env.id)
    expect(vars).toMatchObject({ FOO: 'bar', ORDER_ID: String(result.data.id) })

    expect(mockedSendOrderCreated).toHaveBeenCalledTimes(1)
    expect(mockedSendOrderCreated.mock.calls[0][0]).toBe('admin@test.dev')

    // No approval request for admin path
    expect(mockedSendApprovalRequest).not.toHaveBeenCalled()
  })
})

describe('createOrder (PM path)', () => {
  it('creates order with status pending, notifies orderer, notifies each active admin, does NOT trigger webhooks', async () => {
    const { admin, pm, product, env, project } = await buildBase()
    // Add another admin and an inactive admin
    const admin2 = await createUser({ role: 'admin', email: 'admin2@test.dev' })
    await createUser({ role: 'admin', email: 'inactive@test.dev', active: false })
    await db.insert(parameters).values({
      scope: 'product',
      scopeId: product.id,
      name: 'FOO',
      type: 'string',
      required: false,
    })

    const input = {
      projectId: project.id,
      productId: product.id,
      environmentId: env.id,
      parameters: { FOO: 'bar' },
    }

    const result = await createOrder(makeSession(pm), input)
    expect(result.ok).toBe(true)
    if (!result.ok) return

    expect(result.data.status).toBe('pending')
    // No infraId on PM path
    expect((result.data as { infraId?: number }).infraId).toBeUndefined()

    // No webhook triggered
    expect(mockedTriggerWebhooks).not.toHaveBeenCalled()

    // Orderer notified
    expect(mockedSendOrderCreated).toHaveBeenCalledTimes(1)
    expect(mockedSendOrderCreated.mock.calls[0][0]).toBe('pm@test.dev')

    // Two active admins notified (admin + admin2); inactive excluded
    expect(mockedSendApprovalRequest).toHaveBeenCalledTimes(2)
    const notifiedAdmins = mockedSendApprovalRequest.mock.calls.map((c) => c[0]).sort()
    expect(notifiedAdmins).toEqual([admin.email, admin2.email].sort())

    // Order persisted with correct fields
    const [dbOrder] = await db.select().from(orders).where(eq(orders.id, result.data.id))
    expect(dbOrder.status).toBe('pending')
    expect(dbOrder.userId).toBe(pm.id)
    expect(dbOrder.parameters).toEqual({ FOO: 'bar' })

    // No infra created for PM path
    const infra = await db
      .select()
      .from(infrastructureElements)
      .where(eq(infrastructureElements.orderId, result.data.id))
    expect(infra.length).toBe(0)
  })
})

describe('createOrder — validation & ownership', () => {
  it('rejects a missing required parameter with 400', async () => {
    const { admin, cat, product, env, project } = await buildBase()
    await db.insert(parameters).values({
      scope: 'product',
      scopeId: product.id,
      name: 'HOSTNAME',
      type: 'string',
      required: true,
    })

    const result = await createOrder(makeSession(admin), {
      projectId: project.id,
      productId: product.id,
      environmentId: env.id,
      parameters: {},
    })

    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.status).toBe(400)
      expect(result.message).toMatch(/HOSTNAME/)
    }
    void cat
  })

  it('rejects an empty string for a required parameter with 400', async () => {
    const { admin, product, env, project } = await buildBase()
    await db.insert(parameters).values({
      scope: 'product',
      scopeId: product.id,
      name: 'HOSTNAME',
      type: 'string',
      required: true,
    })

    const result = await createOrder(makeSession(admin), {
      projectId: project.id,
      productId: product.id,
      environmentId: env.id,
      parameters: { HOSTNAME: '   ' },
    })

    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.status).toBe(400)
  })

  it('rejects a non-numeric value for a number parameter with 400', async () => {
    const { admin, product, env, project } = await buildBase()
    await db.insert(parameters).values({
      scope: 'product',
      scopeId: product.id,
      name: 'SIZE',
      type: 'number',
      required: false,
    })

    const result = await createOrder(makeSession(admin), {
      projectId: project.id,
      productId: product.id,
      environmentId: env.id,
      parameters: { SIZE: 'not-a-number' },
    })

    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.status).toBe(400)
  })

  it('rejects a non-bool value for a bool parameter with 400', async () => {
    const { admin, product, env, project } = await buildBase()
    await db.insert(parameters).values({
      scope: 'product',
      scopeId: product.id,
      name: 'ENABLED',
      type: 'bool',
      required: false,
    })

    const result = await createOrder(makeSession(admin), {
      projectId: project.id,
      productId: product.id,
      environmentId: env.id,
      parameters: { ENABLED: 'yes' },
    })

    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.status).toBe(400)
  })

  it('applies the default for an omitted optional parameter and drops unknown submitted keys', async () => {
    const { admin, product, env, project } = await buildBase()
    await db.insert(parameters).values({
      scope: 'product',
      scopeId: product.id,
      name: 'REGION',
      type: 'string',
      required: false,
      defaultValue: 'eu-west',
    })

    const result = await createOrder(makeSession(admin), {
      projectId: project.id,
      productId: product.id,
      environmentId: env.id,
      // FOO has no parameter definition — it must be dropped, not persisted.
      parameters: { FOO: 'bar' },
    })

    expect(result.ok).toBe(true)
    if (!result.ok) return
    const [dbOrder] = await db.select().from(orders).where(eq(orders.id, result.data.id))
    expect(dbOrder.parameters).toEqual({ REGION: 'eu-west' })
    expect(dbOrder.parameters).not.toHaveProperty('FOO')
  })

  it('places an order for a REQUIRED sensitive parameter that has a stored default', async () => {
    const { admin, product, env, project } = await buildBase()
    await db.insert(parameters).values({
      scope: 'product',
      scopeId: product.id,
      name: 'API_KEY',
      type: 'string',
      required: true,
      sensitive: true,
      defaultValue: 'the-real-secret',
    })

    // The form is never shown this value, so it can only send back the sentinel
    // or nothing. Checking `required` before applying the default made such a
    // product impossible to order: the server had the value and refused to use it.
    const submissions: Record<string, string>[] = [{}, { API_KEY: '[redacted]' }]
    for (const submitted of submissions) {
      const result = await createOrder(makeSession(admin), {
        projectId: project.id,
        productId: product.id,
        environmentId: env.id,
        parameters: submitted,
      })

      expect(result.ok).toBe(true)
      if (!result.ok) return
      const [dbOrder] = await db.select().from(orders).where(eq(orders.id, result.data.id))
      expect(dbOrder.parameters).toEqual({ API_KEY: 'the-real-secret' })
    }
  })

  /*
   * A product is provisioned by a webhook or a pipeline stack, per environment.
   * With neither, `provisionOrderElements` starts nothing, notices, deletes the
   * element rows it just wrote and answers 502 "Could not start the deployment"
   * — which reads as "CI is down" when the truth is "nobody configured a
   * pipeline". An imported Kubernetes product was found in exactly that state:
   * catalogued, parameters imported, a full order form, and a 502 at the till.
   */
  it('refuses a product with nothing to provision it, before the order exists', async () => {
    const admin = await createUser({ role: 'admin', email: 'nodeploy@test.dev' })
    const pm = await createUser({ role: 'project_manager', email: 'nodeploy-pm@test.dev' })
    const cat = await createCategory()
    const product = await createProduct(cat.id, 'Undeployable')
    const ci = await createCiSource()
    const env = await createEnvironment(ci.id)
    // Offered, but with no webhook and no pipeline stack.
    await linkProductEnvironment(product.id, env.id, { deployable: false })
    const project = await createProject(pm.id)

    const result = await createOrder(makeSession(admin), {
      projectId: project.id,
      productId: product.id,
      environmentId: env.id,
      parameters: {},
    })

    expect(result.ok).toBe(false)
    if (result.ok) return
    // 409 and not 502: nothing failed, the product is not set up.
    expect(result.status).toBe(409)
    expect(result.message).toMatch(/no pipeline configured/i)
    // It says who has to fix it and what they have to add.
    expect(result.message).toMatch(/administrator/i)
    expect(result.message).toMatch(/pipeline stack or a webhook/i)

    // And no order row was written, so there is nothing to roll back.
    expect(await db.select().from(orders).where(eq(orders.productId, product.id))).toEqual([])
  })

  /*
   * A T-shirt size is a variable TYPE, alongside string / number / bool /
   * dropdown. `instance_type` is one of these: the customer never types it, the
   * size they picked decides it.
   *
   * Before this, a size was a code, a label and a price. It reached the pipeline
   * as SIZE=M, which the CI base promoted to TF_VAR_size — and no template in
   * the reference repository declares `variable "size"`, so OpenTofu dropped it.
   * Choosing XL changed the price and nothing about the machine.
   */
  describe('a size-typed parameter', () => {
    const withSizes = async () => {
      const base = await buildBase()
      await createSize(base.product.id, base.env.id, { code: 'S', price: '10.00' })
      await createSize(base.product.id, base.env.id, { code: 'XL', price: '80.00' })
      return base
    }

    it('takes its value from the chosen size', async () => {
      const { admin, product, env, project } = await withSizes()
      await db.insert(parameters).values({
        scope: 'product', scopeId: product.id, name: 'instance_type', type: 'size',
        sizeValues: { S: 't3.micro', XL: 'm6i.2xlarge' },
      })

      const result = await createOrder(makeSession(admin), {
        projectId: project.id, productId: product.id, environmentId: env.id,
        sizeCode: 'XL', parameters: {},
      })

      expect(result.ok).toBe(true)
      if (!result.ok) return
      const [row] = await db.select().from(orders).where(eq(orders.id, result.data.id))
      expect(row.parameters).toEqual({ instance_type: 'm6i.2xlarge' })
    })

    // The whole point of deciding it on the server: one choice fixes both the
    // price and the hardware, and a hand-written request cannot separate them.
    it('ignores a value the caller submits for it', async () => {
      const { admin, product, env, project } = await withSizes()
      await db.insert(parameters).values({
        scope: 'product', scopeId: product.id, name: 'instance_type', type: 'size',
        sizeValues: { S: 't3.micro', XL: 'm6i.2xlarge' },
      })

      const result = await createOrder(makeSession(admin), {
        projectId: project.id, productId: product.id, environmentId: env.id,
        sizeCode: 'S', parameters: { instance_type: 'm6i.32xlarge' },
      })

      expect(result.ok).toBe(true)
      if (!result.ok) return
      const [row] = await db.select().from(orders).where(eq(orders.id, result.data.id))
      // Bought an S, gets an S.
      expect(row.parameters).toEqual({ instance_type: 't3.micro' })
    })

    // vSphere needs three values from one size, which is why the map lives on
    // the VARIABLE and not on the size.
    it('drives as many variables as the template needs', async () => {
      const { admin, product, env, project } = await withSizes()
      await db.insert(parameters).values([
        { scope: 'product', scopeId: product.id, name: 'num_cpus', type: 'size', sizeValues: { S: '2', XL: '16' } },
        { scope: 'product', scopeId: product.id, name: 'memory_mb', type: 'size', sizeValues: { S: '4096', XL: '65536' } },
        { scope: 'product', scopeId: product.id, name: 'disk_size_gb', type: 'size', sizeValues: { S: '40', XL: '500' } },
      ])

      const result = await createOrder(makeSession(admin), {
        projectId: project.id, productId: product.id, environmentId: env.id,
        sizeCode: 'XL', parameters: {},
      })

      expect(result.ok).toBe(true)
      if (!result.ok) return
      const [row] = await db.select().from(orders).where(eq(orders.id, result.data.id))
      expect(row.parameters).toEqual({ num_cpus: '16', memory_mb: '65536', disk_size_gb: '500' })
    })

    // A size added after the mapping was written. Refusing beats provisioning an
    // empty instance_type and letting Terraform pick.
    it('refuses a size the mapping has no value for, and says which', async () => {
      const { admin, product, env, project } = await withSizes()
      await db.insert(parameters).values({
        scope: 'product', scopeId: product.id, name: 'instance_type', type: 'size',
        sizeValues: { S: 't3.micro' },
      })

      const result = await createOrder(makeSession(admin), {
        projectId: project.id, productId: product.id, environmentId: env.id,
        sizeCode: 'XL', parameters: {},
      })

      expect(result.ok).toBe(false)
      if (result.ok) return
      expect(result.status).toBe(400)
      expect(result.message).toMatch(/Size XL has no value for instance_type/)
    })

    it('refuses a size variable on an offering that has no sizes', async () => {
      const { admin, product, env, project } = await buildBase()
      await db.insert(parameters).values({
        scope: 'product', scopeId: product.id, name: 'instance_type', type: 'size',
        sizeValues: { M: 't3.large' },
      })

      const result = await createOrder(makeSession(admin), {
        projectId: project.id, productId: product.id, environmentId: env.id, parameters: {},
      })

      expect(result.ok).toBe(false)
      if (result.ok) return
      expect(result.message).toMatch(/set by the size, and this offering has no sizes/)
    })

    /*
     * The second half of what the user asked for: different values in different
     * environments. It costs nothing extra, because `parameters.environment_id`
     * already exists and the resolution already prefers the specific row.
     */
    it('gives one size different values in different environments', async () => {
      const { admin, product, env, ci, project } = await withSizes()
      const other = await createEnvironment(ci.id, 'Second')
      await linkProductEnvironment(product.id, other.id)
      await createSize(product.id, other.id, { code: 'XL', price: '90.00' })

      await db.insert(parameters).values([
        { scope: 'product', scopeId: product.id, environmentId: env.id, name: 'instance_type', type: 'size', sizeValues: { XL: 'm6i.2xlarge' } },
        { scope: 'product', scopeId: product.id, environmentId: other.id, name: 'instance_type', type: 'size', sizeValues: { XL: 'g6-dedicated-16' } },
      ])

      const first = await createOrder(makeSession(admin), {
        projectId: project.id, productId: product.id, environmentId: env.id, sizeCode: 'XL', parameters: {},
      })
      const second = await createOrder(makeSession(admin), {
        projectId: project.id, productId: product.id, environmentId: other.id, sizeCode: 'XL', parameters: {},
      })

      expect(first.ok && second.ok).toBe(true)
      if (!first.ok || !second.ok) return
      const [a] = await db.select().from(orders).where(eq(orders.id, first.data.id))
      const [b] = await db.select().from(orders).where(eq(orders.id, second.data.id))
      expect(a.parameters).toEqual({ instance_type: 'm6i.2xlarge' })
      expect(b.parameters).toEqual({ instance_type: 'g6-dedicated-16' })
    })
  })

  /*
   * A withdrawn product keeps its offerings so it can be put back unchanged
   * (#251) — which means the offering existing no longer implies it can be
   * ordered. `retiredAt` is the check now, and it is the only thing standing
   * between a disabled product and an order for it.
   */
  it('refuses an order for a product that has been withdrawn', async () => {
    const { admin, product, env, project } = await buildBase()
    await db.update(products).set({ retiredAt: new Date() }).where(eq(products.id, product.id))

    const result = await createOrder(makeSession(admin), {
      projectId: project.id, productId: product.id, environmentId: env.id, parameters: {},
    })

    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.status).toBe(400)
    expect(result.message).toMatch(/no longer available to order/i)
  })

  it('takes it again once it is put back', async () => {
    const { admin, product, env, project } = await buildBase()
    await db.update(products).set({ retiredAt: new Date() }).where(eq(products.id, product.id))
    await db.update(products).set({ retiredAt: null }).where(eq(products.id, product.id))

    const result = await createOrder(makeSession(admin), {
      projectId: project.id, productId: product.id, environmentId: env.id, parameters: {},
    })

    expect(result.ok).toBe(true)
  })

  /*
   * The element's state-key namespace, stored and sent, has to be the SAME
   * string (#200).
   *
   * The row is what the teardown derives from and the variable is what the apply
   * used. A drift between them stands the state up under one name and tears it
   * down under another — which reports success and leaves the infrastructure
   * running.
   */
  it('stores the same state-key namespace it sends to the pipeline', async () => {
    const { admin, product, env, project } = await buildBase()

    const result = await createOrder(makeSession(admin), {
      projectId: project.id, productId: product.id, environmentId: env.id, parameters: {},
    })
    expect(result.ok).toBe(true)
    if (!result.ok) return

    const [element] = await db
      .select()
      .from(infrastructureElements)
      .where(eq(infrastructureElements.orderId, result.data.id))

    const sent = mockedTriggerWebhooks.mock.calls.at(-1)?.[2] as Record<string, string>
    expect(element.stateKeyNamespace).toBe(sent[STATE_KEY_NAMESPACE_VAR])
    expect(element.stateKeyNamespace).toBe(stateKeyNamespaceFor(result.data.id))
  })

  // Not a bare order id: a pre-#183 element's key is the raw value the orderer
  // typed, so `web-01-42` typed back then is indistinguishable from `web-01`
  // namespaced by order 42. The letter is what tells them apart.
  it('namespaces with something no legacy key can produce', async () => {
    const { admin, product, env, project } = await buildBase()

    const result = await createOrder(makeSession(admin), {
      projectId: project.id, productId: product.id, environmentId: env.id, parameters: {},
    })
    if (!result.ok) return

    const [element] = await db
      .select()
      .from(infrastructureElements)
      .where(eq(infrastructureElements.orderId, result.data.id))

    expect(element.stateKeyNamespace).not.toMatch(/^\d+$/)
    expect(element.stateKeyNamespace).toBe(`o${result.data.id}`)
  })

  /*
   * #200. The trigger layer reports which state key each stack actually used and
   * provisioning WRITES IT DOWN — the derivation itself is webhooks.test.ts's
   * job, and it is mocked here. What this proves is the wiring, which is the
   * half that makes the recorded key exist at all.
   *
   * Recorded, so a later retry or teardown addresses the state this apply
   * created rather than re-deriving it from a stack row that may have moved.
   */
  it('writes down the state key each stack reported using', async () => {
    const { admin, product, env, project } = await buildBase()
    mockedTriggerStacks.mockResolvedValueOnce({
      pipelineIds: ['pipe-stack'],
      failures: [],
      stateKeys: { '7': 'web-01-o99' },
    })

    const result = await createOrder(makeSession(admin), {
      projectId: project.id, productId: product.id, environmentId: env.id,
      parameters: { hostname: 'web-01' },
    })
    expect(result.ok).toBe(true)
    if (!result.ok) return

    const [element] = await db
      .select()
      .from(infrastructureElements)
      .where(eq(infrastructureElements.orderId, result.data.id))

    expect(element.stateKeys).toEqual({ '7': 'web-01-o99' })
  })

  /*
   * A stack whose trigger FAILED still gets its key written down.
   *
   * The trigger layer records before it fires, not after it succeeds, because an
   * HTTP call that failed may still have started the pipeline — and a key nobody
   * recorded is a state with no teardown. Here one stack started and one did
   * not; both keys survive.
   *
   * (An order where NOTHING started is a different case: #206 deletes the
   * element rows and refuses the order, so there is no row left to carry a key.)
   */
  it('keeps the key of a stack whose trigger failed, alongside one that started', async () => {
    const { admin, product, env, project } = await buildBase()
    mockedTriggerStacks.mockResolvedValueOnce({
      pipelineIds: ['pipe-stack'],
      failures: ['pipeline stack "disk" (#8): boom'],
      stateKeys: { '7': 'web-01-o99', '8': 'web-01-o99-disk' },
    })

    const result = await createOrder(makeSession(admin), {
      projectId: project.id, productId: product.id, environmentId: env.id,
      parameters: { hostname: 'web-01' },
    })
    expect(result.ok).toBe(true)

    const [element] = await db.select().from(infrastructureElements)
    expect(element.stateKeys).toEqual({ '7': 'web-01-o99', '8': 'web-01-o99-disk' })
  })

  it('still refuses a required parameter that has no default to fall back on', async () => {
    const { admin, product, env, project } = await buildBase()
    await db.insert(parameters).values({
      scope: 'product',
      scopeId: product.id,
      name: 'REGION',
      type: 'string',
      required: true,
      defaultValue: '',
    })

    const result = await createOrder(makeSession(admin), {
      projectId: project.id,
      productId: product.id,
      environmentId: env.id,
      parameters: {},
    })

    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.message).toMatch(/Missing required parameter: REGION/)
  })

  it('treats the redaction sentinel as "unchanged", not as the value (#131)', async () => {
    const { admin, product, env, project } = await buildBase()
    await db.insert(parameters).values({
      scope: 'product',
      scopeId: product.id,
      name: 'API_KEY',
      type: 'string',
      required: false,
      sensitive: true,
      defaultValue: 'the-real-secret',
    })

    // Reads are redacted, so the reorder and apply-template prefills hand the
    // form '[redacted]' for every sensitive parameter. Posting that back must
    // not overwrite the stored secret with the placeholder — and must not ship
    // the placeholder to the pipeline as a trigger variable.
    const result = await createOrder(makeSession(admin), {
      projectId: project.id,
      productId: product.id,
      environmentId: env.id,
      parameters: { API_KEY: '[redacted]' },
    })

    expect(result.ok).toBe(true)
    if (!result.ok) return
    const [dbOrder] = await db.select().from(orders).where(eq(orders.id, result.data.id))
    expect(dbOrder.parameters).toEqual({ API_KEY: 'the-real-secret' })
  })

  it('does not store submitted keys that have no parameter definition (CI-variable injection)', async () => {
    const { admin, product, env, project } = await buildBase()
    await db.insert(parameters).values({
      scope: 'product',
      scopeId: product.id,
      name: 'REGION',
      type: 'string',
      required: false,
      defaultValue: 'eu-west',
    })

    const result = await createOrder(makeSession(admin), {
      projectId: project.id,
      productId: product.id,
      environmentId: env.id,
      // Attempt to inject synthetic trigger vars with no definition.
      parameters: { REGION: 'us-east', REF: 'attacker-branch', TF_ACTION: 'destroy' },
    })

    expect(result.ok).toBe(true)
    if (!result.ok) return

    const [dbOrder] = await db.select().from(orders).where(eq(orders.id, result.data.id))
    expect(dbOrder.parameters).toEqual({ REGION: 'us-east' })
    expect(dbOrder.parameters).not.toHaveProperty('REF')
    expect(dbOrder.parameters).not.toHaveProperty('TF_ACTION')

    // And they must not reach the CI trigger layer either.
    const [, , vars] = mockedTriggerWebhooks.mock.calls[0]
    expect(vars).not.toHaveProperty('REF')
    expect(vars).not.toHaveProperty('TF_ACTION')
  })

  it('does not let a parameter DEFINITION named REF choose the git ref (issue #183)', async () => {
    const { admin, product, env, project } = await buildBase()
    // The definition exists — an admin created it, or `sync-parameters` imported
    // it from a template's variables.tf. Dropping keys with no definition, which
    // is what the previous test covers, protects nothing against this: the key
    // has one.
    await db.insert(parameters).values([
      { scope: 'product', scopeId: product.id, name: 'REF', type: 'string', required: false },
      { scope: 'product', scopeId: product.id, name: 'TF_ACTION', type: 'string', required: false },
      { scope: 'product', scopeId: product.id, name: 'hostname', type: 'string', required: false },
    ])

    const result = await createOrder(makeSession(admin), {
      projectId: project.id,
      productId: product.id,
      environmentId: env.id,
      parameters: { REF: 'attacker/branch', TF_ACTION: 'destroy', hostname: 'web-01' },
    })

    expect(result.ok).toBe(true)
    if (!result.ok) return

    // `triggerGitLabPipeline` reads variables['REF'] as the git ref it runs, so
    // this is the difference between the pipeline running main and running
    // whatever the orderer pushed, with the environment's trigger token.
    const [, , vars] = mockedTriggerWebhooks.mock.calls[0]
    expect(vars).not.toHaveProperty('REF')
    expect(vars).not.toHaveProperty('TF_ACTION')
    expect(vars).toMatchObject({ hostname: 'web-01' })

    // And it is not persisted either, so approving a pending order months later
    // cannot replay it.
    const [dbOrder] = await db.select().from(orders).where(eq(orders.id, result.data.id))
    expect(dbOrder.parameters).toEqual({ hostname: 'web-01' })
  })

  it('trims surrounding whitespace before validating and storing values', async () => {
    const { admin, product, env, project } = await buildBase()
    await db.insert(parameters).values([
      { scope: 'product', scopeId: product.id, name: 'SIZE', type: 'number', required: true },
      { scope: 'product', scopeId: product.id, name: 'ENABLED', type: 'bool', required: true },
    ])

    const result = await createOrder(makeSession(admin), {
      projectId: project.id,
      productId: product.id,
      environmentId: env.id,
      // Padded values must be accepted (not rejected) and persisted trimmed so
      // the whitespace never reaches the CI trigger variables.
      parameters: { SIZE: ' 4 ', ENABLED: ' true ' },
    })

    expect(result.ok).toBe(true)
    if (!result.ok) return
    const [dbOrder] = await db.select().from(orders).where(eq(orders.id, result.data.id))
    expect(dbOrder.parameters).toMatchObject({ SIZE: '4', ENABLED: 'true' })
  })

  it('accepts valid required + typed parameters (happy path)', async () => {
    const { admin, product, env, project } = await buildBase()
    await db.insert(parameters).values([
      { scope: 'product', scopeId: product.id, name: 'HOSTNAME', type: 'string', required: true },
      { scope: 'product', scopeId: product.id, name: 'SIZE', type: 'number', required: true },
      { scope: 'product', scopeId: product.id, name: 'ENABLED', type: 'bool', required: false },
    ])

    const result = await createOrder(makeSession(admin), {
      projectId: project.id,
      productId: product.id,
      environmentId: env.id,
      parameters: { HOSTNAME: 'web-01', SIZE: '4', ENABLED: 'true' },
    })

    expect(result.ok).toBe(true)
    if (result.ok) expect(result.data.status).toBe('provisioning')
  })

  it('returns 403 when a PM orders into another PM\'s project', async () => {
    const { product, env } = await buildBase()
    const otherPm = await createUser({ role: 'project_manager', email: 'other-pm@test.dev' })
    const foreignProject = await createProject(otherPm.id)
    const attacker = await createUser({ role: 'project_manager', email: 'attacker@test.dev' })

    const result = await createOrder(makeSession(attacker), {
      projectId: foreignProject.id,
      productId: product.id,
      environmentId: env.id,
      parameters: {},
    })

    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.status).toBe(403)
  })

  it('returns 400 when the product is not offered in the chosen environment', async () => {
    const { admin, cat, project } = await buildBase()
    const unofferedProduct = await createProduct(cat.id, 'Unoffered')
    // Create a second environment the product is NOT linked to
    const ci = await createCiSource({ name: 'CI2' })
    const otherEnv = await createEnvironment(ci.id)

    const result = await createOrder(makeSession(admin), {
      projectId: project.id,
      productId: unofferedProduct.id,
      environmentId: otherEnv.id,
      parameters: {},
    })

    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.status).toBe(400)
  })
})

// FA-10.4 / issue #22. These rules live on the product/environment offering and
// used to be enforced only by OrderForm in the browser, so a direct POST could
// bypass them entirely — and the result lands in billing attribution.
describe('createOrder — cost centre rules are enforced server-side', () => {
  const buildWith = async (
    mode: 'project' | 'select' | 'overhead',
    forced: boolean,
    overheadCostCenterId?: number | null,
  ) => {
    const admin = await createUser({ role: 'admin', email: 'cc-admin@test.dev' })
    const pm = await createUser({ role: 'project_manager', email: 'cc-pm@test.dev' })
    const cat = await createCategory()
    const product = await createProduct(cat.id, 'CC Product')
    const ci = await createCiSource()
    const env = await createEnvironment(ci.id)
    await linkProductEnvironment(product.id, env.id, {
      costCenterMode: mode,
      forcedCostCenter: forced,
      ...(overheadCostCenterId !== undefined ? { overheadCostCenterId } : {}),
    })
    const project = await createProject(pm.id)
    return { admin, product, env, project }
  }

  const base = (p: { product: { id: number }; env: { id: number }; project: { id: number } }) => ({
    projectId: p.project.id,
    productId: p.product.id,
    environmentId: p.env.id,
    parameters: {},
  })

  it('rejects an order with no cost centre when the environment forces one', async () => {
    const ctx = await buildWith('select', true)
    const result = await createOrder(makeSession(ctx.admin), base(ctx))
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.status).toBe(400)
      expect(result.message).toMatch(/cost center is required/i)
    }
  })

  it('rejects a cost centre that has been deactivated', async () => {
    const ctx = await buildWith('select', true)
    const cc = await createCostCenter({ active: false })
    const result = await createOrder(makeSession(ctx.admin), { ...base(ctx), costCenterId: cc.id })
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.status).toBe(400)
      expect(result.message).toMatch(/not active/i)
    }
  })

  it('rejects a cost centre id that does not exist', async () => {
    const ctx = await buildWith('select', true)
    const result = await createOrder(makeSession(ctx.admin), { ...base(ctx), costCenterId: 999_999 })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.status).toBe(400)
  })

  it('stores an active cost centre when the environment asks the user to choose', async () => {
    const ctx = await buildWith('select', true)
    const cc = await createCostCenter()
    const result = await createOrder(makeSession(ctx.admin), { ...base(ctx), costCenterId: cc.id })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    const [row] = await db.select().from(orders).where(eq(orders.id, result.data.id))
    expect(row.costCenterId).toBe(cc.id)
  })

  it('allows omitting the cost centre when selection is offered but not forced', async () => {
    const ctx = await buildWith('select', false)
    const result = await createOrder(makeSession(ctx.admin), base(ctx))
    expect(result.ok).toBe(true)
    if (!result.ok) return
    const [row] = await db.select().from(orders).where(eq(orders.id, result.data.id))
    expect(row.costCenterId).toBeNull()
  })

  it('ignores a submitted cost centre in project mode, where attribution follows the project', async () => {
    const ctx = await buildWith('project', false)
    const cc = await createCostCenter()
    const result = await createOrder(makeSession(ctx.admin), { ...base(ctx), costCenterId: cc.id })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    const [row] = await db.select().from(orders).where(eq(orders.id, result.data.id))
    // The UI never offers the field in this mode, so a value that arrives anyway
    // must not be stored against the order.
    expect(row.costCenterId).toBeNull()
  })

  // ── overhead mode (issue #22) ───────────────────────────────────────────────
  // Before product_environments carried an account to point at, `overhead` fell
  // through to the same branch as `select` and asked the user to pick — the
  // opposite of a fixed shared account.
  it('bills an overhead order to the account configured on the offering', async () => {
    const overhead = await createCostCenter({ code: 'CC-OVERHEAD' })
    const ctx = await buildWith('overhead', true, overhead.id)

    const result = await createOrder(makeSession(ctx.admin), base(ctx))
    expect(result.ok).toBe(true)
    if (!result.ok) return
    const [row] = await db.select().from(orders).where(eq(orders.id, result.data.id))
    expect(row.costCenterId).toBe(overhead.id)
  })

  it('ignores a submitted cost centre in overhead mode', async () => {
    const overhead = await createCostCenter({ code: 'CC-OVERHEAD' })
    const submitted = await createCostCenter({ code: 'CC-USER-PICKED' })
    const ctx = await buildWith('overhead', true, overhead.id)

    const result = await createOrder(makeSession(ctx.admin), { ...base(ctx), costCenterId: submitted.id })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    const [row] = await db.select().from(orders).where(eq(orders.id, result.data.id))
    // The account is fixed by the offering — a caller cannot redirect the spend.
    expect(row.costCenterId).toBe(overhead.id)
  })

  it('rejects a forced overhead order when no account is configured', async () => {
    const ctx = await buildWith('overhead', true, null)
    const result = await createOrder(makeSession(ctx.admin), base(ctx))
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.status).toBe(400)
      expect(result.message).toMatch(/no overhead cost center is configured/i)
    }
  })

  it('records no cost centre when an unforced overhead offering has no account', async () => {
    const ctx = await buildWith('overhead', false, null)
    const result = await createOrder(makeSession(ctx.admin), base(ctx))
    expect(result.ok).toBe(true)
    if (!result.ok) return
    const [row] = await db.select().from(orders).where(eq(orders.id, result.data.id))
    expect(row.costCenterId).toBeNull()
  })

  it('rejects an overhead account that has since been deactivated', async () => {
    // The offering was configured while the account was live; deactivating it
    // must stop new spend rather than silently attributing to a dead account.
    const overhead = await createCostCenter({ code: 'CC-OVERHEAD', active: false })
    const ctx = await buildWith('overhead', true, overhead.id)

    const result = await createOrder(makeSession(ctx.admin), base(ctx))
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.status).toBe(400)
      expect(result.message).toMatch(/overhead cost center is not active/i)
    }
  })
})

// Issue #1: "test a 1ClickApp for 30 minutes with Admin priv". "Admin priv" is
// elevated rights INSIDE the provisioned app — the portal cannot grant rights in
// somebody else's Terraform, so it passes the intent to CI. A trial therefore does
// NOT bypass approval; that would make every trial-enabled product a way around
// the approval workflow entirely.
describe('createOrder — time-boxed trials', () => {
  const buildTrial = async (over?: { trialEnabled?: boolean; trialDurationMinutes?: number }) => {
    const admin = await createUser({ role: 'admin', email: 'trial-admin@test.dev' })
    const pm = await createUser({ role: 'project_manager', email: 'trial-pm@test.dev' })
    const cat = await createCategory()
    const product = await createProduct(cat.id, 'OneClick App')
    const ci = await createCiSource()
    const env = await createEnvironment(ci.id)
    await linkProductEnvironment(product.id, env.id, over)
    const project = await createProject(pm.id)
    return {
      admin,
      pm,
      base: { projectId: project.id, productId: product.id, environmentId: env.id, parameters: {} },
    }
  }

  it('refuses a trial of an offering that has not opted in', async () => {
    // The toggle is hidden in the browser for such products, and a hidden control
    // is not a control.
    const { admin, base } = await buildTrial()
    const result = await createOrder(makeSession(admin), { ...base, trial: true })
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.status).toBe(400)
      expect(result.message).toMatch(/not available as a trial/i)
    }
  })

  it('still allows a normal order of a trial-enabled offering', async () => {
    const { admin, base } = await buildTrial({ trialEnabled: true })
    const result = await createOrder(makeSession(admin), base)
    expect(result.ok).toBe(true)
    if (!result.ok) return
    const [row] = await db.select().from(orders).where(eq(orders.id, result.data.id))
    expect(row.isTrial).toBe(false)
  })

  it('marks the order and schedules the teardown for an admin trial', async () => {
    const { admin, base } = await buildTrial({ trialEnabled: true, trialDurationMinutes: 30 })
    const before = Date.now()
    const result = await createOrder(makeSession(admin), { ...base, trial: true })
    expect(result.ok).toBe(true)
    if (!result.ok) return

    const [order] = await db.select().from(orders).where(eq(orders.id, result.data.id))
    expect(order.isTrial).toBe(true)

    const [infra] = await db
      .select()
      .from(infrastructureElements)
      .where(eq(infrastructureElements.orderId, order.id))
    // The scheduled-decommission sweep (issue #30) is what tears it down, so a
    // trial needs no expiry mechanism of its own.
    const expiry = infra.scheduledDecommissionAt?.getTime() ?? 0
    expect(expiry).toBeGreaterThanOrEqual(before + 30 * 60_000)
    expect(expiry).toBeLessThanOrEqual(Date.now() + 30 * 60_000)
  })

  it('honours a configured duration other than 30 minutes', async () => {
    const { admin, base } = await buildTrial({ trialEnabled: true, trialDurationMinutes: 120 })
    const before = Date.now()
    const result = await createOrder(makeSession(admin), { ...base, trial: true })
    expect(result.ok).toBe(true)
    if (!result.ok) return

    const [infra] = await db
      .select()
      .from(infrastructureElements)
      .where(eq(infrastructureElements.orderId, result.data.id))
    expect(infra.scheduledDecommissionAt?.getTime()).toBeGreaterThanOrEqual(before + 120 * 60_000)
  })

  it('passes the trial variables to CI', async () => {
    const { admin, base } = await buildTrial({ trialEnabled: true, trialDurationMinutes: 45 })
    await createOrder(makeSession(admin), { ...base, trial: true })

    expect(mockedTriggerWebhooks).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      expect.objectContaining({ TRIAL: 'true', TRIAL_DURATION_MINUTES: '45' }),
      // The recorder that stores each pipeline id as it starts (issue #132).
      expect.any(Function),
    )
  })

  it('sends no trial variables for an ordinary order', async () => {
    const { admin, base } = await buildTrial({ trialEnabled: true })
    await createOrder(makeSession(admin), base)

    const vars = mockedTriggerWebhooks.mock.calls[0][2] as Record<string, string>
    expect(vars.TRIAL).toBeUndefined()
    expect(vars.TRIAL_DURATION_MINUTES).toBeUndefined()
  })

  it('leaves an ordinary order with no teardown schedule', async () => {
    const { admin, base } = await buildTrial({ trialEnabled: true })
    const result = await createOrder(makeSession(admin), base)
    expect(result.ok).toBe(true)
    if (!result.ok) return

    const [infra] = await db
      .select()
      .from(infrastructureElements)
      .where(eq(infrastructureElements.orderId, result.data.id))
    expect(infra.scheduledDecommissionAt).toBeNull()
  })

  it('does NOT bypass approval for a project manager', async () => {
    // Self-service trials would turn every trial-enabled product into a way around
    // the approval workflow.
    const { pm, base } = await buildTrial({ trialEnabled: true })
    const result = await createOrder(makeSession(pm), { ...base, trial: true })
    expect(result.ok).toBe(true)
    if (!result.ok) return

    const [order] = await db.select().from(orders).where(eq(orders.id, result.data.id))
    expect(order.status).toBe('pending')
    expect(order.isTrial).toBe(true)
    // Nothing is provisioned yet, so nothing is scheduled yet either.
    const infra = await db
      .select()
      .from(infrastructureElements)
      .where(eq(infrastructureElements.orderId, order.id))
    expect(infra).toHaveLength(0)
  })
})

// Issue #38. Orders reference the product by id, so without a snapshot a later
// price change silently rewrites what the order detail page reports as approved.
describe('createOrder — product snapshot', () => {
  const buildSnapshot = async () => {
    const admin = await createUser({ role: 'admin', email: 'snap-admin@test.dev' })
    const pm = await createUser({ role: 'project_manager', email: 'snap-pm@test.dev' })
    const cat = await createCategory()
    const product = await createProduct(cat.id, 'Nginx Gateway')
    const ci = await createCiSource()
    const env = await createEnvironment(ci.id, undefined, 'AWS Frankfurt')
    await linkProductEnvironment(product.id, env.id, { price: '10.00', currency: 'CHF' })
    const project = await createProject(pm.id)
    return {
      admin,
      pm,
      product,
      env,
      base: { projectId: project.id, productId: product.id, environmentId: env.id, parameters: {} },
    }
  }

  it('stores what was offered on an admin order', async () => {
    const ctx = await buildSnapshot()
    const result = await createOrder(makeSession(ctx.admin), ctx.base)
    expect(result.ok).toBe(true)
    if (!result.ok) return

    const [row] = await db.select().from(orders).where(eq(orders.id, result.data.id))
    expect(row.productSnapshot).toMatchObject({
      version: 1,
      productName: 'Nginx Gateway',
      environmentName: 'AWS Frankfurt',
      price: '10.00',
      currency: 'CHF',
    })
  })

  it('stores it on a pending order too, at order time', async () => {
    // The snapshot has to be what the customer SAW, so it is taken when the order
    // is placed rather than when it is approved.
    const ctx = await buildSnapshot()
    const result = await createOrder(makeSession(ctx.pm), ctx.base)
    expect(result.ok).toBe(true)
    if (!result.ok) return

    const [row] = await db.select().from(orders).where(eq(orders.id, result.data.id))
    expect(row.status).toBe('pending')
    expect(row.productSnapshot?.price).toBe('10.00')
  })

  it('is unaffected by a later price change', async () => {
    // This is the whole point: the order keeps reporting the price it was placed at.
    const ctx = await buildSnapshot()
    const result = await createOrder(makeSession(ctx.admin), ctx.base)
    if (!result.ok) throw new Error('setup failed')

    await linkProductEnvironment(ctx.product.id, ctx.env.id, { price: '99.00' })
    await db
      .update(productEnvironments)
      .set({ price: '99.00' })
      .where(eq(productEnvironments.productId, ctx.product.id))

    const [row] = await db.select().from(orders).where(eq(orders.id, result.data.id))
    expect(row.productSnapshot?.price).toBe('10.00')
  })

  it('records the parameter definitions that applied', async () => {
    const ctx = await buildSnapshot()
    await db.insert(parameters).values({
      scope: 'product', scopeId: ctx.product.id, name: 'REGION', type: 'string', defaultValue: 'eu-central-1',
    })

    const result = await createOrder(makeSession(ctx.admin), {
      ...ctx.base,
      parameters: { REGION: 'eu-west-1' },
    })
    if (!result.ok) throw new Error('setup failed')

    const [row] = await db.select().from(orders).where(eq(orders.id, result.data.id))
    // The DEFINITION, with its default — the submitted value lives in `parameters`.
    expect(row.productSnapshot?.parameters).toMatchObject([{ name: 'REGION', defaultValue: 'eu-central-1' }])
    expect(row.parameters).toEqual({ REGION: 'eu-west-1' })
  })

  it('surfaces the snapshot on the order read paths', async () => {
    const ctx = await buildSnapshot()
    const created = await createOrder(makeSession(ctx.admin), ctx.base)
    if (!created.ok) throw new Error('setup failed')

    const detail = await getOrderById(makeSession(ctx.admin), created.data.id)
    expect(detail.ok && detail.data.productSnapshot?.price).toBe('10.00')

    const listed = await listOrders(makeSession(ctx.admin))
    expect(listed.ok && listed.data.items[0].productSnapshot?.price).toBe('10.00')
  })
})

// Issue #35. Delegation is reflected in the approval-request email as a CC, not a
// redirect: nobody is removed from the recipient list, and the substitute's copy
// gains the names of the admins they are covering for.
describe('createOrder — delegation in the approval-request email', () => {
  it('annotates the substitute’s copy and leaves the away admin on the list', async () => {
    const { pm, product, env, project } = await buildBase()
    const away = await createUser({ role: 'admin', email: 'away@test.dev', name: 'Away Admin' })
    const sub = await createUser({ role: 'admin', email: 'sub@test.dev', name: 'Sub Admin' })
    await seedDelegation(away.id, sub.id, { startsInDays: 0, endsInDays: 5 })

    const result = await createOrder(makeSession(pm), {
      projectId: project.id,
      productId: product.id,
      environmentId: env.id,
      parameters: {},
    })
    expect(result.ok).toBe(true)

    const byRecipient = new Map(
      mockedSendApprovalRequest.mock.calls.map((c) => [c[0] as string, c[4] as string[]]),
    )
    // The away admin is still notified — a redirect would have made approval
    // traffic invisible to the admin who remains accountable for it.
    expect(byRecipient.has('away@test.dev')).toBe(true)
    expect(byRecipient.get('away@test.dev')).toEqual([])
    expect(byRecipient.get('sub@test.dev')).toEqual(['Away Admin'])
  })

  it('annotates nobody when no delegation is in force', async () => {
    const { pm, product, env, project } = await buildBase()
    await createUser({ role: 'admin', email: 'other@test.dev', name: 'Other' })

    await createOrder(makeSession(pm), {
      projectId: project.id,
      productId: product.id,
      environmentId: env.id,
      parameters: {},
    })

    for (const call of mockedSendApprovalRequest.mock.calls) {
      expect(call[4]).toEqual([])
    }
  })

  it('ignores a delegation whose period has passed', async () => {
    const { pm, product, env, project } = await buildBase()
    const away = await createUser({ role: 'admin', email: 'away@test.dev', name: 'Away Admin' })
    const sub = await createUser({ role: 'admin', email: 'sub@test.dev', name: 'Sub Admin' })
    await seedDelegation(away.id, sub.id, { startsInDays: -9, endsInDays: -2 })

    await createOrder(makeSession(pm), {
      projectId: project.id,
      productId: product.id,
      environmentId: env.id,
      parameters: {},
    })

    const subCall = mockedSendApprovalRequest.mock.calls.find((c) => c[0] === 'sub@test.dev')
    expect(subCall?.[4]).toEqual([])
  })
})

/**
 * Issue #206. A product with no webhook and no pipeline stack for the environment
 * starts nothing and fails at nothing, so the "nothing started" guard — which
 * used to require `failures.length > 0` — never fired. The run closed cleanly
 * with an empty id list, `isSettled` refused it (rightly: nothing reported
 * success), and the order sat in 'provisioning' with nothing in existence that
 * could ever move it.
 */
describe('an order whose triggers fire nothing (#206)', () => {
  beforeEach(() => {
    mockedTriggerWebhooks.mockResolvedValue({ pipelineIds: [], failures: [] })
    mockedTriggerStacks.mockResolvedValue({ pipelineIds: [], failures: [] })
  })

  it('is refused rather than left provisioning forever', async () => {
    const ctx = await buildBase()
    const result = await createOrder(makeSession(ctx.admin), {
      projectId: ctx.project.id,
      productId: ctx.product.id,
      environmentId: ctx.env.id,
      parameters: {},
    })

    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.status).toBe(502)
  })

  it('says what is actually wrong, not "could not start any pipeline: "', async () => {
    // The old message interpolated an empty failure list, which told an operator
    // nothing. This is a misconfiguration and the fix is in Admin → Products.
    const ctx = await buildBase()
    const result = await createOrder(makeSession(ctx.admin), {
      projectId: ctx.project.id,
      productId: ctx.product.id,
      environmentId: ctx.env.id,
      parameters: {},
    })

    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.message).toMatch(/no product webhook and no pipeline stack/i)
      expect(result.message).not.toMatch(/Could not start any pipeline:\s*$/)
    }
  })

  it('leaves no order claiming to be provisioning', async () => {
    const ctx = await buildBase()
    await createOrder(makeSession(ctx.admin), {
      projectId: ctx.project.id,
      productId: ctx.product.id,
      environmentId: ctx.env.id,
      parameters: {},
    })

    const rows = await db.select().from(orders).where(eq(orders.projectId, ctx.project.id))
    expect(rows.every((o) => o.status !== 'provisioning')).toBe(true)
  })

  it('leaves no infrastructure element behind', async () => {
    // They are inserted before their triggers fire. Left in place they are
    // 'active' elements with no pipeline: counted in inventory, and
    // decommissioning them fires destroy at infrastructure never created.
    const ctx = await buildBase()
    await createOrder(makeSession(ctx.admin), {
      projectId: ctx.project.id,
      productId: ctx.product.id,
      environmentId: ctx.env.id,
      parameters: {},
      quantity: 3,
    })

    const rows = await db
      .select()
      .from(infrastructureElements)
      .where(eq(infrastructureElements.projectId, ctx.project.id))
    expect(rows).toHaveLength(0)
  })

  it('still reports the failures when there were some', async () => {
    // The other half of the same guard must keep its own message.
    mockedTriggerWebhooks.mockResolvedValue({ pipelineIds: [], failures: ['webhook #1: 502'] })
    const ctx = await buildBase()
    const result = await createOrder(makeSession(ctx.admin), {
      projectId: ctx.project.id,
      productId: ctx.product.id,
      environmentId: ctx.env.id,
      parameters: {},
    })

    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.message).toMatch(/webhook #1: 502/)
  })
})

/**
 * Issue #208. The orders table has had a Project column all along, reading a
 * field on the shared `Order` type that neither projection ever selected — so the
 * cell was blank and the detail page fell back to `#12`.
 *
 * These assert on the NAME rather than on the query succeeding, which is the
 * whole point: every existing test passed with the field permanently undefined.
 */
describe('the project name (#208)', () => {
  it('is on the list', async () => {
    const { admin, pm, product, env, project } = await buildBase()
    const order = await seedOrder(project.id, product.id, env.id, pm.id)

    const result = await listOrders(makeSession(admin))
    expect(result.ok).toBe(true)
    if (result.ok) {
      const row = result.data.items.find((o) => o.id === order.id)
      expect(row?.projectName).toBe(project.name)
    }
  })

  it('is on the detail', async () => {
    const { admin, pm, product, env, project } = await buildBase()
    const order = await seedOrder(project.id, product.id, env.id, pm.id)

    const result = await getOrderById(makeSession(admin), order.id)
    expect(result.ok).toBe(true)
    if (result.ok) expect(result.data.projectName).toBe(project.name)
  })

  it('is a name, not the id it used to fall back to', async () => {
    const { admin, pm, product, env, project } = await buildBase()
    const order = await seedOrder(project.id, product.id, env.id, pm.id)

    const result = await getOrderById(makeSession(admin), order.id)
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.data.projectName).not.toBeUndefined()
      expect(result.data.projectName).not.toBe(`#${project.id}`)
    }
  })

  it('reaches a project manager looking at their own order', async () => {
    // The join must not depend on being an admin: the list is filtered by owner
    // for a project manager, and the name has to survive that.
    const { pm, product, env, project } = await buildBase()
    const order = await seedOrder(project.id, product.id, env.id, pm.id)

    const result = await listOrders(makeSession(pm))
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.data.items.find((o) => o.id === order.id)?.projectName).toBe(project.name)
    }
  })
})

// An order that reaches `provisioning` and never hears back from CI had no way
// out: Retry is gated on `failed`, which the order can only reach through a
// callback that is not coming. Seen live as order 37 on the dev instance —
// provisioning since 24 August, `updated_at` 0.6s after `created_at`,
// `pipeline_status` empty.
describe('markOrderFailed (issue #206)', () => {
  const LONG_AGO = new Date(Date.now() - 90 * 60 * 1000)

  async function stuckOrder(status = 'provisioning', updatedAt: Date = LONG_AGO) {
    const owner = await createUser({ role: 'project_manager' })
    const cat = await createCategory()
    const product = await createProduct(cat.id)
    const ci = await createCiSource()
    const env = await createEnvironment(ci.id)
    const project = await createProject(owner.id)
    const order = await seedOrder(project.id, product.id, env.id, owner.id, { status })
    await db.update(orders).set({ updatedAt }).where(eq(orders.id, order.id))
    return order
  }

  it('lets root write off an order that has gone silent', async () => {
    const root = await createUser({ role: 'root' })
    const order = await stuckOrder()

    const result = await markOrderFailed(makeSession(root), order.id, 'Pipeline 740 finished; no callback arrived.')

    expect(result.ok).toBe(true)
    const [row] = await db.select().from(orders).where(eq(orders.id, order.id))
    expect(row.status).toBe('failed')
  })

  // The whole point is that a person took responsibility for a status nothing
  // observed, so the entry has to say who and why.
  it('records who wrote it off and the reason they gave', async () => {
    const root = await createUser({ role: 'root' })
    const order = await stuckOrder()

    await markOrderFailed(makeSession(root), order.id, 'Pipeline finished in GitLab, callback never arrived.')

    const [entry] = await db
      .select()
      .from(auditLog)
      .where(eq(auditLog.action, 'order.written_off'))
      .orderBy(desc(auditLog.id))
      .limit(1)
    expect(entry.userId).toBe(root.id)
    expect(entry.entityId).toBe(order.id)
    expect(entry.details).toContain(root.email)
    expect(entry.details).toContain('callback never arrived')
    expect(entry.details).toMatch(/\d+ minutes/)
  })

  it('refuses anyone who is not root', async () => {
    const admin = await createUser({ role: 'admin' })
    const order = await stuckOrder()

    const result = await markOrderFailed(makeSession(admin), order.id, 'let me')

    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.status).toBe(403)
    const [row] = await db.select().from(orders).where(eq(orders.id, order.id))
    expect(row.status).toBe('provisioning')
  })

  // Every other status either resolves itself or has its own way out; this exists
  // only for the one that does not.
  it.each(['pending', 'completed', 'failed', 'rejected'])(
    'refuses to touch an order that is %s',
    async (status) => {
      const root = await createUser({ role: 'root' })
      const order = await stuckOrder(status)

      const result = await markOrderFailed(makeSession(root), order.id, 'reason')

      expect(result.ok).toBe(false)
      if (!result.ok) expect(result.status).toBe(409)
    },
  )

  // A pipeline that is merely slow must not be written off out from under itself.
  it('refuses while the order could still be running', async () => {
    const root = await createUser({ role: 'root' })
    const order = await stuckOrder('provisioning', new Date(Date.now() - 60 * 1000))

    const result = await markOrderFailed(makeSession(root), order.id, 'impatient')

    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.status).toBe(409)
      expect(result.message).toMatch(/may still be running/i)
    }
  })

  it('accepts it the moment the silence is long enough', async () => {
    const root = await createUser({ role: 'root' })
    const order = await stuckOrder('provisioning', new Date(Date.now() - STUCK_ORDER_SILENCE_MS - 1000))

    const result = await markOrderFailed(makeSession(root), order.id, 'no callback')

    expect(result.ok).toBe(true)
  })

  it('insists on a reason', async () => {
    const root = await createUser({ role: 'root' })
    const order = await stuckOrder()

    const result = await markOrderFailed(makeSession(root), order.id, '   ')

    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.status).toBe(400)
  })

  it('answers 404 for an order that is not there', async () => {
    const root = await createUser({ role: 'root' })
    const result = await markOrderFailed(makeSession(root), 999_999, 'reason')
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.status).toBe(404)
  })

  // The UPDATE carries the status in its WHERE, so a callback that lands between
  // the read and the write wins rather than being overwritten by the write-off.
  it('loses to a callback that arrives first', async () => {
    const root = await createUser({ role: 'root' })
    const order = await stuckOrder()
    await db.update(orders).set({ status: 'completed' }).where(eq(orders.id, order.id))

    const result = await markOrderFailed(makeSession(root), order.id, 'too late')

    expect(result.ok).toBe(false)
    const [row] = await db.select().from(orders).where(eq(orders.id, order.id))
    expect(row.status).toBe('completed')
  })
})

// The order detail page printed `#3` where the cost centre belongs. An internal
// row id is the one form in which a finance reader cannot recognise the account
// their order was charged against.
describe('getOrderById cost centre naming', () => {
  async function orderWithCostCentre(costCenterId: number | null) {
    const owner = await createUser({ role: 'root' })
    const cat = await createCategory()
    const product = await createProduct(cat.id)
    const ci = await createCiSource()
    const env = await createEnvironment(ci.id)
    const project = await createProject(owner.id)
    const order = await seedOrder(project.id, product.id, env.id, owner.id)
    await db.update(orders).set({ costCenterId }).where(eq(orders.id, order.id))
    return { owner, order }
  }

  it('answers with the code and the name, not just the id', async () => {
    const cc = await createCostCenter({ code: 'IT-4711', name: 'Platform Networking' })
    const { owner, order } = await orderWithCostCentre(cc.id)

    const result = await getOrderById(makeSession(owner), order.id)

    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.data.costCenterId).toBe(cc.id)
      expect(result.data.costCenterCode).toBe('IT-4711')
      expect(result.data.costCenterName).toBe('Platform Networking')
    }
  })

  // A cost centre is optional — see costCenterMode. Joining it must not make an
  // order without one vanish from its own detail page.
  it('still answers for an order that has no cost centre', async () => {
    const { owner, order } = await orderWithCostCentre(null)

    const result = await getOrderById(makeSession(owner), order.id)

    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.data.id).toBe(order.id)
      expect(result.data.costCenterId).toBeNull()
      expect(result.data.costCenterCode ?? null).toBeNull()
    }
  })

  // An inactive cost centre is still the one the order was charged against, and
  // the order has to keep reading correctly after an admin retires it.
  it('names a retired cost centre too', async () => {
    const cc = await createCostCenter({ code: 'OLD-1', name: 'Closed Department', active: false })
    const { owner, order } = await orderWithCostCentre(cc.id)

    const result = await getOrderById(makeSession(owner), order.id)

    expect(result.ok).toBe(true)
    if (result.ok) expect(result.data.costCenterCode).toBe('OLD-1')
  })
})

/**
 * The budget gate (#325), tested where it actually sits.
 *
 * In `createPreparedOrder` rather than in a route, because the approval path
 * comes through here too — a check in the checkout handler alone would let an
 * order approved next week spend a budget that is already gone.
 */
describe('createOrder — budget enforcement', () => {
  const withBudget = async (
    behaviour: 'warn' | 'block',
    amount: string,
  ) => {
    const base = await buildBase()
    const centre = await createCostCenter()
    await db.update(projects).set({ costCenterId: centre.id }).where(eq(projects.id, base.project.id))
    await db.update(costCenters).set({
      budgetAmount: amount, budgetCurrency: 'EUR', budgetPeriod: 'total', budgetBehaviour: behaviour,
    }).where(eq(costCenters.id, centre.id))
    return { ...base, centre }
  }

  const order = (base: Awaited<ReturnType<typeof withBudget>>, over?: { overrideBudget?: boolean }) => ({
    projectId: base.project.id,
    productId: base.product.id,
    environmentId: base.env.id,
    parameters: {},
    ...(over ?? {}),
  })

  it('refuses an order against a spent budget', async () => {
    const base = await withBudget('block', '0.00')
    const result = await createOrder(makeSession(base.admin), order(base))
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.status).toBe(409)
    expect(result.message).toContain('over budget')
  })

  it('lets the order through when the behaviour is warn', async () => {
    // The whole point of the setting being configurable: over budget is not
    // automatically a refusal, and a `warn` centre that blocked would be the
    // feature doing the opposite of what root asked for.
    mockedTriggerWebhooks.mockResolvedValueOnce({ pipelineIds: ['pipe-warn'], failures: [] })
    const base = await withBudget('warn', '0.00')
    const result = await createOrder(makeSession(base.admin), order(base))
    expect(result.ok).toBe(true)
  })

  it('lets the order through while the budget still has room', async () => {
    mockedTriggerWebhooks.mockResolvedValueOnce({ pipelineIds: ['pipe-room'], failures: [] })
    const base = await withBudget('block', '100000.00')
    const result = await createOrder(makeSession(base.admin), order(base))
    expect(result.ok).toBe(true)
  })

  it('refuses even root without the override, so the escape is deliberate', async () => {
    const base = await withBudget('block', '0.00')
    const root = await createUser({ role: 'root' })
    const result = await createOrder(makeSession(root), order(base))
    expect(result.ok).toBe(false)
  })

  it('lets root through WITH the override, and writes it to the audit log', async () => {
    // A hard block with no way past it becomes an outage during an incident —
    // the one time somebody genuinely needs to provision against a spent
    // budget. The record is what makes that acceptable.
    mockedTriggerWebhooks.mockResolvedValueOnce({ pipelineIds: ['pipe-override'], failures: [] })
    const base = await withBudget('block', '0.00')
    const root = await createUser({ role: 'root' })

    const result = await createOrder(makeSession(root), order(base, { overrideBudget: true }))
    expect(result.ok).toBe(true)

    const entries = await db.select().from(auditLog).where(eq(auditLog.action, 'order.budget_overridden'))
    expect(entries).toHaveLength(1)
    expect(entries[0].details).toContain(base.centre.code)
    // And root is told, like any other orderer who went through over budget.
    // The override says they meant to; it does not say they wanted it silent.
    if (!result.ok) return
    expect(result.data.budgetWarning).toContain('over budget')
  })

  it('does not let a non-root user override', async () => {
    // Otherwise the setting is advisory for anyone who knows the flag exists.
    const base = await withBudget('block', '0.00')
    const result = await createOrder(makeSession(base.admin), order(base, { overrideBudget: true }))
    expect(result.ok).toBe(false)
  })

  it('refuses an order that would blow an untouched budget on its own', async () => {
    /*
     * The gate used to ask only "is the budget already spent?", so against an
     * untouched budget of 500 the FIRST order could be for any amount and go
     * through — the budget then refused the SECOND, after the money that broke
     * it had gone. The order being placed is part of the question.
     */
    const base = await withBudget('block', '500.00')
    await db.update(productEnvironments)
      .set({ price: '10000.00', currency: 'EUR' })
      .where(eq(productEnvironments.productId, base.product.id))

    const result = await createOrder(makeSession(base.admin), order(base))
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.status).toBe(409)
    expect(result.message).toMatch(/over the 500\.00 EUR budget/i)
  })

  it('lets an order through when it fits the budget that is left', async () => {
    mockedTriggerWebhooks.mockResolvedValueOnce({ pipelineIds: ['pipe-fits'], failures: [] })
    const base = await withBudget('block', '500.00')
    await db.update(productEnvironments)
      .set({ price: '100.00', currency: 'EUR' })
      .where(eq(productEnvironments.productId, base.product.id))

    const result = await createOrder(makeSession(base.admin), order(base))
    expect(result.ok).toBe(true)
  })

  it('counts the whole order, not one element of it', async () => {
    // One approval covers all N elements (#104), so N x price is what lands
    // against the budget.
    const base = await withBudget('block', '500.00')
    await db.update(productEnvironments)
      .set({ price: '100.00', currency: 'EUR' })
      .where(eq(productEnvironments.productId, base.product.id))

    const result = await createOrder(makeSession(base.admin), { ...order(base), quantity: 20 })
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.message).toMatch(/budget/i)
  })

  it('tells the orderer the order went through over budget', async () => {
    // A warning nobody receives is not a warning: an over-budget order that
    // passes silently is indistinguishable from one that was inside its budget.
    mockedTriggerWebhooks.mockResolvedValueOnce({ pipelineIds: ['pipe-warned'], failures: [] })
    const base = await withBudget('warn', '0.00')
    const result = await createOrder(makeSession(base.admin), order(base))
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.data.budgetWarning).toContain('over budget')
  })

  it('records the warning in the audit log', async () => {
    mockedTriggerWebhooks.mockResolvedValueOnce({ pipelineIds: ['pipe-warn-audit'], failures: [] })
    const base = await withBudget('warn', '0.00')
    await createOrder(makeSession(base.admin), order(base))

    const entries = await db.select().from(auditLog).where(eq(auditLog.action, 'order.budget_warning'))
    expect(entries).toHaveLength(1)
    expect(entries[0].details).toContain(base.centre.code)
  })

  it('says nothing about a budget when the order was inside it', async () => {
    // Otherwise every order carries a notice and the one that matters is lost.
    mockedTriggerWebhooks.mockResolvedValueOnce({ pipelineIds: ['pipe-quiet'], failures: [] })
    const base = await withBudget('warn', '100000.00')
    const result = await createOrder(makeSession(base.admin), order(base))
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.data.budgetWarning).toBeUndefined()
    expect(await db.select().from(auditLog).where(eq(auditLog.action, 'order.budget_warning'))).toHaveLength(0)
  })
})

/*
 * Policy enforcement at the order ordinals (#110).
 *
 * The gate itself is tested in `lib/policy/gate.test.ts`; what these tests are
 * for is the WIRING — that a refusal reaches the requester as a refusal, that a
 * warning is on the order the requester gets back rather than only in a log, and
 * that the override is root's alone. Every one of those is a place where a gate
 * that works can still be a gate nobody feels.
 */
describe('createOrder — policy enforcement (#110)', () => {
  afterEach(() => vi.restoreAllMocks())

  /** A portal-wide OPA engine, which is what an installation has one of. */
  const withEngine = async (failureMode: 'blocking' | 'best_effort' = 'blocking') => {
    const root = await createUser({ role: 'root', email: 'root@test.dev', name: 'Root' })
    await createIntegration(root.id, {
      kind: 'opa',
      name: 'Policy engine',
      baseUrl: 'https://opa.example.com',
      authType: 'none',
      failureMode,
    })
    return root
  }

  const decision = (payload: Record<string, unknown>) =>
    new Response(JSON.stringify({ result: payload }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    })

  const order = (base: Awaited<ReturnType<typeof buildBase>>, over?: { overridePolicy?: boolean }) => ({
    projectId: base.project.id,
    productId: base.product.id,
    environmentId: base.env.id,
    parameters: {},
    ...(over ?? {}),
  })

  it('refuses an order a policy denies, and names the rule that refused it', async () => {
    // #110 in one assertion: "denied" with no rule leaves the requester with
    // nothing to change and nobody to ask.
    const base = await buildBase()
    await withEngine()
    vi.spyOn(global, 'fetch').mockResolvedValue(
      decision({ decision: 'deny', rule: 'quota/vm-count', message: 'This project already holds 20 VMs' }),
    )

    const result = await createOrder(makeSession(base.admin), order(base))
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.status).toBe(409)
    expect(result.message).toContain('This project already holds 20 VMs.')
    expect(result.message).toContain('quota/vm-count')
  })

  it('places an order a policy allows', async () => {
    mockedTriggerWebhooks.mockResolvedValueOnce({ pipelineIds: ['pipe-allow'], failures: [] })
    const base = await buildBase()
    await withEngine()
    vi.spyOn(global, 'fetch').mockResolvedValue(decision({ decision: 'allow', rule: 'baseline' }))

    const result = await createOrder(makeSession(base.admin), order(base))
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.data.policyWarning).toBeUndefined()
  })

  it('places a warned order with the policy’s own words on it', async () => {
    mockedTriggerWebhooks.mockResolvedValueOnce({ pipelineIds: ['pipe-warn'], failures: [] })
    const base = await buildBase()
    await withEngine()
    vi.spyOn(global, 'fetch').mockResolvedValue(
      decision({ decision: 'warn', rule: 'quota/near-limit', message: 'This project is near its VM limit.' }),
    )

    const result = await createOrder(makeSession(base.admin), order(base))
    expect(result.ok).toBe(true)
    if (!result.ok) return
    // On the order, not only in the log: the person who placed it is the one who
    // can do something about it.
    expect(result.data.policyWarning).toBe('This project is near its VM limit.')

    const entries = await db.select().from(auditLog).where(eq(auditLog.action, 'order.policy_warning'))
    expect(entries).toHaveLength(1)
    expect(entries[0].details).toContain('quota/near-limit')
  })

  it('holds an admin’s order for approval when a policy asks for a person', async () => {
    /*
     * #110's third answer, and the reason it cannot be folded into `allow` or
     * `deny`: this is the one outcome that changes WHO may commit the order.
     *
     * An admin's order provisions immediately (`createPreparedOrder`), so a rule
     * that asks for an approval has to stop that — otherwise the rule does
     * nothing at all for exactly the role it was written about. The order is
     * written `pending`, which puts it in the approvals queue, and
     * `approveOrder`'s self-approval guard means a DIFFERENT admin has to say
     * yes — which is what "needs approval" has to mean to be worth having.
     */
    const base = await buildBase()
    await withEngine()
    vi.spyOn(global, 'fetch').mockResolvedValue(
      decision({
        decision: 'needs-approval',
        rule: 'sod/production',
        message: 'Production needs a second pair of eyes.',
      }),
    )

    const result = await createOrder(makeSession(base.admin), order(base))

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.data.status).toBe('pending')
    // The requester is told which rule asked, in the policy's own words — the
    // same reason a refusal names its rule.
    expect(result.data.policyApprovalRequired).toContain('Production needs a second pair of eyes.')
    expect(result.data.policyApprovalRequired).toContain('sod/production')
    // Nothing was built and nothing was started: the order is a request again.
    expect(mockedTriggerWebhooks).not.toHaveBeenCalled()

    const entries = await db.select().from(auditLog).where(eq(auditLog.action, 'order.policy_needs_approval'))
    expect(entries).toHaveLength(1)
    expect(entries[0].details).toContain('sod/production')
    expect(entries[0].entityId).toBe(result.data.id)
  })

  it('asks an approver, by mail, for an order policy held back', async () => {
    // The queue is not the only way an approval is reached: the ordering path
    // mails every admin, and an order parked by policy must not be the one that
    // arrives quietly.
    const base = await buildBase()
    await withEngine()
    vi.spyOn(global, 'fetch').mockResolvedValue(
      decision({ decision: 'needs-approval', rule: 'sod/production' }),
    )

    const result = await createOrder(makeSession(base.admin), order(base))

    expect(result.ok).toBe(true)
    expect(mockedSendApprovalRequest).toHaveBeenCalled()
  })

  it('says which rule asked for an approval when a project manager’s order waits', async () => {
    // Their order waits for approval either way, so this is not a change of
    // status — but "why did this one need a person" is a question the requester
    // would otherwise have to ask someone about.
    const base = await buildBase()
    await withEngine()
    vi.spyOn(global, 'fetch').mockResolvedValue(
      decision({ decision: 'needs-approval', rule: 'sod/production' }),
    )

    const result = await createOrder(makeSession(base.pm), order(base))

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.data.status).toBe('pending')
    expect(result.data.policyApprovalRequired).toContain('sod/production')
  })

  it('lets root through WITH the override, and records the rule that was waived', async () => {
    mockedTriggerWebhooks.mockResolvedValueOnce({ pipelineIds: ['pipe-override'], failures: [] })
    const base = await buildBase()
    const root = await withEngine()
    vi.spyOn(global, 'fetch').mockResolvedValue(
      decision({ decision: 'deny', rule: 'quota/vm-count', message: 'This project already holds 20 VMs' }),
    )

    const result = await createOrder(makeSession(root), order(base, { overridePolicy: true }))
    expect(result.ok).toBe(true)
    if (!result.ok) return
    // Root is told what they waived — the override says they meant to place it,
    // not that they wanted it quiet.
    expect(result.data.policyWarning).toContain('quota/vm-count')

    const entries = await db.select().from(auditLog).where(eq(auditLog.action, 'order.policy_overridden'))
    expect(entries).toHaveLength(1)
    expect(entries[0].details).toContain('quota/vm-count')
  })

  it('refuses root without the override, so the escape is deliberate', async () => {
    const base = await buildBase()
    const root = await withEngine()
    vi.spyOn(global, 'fetch').mockResolvedValue(decision({ decision: 'deny', rule: 'quota/vm-count' }))

    const result = await createOrder(makeSession(root), order(base))
    expect(result.ok).toBe(false)
  })

  it('does not let a non-root user override a refusal', async () => {
    // Otherwise a policy is advisory for anyone who knows the flag exists.
    const base = await buildBase()
    await withEngine()
    vi.spyOn(global, 'fetch').mockResolvedValue(decision({ decision: 'deny', rule: 'quota/vm-count' }))

    const result = await createOrder(makeSession(base.admin), order(base, { overridePolicy: true }))
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.status).toBe(409)
  })

  it('refuses under a blocking engine that cannot be asked, saying so', async () => {
    const base = await buildBase()
    await withEngine('blocking')
    vi.spyOn(global, 'fetch').mockRejectedValue(new Error('connect ECONNREFUSED'))

    const result = await createOrder(makeSession(base.admin), order(base))
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.status).toBe(409)
    expect(result.message).toContain('could not be asked')
  })

  it('places, with a warning, under a best-effort engine that cannot be asked', async () => {
    mockedTriggerWebhooks.mockResolvedValueOnce({ pipelineIds: ['pipe-degraded'], failures: [] })
    const base = await buildBase()
    await withEngine('best_effort')
    vi.spyOn(global, 'fetch').mockRejectedValue(new Error('connect ECONNREFUSED'))

    const result = await createOrder(makeSession(base.admin), order(base))
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.data.policyWarning).toContain('could not be asked')

    // And the unevaluated order is on the record, because "this order was never
    // checked" is exactly the outcome nobody sees otherwise.
    const entries = await db.select().from(auditLog).where(eq(auditLog.action, 'order.policy_unavailable'))
    expect(entries).toHaveLength(1)
  })

  it('leaves orders exactly as they were when no engine is configured', async () => {
    // The state every installation starts in: installing a policy engine must be
    // a choice, and this is what makes it one.
    mockedTriggerWebhooks.mockResolvedValueOnce({ pipelineIds: ['pipe-nopolicy'], failures: [] })
    const base = await buildBase()
    const fetchMock = vi.spyOn(global, 'fetch')

    const result = await createOrder(makeSession(base.admin), order(base))
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.data.policyWarning).toBeUndefined()
    expect(fetchMock).not.toHaveBeenCalled()
  })
})
