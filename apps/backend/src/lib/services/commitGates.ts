import type { OrderDocumentSource } from '@/lib/policy/orderDocument'
import type { BudgetState, Role } from '@infrashelf/types'
import { db } from '@/lib/db/client'
import { orders, projects, users } from '@/lib/db/schema'
import { eq } from 'drizzle-orm'
import { loadBudgetState } from '@/lib/services/budgets'
import { evaluateOrderPolicy } from '@/lib/policy/gate'
import { logAudit } from '@/lib/audit'
import { ok, err, type Result } from '@/lib/services/result'

/**
 * The gates, asked again at the moment an order is COMMITTED (#511).
 *
 * ── Why a second ask, given the first ────────────────────────────────────────
 *
 * `createPreparedOrder` asks the budget and the policy once, when the order is a
 * REQUEST. Everything it was based on can move before anybody acts on that
 * request: a ceiling lowered, a cost centre changed, a policy added that would
 * have refused it. The commit is the second decision and the last moment it can
 * be taken — and until this module existed, every commit path asked nothing:
 * `approveOrder` claimed the order and provisioned it, and the deployment-window
 * sweep did the same a day later. Two comments said the check happened there
 * (the approvals queue's, and the budget gate's); neither was true.
 *
 * ── One function, called from every path ─────────────────────────────────────
 *
 * The alternative was three checks, one per commit path, drifting apart — which
 * is how the gap arose in the first place. So this takes an ORDER ID and loads
 * what it needs, and a call site is one line: no caller can assemble the inputs
 * slightly differently, and a fourth path added later cannot quietly skip it.
 *
 * ── Sleeping orders, and what a refusal means ────────────────────────────────
 *
 * A refusal here is not a rejection: nothing has been provisioned, the order goes
 * back where it was, and it can be committed again once the budget is raised or
 * the rule changed. `seam` is what the audit entry says happened, because "the
 * policy refused order 12" reads very differently depending on whether an admin
 * was clicking Approve or a window had just opened.
 */

/** Who is committing the order, when a person is. Absent for the sweep. */
export interface CommitActor {
  id: number
  email: string
  role: Role
}

export interface CommitContext {
  /** Named in the audit entry, in the words of the place it happened. */
  seam: string
  actor?: CommitActor | null
  /** Root's escape from a policy refusal, as on the ordering path (#110). */
  overridePolicy?: boolean
}

export interface CommitVerdict {
  /**
   * Set when policy allowed the order with something to say. Carried back so the
   * caller can put it in front of whoever is looking — the same reading as
   * `policyWarning` on the ordering path.
   */
  policyWarning: string | null
}

const noWarnings: CommitVerdict = { policyWarning: null }

/** The refusal naming the cost centre and the state, in the approver's words. */
const overBudgetMessage = (state: BudgetState): string => {
  const window = state.period === 'monthly' ? 'this month' : 'in total'
  return (
    `${state.costCenterLabel} is over budget: ${state.committed.toFixed(2)} ${state.currency} of ` +
    `${state.amount?.toFixed(2)} ${state.currency} committed ${window}, and this order is part of it. ` +
    `It was affordable when it was requested. Raise the budget to commit it.`
  )
}

/**
 * Ask the budget and the policy about an order that is about to be built.
 *
 * `ok` with a possibly-set `policyWarning`, or a refusal carrying the sentence to
 * show. Never throws for either gate: an engine that cannot be asked is decided
 * by the integration's own failure mode, inside `evaluateOrderPolicy`.
 */
