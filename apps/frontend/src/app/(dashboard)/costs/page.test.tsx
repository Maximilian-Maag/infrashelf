import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen } from '@testing-library/react'
import type * as Navigation from 'next/navigation'
import type { CostReport } from '@infrashelf/types'
import { ApiError } from '@/lib/api'
import CostsPage from './page'

const auth = vi.fn()
vi.mock('@/lib/auth', () => ({ auth: () => auth() }))
const lang = vi.fn(async () => 'en')
vi.mock('@/lib/getLang', () => ({ getLang: () => lang() }))

const redirect = vi.fn((url: string) => { throw new Error(`NEXT_REDIRECT:${url}`) })
vi.mock('next/navigation', async (importOriginal) => ({
  ...(await importOriginal<typeof Navigation>()),
  redirect: (url: string) => redirect(url),
  useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
  useSearchParams: () => new URLSearchParams(),
  usePathname: () => '/costs',
}))
vi.mock('@/components/ui/Toast', () => ({ useToast: () => ({ toast: vi.fn() }) }))

const get = vi.fn()
vi.mock('@/lib/serverApi', () => ({ get: (path: string) => get(path) }))

const period = (month: string, totalEur: number, partial = false) =>
  ({ period: month, totalEur, orderCount: 1, estimatedOrders: 0, partial })

const bucket = (id: number | null, label: string, totalEur: number) =>
  ({ id, label, totalEur, orderCount: 1 })

const report = (over: Partial<CostReport> = {}): CostReport =>
  ({
    totalEur: 1234.5,
    orderCount: 3,
    estimatedOrders: 0,
    unpricedOrders: 0,
    unconverted: [],
    comparison: null,
    series: [],
    byProject: [],
    byCostCenter: [],
    byProduct: [],
    byEnvironment: [],
    ...over,
  }) as CostReport

const answer = (over: { report?: unknown; projects?: unknown; rates?: unknown } = {}) => {
  get.mockImplementation((path: string) => {
    const v = path.startsWith('/api/costs') ? ('report' in over ? over.report : report())
      : path.startsWith('/api/projects') ? ('projects' in over ? over.projects : [{ id: 1, name: 'Platform' }])
      : ('rates' in over ? over.rates : [])
    return v instanceof Error ? Promise.reject(v) : Promise.resolve(v)
  })
}

const params = (p: Record<string, string | string[] | undefined> = {}) => Promise.resolve(p)
const costsCall = () => (get.mock.calls.map((c) => c[0] as string).find((p) => p.startsWith('/api/costs')) ?? '')

beforeEach(() => {
  get.mockReset()
  redirect.mockClear()
  vi.spyOn(console, 'error').mockImplementation(() => {})
  auth.mockResolvedValue({ user: { name: 'Ada', role: 'admin' } })
  lang.mockResolvedValue('en')
  answer()
})

