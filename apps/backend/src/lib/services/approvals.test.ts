import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import type { SessionUser } from '@infrashelf/types'
import type * as WindowPolicyService from '@/lib/services/windowPolicy'

vi.mock('@/lib/notification', () => ({
  sendOrderApproved: vi.fn().mockResolvedValue(undefined),
  sendOrderRejected: vi.fn().mockResolvedValue(undefined),
}))

vi.mock('@/lib/ci/webhooks', () => ({
  triggerProductWebhooksTracked: vi.fn().mockResolvedValue({ pipelineIds: ['pipe-42'], failures: [] }),
  triggerPipelineStacksTracked: vi.fn().mockResolvedValue({ pipelineIds: [], failures: [] }),
}))

vi.mock('@/lib/services/windowPolicy', async (importOriginal) => ({
  ...(await importOriginal<typeof WindowPolicyService>()),
  whenMayItDeploy: vi.fn(),
}))

import { listApprovals, approveOrder, rejectOrder } from './approvals'
import { createIntegration } from '@/lib/services/admin/integrations'
import { sendOrderApproved, sendOrderRejected } from '@/lib/notification'
import { triggerProductWebhooksTracked } from '@/lib/ci/webhooks'
import { whenMayItDeploy } from '@/lib/services/windowPolicy'
import { db } from '@/lib/db/client'
import {
  orders,
  infrastructureElements,
  productEnvironments,
  auditLog,
  approvalDelegations,
  costCenters,
  projects,
} from '@/lib/db/schema'
import { eq } from 'drizzle-orm'
import {
  createUser,
  createCategory,
  createProduct,
  createCiSource,
  createEnvironment,
  createProject,
  createOrder as seedOrder,
  createDelegation as seedDelegation,
  linkProductEnvironment,
  createCostCenter,
} from '@/test/helpers'

const makeSession = (u: { id: number; email: string; name: string; role: string }): SessionUser =>
  ({ id: u.id, email: u.email, name: u.name, role: u.role as SessionUser['role'] })

const mockedWebhooks = vi.mocked(triggerProductWebhooksTracked)
const mockedApproved = vi.mocked(sendOrderApproved)
const mockedRejected = vi.mocked(sendOrderRejected)

beforeEach(() => {
  mockedWebhooks.mockReset().mockResolvedValue({ pipelineIds: ['pipe-42'], failures: [] })
  mockedApproved.mockReset().mockResolvedValue(undefined)
  mockedRejected.mockReset().mockResolvedValue(undefined)
})

const setup = async () => {
  const admin = await createUser({ role: 'admin', email: 'admin@test.dev', name: 'Admin' })
  const pm = await createUser({ role: 'project_manager', email: 'pm@test.dev', name: 'PM' })
  const cat = await createCategory()
  const product = await createProduct(cat.id, 'Product A')
  const ci = await createCiSource()
  const env = await createEnvironment(ci.id)
  const project = await createProject(pm.id)
  return { admin, pm, product, env, project }
}

