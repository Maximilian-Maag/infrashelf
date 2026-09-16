import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen } from '@testing-library/react'
import type * as Navigation from 'next/navigation'
import type { Order } from '@infrashelf/types'
import { ApiError } from '@/lib/api'
import OrdersPage from './page'

const auth = vi.fn()
vi.mock('@/lib/auth', () => ({ auth: () => auth() }))
vi.mock('@/lib/getLang', () => ({ getLang: async () => 'en' }))

const redirect = vi.fn((url: string) => { throw new Error(`NEXT_REDIRECT:${url}`) })
vi.mock('next/navigation', async (importOriginal) => ({
  ...(await importOriginal<typeof Navigation>()),
  redirect: (url: string) => redirect(url),
}))

vi.mock('@/components/ui/RefreshButton', () => ({ RefreshButton: () => <button type="button">Refresh</button> }))
vi.mock('@/components/ui/AutoRefresh', () => ({
  AutoRefresh: ({ active }: { active: boolean }) => <div data-testid="autorefresh" data-active={String(active)} />,
}))

const get = vi.fn()
vi.mock('@/lib/serverApi', () => ({ get: (path: string) => get(path) }))

const order = (over: Partial<Order> = {}): Order => ({
  id: 7,
  productId: 1,
  productName: 'Managed Postgres',
  environmentName: 'prod',
  projectName: 'Platform',
  status: 'active',
  createdAt: '2026-01-01T00:00:00.000Z',
  ...over,
} as Order)

const answer = (value: unknown = { items: [order()], total: 1, limit: 20, offset: 0 }) => {
  get.mockImplementation(() => (value instanceof Error ? Promise.reject(value) : Promise.resolve(value)))
}

const params = (p: { offset?: string } = {}) => Promise.resolve(p)
const query = () => new URL(String(get.mock.calls[0][0]), 'http://x').searchParams

beforeEach(() => {
  get.mockReset()
  redirect.mockClear()
  auth.mockResolvedValue({ user: { id: '3', role: 'user' } })
  answer()
})

/**
 * The page checkout lands on. It asks for ONE window rather than the whole
 * history (#158), and it deliberately lets a failed read reach the error
 * boundary rather than rendering an empty table — "you have no orders" is a
 * statement somebody would act on by ordering the same thing again.
 */
describe('OrdersPage', () => {
  it('sends a caller with no session to the login page', async () => {
    auth.mockResolvedValue(null)
    await expect(OrdersPage({ searchParams: params() })).rejects.toThrow('NEXT_REDIRECT')
    expect(redirect).toHaveBeenCalledWith('/login')
  })

  it('asks in the language the page renders in', async () => {
    render(await OrdersPage({ searchParams: params() }))
    expect(query().get('lang')).toBe('en')
  })

  it('passes the offset through as the browser sent it', async () => {
    // The backend clamps it; a page that second-guessed it here would only
    // disagree with the count it renders.
    render(await OrdersPage({ searchParams: params({ offset: '40' }) }))
    expect(query().get('offset')).toBe('40')
  })

  it('leaves the offset out when there is none', async () => {
    render(await OrdersPage({ searchParams: params() }))
    expect(query().get('offset')).toBeNull()
  })

  it('encodes an offset that is not a number rather than pasting it in', async () => {
    render(await OrdersPage({ searchParams: params({ offset: 'a b&lang=de' }) }))
    // One parameter, not two: the backend answers the nonsense, and the page's
    // own `lang` cannot be overwritten from the address bar.
    expect(query().get('lang')).toBe('en')
    expect(query().get('offset')).toBe('a b&lang=de')
  })

  it('renders the orders it was given', async () => {
    render(await OrdersPage({ searchParams: params() }))
    expect(screen.getByText('Managed Postgres')).toBeInTheDocument()
  })

  it('says the list is empty only when the read succeeded with nothing in it', async () => {
    answer({ items: [], total: 0, limit: 20, offset: 0 })
    render(await OrdersPage({ searchParams: params() }))
    expect(screen.getByText(/no orders/i)).toBeInTheDocument()
  })

  it('lets a failed read reach the error boundary instead of rendering an empty table', async () => {
    // Deliberate, and worth a test because the next person to wrap this in a
    // `try` would not know: an outage rendering "no orders" is #415, and here it
    // is the screen a user checks after paying for something.
    answer(new ApiError(502, 'Bad Gateway'))
    await expect(OrdersPage({ searchParams: params() })).rejects.toThrow('Bad Gateway')
  })

  it('polls while an order is still settling, and stops when none is', async () => {
    // The status arrives from CI minutes after checkout, and before #314 this
    // page had no refresh control at all.
    answer({ items: [order({ status: 'provisioning' })], total: 1, limit: 20, offset: 0 })
    const settling = render(await OrdersPage({ searchParams: params() }))
    expect(screen.getByTestId('autorefresh')).toHaveAttribute('data-active', 'true')
    settling.unmount()

    answer({ items: [order({ status: 'active' })], total: 1, limit: 20, offset: 0 })
    render(await OrdersPage({ searchParams: params() }))
    expect(screen.getByTestId('autorefresh')).toHaveAttribute('data-active', 'false')
  })

  it('pages with links when there is more than one page', async () => {
    answer({ items: [order()], total: 45, limit: 20, offset: 20 })
    render(await OrdersPage({ searchParams: params({ offset: '20' }) }))

    expect(screen.getByRole('link', { name: /next/i })).toHaveAttribute('href', '/orders?offset=40')
    // Page one is the bare URL — the one people copy and paste.
    expect(screen.getByRole('link', { name: /previous/i })).toHaveAttribute('href', '/orders')
  })
})
