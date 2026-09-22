import { redactParameters } from '@/lib/services/parameterRedaction'
import type { DriftSummary } from '@/lib/db/schema'

/**
 * The element document: what the portal hands a policy engine about something
 * that already EXISTS (issue #110, slice 6 — continuous evaluation).
 *
 * ── A different question from the order document ─────────────────────────────
 *
 * `orderDocument.ts` describes an intention: what somebody is asking for, with
 * the requester and their role, and the answer decides whether it happens. This
 * describes a fact: a machine that is running, with the parameters it was built
 * with and what the last refresh found. The order document is answered
 * allow/warn/deny/needs-approval and the portal acts on it; this one is answered
 * the same way and the portal only REPORTS, because an element that has drifted
 * out of compliance cannot be un-provisioned by a report, and refusing to render
 * its page would be the wrong response to it.
 *
 * They are separate documents rather than one with a mode flag because they
 * answer different questions from different data, and a policy author writing
 * "a database password needs a second approver before ordering" should not have
 * to know that the same rule is also asked about a running database.
 *
 * ── An interface, like the order document ────────────────────────────────────
 *
 * Policies are written against these keys, so a rename here silently stops a rule
 * matching, and a policy that no longer fires is indistinguishable from one that
 * found nothing wrong. `elementDocument.test.ts` pins the shape key by key and
 * fails on any addition, rename or retype; the fix is to bump
 * `ELEMENT_DOCUMENT_VERSION` and say why in #110.
 *
 * ── Sensitive parameters ─────────────────────────────────────────────────────
 *
 * Redacted by the same rule as the order document (#131): the engine is an
 * external system, so the values are REDACTED and the names travel beside them,
 * which lets a policy ask "does this hold a database password" without being told
 * what it is.
 *
 * ── The refresh ──────────────────────────────────────────────────────────────
 *
 * `refresh.outcome` is what the scheduled drift report last said (#108), and it
 * is included because it is the live fact that makes this evaluation "against
 * what exists" rather than "against what was ordered". A policy can therefore
 * distinguish "a VM with an open port" from "a VM with an open port that the last
 * plan also found drifted". Null means the element has never been refreshed,
 * which is deliberately not the same as a clean one.
 */

/**
 * The document's version. Bump this whenever the shape changes.
 *
 * Independent of `ORDER_DOCUMENT_VERSION`: the two documents change for their own
 * reasons, and tying them together would make every policy author re-version
 * their rules because an unrelated document moved.
 */
export const ELEMENT_DOCUMENT_VERSION = 1

export interface ElementDocument {
  version: number
  /** The element this is about — what a report about it would name. */
  elementId: number
  /** The order it was provisioned from, so a policy can relate the two. */
  orderId: number
  projectId: number
  productId: number
  environmentId: number
  /** The size code the order chose, or null for an offering that has none (#98). */
  size: string | null
  quantity: number
  status: string
  /** ISO 8601, or null for an element whose provisioning never reported. */
  deployedAt: string | null
  /** Parameter values, with every sensitive one replaced by `REDACTED`. */
  parameters: Record<string, string>
  /** Names of the redacted ones, sorted — never their values. */
  sensitiveParameters: string[]
  /**
   * What Terraform recorded as this element's outputs, verbatim.
   *
   * Included because a policy about running infrastructure is usually about
   * addresses and identifiers — "nothing may hold a public IP in this
   * environment" cannot be asked of the order document, which has no outputs yet.
   */
  outputs: Record<string, string>
  /** What the last refresh found (#108). See the header. */
  refresh: {
    outcome: string | null
    /** ISO 8601, or null when no drift was ever detected. */
    driftDetectedAt: string | null
    /** The drifted resources the plan listed, as the element page shows them. */
    resources: { address: string; action: string }[]
  }
}

/**
 * What the builder needs: the element row, its order's size and quantity, and the
 * drift columns.
 *
 * Structural rather than the row type itself, for the same reason the order
 * document takes `OrderDocumentSource` rather than `PreparedOrder`: taking the
 * whole row would make every future column silently part of the wire format.
 */
export interface ElementDocumentSource {
  elementId: number
  orderId: number
  projectId: number
  productId: number
  environmentId: number
  sizeCode: string | null
  quantity: number
  status: string
  deployedAt: Date | null
  parameters: Record<string, string> | null
  outputs: Record<string, string> | null
  lastRefreshOutcome: string | null
  driftDetectedAt: Date | null
  driftSummary: DriftSummary | null
}

/**
 * Build the document. Pure: no database, no clock, no engine.
 *
 * `sensitiveNames` comes from `loadSensitiveParameterNames()`, the same source
 * the order document uses — the whole catalogue, matched by name, because
 * over-redacting is the safe direction.
 */
export const buildElementDocument = (
  source: ElementDocumentSource,
  sensitiveNames: ReadonlySet<string>,
): ElementDocument => {
  const parameters = source.parameters ?? {}

  return {
    version: ELEMENT_DOCUMENT_VERSION,
    elementId: source.elementId,
    orderId: source.orderId,
    projectId: source.projectId,
    productId: source.productId,
    environmentId: source.environmentId,
    size: source.sizeCode,
    quantity: source.quantity,
    status: source.status,
    deployedAt: source.deployedAt ? source.deployedAt.toISOString() : null,
    parameters: redactParameters(parameters, new Set(sensitiveNames)),
    // Sorted, so a policy comparing two documents does not see the order a form
    // happened to serialise a map in.
    sensitiveParameters: Object.keys(parameters)
      .filter((name) => sensitiveNames.has(name))
      .sort(),
    outputs: { ...(source.outputs ?? {}) },
    refresh: {
      outcome: source.lastRefreshOutcome,
      driftDetectedAt: source.driftDetectedAt ? source.driftDetectedAt.toISOString() : null,
      resources: (source.driftSummary?.resources ?? []).map((r) => ({
        address: r.address,
        action: r.action,
      })),
    },
  }
}