describe('listApprovals', () => {
  it('returns only pending orders with joined fields', async () => {
    const { pm, product, env, project } = await setup()
    const pending = await seedOrder(project.id, product.id, env.id, pm.id, { status: 'pending' })
    await seedOrder(project.id, product.id, env.id, pm.id, { status: 'completed' })
    await seedOrder(project.id, product.id, env.id, pm.id, { status: 'rejected' })

    const result = await listApprovals()
    expect(result.ok).toBe(true)
    if (!result.ok) return

    expect(result.data.length).toBe(1)
    expect(result.data[0].id).toBe(pending.id)
    expect(result.data[0].productName).toBe('Product A')
    expect(result.data[0].environmentName).toBe('Test Env')
    expect(result.data[0].userName).toBe('PM')
    expect(result.data[0].projectName).toBe('Test Project')
  })

  it('returns empty list when no pending orders exist', async () => {
    const { pm, product, env, project } = await setup()
    await seedOrder(project.id, product.id, env.id, pm.id, { status: 'completed' })

    const result = await listApprovals()
    expect(result.ok).toBe(true)
    if (result.ok) expect(result.data).toEqual([])
  })

  /**
   * The approver's half of #325.
   *
   * The gates are asked again when the approval commits the order (#511), so a
   * `warn` cost centre would tell the approver nothing and a `block` one would
   * refuse them AFTER they clicked. The queue row is the last moment the decision
   * can be taken.
   */
  describe('budget on the queue row', () => {
    /**
     * A pending order that has since become unaffordable.
     *
     * The only way to reach this state is for the ceiling to MOVE while the
     * order waits — the budget check at creation already refuses an order that
     * would not fit, and the advisory lock means two creations cannot race past
     * it. Root lowering a budget is the ordinary case: the order was affordable
     * when it was requested and is not any more.
     */
    const overspentWhileWaiting = async () => {
      const base = await setup()
      await linkProductEnvironment(base.product.id, base.env.id, { price: '400.00', currency: 'EUR' })
      const centre = await createCostCenter()
      await db.update(costCenters).set({
        budgetAmount: '500.00', budgetCurrency: 'EUR', budgetPeriod: 'total', budgetBehaviour: 'block',
      }).where(eq(costCenters.id, centre.id))
      await db.update(projects).set({ costCenterId: centre.id }).where(eq(projects.id, base.project.id))
      const order = await seedOrder(base.project.id, base.product.id, base.env.id, base.pm.id, {
        status: 'pending',
      })

      // Root lowers the ceiling under the waiting order.
      await db.update(costCenters).set({ budgetAmount: '100.00' }).where(eq(costCenters.id, centre.id))
      return { ...base, centre, order }
    }

    it('refuses the approval when the ceiling moved while the order waited', async () => {
      /*
       * The gap this test exists for: the queue row renders the budget and says
       * `block`, and approving used to provision anyway — because `approveOrder`
       * claims the order and calls `provisionOrderElements` WITHOUT asking the
       * gate that the comment above claims runs here. The comment and the
       * `block` behaviour on the row both tell an approver that a spent budget
       * will refuse them after they click; only one of them was true.
       */
      const base = await overspentWhileWaiting()

      const result = await approveOrder(makeSession(base.admin), base.order.id)

      expect(result.ok).toBe(false)
      if (result.ok) return
      expect(result.status).toBe(409)
      expect(result.message).toMatch(/over budget/i)
    })

    it('leaves the order pending when the approval is refused for budget', async () => {
      // A refusal is not a rejection: the order is still a request somebody can
      // act on once the budget is raised again, and stranding it in
      // 'provisioning' would make it unapprovable and invisible to the sweep.
      const base = await overspentWhileWaiting()

      await approveOrder(makeSession(base.admin), base.order.id)

      const [row] = await db.select().from(orders).where(eq(orders.id, base.order.id))
      expect(row.status).toBe('pending')
      expect(await db.select().from(infrastructureElements)).toHaveLength(0)
    })

    it('still approves what the budget still allows', async () => {
      const base = await setup()
      await linkProductEnvironment(base.product.id, base.env.id, { price: '100.00', currency: 'EUR' })
      const centre = await createCostCenter()
      await db.update(costCenters).set({
        budgetAmount: '500.00', budgetCurrency: 'EUR', budgetPeriod: 'total', budgetBehaviour: 'block',
      }).where(eq(costCenters.id, centre.id))
      await db.update(projects).set({ costCenterId: centre.id }).where(eq(projects.id, base.project.id))
      const order = await seedOrder(base.project.id, base.product.id, base.env.id, base.pm.id, {
        status: 'pending',
      })

      const result = await approveOrder(makeSession(base.admin), order.id)
      expect(result.ok).toBe(true)
    })

    it('commits anyway when the budget only warns', async () => {
      /*
       * The control for the two refusals above, and the one a wrong check would
       * break: `warn` is the setting that says "tell me, do not stop me", and the
       * queue row has already told the approver. Reading the behaviour as
       * anything other than a refusal's precondition would turn every warn budget
       * into a block the moment a total moved.
       */
      const base = await priced('400.00')
      const centre = await budgeted('100.00', 'warn')
      await db.update(projects).set({ costCenterId: centre.id }).where(eq(projects.id, base.project.id))
      const order = await seedOrder(base.project.id, base.product.id, base.env.id, base.pm.id, {
        status: 'pending',
      })

      const result = await approveOrder(makeSession(base.admin), order.id)
      expect(result.ok).toBe(true)
    })

    const priced = async (price: string) => {
      const base = await setup()
      await linkProductEnvironment(base.product.id, base.env.id, { price, currency: 'EUR' })
      return base
    }

    const budgeted = async (amount: string, behaviour: 'warn' | 'block' = 'block') => {
      const centre = await createCostCenter()
      await db.update(costCenters).set({
        budgetAmount: amount, budgetCurrency: 'EUR', budgetPeriod: 'total', budgetBehaviour: behaviour,
      }).where(eq(costCenters.id, centre.id))
      return centre
    }

    it("follows the project's cost centre, not orders.cost_center_id alone", async () => {
      // The default 'project' mode stores no centre on the order, so a row that
      // read only `orders.cost_center_id` would report no budget for most of
      // the queue — the same trap costs.ts documents.
      const base = await priced('100.00')
      const centre = await budgeted('500.00')
      await db.update(projects).set({ costCenterId: centre.id }).where(eq(projects.id, base.project.id))
      await seedOrder(base.project.id, base.product.id, base.env.id, base.pm.id, { status: 'pending' })

      const result = await listApprovals()
      expect(result.ok).toBe(true)
      if (!result.ok) return
      expect(result.data[0].budget?.amount).toBe(500)
      expect(result.data[0].budget?.committed).toBe(100)
    })

    it('flags a row whose budget is already spent, with the behaviour that applies', async () => {
      const base = await priced('600.00')
      const centre = await budgeted('500.00', 'warn')
      await db.update(projects).set({ costCenterId: centre.id }).where(eq(projects.id, base.project.id))
      await seedOrder(base.project.id, base.product.id, base.env.id, base.pm.id, { status: 'pending' })

      const result = await listApprovals()
      expect(result.ok).toBe(true)
      if (!result.ok) return
      expect(result.data[0].budget?.exhausted).toBe(true)
      // Which one it is changes what approving means: `warn` goes through,
      // `block` is refused at the gate.
      expect(result.data[0].budget?.behaviour).toBe('warn')
    })

    it('carries no budget for a cost centre that has none', async () => {
      // A row saying "no limit" on every order would be noise on a queue where
      // budgets are opt-in.
      const base = await priced('100.00')
      const centre = await createCostCenter()
      await db.update(projects).set({ costCenterId: centre.id }).where(eq(projects.id, base.project.id))
      await seedOrder(base.project.id, base.product.id, base.env.id, base.pm.id, { status: 'pending' })

      const result = await listApprovals()
      expect(result.ok).toBe(true)
      if (!result.ok) return
      expect(result.data[0].budget).toBeNull()
    })

    it('carries no budget for an order with no cost centre at all', async () => {
      const base = await priced('100.00')
      await seedOrder(base.project.id, base.product.id, base.env.id, base.pm.id, { status: 'pending' })

      const result = await listApprovals()
      expect(result.ok).toBe(true)
      if (!result.ok) return
      expect(result.data[0].budget).toBeNull()
    })

    it('does not leak the project cost centre it looked up onto the row', async () => {
      // It is a lookup input, not part of the contract; shipping it would invite
      // a client to read it instead of `budget` and reintroduce the attribution
      // bug this whole path exists to avoid.
      const base = await priced('100.00')
      const centre = await budgeted('500.00')
      await db.update(projects).set({ costCenterId: centre.id }).where(eq(projects.id, base.project.id))
      await seedOrder(base.project.id, base.product.id, base.env.id, base.pm.id, { status: 'pending' })

      const result = await listApprovals()
      expect(result.ok).toBe(true)
      if (!result.ok) return
      expect(result.data[0]).not.toHaveProperty('projectCostCenterId')
    })
  })
})

