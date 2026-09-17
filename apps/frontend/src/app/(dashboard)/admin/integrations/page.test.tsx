import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen } from '@testing-library/react'
import type * as Navigation from 'next/navigation'
import { ApiError } from '@/lib/api'
import IntegrationsPage from './page'

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

vi.mock('./IntegrationsManager', () => ({
  IntegrationsManager: ({
    initial,
    initialError,
    environments,
  }: {
    initial: unknown[]
    initialError: string | null
    environments: unknown[]
  }) => (
    <div
      data-testid="manager"
      data-count={initial.length}
      data-error={initialError ?? ''}
      data-environments={environments.length}
    />
  ),
}))

const rowsFor = (path: string) =>
  path === '/api/admin/integrations' ? [{ id: 1 }, { id: 2 }] : [{ id: 4 }]

beforeEach(() => {
  get.mockReset().mockImplementation(async (path: string) => rowsFor(path))
  redirect.mockClear()
  vi.spyOn(console, 'error').mockImplementation(() => {})
  auth.mockResolvedValue({ user: { role: 'root' } })
})

describe('IntegrationsPage', () => {
  it('sends a caller with no session to the login page', async () => {
    auth.mockResolvedValue(null)
    await expect(IntegrationsPage()).rejects.toThrow('NEXT_REDIRECT')
    expect(redirect).toHaveBeenCalledWith('/login')
  })

  it('refuses anyone who is not root', async () => {
    // These rows hold credentials to systems that can change infrastructure —
    // the same audience as CI sources, which is narrower than the admin catalogue.
    for (const role of ['admin', 'project_manager']) {
      redirect.mockClear()
      auth.mockResolvedValue({ user: { role } })
      await expect(IntegrationsPage(), role).rejects.toThrow('NEXT_REDIRECT')
      expect(redirect).toHaveBeenCalledWith('/admin')
    }
  })

  it('fetches both lists and hands them to the manager', async () => {
    render(await IntegrationsPage())

    expect(get).toHaveBeenCalledWith('/api/admin/integrations')
    expect(get).toHaveBeenCalledWith('/api/admin/environments')
    expect(screen.getByTestId('manager')).toHaveAttribute('data-count', '2')
    expect(screen.getByTestId('manager')).toHaveAttribute('data-environments', '1')
    expect(screen.getByTestId('manager')).toHaveAttribute('data-error', '')
  })

  it('hands over the REASON when the fetch failed, not an empty list', async () => {
    // "There are no integrations" is a state an operator acts on by adding one;
    // a 502 is one they act on by looking at the backend (#415).
    get.mockRejectedValue(new ApiError(502, 'Bad Gateway'))
    render(await IntegrationsPage())

    expect(screen.getByTestId('manager')).toHaveAttribute('data-error', 'HTTP 502: Bad Gateway')
    expect(screen.getByTestId('manager')).toHaveAttribute('data-count', '0')
    expect(console.error).toHaveBeenCalledWith(
      '[page] could not load integrations: HTTP 502: Bad Gateway',
    )
  })

  it('still lists the integrations when only the environments failed', async () => {
    /*
     * The two sections settle independently, and this is the case that makes it
     * worth doing: the bindings degrade to ids, which the manager renders as
     * ids, while the integrations themselves are intact. One await for both
     * would have thrown the whole page away over a list used for labels.
     */
    get.mockImplementation(async (path: string) => {
      if (path === '/api/admin/environments') throw new ApiError(500, 'Internal Server Error')
      return rowsFor(path)
    })

    render(await IntegrationsPage())

    expect(screen.getByTestId('manager')).toHaveAttribute('data-count', '2')
    expect(screen.getByTestId('manager')).toHaveAttribute('data-environments', '0')
    // The integrations section itself did not fail, and must not claim to have.
    expect(screen.getByTestId('manager')).toHaveAttribute('data-error', '')
  })
})
