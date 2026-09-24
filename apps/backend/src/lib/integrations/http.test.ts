import { describe, it, expect } from 'vitest'
import {
  integrationUrl,
  authHeaders,
  insecureCredentialTransport,
  describeFailure,
  type IntegrationTarget,
} from './http'

/**
 * The two halves of talking to an integration that every kind shares (issue
 * #111), and the sentence an operator is shown when one fails.
 *
 * This file had no test of its own until #307's tail: it is the module `probe`,
 * `foreman`, `grafana` and `loki` all build their calls on, so a mistake here is
 * a mistake in every outbound call the portal makes, and each of these
 * behaviours is invisible from either end — a URL built the obvious way drops a
 * gateway's base path, an auth type mapped to the wrong header authenticates
 * against nothing, and a credential put on the wire in cleartext looks exactly
 * like a working integration until someone reads the traffic.
 */
const target = (over: Partial<IntegrationTarget> = {}): IntegrationTarget => ({
  kind: 'foreman',
  baseUrl: 'https://foreman.example.com',
  authType: 'bearer',
  username: 'svc',
  credential: 'a-token',
  ...over,
})

describe('integrationUrl', () => {
  it('joins the path onto the base', () => {
    expect(integrationUrl('https://foreman.example.com', '/api/v2/status').toString()).toBe(
      'https://foreman.example.com/api/v2/status',
    )
  })

  it('keeps the base path, which is what a gateway mounts an integration at', () => {
    // `new URL(path, base)` — the obvious way — would discard `/foreman` and call
    // the gateway root, so a Foreman (or Grafana, or Loki) mounted at a subpath
    // would be reported unreachable while being perfectly up.
    expect(integrationUrl('https://gw.example.com/foreman', '/api/v2/status').toString()).toBe(
      'https://gw.example.com/foreman/api/v2/status',
    )
  })

  it('strips trailing slashes from the base instead of doubling them', () => {
    // `//api/v2/status` is a 404 on Nexus and Pulp — not a redirect to the single
    // slash, which is what makes this worth asserting rather than assuming.
    expect(integrationUrl('https://nexus.example.com/', '/service/rest/v1/status').toString()).toBe(
      'https://nexus.example.com/service/rest/v1/status',
    )
    expect(integrationUrl('https://nexus.example.com///', '/service/rest/v1/status').toString()).toBe(
      'https://nexus.example.com/service/rest/v1/status',
    )
  })

  it('refuses a protocol fetch would otherwise accept', () => {
    // The base URL is operator-supplied, and `fetch` is happy to read a file.
    expect(() => integrationUrl('file:///etc', '/passwd')).toThrow(/Disallowed URL protocol: file:/)
    expect(() => integrationUrl('data:text/plain,hello', '/x')).toThrow(/Disallowed URL protocol: data:/)
  })

  it('accepts plain http, which an internal status endpoint legitimately uses', () => {
    // Versions of this guard that only allow https break the unauthenticated
    // internal case; `insecureCredentialTransport` is what refuses the credential.
    expect(integrationUrl('http://loki.internal:3100', '/ready').protocol).toBe('http:')
  })
})

describe('insecureCredentialTransport', () => {
  it('allows a credential over https', () => {
    const url = integrationUrl('https://foreman.example.com', '/api')
    expect(insecureCredentialTransport(target(), url)).toBeNull()
  })

  it('allows plain http when the integration needs no credential', () => {
    const url = integrationUrl('http://loki.internal:3100', '/ready')
    expect(insecureCredentialTransport(target({ authType: 'none', credential: null }), url)).toBeNull()
  })

  it('refuses every authenticated kind over plain http', () => {
    // CodeRabbit on #499 (CWE-319): the credential is encrypted at rest so that it
    // is not readable, and sending it in cleartext undoes that for anyone on the
    // path. Each auth type is named because the guard must not depend on which one.
    const url = integrationUrl('http://foreman.internal', '/api')
    for (const authType of ['bearer', 'basic', 'token_header'] as const) {
      expect(insecureCredentialTransport(target({ authType }), url)).toMatch(
        /Refusing to send the stored credential over plain HTTP/,
      )
    }
  })

  it('says both ways out, because https is not always available', () => {
    const url = integrationUrl('http://foreman.internal', '/api')
    const reason = insecureCredentialTransport(target(), url)
    expect(reason).toContain('https:// base URL')
    expect(reason).toContain('authentication to "none"')
  })
})

