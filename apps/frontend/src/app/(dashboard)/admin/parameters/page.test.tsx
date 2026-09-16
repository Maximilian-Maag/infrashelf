import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen } from '@testing-library/react'
import type * as Navigation from 'next/navigation'
import { ApiError } from '@/lib/api'
import ParametersPage from './page'

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

vi.mock('./ParametersManager', () => ({
  ParametersManager: ({ initial, initialError }: { initial: unknown[]; initialError: string | null }) =>
    <div data-testid="manager" data-count={initial.length} data-error={initialError ?? ''} />,
}))

beforeEach(() => {
  get.mockReset().mockImplementation((path: string) =>
    Promise.resolve(path.startsWith('/api/admin/parameters')
      ? [{ id: 1, scope: 'global' }, { id: 2, scope: 'global' }, { id: 3, scope: 'product' }]
      : []))
  redirect.mockClear()
  vi.spyOn(console, 'error').mockImplementation(() => {})
  auth.mockResolvedValue({ user: { role: 'root' } })
})

/**
 * The page fetches, the manager renders (#452). It was already a server
 * component authenticating before anything rendered, so asking for the rows here
 * costs nothing extra and the browser gets them with the HTML.
 */
describe('ParametersPage', () => {
  it('sends a caller with no session to the login page', async () => {
    auth.mockResolvedValue(null)
    await expect(ParametersPage()).rejects.toThrow('NEXT_REDIRECT')
    expect(redirect).toHaveBeenCalledWith('/login')
  })

  it('refuses anyone who is not root', async () => {
    // Root-only.
    for (const role of ['admin', 'project_manager']) {
      redirect.mockClear()
      auth.mockResolvedValue({ user: { role } })
      await expect(ParametersPage(), role).rejects.toThrow('NEXT_REDIRECT')
      expect(redirect).toHaveBeenCalledWith('/admin')
    }
  })

  it('fetches the rows and hands them to the manager', async () => {
    render(await ParametersPage())

    expect(get).toHaveBeenCalledWith('/api/admin/parameters')
    // Two of the three: the product-scoped one is filtered out on the server now
    // rather than in the browser.
    expect(screen.getByTestId('manager')).toHaveAttribute('data-count', '2')
    expect(screen.getByTestId('manager')).toHaveAttribute('data-error', '')
  })

  it('hands over the REASON when the fetch failed, not an empty list', async () => {
    // An empty list and a failed fetch are different facts (#415).
    get.mockImplementation((path: string) =>
      path.startsWith('/api/admin/parameters')
        ? Promise.reject(new ApiError(502, 'Bad Gateway'))
        : Promise.resolve([]))
    render(await ParametersPage())

    expect(screen.getByTestId('manager')).toHaveAttribute('data-error', 'HTTP 502: Bad Gateway')
    expect(screen.getByTestId('manager')).toHaveAttribute('data-count', '0')
    expect(console.error).toHaveBeenCalledWith('[page] could not load global parameters: HTTP 502: Bad Gateway')
  })
})
