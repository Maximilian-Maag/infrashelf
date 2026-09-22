import { resolveIntegration } from '@/lib/services/admin/integrations'
import { loadSensitiveParameterNames } from '@/lib/services/parameterRedaction'
import { buildElementDocument, type ElementDocumentSource } from '@/lib/policy/elementDocument'
import { ELEMENT_DECISION_PATH, queryPolicy } from '@/lib/policy/client'

/**
 * Continuous policy evaluation (issue #110, slice 6).
 *
 * The same policies the order gate asks, asked about something that already
 * exists: an element that was compliant when it was ordered and is not any more
 * is precisely what "policy as code" is for. Evaluated when a drift report lands
 * (#108), because that is the moment the portal re-reads what the estate actually
 * looks like, and reported on the element beside that report.
 *
 * ── Report-only, and that is the design ──────────────────────────────────────
 *
 * The order-time gate BLOCKS: a `deny` there means the order does not happen.
 * Nothing here blocks. An element that violates a rule is already running, and
 * the two ways to "enforce" it — un-provision it, or refuse to render its page —
 * are both wrong: the first destroys something a report cannot justify, and the
 * second hides the very fact somebody needs to act on. So a verdict is STORED and
 * SHOWN, and nothing else changes. The issue's fourth open question is answered
 * this way in the plan on #110, and it is the answer the drift report itself
 * already follows: it records what it found and touches no status.
 *
 * ── `unavailable` is a first-class answer here too ───────────────────────────
 *
 * The order gate turns a failed call into `order.policy_unavailable` and lets the
 * integration's `failure_mode` decide whether the order proceeds. There is no
 * equivalent decision to make about an element — nothing proceeds or stops — so a
 * failed call is stored as `unavailable` with the error as its message, exactly as
 * the drift report stores `error` and `locked` as outcomes rather than leaving the
 * last good one standing. "Checked and could not be answered" and "checked and
 * compliant" are different facts, and the element page has to be able to say
 * which one it is looking at.
 *
 * Nothing is audited for an element verdict: unlike the order path, no decision
 * hangs on it, and a scheduled sweep would write one entry per element per run
 * into a log the rest of this codebase uses for decisions somebody took.
 */

/**
 * The five words a stored element verdict can be.
 *
 * The order gate's four, plus `unavailable` for a call that could not be answered
 * (see the header). `needs-approval` is kept rather than folded into `deny`: a
 * policy that says an element should have been approved is telling an operator
 * something different from one that says it should never have existed, and the
 * element page shows the policy's own words beside it either way.
 */
export type ElementPolicyOutcome = 'allow' | 'warn' | 'deny' | 'needs-approval' | 'unavailable'

export interface ElementPolicyVerdict {
  outcome: ElementPolicyOutcome
  /** Which rule decided, when the engine named one. Null on a failed call. */
  rule: string | null
  /** What to tell the person, in the policy's own words. */
  message: string | null
}

/** The sentence stored when the engine could not be asked. */
const unavailableMessage = (integrationName: string, error: string): string =>
  `The policy engine "${integrationName}" could not be asked, so nothing was decided about this ` +
  `element: ${error}. An operator can probe the integration in Admin → Integrations.`

/**
 * Ask policy about one running element.
 *
 * Returns `null` when no engine is configured at all — not an `allow`, because
 * stamping a verdict would claim a policy had been applied to an estate that has
 * none, and the caller must be able to tell the difference (see the header of
 * `gate.ts` for the same reasoning on the order path).
 *
 * Never throws: every way of not getting an answer comes back as a verdict, so no
 * caller has to wrap this in a try/catch and the sweep cannot be broken by a
 * policy engine that is down.
 */
export const evaluateElementPolicy = async (
  source: ElementDocumentSource,
): Promise<ElementPolicyVerdict | null> => {
  const integration = await resolveIntegration('opa', source.environmentId)

  // No engine, no policies, nothing to report. Deliberately silent.
  if (integration === null) return null

  const sensitiveNames = await loadSensitiveParameterNames()
  const document = buildElementDocument(source, sensitiveNames)

  const answer = await queryPolicy(integration, document, ELEMENT_DECISION_PATH)

  if (!answer.ok) {
    return {
      outcome: 'unavailable',
      rule: null,
      message: unavailableMessage(integration.name, answer.error),
    }
  }

  return { outcome: answer.decision, rule: answer.rule, message: answer.message }
}
