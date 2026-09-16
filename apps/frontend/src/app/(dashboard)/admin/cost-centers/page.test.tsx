import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen } from '@testing-library/react'
import type * as Navigation from 'next/navigation'
import { ApiError } from '@/lib/api'
import CostCentersPage from './page'

const auth = vi.fn()
vi.mock('@/lib/auth', () => ({ auth: () => auth() }))
vi.mock('@/lib/getLang', () => ({ getLang: async () => 'en' }))

const redirect = vi.fn((url: string) => { throw new Error(`NEXT_REDIRECT:${url}`) })
vi.mock('next/navigation', async (importOriginal) => ({
  ...(await importOriginal<typeof Navigation>()),
  redirect: (url: string) => redirect(url),
}))

const get = vi.fn()
vi.mock('@/lib/serverApi', () => ({ get: (path: string) => get(path) }))

vi.mock('./CostCentersManager', () => ({
  CostCentersManager: ({ initial, initialError }: { initial: unknown[]; initialError: string | null }) =>
    <div data-testid="manager" data-count={initial.length} data-error={initialError ?? ''} />,
}))

beforeEach(() => {
  get.mockReset().mockResolvedValue([{ id: 1, costCenterId: 1 }, { id: 2, costCenterId: 2 }])
  redirect.mockClear()
  vi.spyOn(console, 'error').mockImplementation(() => {})
  auth.mockResolvedValue({ user: { role: 'root' } })
})

/**
 * The page fetches, the manager renders (#452). It was already a server
 * component authenticating before anything rendered, so asking for the rows here
 * costs nothing extra and the browser gets them with the HTML.
 */
describe('CostCentersPage', () => {
  it('sends a caller with no session to the login page', async () => {
    auth.mockResolvedValue(null)
    await expect(CostCentersPage()).rejects.toThrow('NEXT_REDIRECT')
    expect(redirect).toHaveBeenCalledWith('/login')
  })

  it('refuses anyone who is not root', async () => {
    // Both of these are root-only screens.
    for (const role of ['admin', 'project_manager']) {
      redirect.mockClear()
      auth.mockResolvedValue({ user: { role } })
      await expect(CostCentersPage(), role).rejects.toThrow('NEXT_REDIRECT')
      expect(redirect).toHaveBeenCalledWith('/admin')
    }
  })

  it('fetches the rows and hands them to the manager', async () => {
    render(await CostCentersPage())

    expect(get).toHaveBeenCalledWith('/api/admin/cost-centers')
    expect(screen.getByTestId('manager')).toHaveAttribute('data-count', '2')
    expect(screen.getByTestId('manager')).toHaveAttribute('data-error', '')
  })

  it('hands over the REASON when the fetch failed, not an empty list', async () => {
    // An empty list and a failed fetch are different facts, and the empty one is
    // what an operator acts on (#415).
    get.mockImplementation((path: string) =>
      path === '/api/admin/cost-centers/budgets'
        ? Promise.resolve([])
        : Promise.reject(new ApiError(502, 'Bad Gateway')))
    render(await CostCentersPage())

    expect(screen.getByTestId('manager')).toHaveAttribute('data-error', 'HTTP 502: Bad Gateway')
    expect(screen.getByTestId('manager')).toHaveAttribute('data-count', '0')
    expect(console.error).toHaveBeenCalledWith('[page] could not load cost centers: HTTP 502: Bad Gateway')
  })
})
