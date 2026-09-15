import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen } from '@testing-library/react'
import { ApiError } from '@/lib/api'
import type * as Navigation from 'next/navigation'
import ProjectDetailPage from './page'

const auth = vi.fn()
vi.mock('@/lib/auth', () => ({ auth: () => auth() }))
vi.mock('@/lib/getLang', () => ({ getLang: async () => 'en' }))

const redirect = vi.fn((url: string) => { throw new Error(`NEXT_REDIRECT:${url}`) })
const notFound = vi.fn(() => { throw new Error('NEXT_NOT_FOUND') })
vi.mock('next/navigation', async (importOriginal) => ({
  ...(await importOriginal<typeof Navigation>()),
  redirect: (url: string) => redirect(url),
  notFound: () => notFound(),
  useRouter: () => ({ refresh: vi.fn(), push: vi.fn() }),
}))
vi.mock('@/components/ui/Toast', () => ({ useToast: () => ({ toast: vi.fn() }) }))

const get = vi.fn()
vi.mock('@/lib/serverApi', () => ({ get: (path: string) => get(path) }))

const project = { id: 4, name: 'Platform', description: 'the platform', costCenterId: null }
const order = {
  id: 11, projectId: 4, productId: 2, productName: 'Managed Postgres',
  environmentName: 'prod', status: 'active', createdAt: '2026-01-01T00:00:00.000Z',
}

const answer = (over: Record<string, unknown> = {}) => {
  get.mockImplementation((path: string) => {
    const key = path.startsWith('/api/projects/') ? 'project'
      : path.startsWith('/api/orders') ? 'orders'
      : 'costCenters'
    const v = key in over ? over[key] : { project, orders: { items: [order] }, costCenters: [] }[key]
    return v instanceof Error ? Promise.reject(v) : Promise.resolve(v)
  })
}

const params = Promise.resolve({ id: '4' })

beforeEach(() => {
  auth.mockReset().mockResolvedValue({ user: { name: 'Ada', role: 'admin' } })
  get.mockReset()
  redirect.mockClear()
  notFound.mockClear()
  vi.spyOn(console, 'error').mockImplementation(() => {})
  answer()
})

/**
 * The page is mostly a shell around three fetches, and what matters is which
 * failure means what: a missing project is a 404, an ended session is a trip to
 * the login page, and a failed ORDERS fetch is neither — it is a card that has
 * to say why it is empty (#415).
 */
describe('ProjectDetailPage', () => {
  it('renders the project with its orders', async () => {
    render(await ProjectDetailPage({ params }))

    expect(screen.getByRole('heading', { name: 'Platform' })).toBeInTheDocument()
    expect(screen.getByRole('link', { name: '#11' })).toBeInTheDocument()
    expect(screen.getByText('Managed Postgres')).toBeInTheDocument()
  })

  it('sends a caller with no session to the login page', async () => {
    auth.mockResolvedValue(null)
    await expect(ProjectDetailPage({ params })).rejects.toThrow('NEXT_REDIRECT')
    expect(redirect).toHaveBeenCalledWith('/login')
    expect(get).not.toHaveBeenCalled()
  })

  it('asks for this project, its orders and the cost centres', async () => {
    render(await ProjectDetailPage({ params }))

    const paths = get.mock.calls.map((c) => c[0] as string)
    expect(paths).toContain('/api/projects/4')
    // Scoped to the project: this card used to list every order the viewer
    // could see — for an administrator, the whole installation (#158).
    expect(paths).toContain('/api/orders?projectId=4')
    expect(paths).toContain('/api/admin/cost-centers')
  })

  it('renders each order column, not just the row', async () => {
    render(await ProjectDetailPage({ params }))

    const headers = [...document.querySelectorAll('th')].map((h) => h.textContent)
    expect(headers).toEqual(['ID', 'Product', 'Environment', 'Status', 'Date'])
    expect(screen.getByText('prod')).toBeInTheDocument()
    expect(screen.getByText(new Date(order.createdAt).toLocaleDateString('en'))).toBeInTheDocument()
  })

  it('falls back to the product id when the name did not come back', async () => {
    answer({ orders: { items: [{ ...order, productName: undefined }] } })
    render(await ProjectDetailPage({ params }))
    expect(screen.getByText('#2')).toBeInTheDocument()
  })

  it('offers the way back to the project list', async () => {
    render(await ProjectDetailPage({ params }))

    const crumb = screen.getAllByRole('link', { name: 'Projects' })[0]
    expect(crumb).toHaveAttribute('href', '/projects')
  })

  it('names the cost centres in the log when they are what failed', async () => {
    answer({ costCenters: new ApiError(500, 'boom') })
    render(await ProjectDetailPage({ params }))
    expect(console.error).toHaveBeenCalledWith('[page] could not load cost centers: HTTP 500: boom')
  })

  it('is a 404 when the project does not exist', async () => {
    answer({ project: new ApiError(404, 'Project not found') })
    await expect(ProjectDetailPage({ params })).rejects.toThrow('NEXT_NOT_FOUND')
  })

  /**
   * The regression this test exists for (#434).
   *
   * `serverApi` signals an ended session by THROWING a `redirect()`, and this
   * page's `catch` around the project fetch turned that into `notFound()` — so a
   * signed-out user pressing Back got "project not found" for a project that
   * exists and an account that had simply been signed out. `unstable_rethrow` is
   * the only thing between the two.
   */
  it('sends an ended session to the login page, not to a 404', async () => {
    // What `serverApi` actually throws: Next's own redirect error.
    const { redirect: realRedirect } = await vi.importActual<typeof Navigation>('next/navigation')
    answer({
      project: (() => {
        try { realRedirect('/login?expired=1') } catch (e) { return e as Error }
        throw new Error('redirect did not throw')
      })(),
    })

    await expect(ProjectDetailPage({ params })).rejects.toThrow()
    expect(notFound, 'the redirect was swallowed and became a 404').not.toHaveBeenCalled()
  })

  it('says the orders could not be loaded instead of showing an empty card', async () => {
    // "This project has no orders" and "the order list could not be fetched"
    // are different facts, and the card said the first for both (#415).
    answer({ orders: new ApiError(502, 'Bad Gateway') })
    render(await ProjectDetailPage({ params }))

    expect(screen.getByRole('alert')).toHaveTextContent('HTTP 502: Bad Gateway')
    expect(screen.queryByText('No orders yet.')).not.toBeInTheDocument()
  })

  it('still says there are none when the fetch succeeds and returns none', async () => {
    answer({ orders: { items: [] } })
    render(await ProjectDetailPage({ params }))

    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
    expect(screen.getByText('No orders yet.')).toBeInTheDocument()
  })

  it('keeps the orders when only the cost centres fail', async () => {
    // One failed panel must not blank the other — that is what allSettled is
    // here for.
    answer({ costCenters: new ApiError(403, 'Forbidden') })
    render(await ProjectDetailPage({ params }))

    expect(screen.getByRole('link', { name: '#11' })).toBeInTheDocument()
    expect(screen.getByRole('alert')).toHaveTextContent('HTTP 403: Forbidden')
  })

  it('leaves a trace in the server log for a failure the user reloads past', async () => {
    answer({ orders: new ApiError(500, 'boom') })
    render(await ProjectDetailPage({ params }))

    expect(console.error).toHaveBeenCalledWith('[page] could not load orders for project 4: HTTP 500: boom')
  })
})
