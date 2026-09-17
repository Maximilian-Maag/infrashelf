import { describe, it, expect, vi, afterEach } from 'vitest'
import { listForemanHosts } from './foreman'
import type { IntegrationTarget } from './http'

afterEach(() => vi.restoreAllMocks())

const target = (overrides: Partial<IntegrationTarget> = {}): IntegrationTarget => ({
  kind: 'foreman',
  baseUrl: 'https://foreman.example.com',
  authType: 'bearer',
  username: '',
  credential: 'a-token',
  ...overrides,
})

const jsonRes = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })

const host = (id: number, name: string, over: Record<string, unknown> = {}) => ({
  id,
  name,
  global_status_label: 'OK',
  last_report: '2026-09-17T09:00:00Z',
  ...over,
})

/** A full page, so the client asks for another one. */
const fullPage = (start: number) =>
  jsonRes({ results: Array.from({ length: 100 }, (_, i) => host(start + i, `host-${start + i}`)) })

describe('listForemanHosts', () => {
  it('reads one page and stops when it comes back short', async () => {
    const fetchMock = vi
      .spyOn(global, 'fetch')
      .mockResolvedValue(jsonRes({ results: [host(1, 'web-01.dc.example.com')], total: 1 }))

    const result = await listForemanHosts(target())

    expect(result).toEqual({
      ok: true,
      hosts: [
        {
          id: 1,
          name: 'web-01.dc.example.com',
          status: 'OK',
          lastReportAt: '2026-09-17T09:00:00Z',
        },
      ],
    })
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect((fetchMock.mock.calls[0][0] as URL).toString()).toBe(
      'https://foreman.example.com/api/v2/hosts?per_page=100&page=1',
    )
  })

  it('keeps the base path of a Foreman behind a gateway', async () => {
    const fetchMock = vi.spyOn(global, 'fetch').mockResolvedValue(jsonRes({ results: [] }))

    await listForemanHosts(target({ baseUrl: 'https://gw.example.com/foreman/' }))

    // `new URL(path, base)` would have dropped `/foreman` and asked the gateway
    // root, which answers something — just not this.
    expect((fetchMock.mock.calls[0][0] as URL).pathname).toBe('/foreman/api/v2/hosts')
  })

  it('walks pages until one is short', async () => {
    const fetchMock = vi
      .spyOn(global, 'fetch')
      .mockResolvedValueOnce(fullPage(1))
      .mockResolvedValueOnce(jsonRes({ results: [host(101, 'web-101')] }))

    const result = await listForemanHosts(target())

    expect(result.ok && result.hosts).toHaveLength(101)
    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect((fetchMock.mock.calls[1][0] as URL).searchParams.get('page')).toBe('2')
  })

  it('counts a host that shifted between pages once', async () => {
    // Foreman pages by offset, so a host created mid-listing pushes a row onto a
    // page already read. A doubled host is a fake orphan downstream.
    vi.spyOn(global, 'fetch')
      .mockResolvedValueOnce(fullPage(1))
      .mockResolvedValueOnce(jsonRes({ results: [host(100, 'host-100'), host(101, 'web-101')] }))

    const result = await listForemanHosts(target())

    expect(result.ok && result.hosts).toHaveLength(101)
    expect(result.ok && result.hosts.filter((h) => h.id === 100)).toHaveLength(1)
  })

  it('does not trust `total` to decide where the end is', async () => {
    // Some versions report the count from before the page was built. A loop that
    // believed it would keep asking after the rows ran out.
    const fetchMock = vi
      .spyOn(global, 'fetch')
      .mockResolvedValue(jsonRes({ results: [host(1, 'web-01')], total: 900 }))

    const result = await listForemanHosts(target())

    expect(result.ok && result.hosts).toHaveLength(1)
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('skips a row that carries no usable name', async () => {
    // An empty name would match every element whose hostname parameter is unset.
    vi.spyOn(global, 'fetch').mockResolvedValue(
      jsonRes({ results: [host(1, ''), { id: 2 }, host(3, 'web-03')] }),
    )

    const result = await listForemanHosts(target())

    expect(result.ok && result.hosts.map((h) => h.id)).toEqual([3])
  })

  it('names the credential when Foreman rejects it', async () => {
    vi.spyOn(global, 'fetch').mockResolvedValue(jsonRes({ error: 'unauthorized' }, 401))

    const result = await listForemanHosts(target())

    expect(result).toEqual({ ok: false, error: 'Rejected the stored credential (HTTP 401)' })
  })

  it('refuses a 200 that is not the documented envelope', async () => {
    // A gateway's login page answers 200. Reporting "0 hosts" for it would read
    // as an empty inventory, which is the one answer nobody should act on.
    vi.spyOn(global, 'fetch').mockResolvedValue(new Response('<html>login</html>', { status: 200 }))

    const result = await listForemanHosts(target())

    expect(result.ok).toBe(false)
    expect(result.ok === false && result.error).toMatch(/Unexpected response/)
  })

  it('says what timed out rather than "The operation was aborted"', async () => {
    vi.spyOn(global, 'fetch').mockRejectedValue(
      Object.assign(new Error('The operation was aborted'), { name: 'TimeoutError' }),
    )

    const result = await listForemanHosts(target())

    expect(result.ok === false && result.error).toMatch(/No response within \d+ ms/)
  })

  it('refuses a base URL that is not HTTP', async () => {
    const fetchMock = vi.spyOn(global, 'fetch')

    const result = await listForemanHosts(target({ baseUrl: 'file:///etc/passwd' }))

    expect(result.ok === false && result.error).toMatch(/Disallowed URL protocol/)
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('sends the credential the way the stored auth type says', async () => {
    const fetchMock = vi.spyOn(global, 'fetch').mockResolvedValue(jsonRes({ results: [] }))

    await listForemanHosts(target({ authType: 'basic', username: 'svc', credential: 'pw' }))

    const headers = (fetchMock.mock.calls[0][1] as RequestInit).headers as Record<string, string>
    expect(headers.Authorization).toBe(`Basic ${Buffer.from('svc:pw').toString('base64')}`)
  })

  it('does not follow a redirect to a login page', async () => {
    const fetchMock = vi.spyOn(global, 'fetch').mockResolvedValue(jsonRes({ results: [] }))

    await listForemanHosts(target())

    expect((fetchMock.mock.calls[0][1] as RequestInit).redirect).toBe('manual')
  })

  it('stops rather than paging for ever', async () => {
    // A paginated API that answers the same full page every time is a hang, and
    // this runs while an admin waits.
    const fetchMock = vi.spyOn(global, 'fetch').mockImplementation(async () => fullPage(1))

    const result = await listForemanHosts(target())

    expect(result.ok).toBe(false)
    expect(result.ok === false && result.error).toMatch(/refusing to page further/)
    expect(fetchMock.mock.calls.length).toBeLessThanOrEqual(50)
  })
})
