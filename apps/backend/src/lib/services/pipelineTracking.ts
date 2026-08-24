import { db } from '@/lib/db/client'
import { orders, infrastructureElements } from '@/lib/db/schema'
import { eq, sql, type SQL, type SQLWrapper } from 'drizzle-orm'
import {
  TRIGGERING_KEY,
  TRIGGERING_VALUE,
  settleOrderIfComplete,
  settleElementIfComplete,
  type PipelineTracking,
} from '@/lib/webhook/settle'

/**
 * Recording which pipelines a run is waiting on, while the run is still firing them.
 *
 * The rule every function here exists to keep: from the instant a trigger returns,
 * the row that pipeline reports to must already be findable by its id. The
 * callback handler selects on `pipeline_id @> [id]`, GitLab can POST a failure
 * inside a second, it does not retry, and this codebase does not poll — so an id
 * written after the fan-out finished was an id whose callback matched nothing and
 * an order stranded in 'provisioning' forever (issue #132).
 *
 * A run is therefore three steps: `begin*` takes ownership of the tracking fields,
 * `record*` appends each id as it starts, `finish*` closes the run and re-asks
 * whether it is complete. `record*` and `finish*` reach the existing value with
 * jsonb `||` and `-` inside the UPDATE rather than reading it into JavaScript
 * first, so a callback merging its own status at the same moment cannot be
 * clobbered by them — nor they by it.
 */

/** The `trigger-failed:*` map that keeps a partially-fired run from completing. */
const failureSentinels = (failures: string[]): Record<string, string> => {
  const sentinels: Record<string, string> = {}
  failures.forEach((failure, i) => {
    sentinels[`trigger-failed:${i}`] = failure
  })
  return sentinels
}

/**
 * `column || (the ids of `pipelineIds` the column does not already hold)`.
 *
 * The reconciliation half of the contract: `record*` appends each id the moment it
 * starts, but that write can itself fail, and a pipeline is already running by
 * then and cannot be recalled. Re-applying the full list at the end of the run —
 * skipping what is already there, in trigger order — is what makes an id
 * impossible to lose without duplicating the ones that landed.
 */
const appendMissing = (column: SQLWrapper, pipelineIds: string[]): SQL =>
  sql`${column} || (
    SELECT COALESCE(jsonb_agg(candidate.id ORDER BY candidate.ord), '[]'::jsonb)
    FROM jsonb_array_elements(${JSON.stringify(pipelineIds)}::jsonb)
      WITH ORDINALITY AS candidate(id, ord)
    WHERE NOT ${column} @> jsonb_build_array(candidate.id)
  )`

const appendOne = (column: SQLWrapper, pipelineId: string): SQL =>
  sql`${column} || ${JSON.stringify([pipelineId])}::jsonb`

/**
 * Take ownership of an order's pipeline tracking for a run about to start.
 *
 * The reset matters as much as the sentinel: ids are appended from here on, so an
 * earlier attempt's ids left in place would accumulate — an approval that failed
 * to trigger anything and was retried would leave the order waiting on pipelines
 * from a run that no longer exists. Guarded on 'provisioning' so this cannot
 * re-arm an order some other caller has already taken terminal.
 */
export const beginOrderTriggerRun = async (orderId: number): Promise<void> => {
  await db
    .update(orders)
    .set({
      pipelineId: [],
      pipelineStatus: { [TRIGGERING_KEY]: TRIGGERING_VALUE },
      updatedAt: new Date(),
    })
    .where(sql`${orders.id} = ${orderId} AND ${orders.status} = 'provisioning'`)
}

export const recordOrderPipelineId = async (orderId: number, pipelineId: string): Promise<void> => {
  await db
    .update(orders)
    .set({ pipelineId: appendOne(orders.pipelineId, pipelineId), updatedAt: new Date() })
    .where(eq(orders.id, orderId))
}

/**
 * Close an order's trigger run: reconcile the id list, replace the `triggering`
 * entry with one sentinel per trigger that could not be started, and settle the
 * order if its pipelines have already all reported success.
 *
 * That last step is the one the fan-out owes the callbacks it outran. While
 * `triggering` was in the map a callback was refused the completion decision; the
 * caller that removes it is the only one left who can make it.
 */
