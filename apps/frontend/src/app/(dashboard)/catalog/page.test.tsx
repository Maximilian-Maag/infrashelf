import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen } from '@testing-library/react'
import type * as Navigation from 'next/navigation'
import type { Product } from '@infrashelf/types'
import { ApiError } from '@/lib/api'
import CatalogPage from './page'

const auth = vi.fn()
vi.mock('@/lib/auth', () => ({ auth: () => auth() }))
vi.mock('@/lib/getLang', () => ({ getLang: async () => lang }))

let lang = 'en'

const redirect = vi.fn((url: string) => { throw new Error(`NEXT_REDIRECT:${url}`) })
vi.mock('next/navigation', async (importOriginal) => ({
  ...(await importOriginal<typeof Navigation>()),
  redirect: (url: string) => redirect(url),
}))

// The shop itself navigates, stars and appends; this file is about what the page
// hands it. Everything it is given is exposed, because every one of those props
// is a decision made above it.
vi.mock('./CatalogBrowser', () => ({
  CatalogBrowser: (props: {
    initialPage: { items: unknown[] } | null
    error: string | null
    categories: unknown[]
    initialFavorites: unknown[]
    search: string
    categoryId: number | null
  }) => (
    <div
      data-testid="browser"
      data-products={props.initialPage === null ? 'none' : props.initialPage.items.length}
      data-error={props.error ?? ''}
      data-categories={props.categories.length}
      data-favorites={props.initialFavorites.length}
      data-search={props.search}
      data-category={props.categoryId === null ? '' : props.categoryId}
    />
  ),
}))

const get = vi.fn()
vi.mock('@/lib/serverApi', () => ({ get: (path: string, signal?: AbortSignal) => get(path, signal) }))

const products = [
  { id: 10, categoryId: 1, name: 'Managed Postgres', description: 'A database' },
  { id: 11, categoryId: 2, name: 'Nginx Gateway', description: 'A proxy' },
] as unknown as Product[]

const catalogPage = (items: Product[], total = items.length) => ({ items, total, limit: 24, offset: 0 })

const answer = (over: { catalog?: unknown; categories?: unknown; favorites?: unknown } = {}) => {
  get.mockImplementation((path: string, signal?: AbortSignal) => {
    const key = path.startsWith('/api/catalog') ? 'catalog'
      : path.startsWith('/api/admin/categories') ? 'categories'
      : 'favorites'
    const fallback: Record<string, unknown> = {
      catalog: catalogPage(products),
      categories: [{ id: 1, name: 'Databases' }, { id: 2, name: 'Networking' }],
      favorites: [],
    }
    const v = key in over ? over[key as keyof typeof over] : fallback[key]
    if (v === 'hang') {
      // Honours the abort signal, because that is the thing under test: a mock
      // that simply never settles would pass whether the page sets a deadline or
      // not.
      return new Promise((_resolve, reject) => {
        signal?.addEventListener('abort', () => reject(new Error('aborted')))
      })
    }
    return v instanceof Error ? Promise.reject(v) : Promise.resolve(v)
  })
}

const params = (p: Record<string, string | string[] | undefined> = {}) => Promise.resolve(p)
const catalogCall = () => String(get.mock.calls.map((c) => String(c[0])).find((p) => p.startsWith('/api/catalog')) ?? '')
const catalogQuery = () => new URL(catalogCall(), 'http://x').searchParams
const browser = () => screen.getByTestId('browser')

beforeEach(() => {
  get.mockReset()
  redirect.mockClear()
  lang = 'en'
  vi.spyOn(console, 'error').mockImplementation(() => {})
  auth.mockResolvedValue({ user: { name: 'Ada', role: 'user' } })
  answer()
})

/**
 * The shop, read on the server (#472).
 *
 * The search term and the category used to live in `useState`, so a filtered
 * catalogue could not be linked, Back left the shop, and the first paint was a
 * skeleton on a page whose server already had a session and could have asked.
 */
