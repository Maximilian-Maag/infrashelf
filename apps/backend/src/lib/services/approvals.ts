import type { SessionUser } from '@open-hybrid-cloud/types'
import { db } from '@/lib/db/client'
import {
  orders,
  deploymentEnvironments,
  users,
  projects,
  productEnvironments,
} from '@/lib/db/schema'
import { eq, and, sql } from 'drizzle-orm'
import { logAudit } from '@/lib/audit'
import { sendOrderApproved, sendOrderRejected } from '@/lib/notification'
import { findProductName, findUserEmail } from '@/lib/db/queries'
import { productNameSql } from '@/lib/services/productName'
import { ok, err, type Result } from '@/lib/services/result'
import { redactParametersForOrders } from '@/lib/services/parameterRedaction'
import { activeDelegationsHeldBy, type DelegationRow } from '@/lib/services/delegations'
import { provisionOrderElements } from '@/lib/services/orders'

export interface ApprovalRow {
  id: number
  projectId: number
  productId: number
  environmentId: number
  userId: number
  status: string
  parameters: Record<string, string>
  costCenterId: number | null
  rejectionNote: string | null
  pipelineId: string[]
  createdAt: Date
  updatedAt: Date
  /**
   * Ordered as a time-boxed trial (issue #1). Surfaced in the queue because it
   * changes what the approver is agreeing to: a trial is torn down again shortly
   * after it comes up, and asks the pipeline for elevated rights inside it.
   */
  isTrial: boolean
  /**
   * The chosen size and how many elements the order asks for (issues #98/#104).
   * Both are shown in the queue because they change what the approver is agreeing
   * to: "20 x XL" is a different decision from "1 x XS".
   */
  sizeCode: string | null
  quantity: number
  productName: string
  environmentName: string | null
  userName: string | null
  projectName: string | null
}

export const listApprovals = async (lang: string): Promise<Result<ApprovalRow[]>> => {
  const rows = await db
    .select({
      id: orders.id,
      projectId: orders.projectId,
      productId: orders.productId,
      environmentId: orders.environmentId,
      userId: orders.userId,
      status: orders.status,
      parameters: orders.parameters,
      costCenterId: orders.costCenterId,
      rejectionNote: orders.rejectionNote,
      pipelineId: orders.pipelineId,
      createdAt: orders.createdAt,
      updatedAt: orders.updatedAt,
      isTrial: orders.isTrial,
      sizeCode: orders.sizeCode,
      quantity: orders.quantity,
      productName: productNameSql(orders.productId, lang),
      environmentName: deploymentEnvironments.name,
      userName: users.name,
      projectName: projects.name,
    })
    .from(orders)
    .leftJoin(deploymentEnvironments, eq(orders.environmentId, deploymentEnvironments.id))
    .leftJoin(users, eq(orders.userId, users.id))
    .leftJoin(projects, eq(orders.projectId, projects.id))
    .where(eq(orders.status, 'pending'))
    .orderBy(sql`${orders.createdAt} ASC`)

  // The queue is every pending order, shown to every admin, and the approvals page
  // renders none of these values — so returning them in cleartext shipped every
  // orderer's secrets to every admin for nothing (issue #131).
  return ok(await redactParametersForOrders(rows as ApprovalRow[], (row) => row.id))
}

/**
 * The delegated authority the actor holds at this moment, as an audit suffix.
 *
 * Empty when they hold none, which is the normal case. The wording is
 * deliberately "while holding", not "as": the substitute acted as themselves and
 * the `order.approved` entry already names them — this records the authority that
 * was in force, not a different actor.
 */
const authoritySuffix = (held: DelegationRow[]): string =>
  held.length === 0
    ? ''
    : ` while holding delegated approval authority ${held
        .map((d) => `#${d.id} from ${d.fromUserEmail}`)
        .join(', ')}`

/**
 * One audit entry per delegation that was in force, keyed on the DELEGATION.
 *
 * `order.approved` answers "who approved order 12"; these answer "what was done
 * under delegation 7" — which is the question a delegation has to be auditable
 * for, and the one an entry keyed on the order alone cannot be filtered for.
 */
const logDelegatedUse = async (
  session: SessionUser,
  held: DelegationRow[],
  verb: 'approved' | 'rejected',
  orderId: number,
): Promise<void> => {
  for (const d of held) {
    await logAudit(
      session.id,
      'approval_delegation.used',
      d.id,
      `${session.email} ${verb} order #${orderId} under delegation #${d.id} from ${d.fromUserEmail} ` +
        `(in force ${d.startsOn} to ${d.endsOn})`,
    )
  }
}

/**
 * Nobody approves their own order — not even with a delegation in hand.
 *
 * Two ways an admin can end up as the orderer of a PENDING order: they placed it
 * as a project manager and were promoted afterwards, or an admin's own order was
 * left pending by an earlier code path. Either way, self-approval is the one
 * separation of duties this workflow has, so it is checked BEFORE the order is
 * claimed — a rejection after the claim would strand the order in 'provisioning'.
 *
 * A delegation cannot route around this because the check compares the ACTOR's id
 * with the orderer's, and a delegation never changes who the actor is. Delegating
 * to the orderer and having them approve "as" the delegator is precisely what
 * an identity-swapping design would have allowed.
 */
const assertNotOwnOrder = async (
  session: SessionUser,
  orderId: number,
): Promise<Result<void>> => {
  const [existing] = await db
    .select({ userId: orders.userId })
    .from(orders)
    .where(eq(orders.id, orderId))
    .limit(1)

  if (!existing) return err(404, 'Order not found')
  if (existing.userId === session.id) return err(403, 'You cannot approve your own order')
  return ok(undefined)
}

