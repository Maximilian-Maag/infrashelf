import { describe, it, expect, vi, afterEach } from 'vitest'
import { queryPolicy, ORDER_DECISION_PATH, POLICY_TIMEOUT_MS } from './client'
import type { IntegrationTarget } from '@/lib/integrations/http'

/**
 * The OPA query (issue #110). Unit tests: a mocked `fetch`, no database, no
 * engine. What matters here is the CONTRACT — where the request goes, what it
 * carries, and that every way of not getting a usable answer is a failure rather
 * than an accidental allow.
 */

afterEach(() => vi.restoreAllMocks())

const target = (over: Partial<IntegrationTarget> = {}): IntegrationTarget => ({
  kind: 'opa',
  baseUrl: 'https://opa.example.com',
  authType: 'bearer',
  username: '',
  credential: 'a-token',
  ...over,
})

const jsonRes = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })

const decision = (payload: Record<string, unknown>) => jsonRes({ result: payload })

const callOf = (mock: ReturnType<typeof vi.spyOn>) => {
  const [url, init] = mock.mock.calls[0] as [URL, RequestInit]
  return {
    url: url.toString(),
    headers: (init.headers ?? {}) as Record<string, string>,
    init,
    body: JSON.parse(String(init.body)) as { input?: unknown },
  }
}

const document = { version: 1, projectId: 7, quantity: 2 }

describe('queryPolicy — the request', () => {
  it('POSTs the document as `input` to the decision path', async () => {
    const fetchMock = vi.spyOn(global, 'fetch').mockResolvedValue(decision({ decision: 'allow' }))

    await queryPolicy(target(), document)
    const call = callOf(fetchMock)

    expect(call.url).toBe(`https://opa.example.com${ORDER_DECISION_PATH}`)
    expect(call.init.method).toBe('POST')
    // The path OPA evaluates, and the key its `input` variable refers to — the
    // two things a policy author cannot see from the portal side.
    expect(ORDER_DECISION_PATH).toBe('/v1/data/infrashelf/order/decision')
    expect(call.body).toEqual({ input: document })
  })

  it('keeps a base URL that has a path prefix', async () => {
    const fetchMock = vi.spyOn(global, 'fetch').mockResolvedValue(decision({ decision: 'allow' }))
    await queryPolicy(target({ baseUrl: 'https://gw.example.com/policy/' }), document)
    expect(callOf(fetchMock).url).toBe(`https://gw.example.com/policy${ORDER_DECISION_PATH}`)
  })

  it('sends the stored credential the way the integration is configured', async () => {
    const fetchMock = vi.spyOn(global, 'fetch').mockResolvedValue(decision({ decision: 'allow' }))

    await queryPolicy(target({ authType: 'bearer', credential: 'tok' }), document)
    expect(callOf(fetchMock).headers.Authorization).toBe('Bearer tok')

    vi.restoreAllMocks()
    const basic = vi.spyOn(global, 'fetch').mockResolvedValue(decision({ decision: 'allow' }))
    await queryPolicy(target({ authType: 'basic', username: 'svc', credential: 'pw' }), document)
    expect(callOf(basic).headers.Authorization).toBe(
      `Basic ${Buffer.from('svc:pw').toString('base64')}`,
    )

    vi.restoreAllMocks()
    const none = vi.spyOn(global, 'fetch').mockResolvedValue(decision({ decision: 'allow' }))
    await queryPolicy(target({ authType: 'none', credential: null }), document)
    expect(callOf(none).headers.Authorization).toBeUndefined()
  })

  it('does not follow redirects', async () => {
    // A 302 to a login page is the usual answer to a wrong URL, and following it
    // would turn "unauthorised" into a 200 whose body is HTML — which the parser
    // would then have to guess about.
    const fetchMock = vi.spyOn(global, 'fetch').mockResolvedValue(decision({ decision: 'allow' }))
    await queryPolicy(target(), document)
    expect(callOf(fetchMock).init.redirect).toBe('manual')
  })
})

describe('queryPolicy — the answer', () => {
  it('returns each of the three decisions with the rule that made it', async () => {
    for (const d of ['allow', 'warn', 'deny'] as const) {
      vi.spyOn(global, 'fetch').mockResolvedValue(
        decision({ decision: d, rule: `quota/${d}`, message: `because ${d}` }),
      )
      expect(await queryPolicy(target(), document)).toEqual({
        ok: true,
        decision: d,
        rule: `quota/${d}`,
        message: `because ${d}`,
      })
      vi.restoreAllMocks()
    }
  })

  it('treats a missing rule or message as absent rather than inventing one', async () => {
    // The policy's own words are used as given; a sentence made up here would not
    // be in the policy author's vocabulary, and `null` is the honest answer.
    vi.spyOn(global, 'fetch').mockResolvedValue(decision({ decision: 'deny' }))
    expect(await queryPolicy(target(), document)).toEqual({
      ok: true,
      decision: 'deny',
      rule: null,
      message: null,
    })
  })

  it('ignores a blank rule rather than showing an empty rule name', async () => {
    vi.spyOn(global, 'fetch').mockResolvedValue(decision({ decision: 'deny', rule: '   ' }))
    const result = await queryPolicy(target(), document)
    expect(result).toMatchObject({ ok: true, rule: null })
  })
})

