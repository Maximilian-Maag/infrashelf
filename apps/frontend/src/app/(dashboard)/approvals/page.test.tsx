import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen } from '@testing-library/react'
import type * as Navigation from 'next/navigation'
import type { Order } from '@infrashelf/types'
import { ApiError } from '@/lib/api'
import ApprovalsPage from './page'

const auth = vi.fn()
vi.mock('@/lib/auth', () => ({ auth: () => auth() }))
vi.mock('@/lib/getLang', () => ({ getLang: async () => 'en' }))

const redirect = vi.fn((url: string) => { throw new Error(`NEXT_REDIRECT:${url}`) })
vi.mock('next/navigation', async (importOriginal) => ({
  ...(await importOriginal<typeof Navigation>()),
  redirect: (url: string) => redirect(url),
}))

// Both islands act on their own; this file is about what the page decides.
vi.mock('./ApprovalRow', () => ({
  ApprovalRow: ({ order }: { order: Order }) => <div data-testid={`row-${order.id}`} />,
}))
vi.mock('./DelegationPanel', () => ({
  DelegationPanel: ({ delegations }: { delegations: { mine: unknown[] } }) =>
    <div data-testid="delegations" data-mine={delegations.mine.length} />,
}))

const get = vi.fn()
vi.mock('@/lib/serverApi', () => ({ get: (path: string) => get(path) }))

const order = (id: number): Order => ({
  id, productId: 1, status: 'pending', createdAt: '2026-01-01T00:00:00.000Z',
} as Order)

const answer = (over: { queue?: unknown; delegations?: unknown } = {}) => {
  get.mockImplementation((path: string) => {
    const key = path.startsWith('/api/orders') ? 'queue' : 'delegations'
    const fallback: Record<string, unknown> = {
      queue: { items: [order(7)], total: 1, limit: 20, offset: 0 },
      delegations: { mine: [{ id: 1 }], grantedToMe: [], candidates: [] },
    }
    const v = key in over ? over[key as keyof typeof over] : fallback[key]
    return v instanceof Error ? Promise.reject(v) : Promise.resolve(v)
  })
}

const paths = () => get.mock.calls.map((c) => String(c[0]))

beforeEach(() => {
  get.mockReset()
  redirect.mockClear()
  vi.spyOn(console, 'error').mockImplementation(() => {})
  auth.mockResolvedValue({ user: { id: '3', role: 'admin' } })
  answer()
})

/**
 * An approvals queue is a to-do list, so an empty one means "you are done"
 * (#478). That is the statement this page must not make without having asked
 * successfully — orders that are actually waiting keep waiting, and the
 * administrator who read "no pending orders" has closed the tab.
 */
describe('ApprovalsPage', () => {
  it('sends a caller with no session to the login page', async () => {
    auth.mockResolvedValue(null)
    await expect(ApprovalsPage()).rejects.toThrow('NEXT_REDIRECT')
    expect(redirect).toHaveBeenCalledWith('/login')
  })

  it('sends anyone below admin home', async () => {
    auth.mockResolvedValue({ user: { id: '4', role: 'project_manager' } })
    await expect(ApprovalsPage()).rejects.toThrow('NEXT_REDIRECT')
    expect(redirect).toHaveBeenCalledWith('/')
  })

  it('asks for the pending orders only, not the whole history', async () => {
    // #158: this page is admin-only, so "every order" was every order in the
    // installation, downloaded in full to keep the handful awaiting a decision.
    render(await ApprovalsPage())
    expect(paths().some((p) => p.includes('status=pending'))).toBe(true)
  })

  it('renders a row per order waiting, and says how many', async () => {
    answer({ queue: { items: [order(7), order(8)], total: 2, limit: 20, offset: 0 } })
    render(await ApprovalsPage())

    expect(screen.getByTestId('row-7')).toBeInTheDocument()
    expect(screen.getByTestId('row-8')).toBeInTheDocument()
    expect(screen.getByText(/2 orders pending approval/i)).toBeInTheDocument()
  })

  it('says the queue is empty when it actually read an empty queue', async () => {
    answer({ queue: { items: [], total: 0, limit: 20, offset: 0 } })
    render(await ApprovalsPage())

    expect(screen.getByText(/no pending orders/i)).toBeInTheDocument()
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
  })

  it('does not claim an empty queue when it could not read one', async () => {
    answer({ queue: new ApiError(502, 'Bad Gateway') })
    render(await ApprovalsPage())

    expect(screen.getByRole('alert')).toHaveTextContent('HTTP 502: Bad Gateway')
    expect(screen.queryByText(/no pending orders/i)).not.toBeInTheDocument()
    // Nor a count, which is the same claim in a shorter sentence.
    expect(screen.queryByText(/pending approval/i)).not.toBeInTheDocument()
    expect(console.error).toHaveBeenCalledWith('[page] could not load approval queue: HTTP 502: Bad Gateway')
  })

  it('keeps the queue when only the delegations fail, and says so', async () => {
    // A panel reading "you hold no delegated authority" is a claim somebody
    // might rely on before deciding not to act on a row.
    answer({ delegations: new ApiError(500, 'boom') })
    render(await ApprovalsPage())

    expect(screen.getByTestId('row-7')).toBeInTheDocument()
    expect(screen.getByRole('alert')).toHaveTextContent('HTTP 500: boom')
    expect(screen.getByTestId('delegations')).toHaveAttribute('data-mine', '0')
  })

  it('does not offer root a delegation panel, or ask for one', async () => {
    // Root reaches this page but does not participate in the approval workflow
    // (#35), so the endpoint would only offer it an authority it must not hold.
    auth.mockResolvedValue({ user: { id: '1', role: 'root' } })
    render(await ApprovalsPage())

    expect(screen.queryByTestId('delegations')).not.toBeInTheDocument()
    expect(paths().some((p) => p.includes('/delegations'))).toBe(false)
  })

  it('sends an ended session to the login page, not into an empty queue', async () => {
    // `allSettled` collects the redirect `get` throws like any other failure;
    // `section` is what rethrows it (#427, #434).
    const { redirect: realRedirect } = await vi.importActual<typeof Navigation>('next/navigation')
    let thrown: unknown
    try { realRedirect('/login?expired=1') } catch (e) { thrown = e }
    answer({ queue: thrown })

    await expect(ApprovalsPage()).rejects.toThrow()
  })
})
