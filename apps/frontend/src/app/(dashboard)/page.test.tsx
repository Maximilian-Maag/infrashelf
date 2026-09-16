import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, within } from '@testing-library/react'
import type * as Navigation from 'next/navigation'
import { ApiError } from '@/lib/api'
import DashboardHome from './page'

const auth = vi.fn()
vi.mock('@/lib/auth', () => ({ auth: () => auth() }))
vi.mock('@/lib/getLang', () => ({ getLang: async () => 'en' }))

const redirect = vi.fn((url: string) => { throw new Error(`NEXT_REDIRECT:${url}`) })
vi.mock('next/navigation', async (importOriginal) => ({
  ...(await importOriginal<typeof Navigation>()),
  redirect: (url: string) => redirect(url),
}))

// `CountUp` animates from 0 on a requestAnimationFrame, so the final figure is
// not in the DOM when the page renders. It has its own tests; here it stands in
// for the number it was handed.
vi.mock('@/components/ui/CountUp', () => ({ CountUp: ({ value }: { value: number }) => <>{value}</> }))

const get = vi.fn()
vi.mock('@/lib/serverApi', () => ({ get: (path: string) => get(path) }))

const summary = (over: Record<string, unknown> = {}) => ({
  orders: { total: 12, pending: 3 },
  infrastructure: { active: 7 },
  projects: { total: 4 },
  recentOrders: [
    {
      id: 11, productId: 2, productName: 'Managed Postgres', environmentName: 'prod',
      projectName: 'Platform', status: 'active', createdAt: '2026-01-01T00:00:00.000Z',
    },
  ],
  ...over,
})

const catalog = { items: [{ id: 5, name: 'Managed Redis', description: 'a cache' }] }

const answer = (over: { summary?: unknown; products?: unknown } = {}) => {
  get.mockImplementation((path: string) => {
    const v = path.startsWith('/api/dashboard')
      ? ('summary' in over ? over.summary : summary())
      : ('products' in over ? over.products : catalog)
    return v instanceof Error ? Promise.reject(v) : Promise.resolve(v)
  })
}

const signedInAs = (role: string) => auth.mockResolvedValue({ user: { name: 'Ada', role } })

beforeEach(() => {
  get.mockReset()
  redirect.mockClear()
  vi.spyOn(console, 'error').mockImplementation(() => {})
  signedInAs('admin')
  answer()
})

/**
 * The page every user lands on immediately after login, which is why a failed
 * summary reading as an empty installation matters more here than anywhere
 * (#415, #158).
 */
