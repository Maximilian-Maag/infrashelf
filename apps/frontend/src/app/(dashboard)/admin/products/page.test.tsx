import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen } from '@testing-library/react'
import { ApiError } from '@/lib/api'
import type * as Navigation from 'next/navigation'

vi.mock('@/lib/auth', () => ({ auth: async () => ({ user: { role: 'root' } }) }))
vi.mock('@/lib/getLang', () => ({ getLang: async () => 'en' }))
// Spread, not replaced: `section` calls `unstable_rethrow` so a redirect is not
// swallowed as a failed panel (#427), and a mock that omitted it would fail the
// page for a reason that has nothing to do with this test.
vi.mock('next/navigation', async (importOriginal) => ({
  ...(await importOriginal<typeof Navigation>()),
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

/**
 * Answer each of the page's two fetches, by URL.
 *
 * The product list is paged (#158), so a bare array stands in for one page of
 * itself; an object is passed through so a test can set `total`/`offset` too.
 */
const asPage = (items: unknown) =>
  Array.isArray(items) ? { items, total: items.length, limit: 50, offset: 0 } : items

const answer = (products: unknown, categories: unknown) => {
  get.mockImplementation((path: string) =>
    path.startsWith('/api/admin/products')
      ? (products instanceof Error ? Promise.reject(products) : Promise.resolve(asPage(products)))
      : (categories instanceof Error ? Promise.reject(categories) : Promise.resolve(categories)),
  )
}

/** Render the page the way Next calls it — with the resolved search params. */
const renderPage = async (searchParams: Record<string, string> = {}) =>
  render(await AdminProductsPage({ searchParams: Promise.resolve(searchParams) }))

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
    await renderPage()

    const alert = screen.getByRole('alert')
    expect(alert).toHaveTextContent('HTTP 502: Bad Gateway')
    // The claim that has to be gone: an empty catalogue.
    expect(screen.queryByText('No products yet.')).not.toBeInTheDocument()
  })

  it('leaves a trace in the server log for a failure the user reloads past', async () => {
    answer(new ApiError(500, 'boom'), [category])
    await renderPage()

    expect(console.error).toHaveBeenCalledWith(
      '[page] could not load admin products: HTTP 500: boom',
    )
  })

  it('keeps the products when only the categories fail', async () => {
    answer([product], new ApiError(403, 'Forbidden'))
    await renderPage()

    // One panel failing must not blank the other — that is why this page uses
    // allSettled at all.
    expect(screen.getByRole('link', { name: 'Managed Postgres' })).toBeInTheDocument()
    expect(screen.getByRole('alert')).toHaveTextContent('HTTP 403: Forbidden')
  })

  it('still says "no products yet" when the fetch succeeds and returns none', async () => {
    answer([], [category])
    await renderPage()

    expect(screen.getByText('No products yet.')).toBeInTheDocument()
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
  })
})

describe('AdminProductsPage paging (#158)', () => {
  const fifty = () =>
    Array.from({ length: 50 }, (_, i) => ({ ...product, id: i + 1, name: `Product ${i + 1}` }))

  it('asks the API for the page the URL names', async () => {
    answer({ items: [product], total: 120, limit: 50, offset: 50 }, [category])
    await renderPage({ offset: '50' })

    expect(get).toHaveBeenCalledWith('/api/admin/products?lang=en&offset=50')
  })

  it('offers the next page when there is more than one', async () => {
    answer({ items: fifty(), total: 120, limit: 50, offset: 0 }, [category])
    await renderPage()

    expect(screen.getByRole('link', { name: /next/i })).toHaveAttribute(
      'href',
      '/admin/products?offset=50',
    )
    // Back to page one is not offered from page one.
    expect(screen.queryByRole('link', { name: /previous/i })).not.toBeInTheDocument()
  })

  it('renders no pager when everything fits on one page', async () => {
    answer([product], [category])
    await renderPage()

    expect(screen.queryByRole('link', { name: /next/i })).not.toBeInTheDocument()
  })
})