describe('CatalogPage', () => {
  it('sends a caller with no session to the login page', async () => {
    auth.mockResolvedValue(null)
    await expect(CatalogPage({ searchParams: params() })).rejects.toThrow('NEXT_REDIRECT')
    expect(redirect).toHaveBeenCalledWith('/login')
  })

  it('asks the endpoint for a page, not for everything', async () => {
    render(await CatalogPage({ searchParams: params() }))
    expect(catalogQuery().get('limit')).toBe('24')
    expect(catalogQuery().get('offset')).toBe('0')
  })

  it('sends the search term to the database rather than filtering in the browser', async () => {
    render(await CatalogPage({ searchParams: params({ q: '  nginx  ' }) }))
    // Trimmed here, so the heading, the query and the "load more" that continues
    // it all agree on what was searched for.
    expect(catalogQuery().get('search')).toBe('nginx')
    expect(browser()).toHaveAttribute('data-search', 'nginx')
  })

  it('sends the chosen category to the database', async () => {
    render(await CatalogPage({ searchParams: params({ category: '2' }) }))
    expect(catalogQuery().get('categoryId')).toBe('2')
    expect(browser()).toHaveAttribute('data-category', '2')
  })

  it('treats a category it cannot read as no filter at all', async () => {
    // The backend answers `categoryId=abc` with a 400 rather than ignoring it,
    // and an error page over a URL somebody trimmed by hand would be worse than
    // the whole catalogue.
    for (const category of ['abc', '0', '-2', '1e3', '']) {
      get.mockClear()
      render(await CatalogPage({ searchParams: params({ category }) }))
      expect(catalogQuery().get('categoryId'), category).toBeNull()
    }
  })

  it('asks for the cards and the shelf in the same language', async () => {
    lang = 'de'
    render(await CatalogPage({ searchParams: params() }))
    expect(catalogQuery().get('lang')).toBe('de')
    expect(get).toHaveBeenCalledWith('/api/favorites?lang=de', undefined)
  })

  /*
   * #323, as the server meets it. `GET /api/admin/categories` was gated on root
   * while this page fetched it in the same `Promise.all` as the products, so the
   * 403 rejected the pair and every project manager and admin got the error
   * state instead of the shop.
   */
  it('renders the catalogue even when the category list is refused', async () => {
    answer({ categories: new ApiError(403, 'Forbidden') })
    render(await CatalogPage({ searchParams: params() }))

    expect(browser()).toHaveAttribute('data-products', '2')
    expect(browser()).toHaveAttribute('data-categories', '0')
    expect(browser()).toHaveAttribute('data-error', '')
  })

  it('renders the catalogue when the category list never answers', async () => {
    /*
     * The same failure reached by hanging rather than by 403, and `allSettled`
     * alone does not cover it: a request that is accepted and then says nothing
     * is not a rejection. In the browser this left the shop on its skeleton; on
     * the server it holds the response open and the reader gets nothing at all.
     */
    vi.useFakeTimers()
    try {
      answer({ categories: 'hang' })
      const pending = CatalogPage({ searchParams: params() })
      await vi.advanceTimersByTimeAsync(11_000)
      render(await pending)

      expect(browser()).toHaveAttribute('data-products', '2')
      expect(browser()).toHaveAttribute('data-categories', '0')
    } finally {
      vi.useRealTimers()
    }
  })

  it('renders the catalogue even when the favourites cannot be read', async () => {
    // An outage costs the stars, not the shop.
    answer({ favorites: new ApiError(500, 'boom') })
    render(await CatalogPage({ searchParams: params() }))

    expect(browser()).toHaveAttribute('data-products', '2')
    expect(browser()).toHaveAttribute('data-favorites', '0')
    expect(browser()).toHaveAttribute('data-error', '')
  })

  it('hands over the reason when the products could not be read', async () => {
    // A rejected list is not an empty shop: "no products" during an outage reads
    // as a catalogue nobody has filled in (#415).
    answer({ catalog: new ApiError(502, 'Bad Gateway') })
    render(await CatalogPage({ searchParams: params() }))

    expect(browser()).toHaveAttribute('data-error', 'HTTP 502: Bad Gateway')
    expect(browser()).toHaveAttribute('data-products', 'none')
    expect(console.error).toHaveBeenCalledWith('[page] could not load catalog: HTTP 502: Bad Gateway')
  })

  it('sends an ended session to the login page, not into the error panel', async () => {
    // `allSettled` collects the redirect `get` throws like any other failure;
    // `section` is what rethrows it (#427).
    const { redirect: realRedirect } = await vi.importActual<typeof Navigation>('next/navigation')
    let thrown: unknown
    try { realRedirect('/login?expired=1') } catch (e) { thrown = e }
    answer({ catalog: thrown })

    await expect(CatalogPage({ searchParams: params() })).rejects.toThrow()
  })

  it('takes the first value when a parameter is repeated', async () => {
    render(await CatalogPage({ searchParams: params({ q: ['nginx', 'postgres'] }) }))
    expect(catalogQuery().get('search')).toBe('nginx')
  })
})
