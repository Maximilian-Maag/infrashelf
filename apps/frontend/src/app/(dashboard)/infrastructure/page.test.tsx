import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, within } from '@testing-library/react'
import type * as Navigation from 'next/navigation'
import type { InfrastructureElement } from '@infrashelf/types'
import { ApiError } from '@/lib/api'
import InfrastructurePage from './page'

const auth = vi.fn()
vi.mock('@/lib/auth', () => ({ auth: () => auth() }))

const redirect = vi.fn((url: string) => { throw new Error(`NEXT_REDIRECT:${url}`) })
vi.mock('next/navigation', async (importOriginal) => ({
  ...(await importOriginal<typeof Navigation>()),
  redirect: (url: string) => redirect(url),
  useRouter: () => ({ refresh: vi.fn(), push: vi.fn(), replace: vi.fn() }),
  useSearchParams: () => new URLSearchParams(),
  usePathname: () => '/infrastructure',
}))

// The language comes from a cookie first, then Accept-Language; both are varied
// below, so they are mocked through variables rather than pinned to 'en'.
let langCookie: string | undefined = 'en'
let acceptLanguage = 'en'
vi.mock('next/headers', () => ({
  cookies: async () => ({ get: () => (langCookie === undefined ? undefined : { value: langCookie }) }),
  headers: async () => ({ get: () => acceptLanguage }),
}))

vi.mock('./InfraActions', () => ({
  InfraActions: ({ canRetry }: { canRetry: boolean }) => <div data-testid="actions" data-retry={String(canRetry)} />,
}))

// The filter bar and the export button fetch and navigate on their own; this
// file is about the page around them. `AutoRefresh` is kept visible through a
// marker so the polling decision can be asserted.
vi.mock('./InfraFilters', () => ({
  InfraFilters: ({ resultCount }: { resultCount: number }) => <div data-testid="filters" data-count={resultCount} />,
}))
vi.mock('./InfraExport', () => ({ InfraExport: () => <div data-testid="export" /> }))
vi.mock('@/components/ui/RefreshButton', () => ({ RefreshButton: () => <button type="button">Refresh</button> }))
vi.mock('@/components/ui/AutoRefresh', () => ({
  AutoRefresh: ({ active }: { active: boolean }) => <div data-testid="autorefresh" data-active={String(active)} />,
}))

const get = vi.fn()
vi.mock('@/lib/serverApi', () => ({ get: (path: string) => get(path) }))

const element = (over: Partial<InfrastructureElement> = {}): InfrastructureElement =>
  ({
    id: 1, projectId: 4, projectName: 'Platform', productName: 'Managed Postgres',
    environmentName: 'prod', status: 'active', displayStatus: 'active',
    createdAt: '2026-01-01T00:00:00.000Z', outputs: {}, ...over,
  }) as InfrastructureElement

const listPage = (items: InfrastructureElement[], over: Record<string, number> = {}) =>
  ({ items, total: items.length, limit: 20, offset: 0, ...over })

const facets = { environments: [], projects: [], products: [] }

const answer = (over: { list?: unknown; facets?: unknown } = {}) => {
  get.mockImplementation((path: string) => {
    const v = path.startsWith('/api/infrastructure/facets')
      ? ('facets' in over ? over.facets : facets)
      : ('list' in over ? over.list : listPage([element()]))
    return v instanceof Error ? Promise.reject(v) : Promise.resolve(v)
  })
}

const params = (p: Record<string, string | string[] | undefined> = {}) => Promise.resolve(p)
const listCall = () => (get.mock.calls.map((c) => c[0] as string).find((p) => !p.includes('/facets')) ?? '')
const listQuery = () => new URL(listCall(), 'http://x').searchParams

beforeEach(() => {
  get.mockReset()
  redirect.mockClear()
  vi.spyOn(console, 'error').mockImplementation(() => {})
  auth.mockResolvedValue({ user: { name: 'Ada', role: 'admin' } })
  langCookie = 'en'
  acceptLanguage = 'en'
  answer()
})