describe('approveOrder', () => {
  it('returns 404 for unknown order', async () => {
    const { admin } = await setup()
    const result = await approveOrder(makeSession(admin), 999_999)
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.status).toBe(404)
  })

  it('returns 400 when order is not pending', async () => {
    const { admin, pm, product, env, project } = await setup()
    const order = await seedOrder(project.id, product.id, env.id, pm.id, { status: 'completed' })

    const result = await approveOrder(makeSession(admin), order.id)
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.status).toBe(400)
  })

  it('updates order status to provisioning, creates infra, triggers webhooks, notifies, returns success', async () => {
    const { admin, pm, product, env, project } = await setup()
    const order = await seedOrder(project.id, product.id, env.id, pm.id, { status: 'pending' })
    mockedWebhooks.mockResolvedValueOnce({ pipelineIds: ['pipe-approved'], failures: [] })

    const result = await approveOrder(makeSession(admin), order.id)
    expect(result.ok).toBe(true)
    if (!result.ok) return

    expect(result.data.success).toBe(true)
    // Narrows the union: this environment does not respect deployment windows,
    // so the approval provisioned rather than scheduling (#330).
    if (result.data.scheduled) throw new Error('expected an immediate provision, got a scheduled one')
    expect(result.data.pipelineIds).toEqual(['pipe-approved'])
    expect(result.data.infraId).toBeDefined()

    // Order updated in DB
    const [dbOrder] = await db.select().from(orders).where(eq(orders.id, order.id))
    expect(dbOrder.status).toBe('provisioning')
    expect(dbOrder.pipelineId).toEqual(['pipe-approved'])

    // Infra created in DB
    const infra = await db
      .select()
      .from(infrastructureElements)
      .where(eq(infrastructureElements.orderId, order.id))
    expect(infra.length).toBe(1)

    // Webhook triggered with ORDER_ID
    expect(mockedWebhooks).toHaveBeenCalledTimes(1)
    const [pid, eid, vars] = mockedWebhooks.mock.calls[0]
    expect(pid).toBe(product.id)
    expect(eid).toBe(env.id)
    expect(vars).toMatchObject({ ORDER_ID: String(order.id) })

    // Notification sent to the order's owner
    expect(mockedApproved).toHaveBeenCalledTimes(1)
    expect(mockedApproved.mock.calls[0][0]).toBe('pm@test.dev')
  })
})

