import type { BudgetState, SessionUser } from '@infrashelf/types'
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
import { ok, err, type Result } from '@/lib/services/result'
import { redactParametersForOrders } from '@/lib/services/parameterRedaction'
import { activeDelegationsHeldBy, type DelegationRow } from '@/lib/services/delegations'
import { provisionOrderElements } from '@/lib/services/orders'
import { attachBudgets } from '@/lib/services/budgets'
import { recheckOrderGates, logWaivers } from '@/lib/services/commitGates'
import { whenMayItDeploy } from '@/lib/services/windowPolicy'
import { productNameSql } from '@/lib/db/productText'

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
  /**
   * The budget of the cost centre this order will be billed to (#325), or null
   * when there is none — no budget set, or no cost centre resolvable at all.
   *
   * On the queue because this is the last moment the decision can be taken. The
   * gates are asked again when the approval commits the order (#511), so a
   * `warn` cost centre tells the approver nothing unless it is on the row in
   * front of them, and a `block` one refuses them after they have clicked.
   */
  budget: BudgetState | null
  /**
   * What policy said about the order when it was placed (#110, #526) — the
   * policy's own message, or the reason a `best_effort` engine could not be asked.
   *
   * On the row for the same reason `budget` is: the approver is the last person
   * who can act on a warning, and they decide from this row. Null when policy had
   * nothing to say.
   */
  policyWarning: string | null
}

export const listApprovals = async (lang = 'en'): Promise<Result<ApprovalRow[]>> => {
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
      // What policy said about the order when it was placed (#110, #526). On the
      // row rather than only on the order's own page: the approver is the last
      // person who can act on a warning, and they decide from this row.
      policyWarning: orders.policyWarning,
      pipelineId: orders.pipelineId,
      createdAt: orders.createdAt,
      updatedAt: orders.updatedAt,
      isTrial: orders.isTrial,
      sizeCode: orders.sizeCode,
      quantity: orders.quantity,
      productName: productNameSql(lang, orders.productId),
      environmentName: deploymentEnvironments.name,
      userName: users.name,
      projectName: projects.name,
      // Not returned on the row: the fall-through input for the budget lookup
      // below. An order in the default 'project' mode stores no cost centre of
      // its own, and reading only `orders.cost_center_id` would report "no
      // budget" for most of the queue.
      projectCostCenterId: projects.costCenterId,
    })
    .from(orders)
    .leftJoin(deploymentEnvironments, eq(orders.environmentId, deploymentEnvironments.id))
    .leftJoin(users, eq(orders.userId, users.id))
    .leftJoin(projects, eq(orders.projectId, projects.id))
    .where(eq(orders.status, 'pending'))
    .orderBy(sql`${orders.createdAt} ASC`)

  const withBudgets = await attachBudgets(rows)

  // The queue is every pending order, shown to every admin, and the approvals page
  // renders none of these values — so returning them in cleartext shipped every
  // orderer's secrets to every admin for nothing (issue #131).
  return ok(await redactParametersForOrders(withBudgets as ApprovalRow[], (row) => row.id))
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

/**
 * What approving an order did.
 *
 * A union rather than nullable fields, so a caller cannot read `infraId` off a
 * scheduled approval and get `null` where it expected a number. `scheduled` is
 * discriminated on, and the route renders a different message for it (#330).
 */
export type ApprovalOutcome =
  | {
      success: true
      scheduled: false
      infraId: number
      infraIds: number[]
      pipelineIds: string[]
      /** Set when a policy allowed the commit with something to say (#511). */
      policyWarning?: string
    }
  | { success: true; scheduled: true; scheduledFor: Date; policyWarning?: string }

/**
 * Approve a pending order, re-asking the gates before anything is built (#511).
 *
 * `overridePolicy` and `overrideBudget` are root's escapes from the two refusals
 * at this moment, the same rights as on the ordering path (#110, #325) and checked
 * in `recheckOrderGates`: a rule with no way past it turns a policy mistake into an
 * outage, and a ceiling that moved while the order waited would otherwise have no
 * answer but an edit to the budget itself (#514).
 */
