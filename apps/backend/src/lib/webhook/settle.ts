import { db } from '@/lib/db/client'
import { orders, infrastructureElements } from '@/lib/db/schema'
import { eq, sql } from 'drizzle-orm'
import { logAudit } from '@/lib/audit'
import { sendProvisioningCompleted, sendDecommissioned } from '@/lib/notification'
import { fetchJobTraces, parseTofuOutputs, supportsJobTrace } from '@/lib/ci'
import { findProductName, findUserEmail, findCiSourceForEnv } from '@/lib/db/queries'

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

  // Compare-and-swap: only the caller that flips provisioning → completed runs
  // the terminal effects, so concurrent final events don't double-notify.
  const completed = await db
    .update(orders)
    .set({ status: 'completed', updatedAt: new Date() })
    .where(sql`${orders.id} = ${order.id} AND ${orders.status} = 'provisioning'`)
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
const recordOutputs = async (
  order: SettleableOrder,
  infraElements: { id: number; pipelineId: string[] }[],
): Promise<void> => {
  if (infraElements.length === 0) return

  const ciSource = await findCiSourceForEnv(order.environmentId)
  if (!ciSource) {
    console.warn(`[webhook] No CI source for environment ${order.environmentId}; no outputs recorded.`)
    return
  }
  if (!supportsJobTrace(ciSource.provider)) {
    // Said out loud rather than silently producing an element with no outputs,
    // which looked like a template that declared none.
    console.warn(
      `[webhook] Reading job logs is not implemented for ${ciSource.provider}; ` +
        `order ${order.id} will have no Terraform outputs. See lib/ci/index.ts supportsJobTrace.`,
    )
    return
  }
  if (!ciSource.projectRef) {
    // GitLab's job endpoints are project-scoped and the project is only named in
    // the environment's trigger URL, so a URL of another shape means the log
    // cannot be located at all. An operator can fix this, but only if they are told.
    console.warn(
      `[webhook] Cannot tell which GitLab project environment ${order.environmentId} triggers ` +
        `(its webhook URL has no /projects/<id>/ segment); order ${order.id} will have no ` +
        `Terraform outputs.`,
    )
    return
  }

  // Each element's outputs come from ITS OWN pipelines, which is why
  // `provisionOrderElements` records them on the element row. Under quantity
  // (#104) element 2's pipeline reports element 2's ip_address; merging the
  // order's pipelines into one map dropped it as a duplicate key and stamped
  // element 1's address onto all N — wrong, and silent.
  //
  // The merge still applies WITHIN one element: an element fans out over the
  // product's webhooks and its pipeline stacks (#121), and reading only the
  // pipeline whose event completed the order dropped the rest.
  for (const element of infraElements) {
    if (element.pipelineId.length === 0) {
      // A row whose triggers never fired. Its outputs are unknown, and borrowing
      // a sibling's is exactly the confusion this loop ends.
      console.warn(
        `[webhook] Order ${order.id}: element ${element.id} has no pipeline of its own; ` +
          `no Terraform outputs recorded for it.`,
      )
      continue
    }

    const outputs: Record<string, string> = {}
    for (const pipelineId of element.pipelineId) {
      let traces: string[]
      try {
        traces = await fetchJobTraces(ciSource, pipelineId)
      } catch (err) {
        // One unreadable pipeline log must not cost the outputs of the pipelines
        // that did report.
        console.error(
          `[webhook] Could not read the job log of pipeline ${pipelineId} (order ${order.id}):`,
          err,
        )
        continue
      }
      for (const trace of traces) {
        for (const [key, value] of Object.entries(parseTofuOutputs(trace))) {
          // First writer wins, iterating this element's pipeline ids in the order
          // they were triggered: two of ITS pipelines both declaring `ip_address`
          // is a naming collision in the templates, and picking by CI timing would
          // make the recorded value change from run to run. Two ELEMENTS reporting
          // the same key is normal and no longer reaches this check at all.
          if (key in outputs) {
            if (outputs[key] !== value) {
              console.warn(
                `[webhook] Order ${order.id}, element ${element.id}: output "${key}" is ` +
                  `reported by more than one of its pipelines with different values; ` +
                  `keeping the first.`,
              )
            }
            continue
          }
          outputs[key] = value
        }
      }
    }

    if (Object.keys(outputs).length > 0) {
      await db
        .update(infrastructureElements)
        .set({ outputs })
        .where(eq(infrastructureElements.id, element.id))
    } else {
      console.warn(
        `[webhook] No job log of element ${element.id} (order ${order.id}) contained an ` +
          `Outputs block.`,
      )
    }
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

  const done = await db
    .update(infrastructureElements)
    .set({ status: 'decommissioned' })
    .where(
      sql`${infrastructureElements.id} = ${infra.id} AND ${infrastructureElements.status} = 'decommissioning'`,
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
