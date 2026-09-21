import { resolveIntegration } from '@/lib/services/admin/integrations'
import { loadSensitiveParameterNames } from '@/lib/services/parameterRedaction'
import { buildOrderDocument, type OrderDocumentSource } from '@/lib/policy/orderDocument'
import { queryPolicy } from '@/lib/policy/client'
import { logAudit } from '@/lib/audit'
import type { SessionUser } from '@infrashelf/types'

/**
 * The order-time policy gate (issue #110).
 *
 * ── Where it sits, and why there ─────────────────────────────────────────────
 *
 * Called at the top of `createPreparedOrder`, which is the single point both the
 * direct and the approval path go through — the same argument #325's budget gate
 * is built on, and the same bug is being avoided: a check in the checkout handler
 * alone would let an order approved next week run against a policy that has
 * changed since. `orders.ts` splits `prepareOrder` from `createPreparedOrder` for
 * exactly this seam.
 *
 * It is NOT inside `createPreparedOrder`'s transaction, though the budget gate is.
 * That function's own comment explains why it holds no network call: it takes a
 * per-cost-centre advisory lock, and one slow engine would hold every checkout on
 * that cost centre behind it. The policy question is asked before the transaction
 * opens, and the verdict is carried into it.
 *
 * ── What it does with each answer ────────────────────────────────────────────
 *
 *   allow → nothing to say, nothing written.
 *   warn  → the order proceeds, and the caller puts `policy.message` in front of
 *           the person who placed it. The budget gate's `warn` is the model: an
 *           over-budget order that passes silently is indistinguishable from one
 *           inside its budget, so a warning has to travel with the order.
 *   deny  → the order is refused, naming the rule that refused it.
 *
 * ── Failure semantics, which is #111's fifth bullet rather than a guess here ──
 *
 * The engine being unreachable is a FAILED CALL to an integration, so the stored
 * `failure_mode` answers it — that column exists precisely so no call site
 * decides this for itself. `blocking` refuses the order (a portal that has
 * declared policy mandatory should not quietly stop asking), `best_effort`
 * carries on with a warning, and BOTH are audited, because "the gate could not be
 * asked" is the one outcome nobody would otherwise see.
 *
 * There is no third answer for "no OPA configured at all": that is not a failed
 * call, it is a portal that has no policies, and refusing every order until
 * somebody installs an engine would make this feature a denial of service. It
 * returns `ok` silently — the same reading `resolveIntegration` gives Foreman.
 */

export type PolicyOutcome = 'ok' | 'warn' | 'deny'

export interface PolicyVerdict {
  outcome: PolicyOutcome
  /** Which rule decided, when the engine named one. Null on a failed call. */
  rule: string | null
  /** What to tell the person, in the policy's own words. */
  message: string | null
}

const OK: PolicyVerdict = { outcome: 'ok', rule: null, message: null }

/**
 * The sentence a refused order carries when the engine could not be asked.
 *
 * It says what happened and what to do about it, because the reader is a
 * requester who has just been told no by a system they cannot see, and "policy
 * check failed" would leave them with nowhere to go.
 */
const unavailableMessage = (integrationName: string, error: string): string =>
  `The policy engine "${integrationName}" could not be asked, and it is configured to block when ` +
  `that happens: ${error}. An operator can probe the integration in Admin → Integrations, or set ` +
  `its failure mode to best-effort to let orders through while it is down.`

/**
 * Ask policy about one prepared order.
 *
 * Never throws and never returns an error Result: its answer is a verdict, and
 * every way of not getting one is expressed inside it (see the header). The
 * caller decides what a `deny` means for its own path — `createPreparedOrder`
 * refuses, and a future continuous-evaluation caller reports.
 */
export const evaluateOrderPolicy = async (
  source: OrderDocumentSource,
  session: Pick<SessionUser, 'id' | 'email' | 'role'>,
): Promise<PolicyVerdict> => {
  const integration = await resolveIntegration('opa', source.environmentId)

  // No engine, no policies, nothing to enforce. Deliberately silent: this is the
  // state every installation starts in, and an audit entry per order for "you
  // have not installed OPA" would bury the log it is written to.
  if (integration === null) return OK

  // The catalogue's sensitive names, not the order's: the same answer the read
  // paths give, so a value that is redacted on screen is not sent to the engine
  // either. See the header of `orderDocument.ts`.
  const sensitiveNames = await loadSensitiveParameterNames()
  const document = buildOrderDocument(source, session, sensitiveNames)

  const answer = await queryPolicy(integration, document)

  if (!answer.ok) {
    if (integration.blocking) {
      await logAudit(
        session.id,
        'order.policy_unavailable',
        undefined,
        `Refused an order for environment #${source.environmentId}: ${integration.name} could not be ` +
          `asked and blocks when that happens (${answer.error})`,
      )
      return { outcome: 'deny', rule: null, message: unavailableMessage(integration.name, answer.error) }
    }

    await logAudit(
      session.id,
      'order.policy_unavailable',
      undefined,
      `Allowed an order for environment #${source.environmentId} with policy unevaluated: ` +
        `${integration.name} could not be asked and is best-effort (${answer.error})`,
    )
    return { outcome: 'warn', rule: null, message: unavailableMessage(integration.name, answer.error) }
  }

  if (answer.decision === 'deny') {
    return {
      outcome: 'deny',
      rule: answer.rule,
      message: denyMessage(answer.rule, answer.message),
    }
  }

  if (answer.decision === 'warn') {
    return {
      outcome: 'warn',
      rule: answer.rule,
      message: answer.message ?? warnMessage(answer.rule),
    }
  }

  return { outcome: 'ok', rule: answer.rule, message: null }
}

/**
 * The refusal, with the rule in it.
 *
 * #110 asks for this explicitly: "a denial that does not say which rule refused
 * it teaches the requester nothing". The policy's own `rule` and `message` are
 * used as given and the sentence around them only adds the frame — inventing a
 * reason here would put it in a translation file the policy author cannot see.
 */
export const denyMessage = (rule: string | null, message: string | null): string => {
  const reason = (message ?? 'This order is not permitted by policy').trim()
  // The policy owns the sentence, so its own full stop is respected: a message
  // that already ends in one must not grow a second ("…environment.."), which is
  // what a policy written the obvious way produces.
  const sentence = /[.!?]$/.test(reason) ? reason : `${reason}.`
  return rule === null ? sentence : `${sentence} (rule: ${rule}).`
}

export const warnMessage = (rule: string | null): string =>
  rule === null
    ? 'Policy allowed this order with a warning.'
    : `Policy allowed this order with a warning (rule: ${rule}).`