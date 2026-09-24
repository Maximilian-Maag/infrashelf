import { describe, it, expect, vi, afterEach } from 'vitest'
import { elementLogSelector, queryLokiLogs, LOKI_LINE_LIMIT } from './loki'
import type { IntegrationTarget } from '@/lib/integrations/http'

/**
 * The Loki read path (#111).
 *
 * Every test here is about something that would be a WRONG ANSWER rather than an
 * error: a query that reads the wrong stream, a limit that truncates silently, a
 * gateway's login page reported as "this pipeline printed nothing". None of them
 * fails loudly in production — they say an element has no outputs.
 */
afterEach(() => vi.restoreAllMocks())

const target = (overrides: Partial<IntegrationTarget> = {}): IntegrationTarget => ({
  kind: 'loki',
  baseUrl: 'https://loki.example.com',
  authType: 'bearer',
  username: '',
  credential: 'a-token',
  ...overrides,
})

const jsonRes = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })

const streamsRes = (streams: (unknown)[]) =>
  jsonRes({ status: 'success', data: { resultType: 'streams', result: streams } })

/** The URL a mocked fetch was called with. */
const requestedUrl = (mock: ReturnType<typeof vi.spyOn>): URL =>
  new URL(String((mock.mock.calls[0] as [unknown])[0]))

const window = { since: new Date('2026-09-24T10:00:00Z'), until: new Date('2026-09-24T11:00:00Z') }

describe('elementLogSelector', () => {
  it('builds the one selector the portal will read', () => {
    expect(elementLogSelector(17)).toBe('{element_id="17"}')
  })

  it('refuses anything that is not a positive integer id', () => {
    // The reason this is a function and not a template string at the call site:
    // a LogQL selector is not scoped by anything, so the only thing standing
    // between a caller and every tenant's logs is that this cannot produce a
    // selector for anything but a row the caller was authorised against.
    for (const bad of [0, -1, 1.5, Number.NaN, Number.MAX_SAFE_INTEGER + 2]) {
      expect(() => elementLogSelector(bad), String(bad)).toThrow(/positive integer/)
    }
  })
})

