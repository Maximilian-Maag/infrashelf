import { describe, it, expect, vi, afterEach } from 'vitest'
import { probeIntegration, type ProbeTarget } from './probe'
import type { IntegrationKind } from '@/lib/db/schema'

afterEach(() => vi.restoreAllMocks())

const target = (overrides: Partial<ProbeTarget> = {}): ProbeTarget => ({
  kind: 'foreman',
  baseUrl: 'https://foreman.example.com',
  authType: 'bearer',
  username: '',
  credential: 'a-token',
  ...overrides,
})

const jsonRes = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })

/** The URL and init a mocked fetch was called with. */
const callOf = (mock: ReturnType<typeof vi.spyOn>) => {
  const [url, init] = mock.mock.calls[0] as [URL, RequestInit]
  return { url: url.toString(), headers: (init.headers ?? {}) as Record<string, string>, init }
}

describe('probeIntegration — success', () => {
  it('reports reachable and parses Foreman’s version', () => {
    const fetchMock = vi
      .spyOn(global, 'fetch')
      .mockResolvedValue(jsonRes({ result: 'ok', version: '3.9.1', api_version: 2 }))

    return probeIntegration(target()).then((result) => {
      expect(result).toMatchObject({ ok: true, status: 200 })
      expect(result.detail).toBe('Foreman 3.9.1, API v2')
      expect(callOf(fetchMock).url).toBe('https://foreman.example.com/api/v2/status')
    })
  })

  it('is reachable even when Foreman’s body is not the JSON we hoped for', async () => {
    // The status code already established reachability; a changed body shape
    // must not turn a healthy system into a failure.
    vi.spyOn(global, 'fetch').mockResolvedValue(new Response('<html>ok</html>', { status: 200 }))
    const result = await probeIntegration(target())
    expect(result.ok).toBe(true)
    expect(result.detail).toBeUndefined()
  })

  it('reports no detail for the kinds whose response body has no meaning yet', async () => {
    vi.spyOn(global, 'fetch').mockResolvedValue(jsonRes({ version: '2.1.0' }))
    const result = await probeIntegration(target({ kind: 'grafana' }))
    expect(result).toMatchObject({ ok: true, status: 200, detail: undefined })
  })

  const paths: Record<IntegrationKind, string> = {
    foreman: '/api/v2/status',
    ansible: '/api/v2/ping/',
    nexus: '/service/rest/v1/status',
    pulp: '/pulp/api/v3/status/',
    loki: '/ready',
    grafana: '/api/health',
    opa: '/health',
  }

  it.each(Object.entries(paths))('uses the documented health path for %s', async (kind, path) => {
    const fetchMock = vi.spyOn(global, 'fetch').mockResolvedValue(jsonRes({}))
    await probeIntegration(target({ kind: kind as IntegrationKind }))
    expect(callOf(fetchMock).url).toBe(`https://foreman.example.com${path}`)
  })

  it('does not double the slash when the base URL has a trailing one', async () => {
    // `//api/v2/status` is a 404 on Nexus and Pulp, and an operator pasting a
    // base URL with a trailing slash is the normal case, not the exception.
    const fetchMock = vi.spyOn(global, 'fetch').mockResolvedValue(jsonRes({}))
    await probeIntegration(target({ baseUrl: 'https://foreman.example.com///' }))
    expect(callOf(fetchMock).url).toBe('https://foreman.example.com/api/v2/status')
  })

  it('keeps a base URL that has a path prefix', async () => {
    const fetchMock = vi.spyOn(global, 'fetch').mockResolvedValue(jsonRes({}))
    await probeIntegration(target({ baseUrl: 'https://gw.example.com/foreman' }))
    expect(callOf(fetchMock).url).toBe('https://gw.example.com/foreman/api/v2/status')
  })
})

