import { and, eq, inArray, isNull, lt, or, sql } from 'drizzle-orm'
import { db } from '@/lib/db/client'
import { infrastructureElements, orders } from '@/lib/db/schema'
import { evaluateElementPolicy } from '@/lib/policy/elementGate'
import type { ElementDocumentSource } from '@/lib/policy/elementDocument'

/**
 * Continuous policy evaluation against what exists (issue #110, slice 6).
 *
 * Called by the drift sweep once it has recorded what a run found (#108) — the
 * moment the portal re-reads the estate — for the elements that run reported on.
 * Nothing here changes an element's status: a verdict is written to four columns
 * and shown on the element page, which is the whole of "report-only" (the
 * reasoning is in `elementGate.ts`).
 *
 * ── Why the evaluation happens here and not in the reporting pipeline ────────
 *
 * The pipeline knows state files; the portal knows the order behind each element,
 * its parameters and the requester. A policy about "whose VM is this" cannot be
 * answered from the plan, so the ask belongs to the side that has the document.
 *
 * ── Concurrency, and why it is bounded ───────────────────────────────────────
 *
 * One HTTP call per element, so an estate of two hundred would hold this request
 * for as long as the engine takes to answer two hundred questions. Chunked with a
 * small limit: enough that a normal estate finishes in one engine round trip's
 * worth of wall clock, few enough that a slow or dead engine cannot open a
 * connection per element. A failed call is a stored verdict (`unavailable`), never
 * an exception, so one dead integration cannot stop the sweep from recording what
 * the plan found — which is the part that matters.
 */

/** How many elements are asked about at once. See the header. */
export const POLICY_EVALUATION_CONCURRENCY = 5

export interface EvaluationSummary {
  /** Elements a verdict was stored for. */
  evaluated: number
  /** Of those, how many could not be answered (`unavailable`). */
  unavailable: number
  /** Elements skipped because the engine is not configured for their environment. */
  unconfigured: number
}

const EMPTY: EvaluationSummary = { evaluated: 0, unavailable: 0, unconfigured: 0 }

/**
 * The element rows the policy document is built from, with the order's size and
 * quantity.
 *
 * The size and quantity belong to the ORDER, not the element: an element records
 * what was applied, and those two are part of what was asked for (#98/#104). An
 * element whose order row is gone is not a case worth handling — the foreign key
 * is `onDelete: cascade`.
 */
const sourcesFor = async (elementIds: number[]): Promise<ElementDocumentSource[]> => {
  const rows = await db
    .select({
      elementId: infrastructureElements.id,
      orderId: infrastructureElements.orderId,
      projectId: infrastructureElements.projectId,
      productId: infrastructureElements.productId,
      environmentId: infrastructureElements.environmentId,
      sizeCode: infrastructureElements.sizeCode,
      quantity: orders.quantity,
      status: infrastructureElements.status,
      deployedAt: infrastructureElements.deployedAt,
      parameters: infrastructureElements.parameters,
      outputs: infrastructureElements.outputs,
      lastRefreshOutcome: infrastructureElements.lastRefreshOutcome,
      driftDetectedAt: infrastructureElements.driftDetectedAt,
      driftSummary: infrastructureElements.driftSummary,
    })
    .from(infrastructureElements)
    .innerJoin(orders, eq(infrastructureElements.orderId, orders.id))
    .where(inArray(infrastructureElements.id, elementIds))

  return rows.map((row) => ({ ...row, quantity: row.quantity ?? 1 }))
}

/**
 * Ask policy about each element and store the answer.
 *
 * `checkedAt` is the time of the run that triggered this, not the clock at the
 * moment of the call: the columns describe a sweep, and a retried sweep must not
 * look like a newer evaluation than a report that already landed. The write is
 * monotonic for the same reason the drift columns are — a late retry of an older
 * run must not overwrite a newer verdict.
 */
export const evaluateElementPolicies = async (
  elementIds: number[],
  checkedAt: Date,
): Promise<EvaluationSummary> => {
  if (elementIds.length === 0) return EMPTY

  const sources = await sourcesFor(elementIds)
  const summary: EvaluationSummary = { evaluated: 0, unavailable: 0, unconfigured: 0 }

  for (let i = 0; i < sources.length; i += POLICY_EVALUATION_CONCURRENCY) {
    const chunk = sources.slice(i, i + POLICY_EVALUATION_CONCURRENCY)

    const verdicts = await Promise.all(
      chunk.map(async (source) => ({ source, verdict: await evaluateElementPolicy(source) })),
    )

    for (const { source, verdict } of verdicts) {
      // No engine for this element's environment: nothing is written, so the page
      // shows no policy line rather than a green one nobody earned.
      if (verdict === null) {
        summary.unconfigured += 1
        continue
      }

      const rows = await db
        .update(infrastructureElements)
        .set({
          policyCheckedAt: checkedAt,
          policyOutcome: verdict.outcome,
          policyRule: verdict.rule,
          policyMessage: verdict.message,
        })
        .where(
          and(
            eq(infrastructureElements.id, source.elementId),
            // Re-checked at the write: a teardown may have started while the
            // engine was being asked, and an element on its way out is not a
            // policy subject.
            eq(infrastructureElements.status, 'active'),
            or(
              isNull(infrastructureElements.policyCheckedAt),
              lt(infrastructureElements.policyCheckedAt, checkedAt),
            ),
          ),
        )
        .returning({ id: infrastructureElements.id })

      if (rows.length === 0) continue
      summary.evaluated += 1
      if (verdict.outcome === 'unavailable') summary.unavailable += 1
    }
  }

  return summary
}

/**
 * The columns the element page reads, as a fragment so the read paths agree about
 * what "no verdict" looks like.
 *
 * Null everywhere rather than a default: an element that has never been evaluated
 * is not one that passed, which is the same distinction `lastRefreshOutcome` draws
 * for drift.
 */
export const policyColumns = {
  policyCheckedAt: infrastructureElements.policyCheckedAt,
  policyOutcome: infrastructureElements.policyOutcome,
  policyRule: infrastructureElements.policyRule,
  policyMessage: infrastructureElements.policyMessage,
}

/** Counted, for the drift report's own record and for tests. */
export const elementsAwaitingPolicy = async (): Promise<number> => {
  const [row] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(infrastructureElements)
    .where(and(eq(infrastructureElements.status, 'active'), isNull(infrastructureElements.policyCheckedAt)))

  return row?.n ?? 0
}