describe('rejectOrder', () => {
  it('returns 404 for unknown order', async () => {
    const { admin } = await setup()
    const result = await rejectOrder(makeSession(admin), 999_999, 'no')
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.status).toBe(404)
  })

  it('returns 400 when order is not pending', async () => {
    const { admin, pm, product, env, project } = await setup()
    const order = await seedOrder(project.id, product.id, env.id, pm.id, { status: 'completed' })

    const result = await rejectOrder(makeSession(admin), order.id, 'because')
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.status).toBe(400)
  })

  it('updates status to rejected with rejectionNote, notifies, returns ok(undefined)', async () => {
    const { admin, pm, product, env, project } = await setup()
    const order = await seedOrder(project.id, product.id, env.id, pm.id, { status: 'pending' })

    const result = await rejectOrder(makeSession(admin), order.id, 'Budget exceeded')
    expect(result.ok).toBe(true)
    if (result.ok) expect(result.data).toBeUndefined()

    const [dbOrder] = await db.select().from(orders).where(eq(orders.id, order.id))
    expect(dbOrder.status).toBe('rejected')
    expect(dbOrder.rejectionNote).toBe('Budget exceeded')

    expect(mockedRejected).toHaveBeenCalledTimes(1)
    expect(mockedRejected.mock.calls[0][0]).toBe('pm@test.dev')
    expect(mockedRejected.mock.calls[0][3]).toBe('Budget exceeded')
  })
})

// Issue #1. A project manager's trial waits for approval like any other order, so
// approval is where the trial is actually provisioned — and where its clock has to
// start. Starting it at order time could burn the whole trial, or expire it
// outright, before the infrastructure existed.
describe('approveOrder — time-boxed trials', () => {
  const buildTrial = async (over?: { trialEnabled?: boolean; trialDurationMinutes?: number }) => {
    const ctx = await setup()
    await linkProductEnvironment(ctx.product.id, ctx.env.id, { trialEnabled: true, ...over })
    return ctx
  }

  const infraFor = async (orderId: number) =>
    (await db.select().from(infrastructureElements).where(eq(infrastructureElements.orderId, orderId)))[0]

  it('starts the clock at approval, not at order time', async () => {
    const ctx = await buildTrial({ trialDurationMinutes: 30 })
    const order = await seedOrder(ctx.project.id, ctx.product.id, ctx.env.id, ctx.pm.id, {
      status: 'pending',
      isTrial: true,
    })

    const approvedAt = Date.now()
    const result = await approveOrder(makeSession(ctx.admin), order.id)
    expect(result.ok).toBe(true)

    const infra = await infraFor(order.id)
    const expiry = infra.scheduledDecommissionAt?.getTime() ?? 0
    expect(expiry).toBeGreaterThanOrEqual(approvedAt + 30 * 60_000)
    expect(expiry).toBeLessThanOrEqual(Date.now() + 30 * 60_000)
  })

  it('passes the trial variables to CI on approval', async () => {
    const ctx = await buildTrial({ trialDurationMinutes: 45 })
    const order = await seedOrder(ctx.project.id, ctx.product.id, ctx.env.id, ctx.pm.id, {
      status: 'pending',
      isTrial: true,
    })

    await approveOrder(makeSession(ctx.admin), order.id)
    expect(mockedWebhooks).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      expect.objectContaining({ TRIAL: 'true', TRIAL_DURATION_MINUTES: '45' }),
      // The recorder that stores each pipeline id as it starts (issue #132).
      expect.any(Function),
    )
  })

  it('applies a duration an admin corrected while the order was pending', async () => {
    // Re-read from the offering rather than snapshotted on the order, so the
    // current configuration is the one that applies.
    const ctx = await buildTrial({ trialDurationMinutes: 30 })
    const order = await seedOrder(ctx.project.id, ctx.product.id, ctx.env.id, ctx.pm.id, {
      status: 'pending',
      isTrial: true,
    })
    await db
      .update(productEnvironments)
      .set({ trialDurationMinutes: 90 })
      .where(eq(productEnvironments.productId, ctx.product.id))

    await approveOrder(makeSession(ctx.admin), order.id)
    expect(mockedWebhooks).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      expect.objectContaining({ TRIAL_DURATION_MINUTES: '90' }),
      expect.any(Function),
    )
  })

  it('falls back to 30 minutes when the offering was withdrawn while pending', async () => {
    // Blocking an approval an admin already decided on would be worse; the trial
    // is still torn down.
    const ctx = await setup()
    const order = await seedOrder(ctx.project.id, ctx.product.id, ctx.env.id, ctx.pm.id, {
      status: 'pending',
      isTrial: true,
    })

    const approvedAt = Date.now()
    const result = await approveOrder(makeSession(ctx.admin), order.id)
    expect(result.ok).toBe(true)

    const infra = await infraFor(order.id)
    const expiry = infra.scheduledDecommissionAt?.getTime() ?? 0
    expect(expiry).toBeGreaterThanOrEqual(approvedAt + 30 * 60_000)
  })

  it('leaves a non-trial approval unscheduled and un-flagged', async () => {
    const ctx = await buildTrial()
    const order = await seedOrder(ctx.project.id, ctx.product.id, ctx.env.id, ctx.pm.id, { status: 'pending' })

    await approveOrder(makeSession(ctx.admin), order.id)

    const infra = await infraFor(order.id)
    expect(infra.scheduledDecommissionAt).toBeNull()
    const vars = mockedWebhooks.mock.calls[0][2] as Record<string, string>
    expect(vars.TRIAL).toBeUndefined()
  })

  it('surfaces the trial flag in the approval queue', async () => {
    // It changes what the approver is agreeing to: a trial is torn down shortly
    // after it comes up and asks the pipeline for elevated rights inside it.
    const ctx = await buildTrial()
    await seedOrder(ctx.project.id, ctx.product.id, ctx.env.id, ctx.pm.id, { status: 'pending', isTrial: true })

    const result = await listApprovals()
    expect(result.ok).toBe(true)
    if (result.ok) expect(result.data[0].isTrial).toBe(true)
  })
})

