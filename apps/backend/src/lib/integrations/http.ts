import type { IntegrationAuthType, IntegrationKind } from '@/lib/db/schema'

/**
 * The parts of talking to a registered integration that every kind shares
 * (issue #111): where a call goes, and what it puts in the Authorization header.
 *
 * Extracted from `probe.ts` when the Foreman host listing became the second
 * caller. Both halves are places where a mistake is invisible from either end —
 * a URL built the obvious way silently drops a base path, and an auth type
 * quietly mapped to the wrong header authenticates against nothing — so they
 * are written once rather than per client.
 */

/** What a call needs; a subset of the row, so a caller can pass a fixture. */
export interface IntegrationTarget {
  kind: IntegrationKind
  baseUrl: string
  authType: IntegrationAuthType
  username: string
  /** Decrypted. No client ever sees the envelope. */
  credential: string | null
}

/**
 * Reject anything that is not plain HTTP(S) before it reaches `fetch`.
 *
 * The base URL is operator-supplied, and `fetch` would happily accept `file:` or
 * a `data:` URL. Mirrors the same guard in lib/ci/gitlab.ts.
 */
export const integrationUrl = (baseUrl: string, path: string): URL => {
  // Concatenated, not `new URL(path, base)`: the API paths are absolute, and the
  // two-argument form would discard the base's own path — so a Foreman mounted
  // at https://gw.example.com/foreman would be called at the gateway root.
  // Trailing slashes are stripped first, because `//api/v2/status` is a 404 on
  // Nexus and Pulp.
  const url = new URL(`${baseUrl.replace(/\/+$/, '')}${path}`)
  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    throw new Error(`Disallowed URL protocol: ${url.protocol}`)
  }
  return url
}

export const authHeaders = (target: IntegrationTarget): Record<string, string> => {
  const credential = target.credential ?? ''
  switch (target.authType) {
    case 'none':
      return {}
    case 'bearer':
      return { Authorization: `Bearer ${credential}` }
    case 'basic':
      return {
        Authorization: `Basic ${Buffer.from(`${target.username}:${credential}`).toString('base64')}`,
      }
    case 'token_header':
      // Nexus and Pulp deployments behind a gateway commonly want a bare token
      // header rather than a scheme. Kept distinct from `bearer` so the stored
      // configuration says which one, instead of the operator smuggling
      // "Bearer x" into the credential itself.
      return { 'X-Auth-Token': credential }
  }
}

/**
 * Why a call to an integration did not produce an answer.
 *
 * A sentence, not a code: it is shown to an operator and stored in
 * `integrations.last_error`, and "HTTP 401" alone has cost more diagnosis time
 * than it has saved.
 */
export const describeFailure = (status: number | null, path: string, e?: unknown): string => {
  if (status === null) {
    // AbortSignal.timeout rejects with a TimeoutError whose message is just
    // "The operation was aborted" — useless on its own, so the caller says what
    // timed out and after how long instead of passing this through.
    return e instanceof Error ? e.message : String(e)
  }
  return status === 401 || status === 403
    ? `Rejected the stored credential (HTTP ${status})`
    : `HTTP ${status} from ${path}`
}