describe('queryLokiLogs', () => {
  it('asks query_range for the element stream, oldest first, over the window given', async () => {
    const fetchMock = vi
      .spyOn(global, 'fetch')
      .mockResolvedValue(streamsRes([{ stream: { element_id: '17' }, values: [['1758708000000000000', 'hello']] }]))

    const result = await queryLokiLogs(target(), elementLogSelector(17), window)

    expect(result).toMatchObject({ ok: true, truncated: false })
    const url = requestedUrl(fetchMock)
    expect(url.pathname).toBe('/loki/api/v1/query_range')
    expect(url.searchParams.get('query')).toBe('{element_id="17"}')
    expect(url.searchParams.get('direction')).toBe('forward')
    expect(url.searchParams.get('limit')).toBe(String(LOKI_LINE_LIMIT))
    // Nanoseconds, not a date string: Loki accepts RFC3339, but the integer form
    // leaves no question about how a given instance parses it.
    expect(url.searchParams.get('start')).toBe(`${BigInt(window.since.getTime()) * 1_000_000n}`)
    expect(url.searchParams.get('end')).toBe(`${BigInt(window.until.getTime()) * 1_000_000n}`)
  })

  it('keeps the base path of a Loki that is mounted behind a gateway', async () => {
    const fetchMock = vi.spyOn(global, 'fetch').mockResolvedValue(streamsRes([]))

    await queryLokiLogs(target({ baseUrl: 'https://gw.example.com/loki/' }), elementLogSelector(1), window)

    expect(requestedUrl(fetchMock).toString()).toContain('https://gw.example.com/loki/loki/api/v1/query_range')
  })

  it('sends the credential the way the integration says to', async () => {
    const fetchMock = vi.spyOn(global, 'fetch').mockResolvedValue(streamsRes([]))

    await queryLokiLogs(target({ authType: 'basic', username: 'svc', credential: 'pw' }), elementLogSelector(1), window)
    const [, init] = fetchMock.mock.calls[0] as [unknown, RequestInit]
    expect((init.headers as Record<string, string>).Authorization).toBe(
      `Basic ${Buffer.from('svc:pw').toString('base64')}`,
    )

    // An unauthenticated Loki (a public one behind a network policy) sends no
    // header at all rather than an empty one.
    vi.restoreAllMocks()
    const anon = vi.spyOn(global, 'fetch').mockResolvedValue(streamsRes([]))
    await queryLokiLogs(target({ authType: 'none', credential: null }), elementLogSelector(1), window)
    const [, anonInit] = anon.mock.calls[0] as [unknown, RequestInit]
    expect(anonInit.headers).toEqual({ Accept: 'application/json' })
  })

  it('refuses to put a stored credential on a plaintext connection', async () => {
    const fetchMock = vi.spyOn(global, 'fetch')

    const result = await queryLokiLogs(
      target({ baseUrl: 'http://loki.internal' }),
      elementLogSelector(1),
      window,
    )

    expect(result).toMatchObject({ ok: false })
    expect(result.ok === false && result.error).toMatch(/plain HTTP/)
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('merges several streams into one timeline', async () => {
    // One element can match several streams — a template that labels per stage,
    // or a pipeline that restarted. Concatenating them would hand the parser two
    // `Outputs:` blocks in an order that never happened.
    vi.spyOn(global, 'fetch').mockResolvedValue(
      streamsRes([
        { stream: { job: 'b' }, values: [['1758708002000000000', 'second'], ['1758708004000000000', 'fourth']] },
        { stream: { job: 'a' }, values: [['1758708001000000000', 'first'], ['1758708003000000000', 'third']] },
      ]),
    )

    const result = await queryLokiLogs(target(), elementLogSelector(17), window)

    expect(result.ok && result.lines.map((l) => l.line)).toEqual(['first', 'second', 'third', 'fourth'])
  })

  it('says so when the limit is what came back', async () => {
    // A truncated apply log looks exactly like one that declared no outputs, so
    // the answer has to carry the difference.
    const many = Array.from({ length: LOKI_LINE_LIMIT }, (_, i) => [`175870800${String(i).padStart(9, '0')}`, `line ${i}`])
    vi.spyOn(global, 'fetch').mockResolvedValue(streamsRes([{ stream: {}, values: many }]))

    const result = await queryLokiLogs(target(), elementLogSelector(17), window)

    expect(result).toMatchObject({ ok: true, truncated: true })
    expect(result.ok && result.lines).toHaveLength(LOKI_LINE_LIMIT)
  })

  it('turns a 400 into Loki’s own sentence, because it is usually the query', async () => {
    vi.spyOn(global, 'fetch').mockResolvedValue(jsonRes({ status: 'error', error: 'parse error at line 1' }, 400))

    const result = await queryLokiLogs(target(), elementLogSelector(17), window)

    expect(result.ok === false && result.error).toBe(
      'HTTP 400 from /loki/api/v1/query_range: parse error at line 1',
    )
  })

  it('names the credential when the credential is the problem', async () => {
    vi.spyOn(global, 'fetch').mockResolvedValue(new Response('Unauthorized', { status: 401 }))

    const result = await queryLokiLogs(target(), elementLogSelector(17), window)

    expect(result.ok === false && result.error).toMatch(/Rejected the stored credential \(HTTP 401\)/)
  })

  it('reports a body that is not Loki as such, rather than as an empty log', async () => {
    // The usual cause is a base URL pointing at a gateway login page, and
    // "0 lines" for that reads as a pipeline that shipped nothing.
    vi.spyOn(global, 'fetch').mockResolvedValue(new Response('<html>Sign in</html>', { status: 200 }))

    const result = await queryLokiLogs(target(), elementLogSelector(17), window)

    expect(result.ok === false && result.error).toBe('Unexpected response from /loki/api/v1/query_range')
  })

  it('reports a metric query asked of the log endpoint', async () => {
    vi.spyOn(global, 'fetch').mockResolvedValue(
      jsonRes({ status: 'success', data: { resultType: 'matrix', result: [] } }),
    )

    const result = await queryLokiLogs(target(), elementLogSelector(17), window)

    expect(result.ok === false && result.error).toMatch(/answered with matrix instead of streams/)
  })

  it('ignores the values it cannot read instead of failing the whole query', async () => {
    vi.spyOn(global, 'fetch').mockResolvedValue(
      streamsRes([
        {
          stream: {},
          values: [
            ['1758708001000000000', 'good'],
            ['not-a-pair'],
            [1, 'not-a-timestamp'],
            // A string timestamp that is not a whole number: it is parsed as a
            // BigInt for the sort, and BigInt('') throws — the one input that
            // would break this function's promise never to throw.
            ['', 'empty timestamp'],
            ['1758708001000000000.5', 'fractional'],
            null,
          ],
        },
        { stream: {} },
        null,
      ]),
    )

    const result = await queryLokiLogs(target(), elementLogSelector(17), window)

    expect(result.ok && result.lines.map((l) => l.line)).toEqual(['good'])
  })

  it('refuses a window that ends before it starts', async () => {
    const fetchMock = vi.spyOn(global, 'fetch')

    const result = await queryLokiLogs(target(), elementLogSelector(17), {
      since: new Date('2026-09-24T11:00:00Z'),
      until: new Date('2026-09-24T10:00:00Z'),
    })

    expect(result.ok === false && result.error).toMatch(/ends before it starts/)
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('reports a timeout as a timeout, not as Loki’s own error', async () => {
    vi.spyOn(global, 'fetch').mockRejectedValue(
      Object.assign(new Error('The operation was aborted'), { name: 'TimeoutError' }),
    )

    const result = await queryLokiLogs(target(), elementLogSelector(17), window)

    expect(result.ok === false && result.error).toBe('No response within 20000 ms')
  })

  it('refuses a base URL that is not http(s)', async () => {
    const result = await queryLokiLogs(target({ baseUrl: 'file:///etc' }), elementLogSelector(17), window)

    expect(result.ok === false && result.error).toMatch(/Disallowed URL protocol/)
  })
})