// Issue #35. Two rules meet here, and the second exists because of the first:
// a delegation transfers AUTHORITY, and the one thing authority may never buy is
// permission to approve your own order.
describe('approveOrder — separation of duties', () => {
  it('refuses to let the orderer approve their own order', async () => {
    const { product, env, project } = await setup()
    // A project manager who was promoted to admin still has their old pending
    // orders in the queue — that is how an admin ends up as the orderer.
    const promoted = await createUser({ role: 'admin', email: 'promoted@test.dev', name: 'Promoted' })
    const order = await seedOrder(project.id, product.id, env.id, promoted.id, { status: 'pending' })

    const result = await approveOrder(makeSession(promoted), order.id)
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.status).toBe(403)

    // Checked BEFORE the claim: a refusal after it would strand the order.
    const [dbOrder] = await db.select().from(orders).where(eq(orders.id, order.id))
    expect(dbOrder.status).toBe('pending')
    expect(mockedWebhooks).not.toHaveBeenCalled()
  })

  it('a delegation does not buy the orderer the right to approve their own order', async () => {
    const { admin, product, env, project } = await setup()
    const orderer = await createUser({ role: 'admin', email: 'orderer@test.dev', name: 'Orderer' })
    const order = await seedOrder(project.id, product.id, env.id, orderer.id, { status: 'pending' })

    // The admin delegates to the very person who placed the order. The
    // delegation is legal; using it to self-approve is not, because the check
    // compares the ACTOR with the orderer and the actor is still the orderer.
    await seedDelegation(admin.id, orderer.id, { startsInDays: 0, endsInDays: 5 })

    const result = await approveOrder(makeSession(orderer), order.id)
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.status).toBe(403)
  })

  it('still lets an admin withdraw their own order by rejecting it', async () => {
    const { product, env, project } = await setup()
    const owner = await createUser({ role: 'admin', email: 'owner@test.dev', name: 'Owner' })
    const order = await seedOrder(project.id, product.id, env.id, owner.id, { status: 'pending' })

    expect((await rejectOrder(makeSession(owner), order.id, 'Changed my mind')).ok).toBe(true)
  })

  it('returns 404 rather than leaking the guard for an unknown order', async () => {
    const { admin } = await setup()
    const result = await approveOrder(makeSession(admin), 999_999)
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.status).toBe(404)
  })
})