export const approveOrder = async (
  session: SessionUser,
  orderId: number,
  options: { overridePolicy?: boolean; overrideBudget?: boolean } = {},
): Promise<Result<ApprovalOutcome>> => {
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

  /*
   * ── The gates, asked again (#511) ──────────────────────────────────────────
   *
   * `createPreparedOrder` asked the budget and the policy when this order was a
   * REQUEST, which may have been days ago. This is where the money is spent and
   * the infrastructure is built, so it is the last moment either can refuse —
   * and until this call existed, nothing here asked at all, while two comments
   * (this file's queue-row one, and the budget gate's) said the check happened
   * at exactly this point.
   *
   * After the claim, so this caller is the one deciding, and before anything is
   * built. A refusal RELEASES the claim: the order goes back to 'pending', where
   * it stays approvable once the budget is raised or the rule changed. Left in
   * 'provisioning' it would be invisible — no second approval can claim it
   * (the claim is conditioned on 'pending') and no sweep looks at it — which is
   * the same trap the window-policy failure below releases the claim for.
   */
  const gates = await recheckOrderGates(order.id, {
    seam: 'when it was approved',
    actor: { id: session.id, email: session.email, role: session.role },
    overridePolicy: options.overridePolicy,
    overrideBudget: options.overrideBudget,
  })

  if (!gates.ok) {
    await db
      .update(orders)
      .set({ status: 'pending', updatedAt: new Date() })
      .where(eq(orders.id, orderId))
    return gates
  }

  const policyWarning = gates.data.policyWarning ?? undefined

  /*
   * The escapes root exercised, written now that the gates have all passed (#521).
   *
   * Here rather than at the gate that accepted them, because the gate behind it
   * can still refuse — and when it does the claim is released and the order goes
   * back to `pending`, so an entry written there would name a waiver for an order
   * nothing committed (and be written again on the retry). Nothing can refuse
   * after this point: the claim has landed and the order is leaving 'pending'.
   *
   * Through `logAudit` rather than a transaction: there is no statement left to
   * pair it with — the claim IS the commit, and it happened before the gates were
   * asked so that this caller is the one deciding. The window override below
   * takes the same view of a decision that was already made.
   */
  await logWaivers(db, session.id, order.id, gates.data.waivers)

  /*
   * Does a window have to open first (#330)?
   *
   * After the claim, not before: the claim is what makes this the one caller
   * acting on the order, and asking first would let two approvals both decide
   * to schedule it. The order is already out of 'pending', so nothing else can
   * touch it while this decides.
   *
   * The approval itself never fails for being out of hours — the admin's
   * decision is recorded either way and the work is not thrown away. Only the
   * provisioning waits.
   */
  let wait: Awaited<ReturnType<typeof whenMayItDeploy>>
  try {
    wait = await whenMayItDeploy(order.environmentId, new Date())
  } catch (e) {
    /*
     * The claim above already moved this order out of 'pending'.
     *
     * A policy read that throws would otherwise strand it in 'provisioning'
     * for good: no second approval can claim it, because the claim is
     * conditioned on 'pending'; and the window sweep cannot pick it up, because
     * it only looks at 'scheduled'. Nothing has been provisioned at this point,
     * so the same undo the provisioning failure below performs is the right one.
     */
    await db
      .update(orders)
      .set({ status: 'pending', updatedAt: new Date() })
      .where(eq(orders.id, orderId))
    throw e
  }

  if (wait) {
    await db
      .update(orders)
      .set({ status: 'scheduled', scheduledFor: wait.scheduledFor, updatedAt: new Date() })
      .where(eq(orders.id, order.id))

    await logAudit(
      session.id,
      'order.scheduled',
      order.id,
      `Approved, waiting for a deployment window at ${wait.scheduledFor.toISOString()}`,
    )

    return ok({
      success: true as const,
      scheduled: true as const,
      scheduledFor: wait.scheduledFor,
      ...(policyWarning ? { policyWarning } : {}),
    })
  }

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
    // Discriminates the union: this one provisioned, the early return above did not.
    scheduled: false as const,
    // The first element, for the callers written when an order had exactly one.
    infraId: provisioned.elementIds[0],
    infraIds: provisioned.elementIds,
    pipelineIds: provisioned.pipelineIds,
    ...(policyWarning ? { policyWarning } : {}),
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
