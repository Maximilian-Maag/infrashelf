import { describe, it, expect, vi, beforeEach } from 'vitest'
import { and, eq } from 'drizzle-orm'
import { db } from '@/lib/db/client'
import { auditLog, costCenters, orders, projects, users } from '@/lib/db/schema'
import {
  createUser, createCategory, createProduct, createCiSource,
  createEnvironment, createProject, createOrder, createCostCenter, linkProductEnvironment,
} from '@/test/helpers'
import { evaluateOrderPolicy } from '@/lib/policy/gate'
import { logWaivers, recheckOrderGates, type CommitActor, type CommitContext, type CommitWaiver } from './commitGates'
import type * as GateModule from '@/lib/policy/gate'

/*
 * The policy engine is mocked; everything else is real.
 *
 * These tests are about what `recheckOrderGates` DOES with a verdict, not about
 * how the verdict is reached — that is `gate.ts` and `orderDocument.ts`, tested
 * next door. Controlling the outcome here is what makes each branch of the commit
 * gate reachable at all: an engine that denies on demand, warns on demand, and
 * does nothing on demand.
 *
 * The budget and the audit log are NOT mocked: the arithmetic at commit is the
 * whole point of the module (#511), and an assertion that an audit entry was
 * written is only honest when read back out of the table.
 */
vi.mock('@/lib/policy/gate', async (importOriginal) => ({
  ...(await importOriginal<typeof GateModule>()),
  evaluateOrderPolicy: vi.fn(),
}))

const OK_VERDICT = { outcome: 'ok' as const, rule: null, message: null }

/** The requester's own email and role, so a policy asked "as the requester" has
 *  something to be asked with. */
const setup = async (
  over: {
    price?: string
    /** Set all four budget columns together, as the table's CHECK requires. */
    budget?: { amount: string; currency?: string; period?: 'total' | 'monthly'; behaviour?: 'warn' | 'block' }
    /** Put the cost centre on the ORDER ('select'/'overhead') rather than the project. */
    onOrder?: boolean
    requesterRole?: 'admin' | 'project_manager' | 'root'
  } = {},
) => {
  const user = await createUser({
    role: over.requesterRole ?? 'project_manager',
    email: `requester-${Math.random()}@test.dev`,
  })
  const category = await createCategory()
  const product = await createProduct(category.id)
  const ci = await createCiSource()
  const environment = await createEnvironment(ci.id)
  const project = await createProject(user.id)

  await linkProductEnvironment(product.id, environment.id, {
    price: over.price ?? '100.00',
    currency: 'EUR',
  })

  const centre = await createCostCenter({ code: 'CC-GATE', name: 'Gating Centre' })
  if (over.budget) {
    await db.update(costCenters).set({
      budgetAmount: over.budget.amount,
      budgetCurrency: over.budget.currency ?? 'EUR',
      budgetPeriod: over.budget.period ?? 'total',
      budgetBehaviour: over.budget.behaviour ?? 'block',
    }).where(eq(costCenters.id, centre.id))
  }

  const order = await createOrder(project.id, product.id, environment.id, user.id, { status: 'pending' })
  if (over.onOrder) {
    await db.update(orders).set({ costCenterId: centre.id }).where(eq(orders.id, order.id))
  } else {
    await db.update(projects).set({ costCenterId: centre.id }).where(eq(projects.id, project.id))
  }

  return { user, project, product, environment, centre, order }
}

const context = (over: Partial<CommitContext> & { seam: string }): CommitContext => over

const auditFor = (orderId: number, action?: string) =>
  db
    .select()
    .from(auditLog)
    .where(action
      ? and(eq(auditLog.entityId, orderId), eq(auditLog.action, action))
      : eq(auditLog.entityId, orderId))
    .orderBy(auditLog.id)

beforeEach(() => {
  vi.mocked(evaluateOrderPolicy).mockReset()
  vi.mocked(evaluateOrderPolicy).mockResolvedValue(OK_VERDICT)
})