export const finishOrderTriggerRun = async (
  orderId: number,
  pipelineIds: string[],
  failures: string[],
  reason: string,
): Promise<void> => {
  const sentinels = JSON.stringify(failureSentinels(failures))
  const [row] = await db
    .update(orders)
    .set({
      pipelineId: appendMissing(orders.pipelineId, pipelineIds),
      pipelineStatus: sql`(${orders.pipelineStatus} - ${TRIGGERING_KEY}) || ${sentinels}::jsonb`,
      updatedAt: new Date(),
    })
    .where(eq(orders.id, orderId))
    .returning({
      id: orders.id,
      userId: orders.userId,
      productId: orders.productId,
      environmentId: orders.environmentId,
      pipelineId: orders.pipelineId,
      pipelineStatus: orders.pipelineStatus,
    })

  if (!row) return
  await settleOrderIfComplete(row, row, reason)
}

/** Undo `beginOrderTriggerRun` for a run that started nothing at all. */
export const clearOrderTriggerRun = async (orderId: number): Promise<void> => {
  await db
    .update(orders)
    .set({ pipelineId: [], pipelineStatus: {}, updatedAt: new Date() })
    .where(eq(orders.id, orderId))
}

/**
 * The same three steps for an infrastructure element's teardown.
 *
 * An element's `pipelineId` holds its provisioning ids while it is active and its
 * destroy ids once decommissioning has started (see `pipelinePhase`), so the reset
 * here is the phase switch — and it has to happen BEFORE the destroy triggers
 * fire, or a destroy that fails immediately matches nothing and leaves the element
 * stranded in 'decommissioning', which both `claimAndDestroy` and the sweep skip
 * permanently.
 */
export const beginElementTriggerRun = async (
  infraId: number,
): Promise<PipelineTracking> => {
  // Read first, because RETURNING yields the row after the update and the
  // provisioning run this replaces is what has to be handed back if no destroy
  // starts. Not a read-decide-write race: the caller has already claimed the
  // element (active → decommissioning), so nothing else writes its tracking.
  const [previous] = await db
    .select({
      pipelineId: infrastructureElements.pipelineId,
      pipelineStatus: infrastructureElements.pipelineStatus,
    })
    .from(infrastructureElements)
    .where(eq(infrastructureElements.id, infraId))
    .limit(1)

  await db
    .update(infrastructureElements)
    .set({ pipelineId: [], pipelineStatus: { [TRIGGERING_KEY]: TRIGGERING_VALUE } })
    .where(
      sql`${infrastructureElements.id} = ${infraId} AND ${infrastructureElements.status} = 'decommissioning'`,
    )

  return previous ?? { pipelineId: [], pipelineStatus: {} }
}

export const recordElementPipelineId = async (
  infraId: number,
  pipelineId: string,
): Promise<void> => {
  await db
    .update(infrastructureElements)
    .set({ pipelineId: appendOne(infrastructureElements.pipelineId, pipelineId) })
    .where(eq(infrastructureElements.id, infraId))
}

export const finishElementTriggerRun = async (
  infraId: number,
  pipelineIds: string[],
  failures: string[],
  reason: string,
): Promise<void> => {
  const sentinels = JSON.stringify(failureSentinels(failures))
  const [row] = await db
    .update(infrastructureElements)
    .set({
      pipelineId: appendMissing(infrastructureElements.pipelineId, pipelineIds),
      pipelineStatus: sql`(${infrastructureElements.pipelineStatus} - ${TRIGGERING_KEY}) || ${sentinels}::jsonb`,
    })
    .where(eq(infrastructureElements.id, infraId))
    .returning({
      id: infrastructureElements.id,
      orderId: infrastructureElements.orderId,
      productId: infrastructureElements.productId,
      pipelineId: infrastructureElements.pipelineId,
      pipelineStatus: infrastructureElements.pipelineStatus,
    })

  if (!row) return
  await settleElementIfComplete(row, row, reason)
}

/**
 * Undo `beginElementTriggerRun` for a teardown that started nothing at all.
 *
 * The element is untouched infrastructure again, so it gets its provisioning run's
 * ids back rather than an empty list: those ids are what the detail page shows for
 * an active element, and the teardown that was about to overwrite them never
 * happened.
 */
export const restoreElementTriggerRun = async (
  infraId: number,
  previous: PipelineTracking,
): Promise<void> => {
  await db
    .update(infrastructureElements)
    .set({ pipelineId: previous.pipelineId, pipelineStatus: previous.pipelineStatus })
    .where(eq(infrastructureElements.id, infraId))
}