/**
 * What is actually deployed, and the page where "nothing here" is most likely to
 * be believed: an installation accumulates these rows forever — decommissioned
 * ones stay for the history — so an empty list reads as deprovisioned rather
 * than as not fetched (#158, #415).
 */
describe('InfrastructurePage', () => {
  it('sends a caller with no session to the login page', async () => {
    auth.mockResolvedValue(null)
    await expect(InfrastructurePage({ searchParams: params() })).rejects.toThrow('NEXT_REDIRECT')
    expect(redirect).toHaveBeenCalledWith('/login')
  })

  it('forwards the filters it knows, and drops anything else', async () => {
    render(await InfrastructurePage({ searchParams: params({
      search: 'db', status: 'active', environmentId: '2', nonsense: 'x',
    }) }))

    expect(listQuery().get('search')).toBe('db')
    expect(listQuery().get('status')).toBe('active')
    expect(listQuery().get('environmentId')).toBe('2')
    expect(listQuery().get('nonsense')).toBeNull()
  })

  it('takes the first value when a filter is repeated', async () => {
    render(await InfrastructurePage({ searchParams: params({ status: ['active', 'failed'] }) }))
    expect(listQuery().get('status')).toBe('active')
  })

  it('sets the language before the filters, so a bookmarked lang cannot win', async () => {
    // A bookmarked URL carrying its own `lang` would otherwise make the rows
    // disagree with the page around them.
    render(await InfrastructurePage({ searchParams: params({ lang: 'de' } as never) }))
    expect(listQuery().get('lang')).toBe('en')
  })

  it('asks for the facets in the same language as the rows', async () => {
    // A dropdown naming products in another language reads as a list of products
    // the user does not have.
    render(await InfrastructurePage({ searchParams: params() }))
    expect(get).toHaveBeenCalledWith('/api/infrastructure/facets?lang=en')
  })

  it('says the list could not be loaded, with its status', async () => {
    // A rejected list is not an empty inventory. 400 is a bookmarked filter the
    // backend rejects; 502 is an outage. The page said the same thing for both.
    answer({ list: new ApiError(400, 'deployedFrom is not a date') })
    render(await InfrastructurePage({ searchParams: params({ deployedFrom: 'yesterday' }) }))

    expect(screen.getByRole('alert')).toHaveTextContent('HTTP 400: deployedFrom is not a date')
    expect(screen.queryByText(/No infrastructure/)).not.toBeInTheDocument()
    expect(console.error).toHaveBeenCalledWith(
      '[page] could not load infrastructure list: HTTP 400: deployedFrom is not a date',
    )
  })

  it('tells "nothing deployed" apart from "nothing matches"', async () => {
    // The first is a state to act on; the second means the filters are too
    // narrow.
    answer({ list: listPage([]) })
    render(await InfrastructurePage({ searchParams: params() }))
    expect(screen.getByText('No infrastructure elements yet.')).toBeInTheDocument()

    answer({ list: listPage([]) })
    const { container } = render(await InfrastructurePage({ searchParams: params({ status: 'failed' }) }))
    expect(within(container).getByText('No infrastructure matches these filters.')).toBeInTheDocument()
  })

  it('does not count the language as a filter', async () => {
    // `lang` is always present, so asking whether the query string is empty
    // would report every page as filtered.
    answer({ list: listPage([]) })
    render(await InfrastructurePage({ searchParams: params() }))
    expect(screen.getByText('No infrastructure elements yet.')).toBeInTheDocument()
  })

  it('does not count the page offset as a filter', async () => {
    // Page two of an unfiltered list is not a filtered list, and `isFiltered`
    // drives the "clear filters" affordance.
    answer({ list: listPage([]) })
    render(await InfrastructurePage({ searchParams: params({ offset: '20' }) }))

    expect(screen.getByText('No infrastructure elements yet.')).toBeInTheDocument()
    expect(listQuery().get('offset')).toBe('20')
  })

  it('groups by project on the default ordering', async () => {
    answer({ list: listPage([
      element({ id: 1, projectName: 'Platform' }),
      element({ id: 2, projectName: 'Data' }),
    ]) })
    render(await InfrastructurePage({ searchParams: params() }))

    expect(screen.getByRole('heading', { name: 'Platform' })).toBeInTheDocument()
    expect(screen.getByRole('heading', { name: 'Data' })).toBeInTheDocument()
  })

  it('names a project that has no name, rather than grouping under nothing', async () => {
    answer({ list: listPage([element({ projectName: undefined, projectId: 9 })]) })
    render(await InfrastructurePage({ searchParams: params() }))
    expect(screen.getByRole('heading', { name: 'Project #9' })).toBeInTheDocument()
  })

  it('goes flat for an explicit sort, so the sort is actually honoured', async () => {
    // Bucketing by project silently overrides a name or status sort: the group a
    // row lands in matters more than its position within it.
    answer({ list: listPage([
      element({ id: 1, projectName: 'Platform' }),
      element({ id: 2, projectName: 'Data' }),
    ]) })
    render(await InfrastructurePage({ searchParams: params({ sort: 'name' }) }))

    expect(screen.queryByRole('heading', { name: 'Platform' })).not.toBeInTheDocument()
    expect(screen.queryByRole('heading', { name: 'Data' })).not.toBeInTheDocument()
  })

  it('still groups when the sort is the default date ordering', async () => {
    render(await InfrastructurePage({ searchParams: params({ sort: 'date' }) }))
    expect(screen.getByRole('heading', { name: 'Platform' })).toBeInTheDocument()
  })

  it('polls on the DERIVED status, not the stored one', async () => {
    // The stored column reads 'active' from the moment a row is written, so
    // watching it stops the refresh exactly when there is something to wait for
    // (#287).
    answer({ list: listPage([element({ status: 'active', displayStatus: 'provisioning' })]) })
    render(await InfrastructurePage({ searchParams: params() }))

    expect(screen.getByTestId('autorefresh')).toHaveAttribute('data-active', 'true')
  })

  it('stops polling once everything has settled', async () => {
    render(await InfrastructurePage({ searchParams: params() }))
    expect(screen.getByTestId('autorefresh')).toHaveAttribute('data-active', 'false')
  })

  it('offers export to an admin and not to a project manager', async () => {
    render(await InfrastructurePage({ searchParams: params() }))
    expect(screen.getByTestId('export')).toBeInTheDocument()

    auth.mockResolvedValue({ user: { name: 'Pat', role: 'project_manager' } })
    const { container } = render(await InfrastructurePage({ searchParams: params() }))
    expect(container.querySelector('[data-testid="export"]')).toBeNull()
  })

  it('keeps the rows when only the facets fail', async () => {
    // Unpopulated dropdowns are a degradation the page tolerates; the free-text
    // search and date filters still work.
    answer({ facets: new ApiError(500, 'boom') })
    render(await InfrastructurePage({ searchParams: params() }))

    expect(screen.getByRole('heading', { name: 'Platform' })).toBeInTheDocument()
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
    expect(console.error).toHaveBeenCalledWith('[page] could not load infrastructure facets: HTTP 500: boom')
  })

  it('prefers the language cookie over the browser’s header', async () => {
    // The cookie is a choice the user made in this app; Accept-Language is a
    // guess the browser supplies. A choice outranks a guess.
    langCookie = 'de'
    acceptLanguage = 'fr-FR,fr;q=0.9'
    render(await InfrastructurePage({ searchParams: params() }))
    expect(listQuery().get('lang')).toBe('de')
  })

  it('falls back to the header when there is no cookie', async () => {
    langCookie = undefined
    acceptLanguage = 'fr-FR,fr;q=0.9'
    render(await InfrastructurePage({ searchParams: params() }))
    expect(listQuery().get('lang')).toBe('fr')
  })

  it('ignores a cookie holding a language this app does not have', async () => {
    // Otherwise a stale or hand-edited cookie renders the whole page in
    // `translations[undefined]`.
    langCookie = 'klingon'
    acceptLanguage = 'fr-FR,fr;q=0.9'
    render(await InfrastructurePage({ searchParams: params() }))
    expect(listQuery().get('lang')).toBe('fr')
  })

  it('offers export and retry to root as well as to an admin', async () => {
    auth.mockResolvedValue({ user: { name: 'Ada', role: 'root' } })
    render(await InfrastructurePage({ searchParams: params() }))

    expect(screen.getByTestId('export')).toBeInTheDocument()
    expect(screen.getByTestId('actions')).toHaveAttribute('data-retry', 'true')
  })

  it('does not offer retry to a project manager', async () => {
    auth.mockResolvedValue({ user: { name: 'Pat', role: 'project_manager' } })
    render(await InfrastructurePage({ searchParams: params() }))
    expect(screen.getByTestId('actions')).toHaveAttribute('data-retry', 'false')
  })

  it('links each row to its detail page, and tells two of a kind apart', async () => {
    // Two elements provisioned from the same product give two links with the
    // same name and different destinations (WCAG 2.4.9); the element id
    // distinguishes them and is already in the URL.
    answer({ list: listPage([element({ id: 1 }), element({ id: 2 })]) })
    render(await InfrastructurePage({ searchParams: params() }))

    expect(screen.getByRole('link', { name: /Managed Postgres#1$/ })).toHaveAttribute('href', '/infrastructure/1')
    expect(screen.getByRole('link', { name: /Managed Postgres#2$/ })).toHaveAttribute('href', '/infrastructure/2')
  })

  it('falls back to the product id when the name did not come back', async () => {
    answer({ list: listPage([element({ productName: undefined, productId: 7 } as never)]) })
    render(await InfrastructurePage({ searchParams: params() }))
    expect(screen.getByRole('link', { name: /Product #7/ })).toBeInTheDocument()
  })

  it('names the order behind a failed deployment', async () => {
    // The row cannot be retried from here without knowing which order produced
    // it, and "failed" with no reference is a dead end.
    answer({ list: listPage([element({ displayStatus: 'failed', orderId: 42 } as never)]) })
    render(await InfrastructurePage({ searchParams: params() }))
    expect(screen.getByText(/Deployment failed · #42/)).toBeInTheDocument()
  })

  it('says nothing about failure when the deployment is fine', async () => {
    render(await InfrastructurePage({ searchParams: params() }))
    expect(screen.queryByText(/Deployment failed/)).not.toBeInTheDocument()
  })

  it('counts the outputs, singular and plural', async () => {
    answer({ list: listPage([element({ outputs: { host: 'db.example.com' } })]) })
    const one = render(await InfrastructurePage({ searchParams: params() }))
    expect(within(one.container).getByText('1 output')).toBeInTheDocument()
    one.unmount()

    answer({ list: listPage([element({ outputs: { host: 'db.example.com', port: '5432' } })]) })
    render(await InfrastructurePage({ searchParams: params() }))
    expect(screen.getByText('2 outputs')).toBeInTheDocument()
  })

  it('leaves the outputs disclosure out when there are none', async () => {
    render(await InfrastructurePage({ searchParams: params() }))
    expect(screen.queryByText(/outputs?$/)).not.toBeInTheDocument()
  })

  it('names the project in the flat view, where no card header does', async () => {
    render(await InfrastructurePage({ searchParams: params({ sort: 'name' }) }))
    expect(screen.getByText(/Platform ·/)).toBeInTheDocument()
  })

  it('says which of an order’s elements this is, when there is more than one', async () => {
    // Twenty elements from one order are otherwise twenty identical rows, and
    // teardown is per element (#104).
    answer({ list: listPage([element({ orderQuantity: 20, sequence: 7 } as never)]) })
    render(await InfrastructurePage({ searchParams: params() }))
    expect(screen.getByText(/7\/20/)).toBeInTheDocument()
  })

  it('does not say 1/1 for a single-element order', async () => {
    answer({ list: listPage([element({ orderQuantity: 1, sequence: 1 } as never)]) })
    render(await InfrastructurePage({ searchParams: params() }))
    expect(screen.queryByText(/1\/1/)).not.toBeInTheDocument()
  })

  it('says so when an element has not been deployed yet', async () => {
    answer({ list: listPage([element({ deployedAt: null } as never)]) })
    render(await InfrastructurePage({ searchParams: params() }))
    expect(screen.getByText(/Not deployed/)).toBeInTheDocument()
  })

  it('flags a scheduled teardown beside the status, with its deadline', async () => {
    // A pending state change with a deadline belongs next to the status rather
    // than buried in the metadata line.
    answer({ list: listPage([element({ status: 'active', scheduledDecommissionAt: '2026-06-01T10:00:00.000Z' } as never)]) })
    render(await InfrastructurePage({ searchParams: params() }))

    expect(screen.getByText(/Scheduled for/)).toBeInTheDocument()
  })

  it('does not flag a teardown scheduled on an element that is no longer active', async () => {
    answer({ list: listPage([element({ status: 'decommissioned', scheduledDecommissionAt: '2026-06-01T10:00:00.000Z' } as never)]) })
    render(await InfrastructurePage({ searchParams: params() }))
    expect(screen.queryByText(/Scheduled for/)).not.toBeInTheDocument()
  })

  it('names the page and says what the list is', async () => {
    render(await InfrastructurePage({ searchParams: params() }))

    expect(screen.getByRole('heading', { name: 'Infrastructure', level: 1 })).toBeInTheDocument()
    expect(screen.getByText('Deployed infrastructure elements grouped by project.')).toBeInTheDocument()
  })

  it('shows the size an element runs at, and nothing when it has none', async () => {
    // Two elements of the same product at different sizes are otherwise
    // indistinguishable in this list (#98).
    answer({ list: listPage([element({ sizeCode: 'large' } as never)]) })
    const sized = render(await InfrastructurePage({ searchParams: params() }))
    expect(within(sized.container).getByText(/Size: large/)).toBeInTheDocument()
    sized.unmount()

    answer({ list: listPage([element({ sizeCode: null } as never)]) })
    render(await InfrastructurePage({ searchParams: params() }))
    expect(screen.queryByText(/Size:/)).not.toBeInTheDocument()
  })

  it('shows each output’s name beside its value', async () => {
    // The disclosure is the only place these appear in the list, and a count
    // with nothing under it is worse than no disclosure.
    answer({ list: listPage([element({ outputs: { host: 'db.example.com', port: '5432' } })]) })
    render(await InfrastructurePage({ searchParams: params() }))

    expect(screen.getByText('host:')).toBeInTheDocument()
    expect(screen.getByText('db.example.com')).toBeInTheDocument()
    expect(screen.getByText('port:')).toBeInTheDocument()
    expect(screen.getByText('5432')).toBeInTheDocument()
  })

  it('does not repeat the project inside a card that already names it', async () => {
    // `showProject` is for the flat view only; in the grouped one the card
    // header carries it and repeating it is noise on every row.
    render(await InfrastructurePage({ searchParams: params() }))

    expect(screen.getByRole('heading', { name: 'Platform' })).toBeInTheDocument()
    expect(screen.queryByText(/Platform ·/)).not.toBeInTheDocument()
  })

  it('tells the filter bar how many rows this page is showing', async () => {
    answer({ list: listPage([element({ id: 1 }), element({ id: 2 })], { total: 57 }) })
    render(await InfrastructurePage({ searchParams: params() }))
    expect(screen.getByTestId('filters')).toHaveAttribute('data-count', '2')
  })
})