describe('recheckOrderGates', () => {
  it('is a 404 for an order that does not exist', async () => {
    const result = await recheckOrderGates(999_999, context({ seam: 'while approving' }))

    expect(result).toEqual({ ok: false, status: 404, message: 'Order not found' })
    expect(vi.mocked(evaluateOrderPolicy)).not.toHaveBeenCalled()
  })

  describe('the budget', () => {
    it('refuses an over-budget order, naming the centre, the two figures and the window', async () => {
      const { order, user } = await setup({ price: '600.00', budget: { amount: '500.00' } })
      const actor: CommitActor = { id: user.id, email: user.email, role: 'project_manager' }

      const result = await recheckOrderGates(order.id, context({ seam: 'while approving', actor }))

      expect(result).toMatchObject({ ok: false, status: 409, code: 'budget_blocked' })
      if (result.ok) throw new Error('expected a refusal')
      // The sentence the approver reads: which centre, what is committed, what
      // the ceiling is, and that the period is a total rather than a month.
      expect(result.message).toContain('CC-GATE — Gating Centre')
      expect(result.message).toContain('600.00 EUR of 500.00 EUR committed in total')
      expect(result.message).toContain('is over budget')
      expect(result.message).toContain('this order is part of it')
    })

    it('records the refusal as order.budget_denied, with the seam it happened at', async () => {
      const { order, user } = await setup({ price: '600.00', budget: { amount: '500.00' } })
      const actor: CommitActor = { id: user.id, email: user.email, role: 'project_manager' }

      await recheckOrderGates(order.id, context({ seam: 'while approving', actor }))

      const entries = await auditFor(order.id, 'order.budget_denied')
      expect(entries).toHaveLength(1)
      expect(entries[0]?.details).toContain('while approving')
      expect(entries[0]?.details).toContain(user.email)
    })

    it('names the requester and the sweep when nobody is committing', async () => {
      const { order, user } = await setup({ price: '600.00', budget: { amount: '500.00' } })

      await recheckOrderGates(order.id, context({ seam: 'when the window opened' }))

      const [entry] = await auditFor(order.id, 'order.budget_denied')
      expect(entry?.userId).toBeNull()
      expect(entry?.details).toContain(`${user.email} (by the sweep)`)
    })

    it('passes a budget of exactly the committed total (strictly greater, not equal)', async () => {
      // The reason the arithmetic differs from the ordering path's: the order's
      // own cost is already inside `committed`, so 500 of 500 is inside the
      // budget and must not be refused. A `>=` here would fail this test.
      const { order, user } = await setup({ price: '500.00', budget: { amount: '500.00' } })
      const actor: CommitActor = { id: user.id, email: user.email, role: 'project_manager' }

      const result = await recheckOrderGates(order.id, context({ seam: 'while approving', actor }))

      expect(result.ok).toBe(true)
      expect(await auditFor(order.id, 'order.budget_denied')).toEqual([])
    })

    it('says "this month" for a monthly budget', async () => {
      const { order, user } = await setup({
        price: '600.00',
        budget: { amount: '500.00', period: 'monthly' },
      })
      const actor: CommitActor = { id: user.id, email: user.email, role: 'project_manager' }

      const result = await recheckOrderGates(order.id, context({ seam: 'while approving', actor }))

      if (result.ok) throw new Error('expected a refusal')
      expect(result.message).toContain('committed this month')
      expect(result.message).not.toContain('in total')
    })

    it('never refuses a cost centre with no budget, even with spend against it', async () => {
      const { order, user } = await setup({ price: '10_000.00' })
      const actor: CommitActor = { id: user.id, email: user.email, role: 'project_manager' }

      const result = await recheckOrderGates(order.id, context({ seam: 'while approving', actor }))

      expect(result.ok).toBe(true)
      expect(await auditFor(order.id, 'order.budget_denied')).toEqual([])
    })

    it('never refuses a warn budget, however far over it is', async () => {
      const { order, user } = await setup({
        price: '600.00',
        budget: { amount: '500.00', behaviour: 'warn' },
      })
      const actor: CommitActor = { id: user.id, email: user.email, role: 'project_manager' }

      const result = await recheckOrderGates(order.id, context({ seam: 'while approving', actor }))

      expect(result.ok).toBe(true)
      expect(await auditFor(order.id, 'order.budget_denied')).toEqual([])
    })

    it('uses the order\u2019s own cost centre ahead of the project\u2019s', async () => {
      // The order carries its own centre (the 'select'/'overhead' modes); the
      // project carries a different, budget-less one. Reading the project's would
      // let a spent ceiling through.
      const { order, user, project } = await setup({
        price: '600.00',
        budget: { amount: '500.00' },
        onOrder: true,
      })
      const other = await createCostCenter({ code: 'CC-OTHER', name: 'No Budget Here' })
      await db.update(projects).set({ costCenterId: other.id }).where(eq(projects.id, project.id))
      const actor: CommitActor = { id: user.id, email: user.email, role: 'project_manager' }

      const result = await recheckOrderGates(order.id, context({ seam: 'while approving', actor }))

      expect(result).toMatchObject({ ok: false, code: 'budget_blocked' })
      if (result.ok) throw new Error('expected a refusal')
      expect(result.message).toContain('CC-GATE — Gating Centre')
    })

    describe('root\u2019s escape (#325, #514)', () => {
      const rootActor = async (): Promise<CommitActor> => {
        const root = await createUser({ role: 'root', email: `root-${Math.random()}@test.dev` })
        return { id: root.id, email: root.email, role: 'root' }
      }

      it('turns the refusal into a waiver for root, and writes nothing yet', async () => {
        const { order } = await setup({ price: '600.00', budget: { amount: '500.00' } })
        const actor = await rootActor()

        const result = await recheckOrderGates(
          order.id,
          context({ seam: 'while approving', actor, overrideBudget: true }),
        )

        if (!result.ok) throw new Error('expected the escape to be accepted')
        expect(result.data.waivers).toHaveLength(1)
        const waiver = result.data.waivers[0]
        if (!waiver) throw new Error('expected a budget waiver')
        expect(waiver.action).toBe('order.budget_overridden')
        expect(waiver.details).toContain(actor.email)
        expect(waiver.details).toContain('while approving')
        expect(waiver.details).toContain('600.00 EUR of 500.00 EUR')
        // Nothing written at the gate (#521): asking is not committing, and the
        // caller writes the waiver where it commits the order.
        expect(await auditFor(order.id)).toEqual([])
      })

      it('still refuses a non-root actor who asks for the override', async () => {
        const { order, user } = await setup({ price: '600.00', budget: { amount: '500.00' } })
        const actor: CommitActor = { id: user.id, email: user.email, role: 'admin' }

        const result = await recheckOrderGates(
          order.id,
          context({ seam: 'while approving', actor, overrideBudget: true }),
        )

        expect(result).toMatchObject({ ok: false, status: 409, code: 'budget_blocked' })
        expect(await auditFor(order.id, 'order.budget_denied')).toHaveLength(1)
      })

      it('grants no waiver to root when the budget is only a warning', async () => {
        const { order } = await setup({
          price: '600.00',
          budget: { amount: '500.00', behaviour: 'warn' },
        })
        const actor = await rootActor()

        const result = await recheckOrderGates(
          order.id,
          context({ seam: 'while approving', actor, overrideBudget: true }),
        )

        if (!result.ok) throw new Error('expected the order through')
        expect(result.data.waivers).toEqual([])
      })
    })
  })

  describe('the policy', () => {
    it('refuses on a deny, and records it as order.policy_denied', async () => {
      const { order, user } = await setup()
      const actor: CommitActor = { id: user.id, email: user.email, role: 'admin' }
      vi.mocked(evaluateOrderPolicy).mockResolvedValue({
        outcome: 'deny', rule: 'quota/vm-count', message: 'At the limit',
      })

      const result = await recheckOrderGates(order.id, context({ seam: 'while approving', actor }))

      expect(result).toMatchObject({ ok: false, status: 409, code: 'policy_denied' })
      if (result.ok) throw new Error('expected a refusal')
      expect(result.message).toBe('At the limit')
      const entries = await auditFor(order.id, 'order.policy_denied')
      expect(entries).toHaveLength(1)
      expect(entries[0]?.details).toContain('At the limit')
      expect(entries[0]?.details).toContain('while approving')
    })

    it('asks the policy as the requester, never as the actor', async () => {
      // A policy that counts a project's VMs must not be told an admin is the
      // one asking. The requester is a project_manager; the actor is root.
      const { order, user, centre } = await setup({ requesterRole: 'project_manager' })
      const root = await createUser({ role: 'root', email: `root-${Math.random()}@test.dev` })
      const actor: CommitActor = { id: root.id, email: root.email, role: 'root' }

      await recheckOrderGates(order.id, context({ seam: 'while approving', actor }))

      expect(vi.mocked(evaluateOrderPolicy)).toHaveBeenCalledWith(
        expect.objectContaining({ projectId: order.projectId, environmentId: order.environmentId, costCenterId: centre.id }),
        { id: user.id, email: user.email, role: 'project_manager' },
      )
    })

    it('lets root step over a policy deny, with a waiver and no warning', async () => {
      const { order } = await setup()
      const root = await createUser({ role: 'root', email: `root-${Math.random()}@test.dev` })
      const actor: CommitActor = { id: root.id, email: root.email, role: 'root' }
      vi.mocked(evaluateOrderPolicy).mockResolvedValue({
        outcome: 'deny', rule: 'quota/vm-count', message: 'At the limit',
      })

      const result = await recheckOrderGates(
        order.id,
        context({ seam: 'while approving', actor, overridePolicy: true }),
      )

      if (!result.ok) throw new Error('expected the escape to be accepted')
      expect(result.data.policyWarning).toBeNull()
      expect(result.data.waivers).toHaveLength(1)
      expect(result.data.waivers[0]?.action).toBe('order.policy_overridden')
      expect(result.data.waivers[0]?.details).toContain('At the limit')
      // No denial written: it was waived, not refused.
      expect(await auditFor(order.id, 'order.policy_denied')).toEqual([])
    })

    it('still refuses a non-root actor who asks for the policy override', async () => {
      const { order, user } = await setup()
      const actor: CommitActor = { id: user.id, email: user.email, role: 'admin' }
      vi.mocked(evaluateOrderPolicy).mockResolvedValue({
        outcome: 'deny', rule: 'quota/vm-count', message: 'At the limit',
      })

      const result = await recheckOrderGates(
        order.id,
        context({ seam: 'while approving', actor, overridePolicy: true }),
      )

      expect(result).toMatchObject({ ok: false, code: 'policy_denied' })
      expect(await auditFor(order.id, 'order.policy_denied')).toHaveLength(1)
    })

    it('carries a warn back as policyWarning and records it with the rule', async () => {
      const { order, user } = await setup()
      const actor: CommitActor = { id: user.id, email: user.email, role: 'admin' }
      vi.mocked(evaluateOrderPolicy).mockResolvedValue({
        outcome: 'warn', rule: 'cost/estimate', message: 'This looks expensive',
      })

      const result = await recheckOrderGates(order.id, context({ seam: 'while approving', actor }))

      if (!result.ok) throw new Error('expected the order through')
      expect(result.data.policyWarning).toBe('This looks expensive')
      expect(result.data.waivers).toEqual([])
      const entries = await auditFor(order.id, 'order.policy_warning')
      expect(entries).toHaveLength(1)
      expect(entries[0]?.details).toContain('(rule: cost/estimate)')
      expect(entries[0]?.details).toContain('This looks expensive')
    })

    it('records a rule-less warn without inventing a rule', async () => {
      const { order, user } = await setup()
      const actor: CommitActor = { id: user.id, email: user.email, role: 'admin' }
      vi.mocked(evaluateOrderPolicy).mockResolvedValue({
        outcome: 'warn', rule: null, message: 'Careful',
      })

      await recheckOrderGates(order.id, context({ seam: 'while approving', actor }))

      const entries = await auditFor(order.id, 'order.policy_warning')
      expect(entries).toHaveLength(1)
      expect(entries[0]?.details).toContain('Careful')
      expect(entries[0]?.details).not.toContain('(rule:')
    })

    it('falls through to ok on needs-approval: the approver IS the approval', async () => {
      const { order, user } = await setup()
      const actor: CommitActor = { id: user.id, email: user.email, role: 'admin' }
      vi.mocked(evaluateOrderPolicy).mockResolvedValue({
        outcome: 'needs-approval', rule: 'two-person', message: 'Somebody else must approve',
      })

      const result = await recheckOrderGates(order.id, context({ seam: 'while approving', actor }))

      if (!result.ok) throw new Error('expected the order through')
      expect(result.data.policyWarning).toBeNull()
      expect(result.data.waivers).toEqual([])
      // Nothing to record: the order is going to the very queue the rule asked for.
      expect(await auditFor(order.id)).toEqual([])
    })

    it('is a quiet ok on an allow, with no audit entry', async () => {
      const { order, user } = await setup()
      const actor: CommitActor = { id: user.id, email: user.email, role: 'admin' }

      const result = await recheckOrderGates(order.id, context({ seam: 'while approving', actor }))

      if (!result.ok) throw new Error('expected the order through')
      expect(result.data).toEqual({ policyWarning: null, waivers: [] })
      expect(await auditFor(order.id)).toEqual([])
    })

    it('fails closed when the requester cannot be read, and never asks the policy', async () => {
      const { order, user } = await setup()
      const actor: CommitActor = { id: user.id, email: user.email, role: 'admin' }
      // The email is what a policy is asked with; an unreadable one is not a
      // reason to skip the gate, it is a reason to refuse.
      await db.update(users).set({ email: '' }).where(eq(users.id, user.id))

      const result = await recheckOrderGates(order.id, context({ seam: 'while approving', actor }))

      expect(result).toMatchObject({ ok: false, status: 409, code: 'policy_denied' })
      if (result.ok) throw new Error('expected a refusal')
      expect(result.message).toContain('requester could not be read')
      expect(vi.mocked(evaluateOrderPolicy)).not.toHaveBeenCalled()
      const entries = await auditFor(order.id, 'order.policy_denied')
      expect(entries).toHaveLength(1)
      expect(entries[0]?.details).toContain('its requester could not be read')
    })
  })

  describe('both gates together', () => {
    it('returns the policy refusal after a budget waiver, and writes no budget waiver', async () => {
      // The budget is decided first, so root's budget waiver is accepted and the
      // policy then refuses. The waiver must not be written — the order is not
      // committed — and the refusal that reaches the caller is the policy's.
      const { order } = await setup({ price: '600.00', budget: { amount: '500.00' } })
      const root = await createUser({ role: 'root', email: `root-${Math.random()}@test.dev` })
      const actor: CommitActor = { id: root.id, email: root.email, role: 'root' }
      vi.mocked(evaluateOrderPolicy).mockResolvedValue({
        outcome: 'deny', rule: 'quota/vm-count', message: 'At the limit',
      })

      const result = await recheckOrderGates(
        order.id,
        context({ seam: 'while approving', actor, overrideBudget: true }),
      )

      expect(result).toMatchObject({ ok: false, code: 'policy_denied' })
      if (result.ok) throw new Error('expected the policy refusal')
      expect(result.message).toBe('At the limit')
      // The budget waiver was accepted, so nothing about it is written; the
      // policy refusal is.
      expect(await auditFor(order.id, 'order.budget_overridden')).toEqual([])
      expect(await auditFor(order.id, 'order.budget_denied')).toEqual([])
      expect(await auditFor(order.id, 'order.policy_denied')).toHaveLength(1)
    })
  })
})

