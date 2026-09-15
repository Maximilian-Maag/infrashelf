import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen } from '@testing-library/react'
import { ApiError } from '@/lib/api'

vi.mock('@/lib/auth', () => ({ auth: async () => ({ user: { role: 'root' } }) }))
vi.mock('@/lib/getLang', () => ({ getLang: async () => 'en' }))
vi.mock('next/navigation', () => ({
  redirect: vi.fn(),
  // The row actions are a client component that reaches for the router.
  useRouter: () => ({ refresh: vi.fn(), push: vi.fn() }),
}))

// Same as ProductRowActions' own test: the row actions want a toast, and this
// page is not the place to stand up the provider.
vi.mock('@/components/ui/Toast', () => ({ useToast: () => ({ toast: vi.fn() }) }))

const get = vi.fn()
vi.mock('@/lib/serverApi', () => ({ get: (path: string) => get(path) }))

import AdminProductsPage from './page'

const product = {
  id: 7,
  name: 'Managed Postgres',
  categoryId: 1,
  price: '10.00',
  createdAt: '2026-01-01T00:00:00.000Z',
}
const category = { id: 1, name: 'Databases' }

/** Answer each of the page's two fetches, by URL. */
const answer = (products: unknown, categories: unknown) => {
  get.mockImplementation((path: string) =>
    path.startsWith('/api/admin/products')
      ? (products instanceof Error ? Promise.reject(products) : Promise.resolve(products))
      : (categories instanceof Error ? Promise.reject(categories) : Promise.resolve(categories)),
  )
}

beforeEach(() => {
  get.mockReset()
  vi.spyOn(console, 'error').mockImplementation(() => {})
})

/**
 * "No products exist" and "the request for products failed" are different facts
 * (#415). The page used to say the first for both: `Promise.allSettled` turned
 * every rejection into `[]`, so a 500, a 401 or a backend that was still
 * starting all rendered a perfectly normal-looking page with an empty table.
 */
describe('AdminProductsPage when a fetch fails', () => {
  it('says the products could not be loaded instead of showing an empty table', async () => {
    answer(new ApiError(502, 'Bad Gateway'), [category])
    render(await AdminProductsPage())

    const alert = screen.getByRole('alert')
    expect(alert).toHaveTextContent('HTTP 502: Bad Gateway')
    // The claim that has to be gone: an empty catalogue.
    expect(screen.queryByText('No products yet.')).not.toBeInTheDocument()
  })

  it('leaves a trace in the server log for a failure the user reloads past', async () => {
    answer(new ApiError(500, 'boom'), [category])
    render(await AdminProductsPage())

    expect(console.error).toHaveBeenCalledWith(
      '[page] could not load admin products: HTTP 500: boom',
    )
  })

  it('keeps the products when only the categories fail', async () => {
    answer([product], new ApiError(403, 'Forbidden'))
    render(await AdminProductsPage())

    // One panel failing must not blank the other — that is why this page uses
    // allSettled at all.
    expect(screen.getByRole('link', { name: 'Managed Postgres' })).toBeInTheDocument()
    expect(screen.getByRole('alert')).toHaveTextContent('HTTP 403: Forbidden')
  })

  it('still says "no products yet" when the fetch succeeds and returns none', async () => {
    answer([], [category])
    render(await AdminProductsPage())

    expect(screen.getByText('No products yet.')).toBeInTheDocument()
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
  })
})
