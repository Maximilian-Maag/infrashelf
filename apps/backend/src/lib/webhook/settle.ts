import { db } from '@/lib/db/client'
import { orders, infrastructureElements } from '@/lib/db/schema'
import { eq, inArray, sql } from 'drizzle-orm'
import { logAudit } from '@/lib/audit'
import { readOutputsForElement, outputsUnavailableReason } from '@/lib/webhook/outputs'
import { sendProvisioningCompleted, sendDecommissioned } from '@/lib/notification'
import { findProductName, findUserEmail, findCiSourceForEnv } from '@/lib/db/queries'
import { resolveIntegration } from '@/lib/services/admin/integrations'

/**
 * Deciding "is this run finished?" and acting on it, in one place.
 *
 * Two callers reach it, which is the whole point:
 *  - the callback handler, after merging a pipeline's success into the map;
 *  - the trigger fan-out, after it stops recording ids (see pipelineTracking).
 *
 * The second exists because the ids are now recorded one at a time, the instant
 * each trigger returns (issue #132). That closes the window in which a callback
 * could not find its row, and opens a smaller one: while the fan-out is still
 * running, the row lists only the pipelines started SO FAR, so a callback for the
 * first of them would see "every pipeline succeeded" and complete an order whose
 * remaining elements were never triggered. `TRIGGERING_KEY` holds that shut, and
 * whoever removes it has to re-ask the question the callback was not allowed to
 * answer.
 */

/** The pipelines a row is waiting on, and what each of them has reported. */
export interface PipelineTracking {
  pipelineId: string[]
  pipelineStatus: Record<string, string>
}

/**
 * Entry that blocks completion for as long as triggers are still being fired.
 *
 * It works because `isSettled` refuses ANY recorded entry that is not a success —
 * the same mechanism the `trigger-failed:*` sentinels use.
 */
export const TRIGGERING_KEY = 'triggering'
export const TRIGGERING_VALUE = 'in progress'

/**
 * Every pipeline succeeded and nothing else is outstanding.
 *
 * The empty case is deliberately NOT settled: a run that started no pipeline at
 * all has nothing to report success, and treating vacuous truth as completion
 * would flip an order to 'completed' the moment its fan-out found no webhook to
 * fire.
 */
const isSettled = (tracking: PipelineTracking): boolean =>
  tracking.pipelineId.length > 0 &&
  tracking.pipelineId.every((pid) => tracking.pipelineStatus[pid] === 'success') &&
  Object.values(tracking.pipelineStatus).every((status) => status === 'success')

export interface SettleableOrder {
  id: number
  userId: number
  productId: number
  environmentId: number
}

/**
 * Complete an order whose pipelines have all succeeded, exactly once.
 *
 * Returns whether THIS caller was the one that completed it.
 *
 * Ordering is the substance of this function (issue #136). Everything that can be
 * lost is done before the compare-and-swap and is idempotent, so a database blip
 * anywhere in it leaves the order in 'provisioning' — where the callback route's
 * selection predicate can still find it and a redelivery, a sibling pipeline's
 * event or the end of the fan-out can finish the job. Everything after the swap is
 * either unrecoverable by nature (the append-only audit entry, which must not
 * describe a completion that did not happen) or cannot throw (the mailer).
 *
 * Terraform outputs are what made the ordering matter: they are the only channel
 * by which a deployment reports its endpoint to the portal (issue #121), and once
 * the order is 'completed' no later event matches it, so a blip during the write
 * lost them permanently.
 */