describe('probeIntegration — authentication', () => {
  it('sends a bearer token', async () => {
    const fetchMock = vi.spyOn(global, 'fetch').mockResolvedValue(jsonRes({}))
    await probeIntegration(target({ authType: 'bearer', credential: 'tok' }))
    expect(callOf(fetchMock).headers.Authorization).toBe('Bearer tok')
  })

  it('sends basic auth built from the username and the credential', async () => {
    const fetchMock = vi.spyOn(global, 'fetch').mockResolvedValue(jsonRes({}))
    await probeIntegration(target({ authType: 'basic', username: 'svc', credential: 'pw' }))
    expect(callOf(fetchMock).headers.Authorization).toBe(
      `Basic ${Buffer.from('svc:pw').toString('base64')}`,
    )
  })

  it('sends a bare token header for token_header', async () => {
    const fetchMock = vi.spyOn(global, 'fetch').mockResolvedValue(jsonRes({}))
    await probeIntegration(target({ authType: 'token_header', credential: 'tok' }))
    expect(callOf(fetchMock).headers['X-Auth-Token']).toBe('tok')
    expect(callOf(fetchMock).headers.Authorization).toBeUndefined()
  })

  it('sends no credential at all for authType none', async () => {
    const fetchMock = vi.spyOn(global, 'fetch').mockResolvedValue(jsonRes({}))
    await probeIntegration(target({ authType: 'none', credential: null }))
    const { headers } = callOf(fetchMock)
    expect(headers.Authorization).toBeUndefined()
    expect(headers['X-Auth-Token']).toBeUndefined()
  })

  it('does not follow redirects', async () => {
    // A 302 to a login page is the usual answer to a bad credential; following
    // it would report a 200 from an HTML page as a healthy integration.
    const fetchMock = vi.spyOn(global, 'fetch').mockResolvedValue(jsonRes({}))
    await probeIntegration(target())
    expect(callOf(fetchMock).init.redirect).toBe('manual')
  })
})

describe('probeIntegration — failure', () => {
  it('names the credential on 401 and 403', async () => {
    for (const status of [401, 403]) {
      vi.spyOn(global, 'fetch').mockResolvedValue(new Response('nope', { status }))
      const result = await probeIntegration(target())
      expect(result).toMatchObject({ ok: false, status })
      expect(result.error).toContain('credential')
      vi.restoreAllMocks()
    }
  })

  it('reports the status and the path for any other HTTP error', async () => {
    vi.spyOn(global, 'fetch').mockResolvedValue(new Response('boom', { status: 502 }))
    const result = await probeIntegration(target())
    expect(result).toMatchObject({ ok: false, status: 502 })
    expect(result.error).toContain('502')
    expect(result.error).toContain('/api/v2/status')
  })

  it('reports a redirect as the failure it is', async () => {
    vi.spyOn(global, 'fetch').mockResolvedValue(
      new Response(null, { status: 302, headers: { location: '/login' } }),
    )
    const result = await probeIntegration(target())
    expect(result.ok).toBe(false)
    expect(result.status).toBe(302)
  })

  it('turns a network error into a result rather than throwing', async () => {
    vi.spyOn(global, 'fetch').mockRejectedValue(new Error('getaddrinfo ENOTFOUND foreman'))
    const result = await probeIntegration(target())
    expect(result).toMatchObject({ ok: false, status: null })
    expect(result.error).toContain('ENOTFOUND')
  })

  it('says what timed out, not "the operation was aborted"', async () => {
    const abort = new Error('The operation was aborted')
    abort.name = 'TimeoutError'
    vi.spyOn(global, 'fetch').mockRejectedValue(abort)

    const result = await probeIntegration(target())
    expect(result.ok).toBe(false)
    expect(result.error).toMatch(/No response within \d+ ms/)
  })

  it('refuses a non-HTTP base URL without making a request', async () => {
    const fetchMock = vi.spyOn(global, 'fetch')
    const result = await probeIntegration(target({ baseUrl: 'file:///etc/passwd' }))
    expect(result.ok).toBe(false)
    expect(result.error).toContain('protocol')
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('refuses a base URL that is not a URL at all', async () => {
    const fetchMock = vi.spyOn(global, 'fetch')
    const result = await probeIntegration(target({ baseUrl: 'not a url' }))
    expect(result.ok).toBe(false)
    expect(fetchMock).not.toHaveBeenCalled()
  })
})