export const approveOrder = async (
  session: SessionUser,
  orderId: number,
): Promise<Result<{ success: true; infraId: number; infraIds: number[]; pipelineIds: string[] }>> => {
  const separation = await assertNotOwnOrder(session, orderId)
  if (!separation.ok) return separation

  // Atomically claim the order (pending → provisioning). Only one concurrent
  // caller can win this conditional update, which prevents a double-clicked or
  // concurrently-approved order from triggering provisioning twice.
  const claimed = await db
    .update(orders)
    .set({ status: 'provisioning', updatedAt: new Date() })
    .where(sql`${orders.id} = ${orderId} AND ${orders.status} = 'pending'`)
    .returning()

  if (!claimed.length) {
    const existing = await db
      .select({ id: orders.id })
      .from(orders)
      .where(eq(orders.id, orderId))
      .limit(1)
    return existing.length ? err(400, 'Order is not pending') : err(404, 'Order not found')
  }

  const order = claimed[0]

  // Snapshotted at the moment of the claim, not at logging time: everything
  // below — webhooks, pipeline stacks, the infrastructure insert — can take
  // minutes, and a delegation that expires at midnight or is revoked mid-run
  // would otherwise be audited as absent from a decision it actually authorised.
  const held = await activeDelegationsHeldBy(session.id)

  // A trial's clock starts HERE, at provisioning, not when the order was placed:
  // the order may have waited for approval, and starting the clock then could
  // burn the whole trial — or expire it outright — before the infrastructure
  // existed. The duration is re-read from the offering rather than snapshotted on
  // the order, so a duration an admin corrected while the order was pending is
  // the one that applies.
  let trialDurationMinutes = 0
  if (order.isTrial) {
    const [offering] = await db
      .select({ trialDurationMinutes: productEnvironments.trialDurationMinutes })
      .from(productEnvironments)
      .where(
        and(
          eq(productEnvironments.productId, order.productId),
          eq(productEnvironments.environmentId, order.environmentId),
        ),
      )
      .limit(1)
    // An offering withdrawn or with a nonsense duration while the order was
    // pending falls back to the schema default rather than blocking an approval
    // an admin already decided on — the trial is still torn down.
    trialDurationMinutes = offering && offering.trialDurationMinutes > 0 ? offering.trialDurationMinutes : 30
  }

  // One decision, N elements: approving an order of twenty approves all twenty
  // (the owner's decision on #104). The fan-out is the same code the admin's
  // direct order runs, so the two cannot derive different Terraform state keys.
  let provisioned: Awaited<ReturnType<typeof provisionOrderElements>>
  try {
    provisioned = await provisionOrderElements({
      orderId: order.id,
      projectId: order.projectId,
      productId: order.productId,
      environmentId: order.environmentId,
      sizeCode: order.sizeCode,
      // Defensive: a row written before the column existed reads as 1 through the
      // schema default, but a hand-edited 0 would silently provision nothing.
      quantity: order.quantity >= 1 ? order.quantity : 1,
      parameters: order.parameters as Record<string, string>,
      isTrial: order.isTrial,
      trialDurationMinutes,
    })
  } catch (e) {
    // Not one element could be started, so nothing is provisioned — release the
    // claim and let the approval be retried.
    await db
      .update(orders)
      .set({ status: 'pending', updatedAt: new Date() })
      .where(eq(orders.id, orderId))
    throw e
  }

  await logAudit(
    session.id,
    'order.approved',
    order.id,
    `Order approved by ${session.email}${authoritySuffix(held)}` +
      (provisioned.elementIds.length > 1 ? ` (${provisioned.elementIds.length} elements)` : ''),
  )
  await logDelegatedUse(session, held, 'approved', order.id)

  const email = await findUserEmail(order.userId)
  const productName = await findProductName(order.productId)
  if (email) {
    await sendOrderApproved(email, productName, order.id)
  }

  return ok({
    success: true as const,
    // The first element, for the callers written when an order had exactly one.
    infraId: provisioned.elementIds[0],
    infraIds: provisioned.elementIds,
    pipelineIds: provisioned.pipelineIds,
  })
}

/**
 * Reject a pending order.
 *
 * Deliberately NOT subject to the self-approval guard: an admin rejecting an
 * order they placed themselves is withdrawing it, which grants nobody anything.
 * The asymmetry is the point — separation of duties exists to stop a person
 * granting themselves resources, not to stop them giving them up.
 */
export const rejectOrder = async (
  session: SessionUser,
  orderId: number,
  rejectionNote: string,
): Promise<Result<void>> => {
  // Atomically transition pending → rejected so a concurrent approve/reject
  // (or double submit) on the same order can't both take effect.
  const rejected = await db
    .update(orders)
    .set({ status: 'rejected', rejectionNote, updatedAt: new Date() })
    .where(sql`${orders.id} = ${orderId} AND ${orders.status} = 'pending'`)
    .returning()

  if (!rejected.length) {
    const existing = await db
      .select({ id: orders.id })
      .from(orders)
      .where(eq(orders.id, orderId))
      .limit(1)
    return existing.length ? err(400, 'Order is not pending') : err(404, 'Order not found')
  }

  const order = rejected[0]

  const held = await activeDelegationsHeldBy(session.id)
  await logAudit(
    session.id,
    'order.rejected',
    order.id,
    `Rejected by ${session.email}${authoritySuffix(held)}: ${rejectionNote}`,
  )
  await logDelegatedUse(session, held, 'rejected', order.id)

  const email = await findUserEmail(order.userId)
  const productName = await findProductName(order.productId)
  if (email) {
    await sendOrderRejected(email, productName, order.id, rejectionNote)
  }

  return ok(undefined)
}
