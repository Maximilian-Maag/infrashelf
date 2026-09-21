import type { IntegrationKind } from '@/lib/db/schema'
import {
  type IntegrationTarget,
  integrationUrl,
  authHeaders,
  describeFailure,
  insecureCredentialTransport,
} from '@/lib/integrations/http'

/**
 * Reachability probe for a registered integration (issue #111).
 *
 * An integration that is silently unreachable is worse than none, so every kind
 * has to be able to answer "did this work, and when". The shape here is
 * deliberately a thin per-kind switch over a shared request: what #111 asks for
 * is the substrate, not six API clients. Each of #112–#117 replaces its own
 * branch with a real client when it lands, and none of them has to re-decide
 * how a health result is stored or reported.
 */

/** What the probe needs. The same subset every integration client takes. */
export type ProbeTarget = IntegrationTarget

export interface ProbeResult {
  ok: boolean
  /** HTTP status, or null when the request never got an answer. */
  status: number | null
  /** Present only on failure, and suitable for `integrations.last_error`. */
  error?: string
  /**
   * Anything the endpoint said that is worth showing, e.g. Foreman's version.
   * Free-form on purpose: it is diagnostic output, not a contract.
   */
  detail?: string
}

/**
 * Health endpoint per kind.
 *
 * These are the vendors' own unauthenticated-or-cheap status endpoints, chosen
 * so a probe cannot have side effects. A probe that listed hosts would be both
 * slow and a write-shaped call against a system the portal is only checking on.
 */
const HEALTH_PATHS: Record<IntegrationKind, string> = {
  foreman: '/api/v2/status',
  // AWX / Automation Controller. The trailing slash matters: without it AWX
  // answers 301 to the slashed form, and a redirect-following probe would report
  // success for a URL that is one hop off.
  ansible: '/api/v2/ping/',
  nexus: '/service/rest/v1/status',
  pulp: '/pulp/api/v3/status/',
  loki: '/ready',
  grafana: '/api/health',
  // OPA (#110). Not `v1/health`: the policy engine's own liveness endpoint sits
  // outside the versioned data API, and `v1/health` is a 404 that would read as
  // "OPA is down" for a URL that is perfectly correct. Answers `{}` with 200 and,
  // unlike `/v1/data/*`, is never behind a decision — which is what a probe
  // needs, since a probe cannot ask a policy whether it is allowed to probe.
  opa: '/health',
}

/**
 * How long to wait. Short on purpose: this runs behind an admin request, and the
 * useful answer to "is Foreman up" after ten seconds is "no".
 */
const PROBE_TIMEOUT_MS = 5_000

/**
 * Probe one integration.
 *
 * Never throws: a probe's job is to turn an unreachable system into a recorded
 * result, and a caller that has to try/catch around it will eventually forget.
 * Every failure — DNS, TLS, timeout, 500, bad protocol — comes back as
 * `{ ok: false, error }`.
 */
export const probeIntegration = async (target: ProbeTarget): Promise<ProbeResult> => {
  let url: URL
  try {
    url = integrationUrl(target.baseUrl, HEALTH_PATHS[target.kind])
  } catch (e) {
    return { ok: false, status: null, error: e instanceof Error ? e.message : String(e) }
  }

  const insecure = insecureCredentialTransport(target, url)
  if (insecure) return { ok: false, status: null, error: insecure }

  let res: Response
  try {
    res = await fetch(url, {
      headers: { Accept: 'application/json', ...authHeaders(target) },
      // Do not follow redirects: a 302 to a login page is the usual answer to a
      // bad credential, and following it would turn "unauthorised" into a 200
      // from an HTML page. `manual` makes that show up as the 3xx it is.
      redirect: 'manual',
      signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
    })
  } catch (e) {
    // AbortSignal.timeout rejects with a TimeoutError whose message is just
    // "The operation was aborted" — useless in `last_error`, so say what timed
    // out and after how long.
    const name = (e as { name?: string })?.name
    if (name === 'TimeoutError' || name === 'AbortError') {
      return { ok: false, status: null, error: `No response within ${PROBE_TIMEOUT_MS} ms` }
    }
    return { ok: false, status: null, error: e instanceof Error ? e.message : String(e) }
  }

  if (!res.ok) {
    // 401/403 is the single most common probe failure and means the stored
    // credential rather than the system, which `describeFailure` says for every
    // client instead of leaving the operator to look up the code.
    return { ok: false, status: res.status, error: describeFailure(res.status, url.pathname) }
  }

  return { ok: true, status: res.status, detail: await describe(target.kind, res) }
}

/**
 * Turn a successful response into something worth showing.
 *
 * Foreman is the one kind implemented properly, per #111: it reports its own
 * version at /api/v2/status, and knowing that the portal is talking to Foreman
 * 3.9 rather than 2.x is the difference between a working reconciliation (#112)
 * and a 404 on an endpoint that moved. The other five deliberately report
 * nothing beyond "reachable" until their own issue gives their response body a
 * meaning — inventing a parse for a body nobody consumes yet would be five
 * guesses to maintain.
 */
const describe = async (kind: IntegrationKind, res: Response): Promise<string | undefined> => {
  if (kind !== 'foreman') return undefined

  // A probe must not fail because the body was not the JSON we hoped for; the
  // status code already established reachability.
  const body = await res.json().catch(() => null)
  if (body === null || typeof body !== 'object') return undefined

  const { version, api_version: apiVersion } = body as { version?: unknown; api_version?: unknown }
  const parts: string[] = []
  if (typeof version === 'string') parts.push(`Foreman ${version}`)
  if (typeof apiVersion === 'number') parts.push(`API v${apiVersion}`)
  return parts.length > 0 ? parts.join(', ') : undefined
}
