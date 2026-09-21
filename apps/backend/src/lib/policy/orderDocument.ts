import type { Role } from '@infrashelf/types'
import { redactParameters } from '@/lib/services/parameterRedaction'

/**
 * The order document: what the portal hands a policy engine (issue #110).
 *
 * ── Why this is a module and not an object literal at the call site ───────────
 *
 * Policies are written against this shape. It is an interface, not an
 * implementation detail: whoever writes the Rego reads THESE keys, and a rename
 * here silently stops a rule from matching — a policy that no longer fires looks
 * exactly like a policy that found nothing wrong. So the shape is pinned by
 * `orderDocument.test.ts`, which fails on any added, renamed or retyped field and
 * says what to do about it (bump the version, say why in #110).
 *
 * `version` is the other half of that. The engine cannot see this repository, so
 * it cannot be told "the document changed" — it can only be told which document
 * it is looking at. A rule written for version 1 keeps working against version 1,
 * and a portal that sends version 2 to a policy directory that has never heard of
 * it can say so rather than evaluating the wrong questions.
 *
 * ── Sensitive parameters ─────────────────────────────────────────────────────
 *
 * The values are REDACTED, not omitted, and the names are listed separately.
 *
 * `orders.parameters` stores a sensitive value in plain text and redacts it on
 * every read path (#131, `lib/services/parameterRedaction.ts`). A policy engine
 * is an external system — usually one the policy authors administer, not the
 * portal's operators — so handing it the plaintext would undo that redaction at
 * exactly the one hop where it cannot be undone, and it would do it for every
 * order rather than for the ones a human chose to look at.
 *
 * Redacted rather than dropped so a policy can still reason about presence
 * ("anything carrying a database password needs a second approver") without
 * seeing the secret, which is why the names travel beside the values. A caller
 * that genuinely needs a policy to read a secret is asking a different question
 * than this issue does, and should have to say so.
 *
 * ── Not here ────────────────────────────────────────────────────────────────
 *
 * Any HTTP call, any decision, any audit entry: this is the document and nothing
 * else, so it can be tested without a database, a network or a policy. The gate
 * that sends it and interprets the answer is slice 3.
 *
 * ── A different thing from `policy/` at the repository root ──────────────────
 *
 * `make policy` evaluates the Rego in `policy/` against the source tree at BUILD
 * time — codebase invariants, run by CI, about this repository. What this module
 * feeds is the opposite direction entirely: the portal calling OPA at RUNTIME to
 * ask about an order. Same binary, same language, unrelated policies and
 * unrelated audiences, and the plan on #110 asks for that to be said in the code
 * rather than discovered by wiring one into the other.
 */

/**
 * The document's version. Bump this whenever the shape changes.
 *
 * A number rather than a date or a hash: the engine's policies are written
 * against a shape, and "which shape" is answered by an integer a rule can compare.
 */
export const ORDER_DOCUMENT_VERSION = 1

export interface OrderDocument {
  version: number
  projectId: number
  productId: number
  environmentId: number
  /** The chosen size code, or null for an offering that has none (#98). */
  size: string | null
  quantity: number
  trial: boolean
  costCenterId: number | null
  /** Parameter values, with every sensitive one replaced by `REDACTED`. */
  parameters: Record<string, string>
  /** Names of the redacted ones, sorted — never their values. */
  sensitiveParameters: string[]
  requester: { id: number; email: string; role: Role }
}

/**
 * What the builder needs from a prepared order.
 *
 * Structural rather than `PreparedOrder` itself: that type carries the snapshot,
 * the budget override and the admin flag, none of which belong in a document
 * someone else's engine reads, and taking the whole of it would mean every future
 * field of `PreparedOrder` silently becoming part of the wire format.
 */
export interface OrderDocumentSource {
  projectId: number
  productId: number
  environmentId: number
  sizeCode: string | null
  quantity: number
  isTrial: boolean
  costCenterId: number | null
  parameters: Record<string, string>
}

/**
 * Build the document.
 *
 * Pure: no database, no clock, no engine. `sensitiveNames` comes from
 * `loadSensitiveParameterNames()` (the whole catalogue, matched by name across
 * every scope — over-redacting is the safe direction, and it is the same answer
 * the read paths give), which keeps this testable as a function of its arguments.
 */
export const buildOrderDocument = (
  source: OrderDocumentSource,
  requester: { id: number; email: string; role: Role },
  sensitiveNames: ReadonlySet<string>,
): OrderDocument => ({
  version: ORDER_DOCUMENT_VERSION,
  projectId: source.projectId,
  productId: source.productId,
  environmentId: source.environmentId,
  size: source.sizeCode,
  quantity: source.quantity,
  trial: source.isTrial,
  costCenterId: source.costCenterId,
  parameters: redactParameters(source.parameters ?? {}, new Set(sensitiveNames)),
  // Sorted, because a policy comparing two documents (or a test comparing one to
  // a fixture) must not see the order a form happened to serialise a map in.
  sensitiveParameters: Object.keys(source.parameters ?? {})
    .filter((name) => sensitiveNames.has(name))
    .sort(),
  requester: { id: requester.id, email: requester.email, role: requester.role },
})