describe('approveOrder — auditing a delegation in use', () => {
  const entriesFor = async (action: string) =>
    db.select().from(auditLog).where(eq(auditLog.action, action))

  it('names the actor AND the authority they were holding', async () => {
    const { admin, pm, product, env, project } = await setup()
    const substitute = await createUser({ role: 'admin', email: 'sub@test.dev', name: 'Sub' })
    const delegation = await seedDelegation(admin.id, substitute.id, { startsInDays: 0, endsInDays: 5 })
    const order = await seedOrder(project.id, product.id, env.id, pm.id, { status: 'pending' })

    expect((await approveOrder(makeSession(substitute), order.id)).ok).toBe(true)

    // "Who approved this?" — the substitute, under their own id and address.
    const approved = await entriesFor('order.approved')
    expect(approved).toHaveLength(1)
    expect(approved[0].userId).toBe(substitute.id)
    expect(approved[0].entityId).toBe(order.id)
    expect(approved[0].details).toContain('sub@test.dev')
    // "Under whose authority?" — named in the same entry.
    expect(approved[0].details).toContain(`#${delegation.id}`)
    expect(approved[0].details).toContain('admin@test.dev')

    // And keyed on the DELEGATION, so "what was done under delegation N" is a
    // filter rather than a full-text hunt through order entries.
    const used = await entriesFor('approval_delegation.used')
    expect(used).toHaveLength(1)
    expect(used[0].userId).toBe(substitute.id)
    expect(used[0].entityId).toBe(delegation.id)
    expect(used[0].details).toContain(`order #${order.id}`)
    expect(used[0].details).toContain('admin@test.dev')
  })

  it('records nothing about delegation when the approver holds none', async () => {
    const { admin, pm, product, env, project } = await setup()
    const order = await seedOrder(project.id, product.id, env.id, pm.id, { status: 'pending' })

    expect((await approveOrder(makeSession(admin), order.id)).ok).toBe(true)

    const approved = await entriesFor('order.approved')
    expect(approved[0].details).not.toContain('delegat')
    expect(await entriesFor('approval_delegation.used')).toEqual([])
  })

  it('ignores an expired delegation — no job had to expire it', async () => {
    const { admin, pm, product, env, project } = await setup()
    const substitute = await createUser({ role: 'admin', email: 'sub@test.dev', name: 'Sub' })
    await seedDelegation(admin.id, substitute.id, { startsInDays: -10, endsInDays: -1 })
    const order = await seedOrder(project.id, product.id, env.id, pm.id, { status: 'pending' })

    expect((await approveOrder(makeSession(substitute), order.id)).ok).toBe(true)
    expect(await entriesFor('approval_delegation.used')).toEqual([])
  })

  it('records every authority a substitute covering two admins was holding', async () => {
    const { admin, pm, product, env, project } = await setup()
    const other = await createUser({ role: 'admin', email: 'other@test.dev', name: 'Other' })
    const substitute = await createUser({ role: 'admin', email: 'sub@test.dev', name: 'Sub' })
    await seedDelegation(admin.id, substitute.id, { startsInDays: 0, endsInDays: 5 })
    await seedDelegation(other.id, substitute.id, { startsInDays: 0, endsInDays: 5 })
    const order = await seedOrder(project.id, product.id, env.id, pm.id, { status: 'pending' })

    expect((await approveOrder(makeSession(substitute), order.id)).ok).toBe(true)
    expect(await entriesFor('approval_delegation.used')).toHaveLength(2)
  })

  it('audits the authority in force at the CLAIM, not at logging time', async () => {
    const { admin, pm, product, env, project } = await setup()
    const substitute = await createUser({ role: 'admin', email: 'sub@test.dev', name: 'Sub' })
    const delegation = await seedDelegation(admin.id, substitute.id, { startsInDays: 0, endsInDays: 5 })
    const order = await seedOrder(project.id, product.id, env.id, pm.id, { status: 'pending' })

    // Provisioning is not instant, so the delegation can end — expire at midnight,
    // or be revoked by the delegator — between the decision and the audit write.
    // The authority that has to be recorded is the one the approval was taken
    // under; re-reading it afterwards would record an approval as unauthorised.
    mockedWebhooks.mockImplementation(async () => {
      await db
        .update(approvalDelegations)
        .set({ revokedAt: new Date() })
        .where(eq(approvalDelegations.id, delegation.id))
      return { pipelineIds: ['pipe-42'], failures: [] }
    })

    expect((await approveOrder(makeSession(substitute), order.id)).ok).toBe(true)

    const approved = await entriesFor('order.approved')
    expect(approved[0].details).toContain(`#${delegation.id}`)
    const used = await entriesFor('approval_delegation.used')
    expect(used).toHaveLength(1)
    expect(used[0].entityId).toBe(delegation.id)
  })

  it('audits a rejection under delegation the same way', async () => {
    const { admin, pm, product, env, project } = await setup()
    const substitute = await createUser({ role: 'admin', email: 'sub@test.dev', name: 'Sub' })
    const delegation = await seedDelegation(admin.id, substitute.id, { startsInDays: 0, endsInDays: 5 })
    const order = await seedOrder(project.id, product.id, env.id, pm.id, { status: 'pending' })

    expect((await rejectOrder(makeSession(substitute), order.id, 'Out of budget')).ok).toBe(true)

    const rejected = await entriesFor('order.rejected')
    expect(rejected[0].details).toContain('sub@test.dev')
    expect(rejected[0].details).toContain('Out of budget')
    const used = await entriesFor('approval_delegation.used')
    expect(used).toHaveLength(1)
    expect(used[0].entityId).toBe(delegation.id)
    expect(used[0].details).toContain('rejected')
  })

  /*
   * The claim is what makes this caller the one acting on the order, and it has
   * already moved it out of 'pending' by the time the window policy is read.
   *
   * A policy read that throws used to leave the order in 'provisioning' for
   * good: no second approval can claim it, because the claim is conditioned on
   * 'pending', and the window sweep never sees it, because that only looks at
   * 'scheduled'. Nothing has been provisioned at that point, so the claim must
   * come back off.
   */
  it('releases the claim when the window policy cannot be read', async () => {
    const { admin, pm, product, env, project } = await setup()
    const order = await seedOrder(project.id, product.id, env.id, pm.id, { status: 'pending' })
    vi.mocked(whenMayItDeploy).mockRejectedValueOnce(new Error('deployment_windows is unreadable'))

    await expect(approveOrder(makeSession(admin), order.id)).rejects.toThrow('unreadable')

    const [row] = await db.select().from(orders).where(eq(orders.id, order.id))
    expect(row.status, 'the order is stranded: nothing can claim it and no sweep looks at it').toBe('pending')
  })
})