describe('CostsPage', () => {
  it('sends a caller with no session to the login page', async () => {
    auth.mockResolvedValue(null)
    await expect(CostsPage({ searchParams: params() })).rejects.toThrow('NEXT_REDIRECT')
    expect(redirect).toHaveBeenCalledWith('/login')
  })

  it('forwards only the filters it knows, and the language', async () => {
    render(await CostsPage({ searchParams: params({ range: 'month', projectId: '4', nonsense: 'x' }) }))

    const url = new URL(costsCall(), 'http://x')
    expect(url.searchParams.get('range')).toBe('month')
    expect(url.searchParams.get('projectId')).toBe('4')
    expect(url.searchParams.get('lang')).toBe('en')
    // Anything else is ignored rather than passed through to the API.
    expect(url.searchParams.get('nonsense')).toBeNull()
  })

  it('takes the first value when a filter is repeated', async () => {
    // The API expects one, and guessing which of two conflicting values was
    // meant is worse than picking.
    render(await CostsPage({ searchParams: params({ range: ['month', 'year'] }) }))
    expect(new URL(costsCall(), 'http://x').searchParams.get('range')).toBe('month')
  })

  it('leaves an empty filter out of the query entirely', async () => {
    render(await CostsPage({ searchParams: params({ projectId: '' }) }))
    expect(new URL(costsCall(), 'http://x').searchParams.has('projectId')).toBe(false)
  })

  it('shows the total and what it was counted from', async () => {
    render(await CostsPage({ searchParams: params() }))

    expect(screen.getByText('1,234.50 EUR')).toBeInTheDocument()
    // The count beside it, so the total is readable as "of what": a sum with no
    // denominator says nothing about whether it is a lot.
    expect(screen.getByText(/^3 orders/i)).toBeInTheDocument()
  })

  it('says a rejected report could not be loaded, with its status', async () => {
    // An invalid custom range comes back 400 and an outage comes back 502, and
    // this page said "an unexpected error occurred" for both (#415).
    answer({ report: new ApiError(400, 'from must be before to') })
    render(await CostsPage({ searchParams: params({ from: '2026-12-01', to: '2026-01-01' }) }))

    expect(screen.getByRole('alert')).toHaveTextContent('HTTP 400: from must be before to')
    // And no zeros beside it, which would read as "nothing was spent".
    expect(screen.queryByText(/0\.00 EUR/)).not.toBeInTheDocument()
  })

  it('keeps the report when only the project list fails', async () => {
    // The project list fills the filter dropdown; the report is the page.
    answer({ projects: new ApiError(403, 'Forbidden') })
    render(await CostsPage({ searchParams: params() }))

    expect(screen.getByText('1,234.50 EUR')).toBeInTheDocument()
    expect(console.error).toHaveBeenCalledWith(
      '[page] could not load projects for the cost filter: HTTP 403: Forbidden',
    )
  })

  it('draws every breakdown the report carries', async () => {
    // The four dimensions are the page. With an empty report none of them render
    // at all, so a fixture without them tests the frame and not the picture.
    answer({
      report: report({
        series: [period('2026-01', 400), period('2026-02', 834.5, true)],
        byProject: [bucket(1, 'Platform', 900), bucket(2, 'Data', 334.5)],
        byCostCenter: [bucket(7, 'CC-7', 1234.5)],
        byProduct: [bucket(3, 'Managed Postgres', 1000)],
        byEnvironment: [bucket(4, 'prod', 1234.5)],
        comparison: {
          current: period('2026-02', 834.5, true),
          previous: period('2026-01', 400),
          changeEur: 434.5,
          changePct: 108.625,
        },
      }),
    })
    render(await CostsPage({ searchParams: params() }))

    // Projects and cost centres are shares — those are the dimensions somebody
    // is accountable for. Product and environment are ranked lists, where the
    // question is "which is biggest", not "what share". Each dimension is
    // headed, so the four are distinguishable on the page.
    for (const heading of ['Per project', 'Per cost centre', 'Per product', 'Per environment']) {
      expect(screen.getByText(heading), heading).toBeInTheDocument()
    }
    // Platform appears in its share chart and again in the filter dropdown.
    expect(screen.getAllByText('Platform').length).toBeGreaterThan(0)
    expect(screen.getByText('CC-7')).toBeInTheDocument()
    expect(screen.getByText('Managed Postgres')).toBeInTheDocument()
    expect(screen.getByText('prod')).toBeInTheDocument()
  })

  it('shows the caveats on the total, and only there', async () => {
    // These figures are a sum of recorded order prices and the catalogue stores
    // no billing period, so any reading of them as a run rate is wrong — and the
    // caveat about money MISSING from the total belongs to the total, not under
    // every chart.
    answer({ report: report({ unpricedOrders: 2, estimatedOrders: 1, unconverted: [{ amount: 40, currency: 'GBP' }] }) })
    render(await CostsPage({ searchParams: params() }))

    expect(screen.getAllByText(/GBP/).length).toBeGreaterThan(0)
    // The unpriced caveat is about money missing from THE total, so it appears
    // once rather than under every chart.
    expect(screen.getAllByText(/no recoverable price are missing/i)).toHaveLength(1)
    // The estimated caveat, by contrast, belongs wherever a figure is drawn.
    expect(screen.getAllByText(/uses the current price/i).length).toBeGreaterThan(0)
  })

  it('says there was no spend rather than drawing empty charts', async () => {
    answer({ report: report({ orderCount: 0, totalEur: 0 }) })
    render(await CostsPage({ searchParams: params() }))

    expect(screen.getByText(/no spend/i)).toBeInTheDocument()
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
  })

  it('leaves the figures in EUR when no rate is stored', async () => {
    // Labelled EUR rather than claiming a conversion that did not happen: the
    // figure stays true and only its currency says so.
    answer({ rates: [] })
    render(await CostsPage({ searchParams: params() }))
    expect(screen.getByText('1,234.50 EUR')).toBeInTheDocument()
  })

  it('converts into the viewer’s currency when a rate IS stored', async () => {
    // The other half, and the one that was missing: every figure on the page
    // goes through one `money()`, so a broken conversion is wrong everywhere at
    // once. A Danish reader, because `en` maps to EUR and the report is already
    // in EUR — at that locale no conversion can happen at all.
    lang.mockResolvedValue('da')
    answer({ rates: [{ currencyCode: 'DKK', rate: '7.46' }] })
    render(await CostsPage({ searchParams: params() }))

    // 1234.50 EUR × 7.46, grouped and separated the Danish way.
    expect(screen.getByText('9.209,37 DKK')).toBeInTheDocument()
    expect(screen.queryByText(/EUR/)).not.toBeInTheDocument()
  })

  it('leaves a trace when the report itself failed', async () => {
    answer({ report: new ApiError(502, 'Bad Gateway') })
    render(await CostsPage({ searchParams: params() }))
    expect(console.error).toHaveBeenCalledWith('[page] could not load cost report: HTTP 502: Bad Gateway')
  })
})