describe('queryPolicy — every way of not getting an answer', () => {
  /*
   * Each of these is a FAILURE, and none of them may be an allow. The caller
   * decides what a failure means from the integration's failure mode — that is
   * the whole point of returning them instead of throwing.
   */
  it('refuses an undefined decision rather than reading it as permission', async () => {
    // OPA answers 200 with `{}` when the path evaluates to nothing, which means
    // the policy repository has no gate at that path — nobody wrote it, which
    // must not read as "everything is permitted".
    vi.spyOn(global, 'fetch').mockResolvedValue(jsonRes({}))
    const result = await queryPolicy(target(), document)
    expect(result.ok).toBe(false)
    expect(result.ok === false && result.error).toContain(ORDER_DECISION_PATH)
  })

  it('refuses a decision word it does not know', async () => {
    vi.spyOn(global, 'fetch').mockResolvedValue(decision({ decision: 'maybe' }))
    const result = await queryPolicy(target(), document)
    expect(result.ok).toBe(false)
    expect(result.ok === false && result.error).toContain('maybe')
  })

  it('refuses a result that is not an object', async () => {
    vi.spyOn(global, 'fetch').mockResolvedValue(jsonRes({ result: 'allow' }))
    expect((await queryPolicy(target(), document)).ok).toBe(false)
    vi.restoreAllMocks()
    vi.spyOn(global, 'fetch').mockResolvedValue(jsonRes({ result: ['allow'] }))
    expect((await queryPolicy(target(), document)).ok).toBe(false)
  })

  it('refuses a body that is not JSON', async () => {
    vi.spyOn(global, 'fetch').mockResolvedValue(new Response('<html>login</html>', { status: 200 }))
    expect((await queryPolicy(target(), document)).ok).toBe(false)
  })

  it('names the credential on 401 and 403', async () => {
    for (const status of [401, 403]) {
      vi.spyOn(global, 'fetch').mockResolvedValue(new Response('nope', { status }))
      const result = await queryPolicy(target(), document)
      expect(result).toMatchObject({ ok: false })
      expect(result.ok === false && result.error).toContain('credential')
      vi.restoreAllMocks()
    }
  })

  it('reports any other HTTP error with its status and path', async () => {
    vi.spyOn(global, 'fetch').mockResolvedValue(new Response('boom', { status: 502 }))
    const result = await queryPolicy(target(), document)
    expect(result.ok === false && result.error).toContain('502')
    expect(result.ok === false && result.error).toContain(ORDER_DECISION_PATH)
  })

  it('reports a redirect as the failure it is', async () => {
    vi.spyOn(global, 'fetch').mockResolvedValue(
      new Response(null, { status: 302, headers: { location: '/login' } }),
    )
    const result = await queryPolicy(target(), document)
    expect(result).toMatchObject({ ok: false })
    expect(result.ok === false && result.error).toContain('302')
  })

  it('turns a network error into a result rather than throwing', async () => {
    vi.spyOn(global, 'fetch').mockRejectedValue(new Error('getaddrinfo ENOTFOUND opa'))
    const result = await queryPolicy(target(), document)
    expect(result.ok === false && result.error).toContain('ENOTFOUND')
  })

  it('says what timed out rather than "the operation was aborted"', async () => {
    const abort = new Error('The operation was aborted')
    abort.name = 'TimeoutError'
    vi.spyOn(global, 'fetch').mockRejectedValue(abort)

    const result = await queryPolicy(target(), document)
    expect(result.ok).toBe(false)
    expect(result.ok === false && result.error).toMatch(new RegExp(`No answer within ${POLICY_TIMEOUT_MS} ms`))
  })

  it('refuses a non-HTTP base URL without making a request', async () => {
    const fetchMock = vi.spyOn(global, 'fetch')
    const result = await queryPolicy(target({ baseUrl: 'file:///etc/passwd' }), document)
    expect(result.ok).toBe(false)
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('refuses to put a credential on the wire in cleartext', async () => {
    // The same rule the probe and the Foreman client apply (#499): an http://
    // engine with a stored token is a token anyone on the path can read.
    const fetchMock = vi.spyOn(global, 'fetch')
    const result = await queryPolicy(target({ baseUrl: 'http://opa.internal:8181' }), document)
    expect(result.ok).toBe(false)
    expect(result.ok === false && result.error).toContain('plain HTTP')
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('allows an unauthenticated engine over plain HTTP', async () => {
    // The normal deployment inside a cluster: OPA on http:// with authentication
    // "none". Refusing this would make the integration unusable where it is most
    // commonly run.
    const fetchMock = vi.spyOn(global, 'fetch').mockResolvedValue(decision({ decision: 'allow' }))
    const result = await queryPolicy(
      target({ baseUrl: 'http://opa.internal:8181', authType: 'none', credential: null }),
      document,
    )
    expect(result.ok).toBe(true)
    expect(callOf(fetchMock).url).toBe(`http://opa.internal:8181${ORDER_DECISION_PATH}`)
  })
})