/*
 * The gates are re-asked when the approval COMMITS the order (#110, #325).
 *
 * An approval is a second decision, taken later than the first, and everything
 * the first decision was based on can have moved in between: the ceiling, the
 * cost centre, the policy. `createPreparedOrder` asks once, when the order is a
 * REQUEST; `approveOrder` is where the money is actually spent and the
 * infrastructure actually built, and it asked nothing at all. Both comments —
 * the queue row's and the budget gate's — said the check happened here. Neither
 * did.
 */
describe('approveOrder — the gates are re-asked at the point of commitment', () => {
  afterEach(() => vi.restoreAllMocks())

  const deny = () =>
    vi.spyOn(global, 'fetch').mockResolvedValue(
      new Response(
        JSON.stringify({
          result: { decision: 'deny', rule: 'quota/vm-count', message: 'This project is at its limit' },
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      ),
    )

  const allow = () =>
    vi.spyOn(global, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ result: { decision: 'allow', rule: 'baseline' } }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    )

  /** A pending order, and an OPA engine that can be pointed at it. */
  const waiting = async () => {
    const base = await setup()
    const root = await createUser({ role: 'root', email: 'root@test.dev', name: 'Root' })
    await createIntegration(root.id, {
      kind: 'opa',
      name: 'Policy engine',
      baseUrl: 'https://opa.example.com',
      authType: 'none',
      failureMode: 'blocking',
    })
    const order = await seedOrder(base.project.id, base.product.id, base.env.id, base.pm.id, {
      status: 'pending',
    })
    return { ...base, root, order }
  }

  it('refuses the approval when a policy denies the order by then', async () => {
    /*
     * #110's own open question — "what happens to an order that policy would
     * deny after it was approved but before it ran" — answered the other way
     * round: the order was allowed when it was requested, and the rule that
     * would refuse it exists by the time somebody approves it. Provisioning it
     * anyway is the policy being advisory exactly where it is a control.
     */
    const base = await waiting()
    deny()

    const result = await approveOrder(makeSession(base.admin), base.order.id)

    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.status).toBe(409)
    expect(result.message).toContain('quota/vm-count')
    expect(result.message).toContain('This project is at its limit')
  })

  it('leaves the order pending, and provisions nothing, when a policy refuses it', async () => {
    // Refused, not rejected: the rule can be argued with, changed, or waived, and
    // an order that had already been built would be none of those.
    const base = await waiting()
    deny()

    await approveOrder(makeSession(base.admin), base.order.id)

    const [row] = await db.select().from(orders).where(eq(orders.id, base.order.id))
    expect(row.status).toBe('pending')
    expect(await db.select().from(infrastructureElements)).toHaveLength(0)
  })

  it('records the refusal, so a queue that will not clear can be explained', async () => {
    const base = await waiting()
    deny()

    await approveOrder(makeSession(base.admin), base.order.id)

    // One action name for "policy refused this order as it was about to be
    // built", whichever seam did the building — the seam itself is in the
    // details, because "the policy refused order 12" reads very differently
    // depending on whether an admin was clicking Approve or a window opened.
    const entries = await db.select().from(auditLog).where(eq(auditLog.action, 'order.policy_denied'))
    expect(entries).toHaveLength(1)
    expect(entries[0].details).toContain('quota/vm-count')
    expect(entries[0].details).toContain('when it was approved')
    expect(entries[0].userId).toBe(base.admin.id)
  })

  it('lets root waive the refusal at the moment of approval', async () => {
    // The same escape as ordering (#110 slice 5), for the same reason: a rule
    // with no way past it turns a policy mistake into an outage, and root's
    // override is what makes that acceptable — recorded, with the rule waived.
    const base = await waiting()
    deny()

    const result = await approveOrder(makeSession(base.root), base.order.id, { overridePolicy: true })

    expect(result.ok).toBe(true)
    const entries = await db
      .select()
      .from(auditLog)
      .where(eq(auditLog.action, 'order.policy_overridden'))
    expect(entries).toHaveLength(1)
    expect(entries[0].details).toContain('quota/vm-count')
  })

  it('does not let a non-root approver waive it', async () => {
    const base = await waiting()
    deny()

    const result = await approveOrder(makeSession(base.admin), base.order.id, { overridePolicy: true })

    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.status).toBe(409)
  })

  it('commits an order whose policy now asks for an approval, because the approval is it', async () => {
    /*
     * #110's third answer, at the commit seam. A rule that asks for a person is
     * SATISFIED by the person: the order would not be here if they had not
     * clicked Approve, so refusing it as though the rule were unmet would make
     * such a rule deadlock the queue — approvable by nobody, refusable by the
     * engine forever.
     *
     * The ordering path is where the rule does its work (the order is written
     * `pending`), which is why nothing is expected of the commit beyond letting
     * it through.
     */
    const base = await waiting()
    vi.spyOn(global, 'fetch').mockResolvedValue(
      new Response(
        JSON.stringify({
          result: {
            decision: 'needs-approval',
            rule: 'sod/production',
            message: 'Production needs a second pair of eyes.',
          },
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      ),
    )

    const result = await approveOrder(makeSession(base.admin), base.order.id)

    expect(result.ok).toBe(true)
    const [row] = await db.select().from(orders).where(eq(orders.id, base.order.id))
    expect(row.status).toBe('provisioning')
    const denied = await db.select().from(auditLog).where(eq(auditLog.action, 'order.policy_denied'))
    expect(denied).toHaveLength(0)
  })

  it('still approves what policy still allows', async () => {
    const base = await waiting()
    allow()

    const result = await approveOrder(makeSession(base.admin), base.order.id)
    expect(result.ok).toBe(true)
  })

  it('carries a warning that arrives at commit to the approver, and to the log', async () => {
    /*
     * A rule that has changed into a `warn` by the time somebody approves is the
     * case with the quietest failure mode: the order goes through (correctly),
     * and the only thing that can carry the message is the approver's own
     * response — with the sweep binding it has no response at all, which is why
     * the entry is written where the verdict is made rather than by each caller.
     */
    const base = await waiting()
    vi.spyOn(global, 'fetch').mockResolvedValue(
      new Response(
        JSON.stringify({ result: { decision: 'warn', rule: 'quota/near-limit', message: 'Nearly at the limit.' } }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      ),
    )

    const result = await approveOrder(makeSession(base.admin), base.order.id)

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.data.policyWarning).toBe('Nearly at the limit.')

    const entries = await db.select().from(auditLog).where(eq(auditLog.action, 'order.policy_warning'))
    expect(entries).toHaveLength(1)
    expect(entries[0].details).toContain('quota/near-limit')
    expect(entries[0].details).toContain('when it was approved')
  })

  it('leaves approvals alone when no engine is configured', async () => {
    // The state every installation starts in, and the one this must not change.
    const { admin, pm, product, env, project } = await setup()
    const order = await seedOrder(project.id, product.id, env.id, pm.id, { status: 'pending' })
    const fetchMock = vi.spyOn(global, 'fetch')

    const result = await approveOrder(makeSession(admin), order.id)
    expect(result.ok).toBe(true)
    expect(fetchMock).not.toHaveBeenCalled()
  })
})
