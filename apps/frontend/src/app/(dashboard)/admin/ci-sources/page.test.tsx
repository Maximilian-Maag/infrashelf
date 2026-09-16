import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen } from '@testing-library/react'
import type * as Navigation from 'next/navigation'
import { ApiError } from '@/lib/api'
import CiSourcesPage from './page'

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

vi.mock('./CiSourcesManager', () => ({
  CiSourcesManager: ({ initial, initialError }: { initial: unknown[]; initialError: string | null }) =>
    <div data-testid="manager" data-count={initial.length} data-error={initialError ?? ''} />,
}))

beforeEach(() => {
  get.mockReset().mockResolvedValue([{ id: 1 }, { id: 2 }])
  redirect.mockClear()
  vi.spyOn(console, 'error').mockImplementation(() => {})
  auth.mockResolvedValue({ user: { role: 'root' } })
})

/**
 * The page fetches, the manager renders (#452). It was already a server
 * component authenticating before anything rendered, so asking for the rows here
 * costs nothing extra and the browser gets them with the HTML.
 */
describe('CiSourcesPage', () => {
  it('sends a caller with no session to the login page', async () => {
    auth.mockResolvedValue(null)
    await expect(CiSourcesPage()).rejects.toThrow('NEXT_REDIRECT')
    expect(redirect).toHaveBeenCalledWith('/login')
  })

  it('refuses anyone who is not root', async () => {
    // These rows hold the access tokens that reach the CI provider.
    for (const role of ['admin', 'project_manager']) {
      redirect.mockClear()
      auth.mockResolvedValue({ user: { role } })
      await expect(CiSourcesPage(), role).rejects.toThrow('NEXT_REDIRECT')
      expect(redirect).toHaveBeenCalledWith('/admin')
    }
  })

  it('fetches the sources and hands them to the manager', async () => {
    render(await CiSourcesPage())

    expect(get).toHaveBeenCalledWith('/api/admin/ci-sources')
    expect(screen.getByTestId('manager')).toHaveAttribute('data-count', '2')
    expect(screen.getByTestId('manager')).toHaveAttribute('data-error', '')
  })

  it('hands over the REASON when the fetch failed, not an empty list', async () => {
    // An empty list and a failed fetch are different facts, and "no CI sources"
    // is a state an operator would act on by adding one (#415).
    get.mockRejectedValue(new ApiError(502, 'Bad Gateway'))
    render(await CiSourcesPage())

    expect(screen.getByTestId('manager')).toHaveAttribute('data-error', 'HTTP 502: Bad Gateway')
    expect(screen.getByTestId('manager')).toHaveAttribute('data-count', '0')
    expect(console.error).toHaveBeenCalledWith('[page] could not load CI sources: HTTP 502: Bad Gateway')
  })
})