describe('DashboardHome', () => {
  it('sends a caller with no session to the login page', async () => {
    auth.mockResolvedValue(null)
    await expect(DashboardHome()).rejects.toThrow('NEXT_REDIRECT')
    expect(redirect).toHaveBeenCalledWith('/login')
  })

  it('asks for four counters and eight products, not the whole installation', async () => {
    // This used to fetch every order, every infrastructure element and every
    // project in full, and the entire catalogue, then slice in the browser
    // (#158, #91).
    render(await DashboardHome())

    expect(get).toHaveBeenCalledWith('/api/dashboard?lang=en')
    expect(get).toHaveBeenCalledWith('/api/catalog?lang=en&limit=8')
  })

  it('shows the counters it was given', async () => {
    render(await DashboardHome())

    expect(screen.getByText('12')).toBeInTheDocument()   // orders
    expect(screen.getByText('7')).toBeInTheDocument()    // active infrastructure
    expect(screen.getByText('4')).toBeInTheDocument()    // projects
  })

  it('says the summary could not be loaded rather than showing an empty installation', async () => {
    // Zeros under a banner saying the summary could not be fetched is a very
    // different page from zeros on their own.
    answer({ summary: new ApiError(502, 'Bad Gateway') })
    render(await DashboardHome())

    expect(screen.getByRole('alert')).toHaveTextContent('HTTP 502: Bad Gateway')
    // The hero and the navigation are still useful, so the page stays.
    expect(screen.getByRole('heading', { level: 1 })).toBeInTheDocument()
  })

  it('keeps the counters when only the products fail', async () => {
    answer({ products: new ApiError(403, 'Forbidden') })
    render(await DashboardHome())

    expect(screen.getByText('12')).toBeInTheDocument()
    expect(screen.getByRole('alert')).toHaveTextContent('HTTP 403: Forbidden')
  })

  it('leaves a trace in the server log for each panel by name', async () => {
    answer({ summary: new ApiError(500, 'boom'), products: new ApiError(500, 'bang') })
    render(await DashboardHome())

    expect(console.error).toHaveBeenCalledWith('[page] could not load dashboard summary: HTTP 500: boom')
    expect(console.error).toHaveBeenCalledWith('[page] could not load featured products: HTTP 500: bang')
  })

  it('links each featured product to its catalogue entry', async () => {
    render(await DashboardHome())

    const product = screen.getByRole('link', { name: /Managed Redis/ })
    expect(product).toHaveAttribute('href', '/catalog/5')
    expect(screen.getByText('a cache')).toBeInTheDocument()
  })

  it('leaves the product strip out when there are none, rather than an empty heading', async () => {
    answer({ products: { items: [] } })
    render(await DashboardHome())

    expect(screen.queryByRole('heading', { name: 'From the catalog' })).not.toBeInTheDocument()
  })

  it('tells two same-named recent orders apart', async () => {
    // Two orders for the same product, project and environment on the same day
    // render the same accessible name against different hrefs (WCAG 2.4.9). The
    // order number is what separates them and is already in the URL.
    const twin = { ...summary().recentOrders[0], id: 12 }
    answer({ summary: summary({ recentOrders: [summary().recentOrders[0], twin] }) })
    render(await DashboardHome())

    // `Managed Postgres#11`, with no space: the sr-only span's leading space is
    // collapsed out of the computed name. The disambiguation is what matters and
    // it holds — the two links no longer share a name.
    expect(screen.getByRole('link', { name: /Managed Postgres#11/ })).toHaveAttribute('href', '/orders/11')
    expect(screen.getByRole('link', { name: /Managed Postgres#12/ })).toHaveAttribute('href', '/orders/12')
  })

  it('falls back to the product id when the name did not come back', async () => {
    answer({ summary: summary({ recentOrders: [{ ...summary().recentOrders[0], productName: undefined }] }) })
    render(await DashboardHome())

    expect(screen.getByRole('link', { name: /Product #2#11/ })).toBeInTheDocument()
  })

  it('shows pending approvals to an admin, as something to act on', async () => {
    render(await DashboardHome())

    const pending = screen.getByRole('link', { name: /Pending approval/i })
    expect(pending).toHaveAttribute('href', '/approvals')
    expect(within(pending).getByText('3')).toBeInTheDocument()
  })

  it('shows an admin with nothing pending a plain zero, not a call to action', async () => {
    answer({ summary: summary({ orders: { total: 12, pending: 0 } }) })
    render(await DashboardHome())

    expect(screen.queryByRole('link', { name: /Pending approval/i })).not.toBeInTheDocument()
    expect(screen.getByText('Pending Approvals')).toBeInTheDocument()
  })

  it('does not offer approvals to a project manager at all', async () => {
    // Approving is an admin's job; a counter for something the role cannot do
    // is noise on the page they land on every day.
    signedInAs('project_manager')
    render(await DashboardHome())

    expect(screen.queryByRole('link', { name: /Pending approval/i })).not.toBeInTheDocument()
    expect(screen.queryByText('Pending Approvals')).not.toBeInTheDocument()
  })

  it('greets the person by name, and falls back rather than greeting nobody', async () => {
    render(await DashboardHome())
    expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent('Welcome back, Ada')

    auth.mockResolvedValue({ user: { role: 'admin' } })
    const { container } = render(await DashboardHome())
    expect(container.querySelector('h1')).toHaveTextContent('Welcome back, User')
  })

  it('shows approvals to root as well as to an admin', async () => {
    // `role === 'admin' || role === 'root'`. Root is the account that exists on
    // a fresh installation, so dropping it hides approvals from the only person
    // who can grant them.
    signedInAs('root')
    render(await DashboardHome())
    expect(screen.getByRole('link', { name: /Pending approval/i })).toBeInTheDocument()
  })

  it('names every counter, and links the ones that go somewhere', async () => {
    render(await DashboardHome())

    for (const [label, href] of [
      ['Total Orders', '/orders'],
      ['Active Infrastructure', '/infrastructure'],
      ['Projects', '/projects'],
    ] as const) {
      const card = screen.getByText(label).closest('a')
      expect(card, label).toHaveAttribute('href', href)
    }
  })

  it('does not make a counter with nowhere to go into a link', async () => {
    // The zero-pending card has no destination; wrapping it in an <a> would put
    // a keyboard stop on something that does nothing.
    answer({ summary: summary({ orders: { total: 12, pending: 0 } }) })
    render(await DashboardHome())

    expect(screen.getByText('Pending Approvals').closest('a')).toBeNull()
  })

  it('heads each strip, and offers the way to the full list', async () => {
    render(await DashboardHome())

    expect(screen.getByRole('heading', { name: 'From the catalog' })).toBeInTheDocument()
    expect(screen.getByRole('heading', { name: 'Recent Orders' })).toBeInTheDocument()
    expect(screen.getByRole('link', { name: /All products/i })).toHaveAttribute('href', '/catalog')
    expect(screen.getByRole('link', { name: /Browse catalog/i })).toHaveAttribute('href', '/catalog')
  })

  it('leaves the recent-orders strip out when there are none', async () => {
    answer({ summary: summary({ recentOrders: [] }) })
    render(await DashboardHome())

    expect(screen.queryByRole('heading', { name: 'Recent Orders' })).not.toBeInTheDocument()
  })
})
