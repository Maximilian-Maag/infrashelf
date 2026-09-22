import {
  type IntegrationTarget,
  integrationUrl,
  authHeaders,
  describeFailure,
  insecureCredentialTransport,
} from '@/lib/integrations/http'

/**
 * Asking an OPA instance one question (issue #110).
 *
 * ── The query ────────────────────────────────────────────────────────────────
 *
 * `POST {baseUrl}/v1/data/infrashelf/order/decision` with `{"input": <document>}`
 * — OPA's data API, where the path is the rule to evaluate and the body is the
 * input its `input` variable refers to. One path, fixed here rather than
 * configurable per integration: the decision this portal asks for is one thing,
 * and a row that could point at a different rule per environment would make
 * "which policy refused this order" unanswerable from the acting side.
 *
 * ── The answer ───────────────────────────────────────────────────────────────
 *
 *     { "result": { "decision": "allow" | "warn" | "deny" | "needs-approval",
 *                   "rule":     "quota/vm-count",      // which rule decided
 *                   "message":  "…"                    // what to tell a person
 *                 } }
 *
 * `rule` is what makes a refusal teach the requester something, which #110 asks
 * for by name. `message` is the policy's own words: the portal cannot phrase a
 * denial it did not write, and inventing one here would put the reason in a
 * translation file that the policy author never sees.
 *
 * ── Failure is a first-class answer, not an exception ────────────────────────
 *
 * Never throws. Every way this can go wrong — no route, no answer, a redirect, a
 * non-2xx, a body that is not the shape above, a decision that is none of the
 * three — comes back as `{ ok: false, error }`, because the caller's next
 * question is the same in all of them: what does the integration's failure mode
 * say to do? That decision belongs to `gate.ts`, not to a try/catch at each
 * call site.
 *
 * An UNDEFINED rule (OPA answers 200 with `{}` when the path evaluates to
 * nothing) is a failure rather than an allow. It means the policy repository has
 * no `infrashelf/order/decision` — nobody wrote the gate — which is exactly the
 * state a portal should not silently treat as "everything is permitted".
 */

/** Where the decision lives, on the engine. */
export const ORDER_DECISION_PATH = '/v1/data/infrashelf/order/decision'

/**
 * How long to wait. The budget gate's own number, for the same reason: this runs
 * on the request that places an order, and the useful answer to "may I place
 * this" after ten seconds is not "no", it is "I could not ask".
 */
export const POLICY_TIMEOUT_MS = 5_000

export type PolicyDecision = 'allow' | 'warn' | 'deny' | 'needs-approval'

export type PolicyQueryResult =
  | { ok: true; decision: PolicyDecision; rule: string | null; message: string | null }
  | { ok: false; error: string }

/**
 * The four words the portal understands, and the whole of them.
 *
 * `needs-approval` is #110's third answer — the issue names the set as "allow /
 * deny / needs-approval" — and it is hyphenated exactly as the issue writes it,
 * because it is a wire word: the policy repository spells it, not this file.
 */
const isDecision = (value: unknown): value is PolicyDecision =>
  value === 'allow' || value === 'warn' || value === 'deny' || value === 'needs-approval'

const asText = (value: unknown): string | null =>
  typeof value === 'string' && value.trim() !== '' ? value : null

/** The probe's own timeout sentence, so the two failures read alike. */
const timedOut = (e: unknown): boolean => {
  const name = (e as { name?: string })?.name
  return name === 'TimeoutError' || name === 'AbortError'
}

/**
 * Ask the engine about one input.
 *
 * `target` is a resolved integration (`resolveIntegration('opa', envId)`) — the
 * credential arrives decrypted and is never logged, and a plain-HTTP base URL
 * carrying a credential is refused here rather than sent in the clear (#499).
 */
export const queryPolicy = async (
  target: IntegrationTarget,
  input: unknown,
): Promise<PolicyQueryResult> => {
  let url: URL
  try {
    url = integrationUrl(target.baseUrl, ORDER_DECISION_PATH)
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) }
  }

  const insecure = insecureCredentialTransport(target, url)
  if (insecure) return { ok: false, error: insecure }

  let res: Response
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: { Accept: 'application/json', 'Content-Type': 'application/json', ...authHeaders(target) },
      body: JSON.stringify({ input }),
      // Not followed, for the reason the probe gives: a 302 to a login page is
      // the usual answer to a wrong URL or credential, and following it would
      // turn "unauthorised" into a 200 whose body is HTML.
      redirect: 'manual',
      signal: AbortSignal.timeout(POLICY_TIMEOUT_MS),
    })
  } catch (e) {
    if (timedOut(e)) return { ok: false, error: `No answer within ${POLICY_TIMEOUT_MS} ms` }
    return { ok: false, error: e instanceof Error ? e.message : String(e) }
  }

  if (!res.ok) {
    return { ok: false, error: describeFailure(res.status, url.pathname) }
  }

  // A body that is not JSON at all is a failure, not an allow: only a decision
  // this portal understands may let an order through.
  const body = (await res.json().catch(() => null)) as { result?: unknown } | null
  const result = body?.result

  if (result === undefined || result === null) {
    return {
      ok: false,
      error: `No decision at ${ORDER_DECISION_PATH} — the policy repository may not load it`,
    }
  }
  if (typeof result !== 'object' || Array.isArray(result)) {
    return { ok: false, error: `Unexpected decision shape from ${ORDER_DECISION_PATH}` }
  }

  const { decision, rule, message } = result as Record<string, unknown>
  if (!isDecision(decision)) {
    return {
      ok: false,
      error: `Unrecognised decision "${String(decision)}" from ${ORDER_DECISION_PATH}`,
    }
  }

  return { ok: true, decision, rule: asText(rule), message: asText(message) }
}