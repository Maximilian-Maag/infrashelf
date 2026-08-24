import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { SessionUser } from '@open-hybrid-cloud/types'

vi.mock('@/lib/notification', () => ({
  sendOrderApproved: vi.fn().mockResolvedValue(undefined),
  sendOrderRejected: vi.fn().mockResolvedValue(undefined),
}))

vi.mock('@/lib/ci/webhooks', () => ({
  triggerProductWebhooksTracked: vi.fn().mockResolvedValue({ pipelineIds: ['pipe-42'], failures: [] }),
  triggerPipelineStacksTracked: vi.fn().mockResolvedValue({ pipelineIds: [], failures: [] }),
}))

import { listApprovals, approveOrder, rejectOrder } from './approvals'
import { sendOrderApproved, sendOrderRejected } from '@/lib/notification'
import { triggerProductWebhooksTracked } from '@/lib/ci/webhooks'
import { db } from '@/lib/db/client'
import {
  orders,
  infrastructureElements,
  productEnvironments,
  auditLog,
  approvalDelegations,
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
})