export const settleOrderIfComplete = async (
  order: SettleableOrder,
  tracking: PipelineTracking,
  reason: string,
): Promise<boolean> => {
  if (!isSettled(tracking)) return false

  // Every element of the order, not one of them: each is provisioned by its own
  // pipelines and gets its own outputs. Ordered by sequence so that "the order's
  // first element" is element 1 rather than whichever row Postgres returned first.
  const infraElements = await db
    .select({ id: infrastructureElements.id, pipelineId: infrastructureElements.pipelineId })
    .from(infrastructureElements)
    .where(eq(infrastructureElements.orderId, order.id))
    .orderBy(infrastructureElements.sequence, infrastructureElements.id)

  const productName = await findProductName(order.productId)
  const email = await findUserEmail(order.userId)

  await recordOutputs(order, infraElements)

  /*
   * Compare-and-swap on what was DECIDED, not merely on the status (#195,
   * finding 7).
   *
   * `isSettled` above reads a snapshot, and `recordOutputs` then makes one
   * network call per element — a gap #175 made proportional to quantity. In it,
   * a duplicate or `canceled` event can flip the order to `failed` and mail the
   * customer, and an admin can hit Retry, claiming `failed → provisioning`. On
   * `status` alone this caller then wakes, sees `provisioning` — the RETRY's —
   * completes the order, mails "ready", and stamps the PREVIOUS run's Terraform
   * outputs onto the elements. The retry's own pipelines report into an order
   * that is already terminal and are ignored.
   *
   * Adding `pipeline_status` to the predicate closes it: the retry rewrites that
   * column, so the swap matches nothing and this caller returns false, which is
   * exactly what it does for any other lost race. Compared as jsonb rather than
   * text, so key order cannot make two equal snapshots miss each other.
   *
   * 'failed' is in the status half because a restart in CI completes a failed
   * order (#500) — the decision that produced this snapshot is still the decision
   * on the row, which is what the `pipeline_status` half is checking, and the map
   * it merges into only reaches "settled" when every recorded pipeline is a
   * success. 'completed' and 'rejected' stay untouchable: neither is a state an
   * operator is trying to leave.
   */
  const decided = JSON.stringify(tracking.pipelineStatus)
  const completed = await db
    .update(orders)
    .set({ status: 'completed', updatedAt: new Date() })
    .where(
      sql`${orders.id} = ${order.id} AND ${orders.status} IN ('provisioning', 'failed') AND ${orders.pipelineStatus} = ${decided}::jsonb`,
    )
    .returning({ id: orders.id })
  if (!completed.length) return false

  await logAudit(null, 'order.completed', order.id, reason)

  // The order's FIRST element, and how many it has. One order can now provision
  // N (issue #104), so naming one id and stopping told the customer about a
  // twentieth of what they ordered — the count is what makes the mail true.
  // Falls back to the order id when an order somehow has no element at all,
  // which is what this line always did.
  const infraId = infraElements[0]?.id ?? order.id
  if (email) {
    await sendProvisioningCompleted(email, productName, infraId, infraElements.length)
  }

  return true
}

/**
 * Parse each element's Terraform outputs out of its job logs and store them.
 *
 * Failures to READ a log are swallowed per pipeline: an unreadable log is a CI-side
 * condition that will not fix itself on redelivery, and blocking the order on it
 * forever is worse than an element with no outputs. A failure to WRITE what was
 * parsed is not swallowed — it propagates, so the caller abandons the completion
 * and the order stays findable for another attempt.
 */
/**
 * Say, on the element, why its outputs are missing (#215).
 *
 * Every branch below already logged. A log line reaches whoever has the container;
 * the person who can fix a revoked CI token is looking at the element page. Both
 * matter, so both happen — the log keeps the detail (the pipeline id, the
 * underlying error) that does not belong in front of a user.
 */
const noteOutputsError = async (elementIds: number[], reason: string): Promise<void> => {
  if (elementIds.length === 0) return
  try {
    await db
      .update(infrastructureElements)
      .set({ outputsError: reason })
      .where(inArray(infrastructureElements.id, elementIds))
  } catch (err) {
    // Explaining the failure must never become the failure. The order has already
    // completed by the time this runs, and losing the explanation is a smaller
    // loss than abandoning that.
    console.error(
      `[webhook] Could not record why outputs are missing for element(s) #${elementIds.join(', #')} `
      + `(reason: ${reason}):`,
      err,
    )
  }
}