export const recheckOrderGates = async (
  orderId: number,
  context: CommitContext,
): Promise<Result<CommitVerdict>> => {
  const [row] = await db
    .select({
      projectId: orders.projectId,
      productId: orders.productId,
      environmentId: orders.environmentId,
      sizeCode: orders.sizeCode,
      quantity: orders.quantity,
      isTrial: orders.isTrial,
      costCenterId: orders.costCenterId,
      parameters: orders.parameters,
      userId: orders.userId,
      projectCostCenterId: projects.costCenterId,
      requesterEmail: users.email,
      requesterRole: users.role,
    })
    .from(orders)
    .leftJoin(projects, eq(orders.projectId, projects.id))
    .leftJoin(users, eq(orders.userId, users.id))
    .where(eq(orders.id, orderId))
    .limit(1)

  if (!row) return err(404, 'Order not found')

  const who = context.actor?.email ?? `${row.requesterEmail ?? 'the requester'} (by the sweep)`

  /*
   * ── The budget ─────────────────────────────────────────────────────────────
   *
   * The question is NOT the one creation asks. A `pending` order's own cost is
   * already inside `committed` (`COMMITTED_STATUSES`), so asking "would this
   * order take it over" would count it twice and refuse an order that fits
   * exactly — a budget of 500 with a single pending order of 500. The question
   * at commit is whether the total, which already contains this order, is now
   * OVER the ceiling: strictly greater, which is creation's arithmetic with this
   * order's own line taken back out.
   *
   * Only `block` refuses. `warn` is the setting that says "tell me, do not stop
   * me", and the queue row shows the approver the state either way.
   */
  const costCenterId = row.costCenterId ?? row.projectCostCenterId ?? null
  const budget = costCenterId === null ? null : await loadBudgetState(costCenterId)
  if (budget && budget.amount !== null && budget.behaviour === 'block' && budget.committed > budget.amount) {
    const message = overBudgetMessage(budget)
    await logAudit(
      context.actor?.id ?? null,
      'order.budget_denied',
      orderId,
      `${who} could not commit order #${orderId} ${context.seam}: ${message}`,
    )
    return err(409, message)
  }

  /*
   * ── The policy ─────────────────────────────────────────────────────────────
   *
   * Asked as the REQUESTER, not as the approver: the document is about the order
   * and whose it is, and a policy that counts a project's VMs must not be told
   * that an admin is the one asking.
   */
  /*
   * Fail closed if the requester cannot be read. `orders.user_id` is NOT NULL and
   * has no cascade, so a user with orders cannot be deleted and this cannot
   * happen — but a policy is asked about an order in terms of who asked for it,
   * and a gate that silently skips itself is the failure this module exists to
   * remove. The budget above has already been checked either way.
   */
  if (!row.requesterEmail || !row.requesterRole) {
    await logAudit(
      context.actor?.id ?? null,
      'order.policy_denied',
      orderId,
      `${who} could not commit order #${orderId} ${context.seam}: its requester could not be read, ` +
        `so the policy could not be asked.`,
    )
    return err(409, 'This order\u2019s requester could not be read, so policy could not be asked about it.')
  }

  const source: OrderDocumentSource = {
    projectId: row.projectId,
    productId: row.productId,
    environmentId: row.environmentId,
    sizeCode: row.sizeCode,
    quantity: row.quantity,
    isTrial: row.isTrial,
    costCenterId,
    parameters: (row.parameters ?? {}) as Record<string, string>,
  }

  const verdict = await evaluateOrderPolicy(source, {
    id: row.userId,
    email: row.requesterEmail,
    role: row.requesterRole,
  })

  /*
   * `needs-approval` deliberately falls through to the `ok` at the end of this
   * function: the person clicking Approve IS the approval that rule asked for
   * (#110), and the deployment-window sweep only ever sees an order somebody has
   * already approved. A verdict refused here would deadlock the queue — the order
   * approvable by nobody, the engine refusing it for ever. The rule did its work
   * where the order was placed, which is where it sent it to this queue.
   */
  if (verdict.outcome === 'deny') {
    const waived = context.overridePolicy === true && context.actor?.role === 'root'
    if (!waived) {
      await logAudit(
        context.actor?.id ?? null,
        'order.policy_denied',
        orderId,
        `${who} could not commit order #${orderId} ${context.seam}: ${verdict.message ?? 'refused by policy'}`,
      )
      return err(409, verdict.message ?? 'This order is not permitted by policy.')
    }

    await logAudit(
      context.actor?.id ?? null,
      'order.policy_overridden',
      orderId,
      `${context.actor?.email} waived the policy refusal on order #${orderId} ${context.seam}: ` +
        `${verdict.message ?? 'refused by policy'}`,
    )
    return ok(noWarnings)
  }

  if (verdict.outcome === 'warn') {
    /*
     * Recorded here rather than left to each caller, because one of the callers
     * has nobody to tell: the sweep commits orders at 06:00 with no session, so a
     * warning returned to it would be a warning nobody ever sees — the same
     * argument the ordering path makes for putting `policyWarning` on the order
     * it hands back.
     *
     * The approval path ALSO shows it (`ApprovalOutcome.policyWarning`), so the
     * person clicking Approve is told as well as the log.
     */
    await logAudit(
      context.actor?.id ?? null,
      'order.policy_warning',
      orderId,
      `${who} committed order #${orderId} ${context.seam} with a policy warning` +
        (verdict.rule ? ` (rule: ${verdict.rule})` : '') +
        `: ${verdict.message ?? '(no message)'}`,
    )
    return ok({ policyWarning: verdict.message })
  }

  return ok(noWarnings)
}
