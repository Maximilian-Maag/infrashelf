import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen } from '@testing-library/react'
import type * as Navigation from 'next/navigation'
import { ApiError } from '@/lib/api'
import ForemanReconcilePage from './page'

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

vi.mock('./ForemanReconcile', () => ({
  ForemanReconcile: ({
    environments,
    environmentsError,
  }: {
    environments: unknown[]
    environmentsError: string | null
  }) => (
    <div
      data-testid="reconcile"
      data-environments={environments.length}
      data-error={environmentsError ?? ''}
    />
  ),
}))

beforeEach(() => {
  get.mockReset().mockResolvedValue([{ id: 4 }, { id: 5 }])
  redirect.mockClear()
  vi.spyOn(console, 'error').mockImplementation(() => {})
  auth.mockResolvedValue({ user: { role: 'root' } })
})

describe('ForemanReconcilePage', () => {
  it('sends a caller with no session to the login page', async () => {
    auth.mockResolvedValue(null)
    await expect(ForemanReconcilePage()).rejects.toThrow('NEXT_REDIRECT')
    expect(redirect).toHaveBeenCalledWith('/login')
  })

  it('refuses anyone who is not root', async () => {
    for (const role of ['admin', 'project_manager']) {
      redirect.mockClear()
      auth.mockResolvedValue({ user: { role } })
      await expect(ForemanReconcilePage(), role).rejects.toThrow('NEXT_REDIRECT')
      expect(redirect).toHaveBeenCalledWith('/admin')
    }
  })

  it('fetches the environments and nothing else', async () => {
    render(await ForemanReconcilePage())

    // The report is NOT fetched here: it makes an outbound call to somebody
    // else's inventory, and a page that reconciled on load would do it again on
    // every refresh.
    expect(get).toHaveBeenCalledTimes(1)
    expect(get).toHaveBeenCalledWith('/api/admin/environments')
    expect(screen.getByTestId('reconcile')).toHaveAttribute('data-environments', '2')
  })

  it('hands over the reason when the environments could not be read', async () => {
    get.mockRejectedValue(new ApiError(500, 'Internal Server Error'))
    render(await ForemanReconcilePage())

    expect(screen.getByTestId('reconcile')).toHaveAttribute(
      'data-error',
      'HTTP 500: Internal Server Error',
    )
    expect(screen.getByTestId('reconcile')).toHaveAttribute('data-environments', '0')
  })
})
