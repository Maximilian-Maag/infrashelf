import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen } from '@testing-library/react'
import type * as Navigation from 'next/navigation'
import type { AuditEntry } from '@infrashelf/types'
import { ApiError } from '@/lib/api'
import AuditPage from './page'

const auth = vi.fn()
vi.mock('@/lib/auth', () => ({ auth: () => auth() }))

const redirect = vi.fn((url: string) => { throw new Error(`NEXT_REDIRECT:${url}`) })
vi.mock('next/navigation', async (importOriginal) => ({
  ...(await importOriginal<typeof Navigation>()),
  redirect: (url: string) => redirect(url),
}))

vi.mock('@/lib/getLang', () => ({ getLang: async () => 'en' }))

// Both islands navigate and fetch on their own; this file is about the page
// around them. The filter bar keeps its result count visible, because what the
// page counted is a decision worth asserting.
vi.mock('./AuditFilters', () => ({
  AuditFilters: ({ resultCount }: { resultCount: number }) => <div data-testid="filters" data-count={resultCount} />,
}))
vi.mock('./AuditExport', () => ({ AuditExport: () => <div data-testid="export" /> }))

const get = vi.fn()
vi.mock('@/lib/serverApi', () => ({ get: (path: string) => get(path) }))

const entry = (over: Partial<AuditEntry> = {}): AuditEntry => ({
  id: 7,
  userId: 3,
  action: 'user.login',
  entityId: null,
  details: '',
  createdAt: '2026-01-01T09:00:00.000Z',
  ...over,
})

const answer = (over: { data?: AuditEntry[]; total?: number } | Error = {}) => {
  get.mockImplementation(() =>
    over instanceof Error
      ? Promise.reject(over)
      : Promise.resolve({ data: over.data ?? [entry()], total: over.total ?? 1, page: 1, pageSize: 20 }),
  )
}

const params = (p: Record<string, string | string[] | undefined> = {}) => Promise.resolve(p)
const query = () => new URL(String(get.mock.calls[0]?.[0] ?? '/api/audit'), 'http://x').searchParams

beforeEach(() => {
  get.mockReset()
  redirect.mockClear()
  vi.spyOn(console, 'error').mockImplementation(() => {})
  auth.mockResolvedValue({ user: { name: 'Ada', role: 'admin' } })
  answer()
})

/**
 * The record of who did what, and the page where "nothing here" is most likely
 * to be believed: an administrator checking who changed something reads an empty
 * table as evidence that nobody did (#221).
 */
describe('AuditPage', () => {
  it('sends a caller with no session to the login page', async () => {
    auth.mockResolvedValue(null)
    await expect(AuditPage({ searchParams: params() })).rejects.toThrow('NEXT_REDIRECT')
    expect(redirect).toHaveBeenCalledWith('/login')
  })

  it('sends a signed-in non-admin home rather than showing them the log', async () => {
    auth.mockResolvedValue({ user: { name: 'Bob', role: 'user' } })
    await expect(AuditPage({ searchParams: params() })).rejects.toThrow('NEXT_REDIRECT')
    expect(redirect).toHaveBeenCalledWith('/')
  })

  it('forwards the filters it knows, and drops anything else', async () => {
    render(await AuditPage({ searchParams: params({
      userId: '3', action: 'user.login', from: '2026-01-01', to: '2026-02-01', nonsense: 'x',
    }) }))

    expect(query().get('userId')).toBe('3')
    expect(query().get('action')).toBe('user.login')
    expect(query().get('from')).toBe('2026-01-01')
    expect(query().get('to')).toBe('2026-02-01')
    expect(query().get('nonsense')).toBeNull()
  })

  it('takes the first value when a filter is repeated', async () => {
    render(await AuditPage({ searchParams: params({ action: ['user.login', 'user.logout'] }) }))
    expect(query().get('action')).toBe('user.login')
  })

  it('asks for the page the offset lands in', async () => {
    render(await AuditPage({ searchParams: params({ offset: '40' }) }))
    expect(query().get('page')).toBe('3')
    expect(query().get('pageSize')).toBe('20')
  })

  it('snaps an offset that is not on a page boundary', async () => {
    // `?offset=47` asked the API for page 1 while the pager built its links from
    // 47 — so Next went to 67, and the row the reader was looking at was on
    // neither page.
    render(await AuditPage({ searchParams: params({ offset: '47' }) }))
    expect(query().get('page')).toBe('3')
  })

  it('reads an offset that is not a decimal integer as page one', async () => {
    // The bar `parseAuditFilters` sets on the backend: `Number()` would read
    // `0x60` as 96, which is a page nobody asked for.
    for (const offset of ['abc', '0x60', ' 20 ', '-20', '1e3']) {
      get.mockClear()
      render(await AuditPage({ searchParams: params({ offset }) }))
      expect(query().get('page'), offset).toBe('1')
    }
  })

  it('renders the entries it was given', async () => {
    render(await AuditPage({ searchParams: params() }))
    expect(screen.getByText('user.login')).toBeInTheDocument()
  })

  it('names the actor as the system when an entry has no user', async () => {
    answer({ data: [entry({ userId: null, userName: undefined })] })
    render(await AuditPage({ searchParams: params() }))
    expect(screen.getByText('System')).toBeInTheDocument()
  })

  /*
   * #221, and the property the whole page is arranged around: the failure used
   * to be dropped and the table rendered "no audit entries" underneath — an
   * outage producing the same screen as a clean record.
   */
  it('reports a failed query instead of rendering an empty audit log', async () => {
    answer(new ApiError(500, 'Internal Server Error'))

    render(await AuditPage({ searchParams: params() }))

    expect(screen.getByRole('alert')).toHaveTextContent('HTTP 500: Internal Server Error')
    expect(screen.queryByText(/no audit entries/i)).not.toBeInTheDocument()
  })

  it('still shows the empty state when the query succeeds with nothing in it', async () => {
    answer({ data: [], total: 0 })
    render(await AuditPage({ searchParams: params() }))
    expect(screen.getByText(/no audit entries/i)).toBeInTheDocument()
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
  })

  it('tells the filter bar how many rows the query produced', async () => {
    answer({ data: [entry({ id: 1 }), entry({ id: 2 })], total: 2 })
    render(await AuditPage({ searchParams: params() }))
    expect(screen.getByTestId('filters')).toHaveAttribute('data-count', '2')
  })

  it('pages with links that carry the filters', async () => {
    answer({ data: [entry()], total: 45 })
    render(await AuditPage({ searchParams: params({ action: 'user.login', offset: '20' }) }))

    const next = screen.getByRole('link', { name: /next/i })
    expect(next).toHaveAttribute('href', '/audit?action=user.login&offset=40')
    expect(screen.getByRole('link', { name: /previous/i })).toHaveAttribute('href', '/audit?action=user.login')
  })

  it('does not page a log that fits on one page', async () => {
    answer({ data: [entry()], total: 1 })
    render(await AuditPage({ searchParams: params() }))
    expect(screen.queryByRole('link', { name: /next/i })).not.toBeInTheDocument()
  })
})