describe('authHeaders', () => {
  it('sends nothing for an unauthenticated integration', () => {
    expect(authHeaders(target({ authType: 'none', credential: null }))).toEqual({})
  })

  it('sends a bearer token', () => {
    expect(authHeaders(target())).toEqual({ Authorization: 'Bearer a-token' })
  })

  it('sends basic auth encoded from the username and the credential', () => {
    const headers = authHeaders(target({ authType: 'basic', username: 'svc', credential: 'pässwörd' }))
    // Round-tripped rather than compared to a literal: the two ways this goes
    // wrong are the wrong separator and a latin1 encoding, and both survive a
    // hard-coded base64 copy-pasted from a failing run.
    const [, encoded] = headers.Authorization.split(' ')
    expect(Buffer.from(encoded, 'base64').toString('utf8')).toBe('svc:pässwörd')
  })

  it('sends a bare token header for the kinds that want one', () => {
    // Nexus and Pulp behind a gateway commonly want `X-Auth-Token` rather than a
    // scheme, which is why this is a type of its own instead of an operator
    // smuggling "Bearer x" into the credential.
    expect(authHeaders(target({ authType: 'token_header', credential: 'nexus-tok' }))).toEqual({
      'X-Auth-Token': 'nexus-tok',
    })
  })

  it('never sends two credential headers at once', () => {
    // A switch, not a chain of ifs: one `Authorization` and no token header, or
    // the other way round, but never both — an integration that received both
    // would authenticate as whichever the far end happened to prefer.
    for (const authType of ['bearer', 'basic', 'token_header'] as const) {
      const headers = authHeaders(target({ authType }))
      expect(Object.keys(headers)).toHaveLength(1)
    }
  })

  it('treats a missing credential as an empty one rather than sending "null"', () => {
    // Unreachable through the admin service, which requires a credential for
    // every kind but `none` (and drops one sent with `none`) — but this module is
    // also called from tests and probes with hand-built targets, and the string
    // "null" would be sent to a real server as a credential.
    expect(authHeaders(target({ credential: null }))).toEqual({ Authorization: 'Bearer ' })
  })
})

describe('describeFailure', () => {
  it('passes through what a transport error said, because a timeout says it there', () => {
    // AbortSignal.timeout rejects with `TimeoutError: The operation was aborted`,
    // and the callers that care say what timed out instead of passing that on.
    const timeout = Object.assign(new Error('The operation was aborted'), { name: 'TimeoutError' })
    expect(describeFailure(null, '/api', timeout)).toBe('The operation was aborted')
  })

  it('stringifies a rejection that is not an Error', () => {
    expect(describeFailure(null, '/api', 'connection refused')).toBe('connection refused')
  })

  it('names the credential, because a 401 is not usually the URL', () => {
    expect(describeFailure(401, '/api/v2/status')).toBe('Rejected the stored credential (HTTP 401)')
    expect(describeFailure(403, '/api/v2/status')).toBe('Rejected the stored credential (HTTP 403)')
  })

  it('names the path for everything else', () => {
    expect(describeFailure(500, '/api/v2/status')).toBe('HTTP 500 from /api/v2/status')
    expect(describeFailure(404, '/ready')).toBe('HTTP 404 from /ready')
  })

  it('carries no body: the caller decides whether the server had anything worth showing', () => {
    // Loki's own parser complaint is appended by the client that knows how to read
    // an error envelope; putting it here would have every client forwarding
    // whatever the far end chose to send, including none of it.
    const message = describeFailure(400, '/loki/api/v1/query_range')
    expect(message).not.toContain(':')
    expect(message).toBe('HTTP 400 from /loki/api/v1/query_range')
  })
})
