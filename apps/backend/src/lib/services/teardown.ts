import { db } from '@/lib/db/client'
import { infrastructureElements } from '@/lib/db/schema'
import { eq } from 'drizzle-orm'
import { triggerProductWebhooksTracked, triggerPipelineStacksTracked } from '@/lib/ci/webhooks'
import { ELEMENT_SEQUENCE_VAR, STATE_KEY_NAMESPACE_VAR } from '@/lib/ci/stateKey'
import { withoutReservedCiVariables } from '@/lib/ci/reserved'
import {
  beginElementTriggerRun,
  recordElementPipelineId,
  finishElementTriggerRun,
  restoreElementTriggerRun,
} from '@/lib/services/pipelineTracking'

/**
 * The CI variables a teardown is fired with.
 *
 * One definition, because there are four callers — the Decommission button, the
 * scheduled sweep, product deletion and project deletion — and a teardown that
 * derives a different Terraform state key than its provisioning did destroys
 * nothing while reporting success. `sequence` is the part that makes that a real
 * risk now that one order has N elements (issue #104): it suffixes the state key,
 * so element 3 must be torn down with `3` and not with whatever its sibling used.
 *
 * `stateKeyNamespace` is required rather than optional for the same reason, and
 * deliberately unlike `sequence`: it is read straight off the row and a projection
 * that forgot to select it would silently read as NULL, which means "derive the
 * pre-#183 key" — and destroying the wrong state name destroys nothing while
 * reporting success. Required makes the compiler ask every caller.
 */
export const destroyVariables = (infra: {
  id: number
  orderId: number
  sequence?: number
  sizeCode?: string | null
  stateKeyNamespace: string | null
  parameters: Record<string, string> | unknown
}): Record<string, string> => ({
  // Stored parameters can contain names the server owns — a definition named REF
  // or TF_ACTION was creatable until #183, and every order placed against one
  // persisted its value here. TF_ACTION below would override that one name; the
  // filter is what handles the rest, including REF, which decides the git ref this
  // destroy runs from.
  ...withoutReservedCiVariables(infra.parameters as Record<string, string>),
  TF_ACTION: 'destroy',
  INFRA_ID: String(infra.id),
  // Pipeline stacks derive TF_STATE_NAME from stateKeyParam ?? ORDER_ID, and the
  // stored parameters do not carry the server-generated order id — so a stack
  // whose stateKeyParam is absent would otherwise destroy an empty/wrong state.
  ORDER_ID: String(infra.orderId),
  // Defaults to 1 for a row read through a projection that did not select it,
  // which is the same value every element provisioned before quantity existed has.
  [ELEMENT_SEQUENCE_VAR]: String(infra.sequence ?? 1),
  // Absent for an element provisioned before #183, which is what keeps its
  // destroy pointed at the state its own apply created.
  ...(infra.stateKeyNamespace !== null
    ? { [STATE_KEY_NAMESPACE_VAR]: infra.stateKeyNamespace }
    : {}),
  ...(infra.sizeCode ? { SIZE: infra.sizeCode } : {}),
})

export interface DestroyOutcome {
  /** Destroy pipelines that were actually started. */
  pipelineIds: string[]
  /** One entry per configured trigger that could NOT be started. Empty = clean. */
  failures: string[]
  /**
   * The element was handed back to 'active' because nothing at all started, so
   * the caller can safely report a retryable failure.
   */
  restoredToActive: boolean
}

/**
 * Fire the destroy triggers for an infrastructure element that the caller has
 * already atomically claimed (active → decommissioning), and persist what
 * happened so the outcome can never be silently lost.
 *
 * Both trigger kinds are fired: infrastructure provisioned by a pipeline stack
 * would otherwise never be torn down. Neither kind aborts on a single failure
 * (one broken stack must not block the rest of the teardown), so the caller has
 * to decide what a partial failure means for it — see `failures`.
 *
 * Three cases:
 *  - nothing failed → pipeline ids stored, teardown is trackable to completion
 *  - nothing STARTED → the element is untouched infrastructure, so it is handed
 *    back to 'active' and the caller can retry
 *  - partial → the started pipelines are stored, plus a sentinel entry per
 *    failed trigger. The sentinel matters: a failed trigger contributes no
 *    pipeline id, so without it the callback handler would flip the element to
 *    'decommissioned' as soon as the pipelines that DID start succeed —
 *    reporting a completed teardown while one stack was never destroyed.
 *
 * Every teardown path goes through here — the Decommission button, the sweep,
 * product deletion, project deletion, category deletion — which is why the id
 * bookkeeping lives here rather than in each of them. Ids are recorded one at a
 * time, as each destroy starts, because a destroy that fails in under a second
 * POSTs its callback before this function returns; matched against an element
 * that still listed its PROVISIONING ids, that callback found nothing and left
 * the element stranded in 'decommissioning' — a state both `claimAndDestroy` and
 * the sweep skip permanently (issue #132).
 */
export const fireDestroyTriggers = async (
  infra: { id: number; productId: number; environmentId: number },
  variables: Record<string, string>,
): Promise<DestroyOutcome> => {
  // Switches the element's pipeline tracking from its provisioning run to this
  // teardown BEFORE anything is fired, so the first destroy id lands in a clean
  // list rather than alongside ids from the apply that created the element.
  const previous = await beginElementTriggerRun(infra.id)
  const onStarted = (pipelineId: string) => recordElementPipelineId(infra.id, pipelineId)

  const webhookOutcome = await triggerProductWebhooksTracked(
    infra.productId,
    infra.environmentId,
    variables,
    onStarted,
  )
  const stackOutcome = await triggerPipelineStacksTracked(
    infra.productId,
    infra.environmentId,
    variables,
    onStarted,
  )

  const pipelineIds = [...webhookOutcome.pipelineIds, ...stackOutcome.pipelineIds]
  const failures = [...webhookOutcome.failures, ...stackOutcome.failures]

  if (failures.length > 0 && pipelineIds.length === 0) {
    await db
      .update(infrastructureElements)
      .set({ status: 'active' })
      .where(eq(infrastructureElements.id, infra.id))
    // Including the `triggering` entry, which left in place would block the NEXT
    // teardown of this element from ever settling.
    await restoreElementTriggerRun(infra.id, previous)
    return { pipelineIds, failures, restoredToActive: true }
  }

  // Closes the run: reconciles the ids, turns the failures into sentinels and
  // re-asks whether the teardown is already finished — a destroy that succeeded
  // while the rest of the fan-out was still firing was refused that answer at the
  // time, because the `triggering` entry was still in the map.
  await finishElementTriggerRun(
    infra.id,
    pipelineIds,
    failures,
    `All destroy pipelines of element ${infra.id} succeeded`,
  )

  return { pipelineIds, failures, restoredToActive: false }
}