describe('logWaivers', () => {
  it('writes one entry per waiver, in order, against the plain db', async () => {
    const { order, user } = await setup()
    const waivers: CommitWaiver[] = [
      { action: 'order.budget_overridden', details: 'root waived the budget' },
      { action: 'order.policy_overridden', details: 'root waived the policy' },
    ]

    await logWaivers(db, user.id, order.id, waivers)

    const entries = await auditFor(order.id)
    expect(entries.map((e) => e.action)).toEqual([
      'order.budget_overridden',
      'order.policy_overridden',
    ])
    expect(entries.map((e) => e.details)).toEqual([
      'root waived the budget',
      'root waived the policy',
    ])
    expect(entries.every((e) => e.userId === user.id)).toBe(true)
  })

  it('accepts a transaction, so the entry and the claim commit together', async () => {
    const { order, user } = await setup()
    const waivers: CommitWaiver[] = [{ action: 'order.budget_overridden', details: 'inside a tx' }]

    await db.transaction(async (tx) => {
      await logWaivers(tx, user.id, order.id, waivers)
    })

    const entries = await auditFor(order.id, 'order.budget_overridden')
    expect(entries).toHaveLength(1)
    expect(entries[0]?.details).toBe('inside a tx')
  })

  it('writes nothing when there are no waivers', async () => {
    const { order, user } = await setup()

    await logWaivers(db, user.id, order.id, [])

    expect(await auditFor(order.id)).toEqual([])
  })
})