const recordOutputs = async (
  order: SettleableOrder,
  infraElements: { id: number; pipelineId: string[] }[],
): Promise<void> => {
  if (infraElements.length === 0) return

  const allIds = infraElements.map((e) => e.id)
  const ciSource = await findCiSourceForEnv(order.environmentId)

  // Resolved once for the whole order: every element of one order shares its
  // environment, so every element's log lives in the same Loki (#111). Null when
  // the deployment has none, which is the arrangement that reads through the CI
  // provider instead.
  const loki = await resolveIntegration('loki', order.environmentId)

  // Reasons that belong to the environment rather than to one element: no CI
  // source and no Loki, a provider whose logs cannot be read, a trigger URL with
  // no project. One answer for every element of the order.
  const unavailable = outputsUnavailableReason(ciSource, { loki: loki !== null })
  if (unavailable) {
    console.warn(`[webhook] Order ${order.id}: ${unavailable}`)
    await noteOutputsError(allIds, unavailable)
    return
  }

  // Each element's outputs come from ITS OWN pipelines, which is why
  // `provisionOrderElements` records them on the element row. Under quantity
  // (#104) element 2's pipeline reports element 2's ip_address; merging the
  // order's pipelines into one map dropped it as a duplicate key and stamped
  // element 1's address onto all N — wrong, and silent.
  for (const element of infraElements) {
    const { outputs, error } = await readOutputsForElement(ciSource, element.pipelineId, {
      elementId: element.id,
      orderId: order.id,
      loki,
    })

    if (error) {
      console.warn(`[webhook] Order ${order.id}, element ${element.id}: ${error}`)
      await noteOutputsError([element.id], error)
      continue
    }

    // Clears any previous complaint: a token that has been fixed and a pipeline
    // that has been re-read should not leave a stale one on the page.
    await db
      .update(infrastructureElements)
      .set({ outputs, outputsError: null })
      .where(eq(infrastructureElements.id, element.id))
  }
}

export interface SettleableElement {
  id: number
  orderId: number
  productId: number
}

/**
 * Flip an element whose destroy pipelines have all succeeded to 'decommissioned',
 * exactly once. Returns whether THIS caller was the one that flipped it.
 *
 * There is no outputs equivalent here — a teardown produces nothing the portal has
 * to keep — so the compare-and-swap comes first and only the notification follows.
 */
export const settleElementIfComplete = async (
  infra: SettleableElement,
  tracking: PipelineTracking,
  reason: string,
): Promise<boolean> => {
  if (!isSettled(tracking)) return false

  // The same shape as the order swap above, and for the same reason (#195,
  // finding 7). The window here is smaller — no per-element network call sits
  // between the decision and the swap — but a re-triggered teardown rewrites
  // `pipeline_status` just the same, and a stale caller must lose.
  const decidedForElement = JSON.stringify(tracking.pipelineStatus)
  const done = await db
    .update(infrastructureElements)
    .set({ status: 'decommissioned' })
    .where(
      sql`${infrastructureElements.id} = ${infra.id} AND ${infrastructureElements.status} = 'decommissioning' AND ${infrastructureElements.pipelineStatus} = ${decidedForElement}::jsonb`,
    )
    .returning({ id: infrastructureElements.id })
  if (!done.length) return false

  await logAudit(null, 'infra.decommissioned', infra.id, reason)

  const orderRows = await db
    .select({ userId: orders.userId })
    .from(orders)
    .where(eq(orders.id, infra.orderId))
    .limit(1)

  if (orderRows[0]) {
    const email = await findUserEmail(orderRows[0].userId)
    const productName = await findProductName(infra.productId)
    if (email) {
      await sendDecommissioned(email, productName, infra.id)
    }
  }

  return true
}
