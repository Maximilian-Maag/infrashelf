import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen } from '@testing-library/react'
import type * as Navigation from 'next/navigation'
import { ApiError } from '@/lib/api'
import DeploymentWindowsPage from './page'

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

vi.mock('./DeploymentWindowsManager', () => ({
  DeploymentWindowsManager: ({ initial, initialError }: { initial: unknown; initialError: string | null }) =>
    <div data-testid="manager" data-count={initial === null ? 'null' : 'set'} data-error={initialError ?? ''} />,
}))
vi.mock('./HolidaysManager', () => ({
  HolidaysManager: ({ initial, initialError }: { initial: unknown; initialError: string | null }) =>
    <div data-testid="holidays" data-count={initial === null ? 'null' : 'set'} data-error={initialError ?? ''} />,
}))

beforeEach(() => {
  get.mockReset().mockResolvedValue({ timeZone: 'UTC', windows: [] })
  redirect.mockClear()
  vi.spyOn(console, 'error').mockImplementation(() => {})
  auth.mockResolvedValue({ user: { role: 'root' } })
})

/**
 * The page fetches, the manager renders (#452). It was already a server
 * component authenticating before anything rendered, so asking for the rows here
 * costs nothing extra and the browser gets them with the HTML.
 */
describe('DeploymentWindowsPage', () => {
  it('sends a caller with no session to the login page', async () => {
    auth.mockResolvedValue(null)
    await expect(DeploymentWindowsPage()).rejects.toThrow('NEXT_REDIRECT')
    expect(redirect).toHaveBeenCalledWith('/login')
  })

  it('refuses anyone who is not root', async () => {
    // Root-only.
    for (const role of ['admin', 'project_manager']) {
      redirect.mockClear()
      auth.mockResolvedValue({ user: { role } })
      await expect(DeploymentWindowsPage(), role).rejects.toThrow('NEXT_REDIRECT')
      expect(redirect).toHaveBeenCalledWith('/admin')
    }
  })

  it('fetches the rows and hands them to the manager', async () => {
    render(await DeploymentWindowsPage())

    expect(get).toHaveBeenCalledWith('/api/admin/deployment-windows')
    expect(screen.getByTestId('manager')).toHaveAttribute('data-count', 'set')
    // One policy, two requests: the holidays get their own hand-off.
    expect(screen.getByTestId('holidays')).toHaveAttribute('data-count', 'set')
    expect(screen.getByTestId('manager')).toHaveAttribute('data-error', '')
  })

  it('hands over the REASON when the fetch failed, not an empty list', async () => {
    // `null` and "a policy with no windows" are different facts: the second
    // reads "provisioning runs at any time" (#415).
    get.mockImplementation((path: string) =>
      path === '/api/admin/holidays'
        ? Promise.resolve({ feed: {}, holidays: [] })
        : Promise.reject(new ApiError(502, 'Bad Gateway')))
    render(await DeploymentWindowsPage())

    expect(screen.getByTestId('manager')).toHaveAttribute('data-error', 'HTTP 502: Bad Gateway')
    expect(screen.getByTestId('manager')).toHaveAttribute('data-count', 'null')
    // And a windows outage does not take the holidays editor away.
    expect(screen.getByTestId('holidays')).toHaveAttribute('data-count', 'set')
    expect(console.error).toHaveBeenCalledWith('[page] could not load deployment windows: HTTP 502: Bad Gateway')
  })
})
