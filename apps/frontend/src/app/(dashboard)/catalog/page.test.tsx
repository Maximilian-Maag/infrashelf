import { describe, it, expect, vi, beforeEach } from 'vitest'
import { act, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type { Product, Category, FavoriteProduct } from '@infrashelf/types'

let currentParams = new URLSearchParams()

vi.mock('next/navigation', () => ({
  useSearchParams: () => currentParams,
}))

vi.mock('next-auth/react', () => ({
  useSession: () => ({ data: { apiToken: 'test-token' } }),
}))

vi.mock('@/lib/useLang', () => ({ useLang: () => 'en' }))

vi.mock('@/lib/api', () => ({
  get: vi.fn(),
  put: vi.fn(),
  del: vi.fn(),
}))

import CatalogPage from './page'
import { get, put, del } from '@/lib/api'

const mockedGet = vi.mocked(get)
const mockedPut = vi.mocked(put)
const mockedDel = vi.mocked(del)

const categories: Category[] = [
  { id: 1, name: 'Databases', displayOrder: 0 },
  { id: 2, name: 'Networking', displayOrder: 1 },
]

const products = [
  { id: 10, categoryId: 1, baseLanguage: 'en', createdAt: '', name: 'Managed Postgres', description: 'A database', imageAlt: 'A database server rack' },
  { id: 11, categoryId: 2, baseLanguage: 'en', createdAt: '', name: 'Nginx Gateway', description: 'A proxy', imageAlt: null },
] as unknown as Product[]

/** The endpoint pages now: one window of rows plus the total behind it (#91). */
const catalogPage = (items: Product[], total = items.length, offset = 0) => ({
  items,
  total,
  limit: 24,
  offset,
})

/**
 * A favourite as the API returns it — derived from the product so the shelf's
 * card is the same tile as the grid's, which is the property the page used to get
 * by filtering the fully-loaded catalogue.
 */
const favoriteOf = (productId: number): FavoriteProduct => {
  const product = products.find((p) => p.id === productId)
  return {
    productId,
    categoryId: product?.categoryId ?? 1,
    name: product?.name ?? 'x',
    description: product?.description ?? '',
    imageAlt: product?.imageAlt ?? null,
    createdAt: '',
  }
}

/** Wire the three GETs the page fires, with a configurable favourites payload. */
const mockApi = (
  favorites: number[],
  opts: {
    favoritesFail?: boolean
    /** The 403 every non-root account used to get from the category list (#323). */
    categoriesFail?: boolean
    /**
     * A category request that is accepted and then never answered.
     *
     * Honours the abort signal the page passes, because that is the thing under
     * test: a mock that simply never settles would pass whether the page sets a
     * deadline or not.
     */
    categoriesHang?: boolean
  } = {},
) => {
  mockedGet.mockImplementation((async (path: string, signal?: AbortSignal) => {
    if (path.startsWith('/api/catalog')) return catalogPage(products)
    if (path.startsWith('/api/admin/categories')) {
      if (opts.categoriesFail) throw new Error('Forbidden')
      if (opts.categoriesHang) {
        return new Promise((_resolve, reject) => {
          signal?.addEventListener('abort', () => reject(new Error('aborted')))
        })
      }
      return categories
    }
    if (path.startsWith('/api/favorites')) {
      if (opts.favoritesFail) throw new Error('favorites down')
      return favorites.map(favoriteOf)
    }
    return []
  }) as never)
}

const favoritesSection = () => screen.queryByRole('region', { name: /my favorites/i })

beforeEach(() => {
  currentParams = new URLSearchParams()
  mockedGet.mockReset()
  mockedPut.mockReset().mockResolvedValue(undefined as never)
  mockedDel.mockReset().mockResolvedValue(undefined as never)
})

describe('CatalogPage favorites', () => {
  it('marks the favourited product as pressed and the other as not', async () => {
    mockApi([11])
    render(<CatalogPage />)

    // Card 11 appears twice — once in the favourites section, once in the grid.
    const cards = await screen.findAllByTestId('product-card-11')
    expect(cards).toHaveLength(2)
    // Both must agree; a starred card that renders unstarred in one place is a
    // bug the user would read as the toggle not working.
    for (const card of cards) {
      expect(within(card).getByRole('button', { name: /remove from favorites/i })).toBeInTheDocument()
    }
    const notFavorited = screen.getByTestId('product-card-10')
    expect(within(notFavorited).getByRole('button', { name: /add to favorites/i })).toBeInTheDocument()
  })

  it("labels a tile's picture with the description its uploader wrote", async () => {
    // Not the product name, and not empty: each component used to decide that for
    // itself — the tile and the cart passed "", the detail page passed the name.
    mockApi([])
    render(<CatalogPage />)
    const card = await screen.findByTestId('product-card-10')

    expect(within(card).getByRole('img', { name: 'A database server rack' })).toBeInTheDocument()
  })

  it('falls back to the product name when the picture has no description', async () => {
    mockApi([])
    render(<CatalogPage />)
    const card = await screen.findByTestId('product-card-11')

    expect(within(card).getByRole('img', { name: 'Nginx Gateway' })).toBeInTheDocument()
  })

  it('hides the favourites section entirely when nothing is starred', async () => {
    // An empty shelf is worse than no shelf.
    mockApi([])
    render(<CatalogPage />)

    await waitFor(() => expect(screen.getByTestId('product-card-10')).toBeInTheDocument())
    expect(favoritesSection()).not.toBeInTheDocument()
  })

  it('shows the favourites section once something is starred', async () => {
    mockApi([10])
    render(<CatalogPage />)

    await waitFor(() => expect(favoritesSection()).toBeInTheDocument())
    const section = favoritesSection()
    if (!section) throw new Error('favourites section missing')
    expect(within(section).getByTestId('product-card-10')).toBeInTheDocument()
    expect(within(section).queryByTestId('product-card-11')).not.toBeInTheDocument()
  })

  it('does not let a slow favourites response revert a star clicked meanwhile', async () => {
    // The favourites request is deliberately not awaited, so the stars are already
    // on screen while it is in flight. Its answer is older than a click that
    // happened after it was sent, and applying it silently un-starred the product.
    const user = userEvent.setup()
    let releaseFavorites: (value: FavoriteProduct[]) => void = () => {}
    const pending = new Promise<FavoriteProduct[]>((resolve) => { releaseFavorites = resolve })

    mockedGet.mockImplementation((async (path: string) => {
      if (path.startsWith('/api/catalog')) return catalogPage(products)
      if (path.startsWith('/api/admin/categories')) return categories
      if (path.startsWith('/api/favorites')) return pending
      return []
    }) as never)

    render(<CatalogPage />)
    const card = await screen.findByTestId('product-card-10')
    await user.click(within(card).getByRole('button', { name: /add to favorites/i }))

    // The server answers with what it knew BEFORE the click: nothing starred.
    releaseFavorites([])
    await waitFor(() => expect(mockedPut).toHaveBeenCalledWith('/api/favorites/10', {}))

    // The star stays filled — and the product now also appears in the favourites
    // section, which is what a reverted state would have hidden. (Its card is a
    // second copy of the same tile, hence getAllByTestId.)
    await waitFor(() => expect(favoritesSection()).toBeInTheDocument())
    for (const copy of screen.getAllByTestId('product-card-10')) {
      expect(within(copy).getByRole('button', { name: /remove from favorites/i })).toBeInTheDocument()
    }
  })

  it('PUTs on star and DELETEs on un-star', async () => {
    const user = userEvent.setup()
    mockApi([])
    render(<CatalogPage />)

    await waitFor(() => expect(screen.getByTestId('product-card-10')).toBeInTheDocument())
    const card = screen.getByTestId('product-card-10')

    await user.click(within(card).getByRole('button', { name: /add to favorites/i }))
    expect(mockedPut).toHaveBeenCalledWith('/api/favorites/10', {})

    // The star flips optimistically, so the un-star action is available at once.
    await waitFor(() =>
      expect(within(screen.getAllByTestId('product-card-10')[0]).getByRole('button', { name: /remove from favorites/i })).toBeInTheDocument(),
    )
    await user.click(within(screen.getAllByTestId('product-card-10')[0]).getByRole('button', { name: /remove from favorites/i }))
    expect(mockedDel).toHaveBeenCalledWith('/api/favorites/10')
  })

  it('reveals the favourites section immediately on the first star', async () => {
    const user = userEvent.setup()
    mockApi([])
    render(<CatalogPage />)

    await waitFor(() => expect(screen.getByTestId('product-card-10')).toBeInTheDocument())
    expect(favoritesSection()).not.toBeInTheDocument()

    await user.click(within(screen.getByTestId('product-card-10')).getByRole('button', { name: /add to favorites/i }))
    await waitFor(() => expect(favoritesSection()).toBeInTheDocument())
  })

  it('rolls the star back when the request fails', async () => {
    // Otherwise the star claims a state the server never recorded.
    const user = userEvent.setup()
    mockApi([])
    mockedPut.mockRejectedValue(new Error('offline'))
    render(<CatalogPage />)

    await waitFor(() => expect(screen.getByTestId('product-card-10')).toBeInTheDocument())
    await user.click(within(screen.getByTestId('product-card-10')).getByRole('button', { name: /add to favorites/i }))

    await waitFor(() =>
      expect(within(screen.getByTestId('product-card-10')).getByRole('button', { name: /add to favorites/i })).toBeInTheDocument(),
    )
    expect(favoritesSection()).not.toBeInTheDocument()
  })

  it('renders the catalogue even when the favourites request fails', async () => {
    // A favourites outage costs the stars, not the whole page.
    mockApi([], { favoritesFail: true })
    render(<CatalogPage />)

    await waitFor(() => expect(screen.getByTestId('product-card-10')).toBeInTheDocument())
    expect(screen.getByTestId('product-card-11')).toBeInTheDocument()
    expect(screen.queryByText(/something went wrong/i)).not.toBeInTheDocument()
  })

  it('renders the catalogue even when the categories request is refused', async () => {
    /*
     * #323, as the browser met it.
     *
     * `GET /api/admin/categories` was gated on root while this page fetched it to
     * build the category filter — in the same `Promise.all` as the products — so
     * the 403 rejected the pair and every project manager and admin got the error
     * state instead of the shop. The products are the page; the filter is beside
     * it. Losing the second must not cost the first.
     */
    mockApi([], { categoriesFail: true })
    render(<CatalogPage />)

    await waitFor(() => expect(screen.getByTestId('product-card-10')).toBeInTheDocument())
    expect(screen.getByTestId('product-card-11')).toBeInTheDocument()
    expect(screen.queryByText(/something went wrong/i)).not.toBeInTheDocument()
  })

  it('renders the catalogue when the categories request never answers', async () => {
    /*
     * The same failure reached by hanging rather than by 403 — and `allSettled`
     * alone does not cover it. A request that is accepted and then says nothing
     * is not a rejection: `fetch` has no timeout of its own, so the promise stays
     * pending, the `await` never reaches its `finally`, and the page keeps its
     * skeleton up with the products already in hand. Raised by CodeRabbit on
     * #324.
     */
    vi.useFakeTimers()
    try {
      mockApi([], { categoriesHang: true })
      render(<CatalogPage />)

      // Past the page's own deadline for the category list. Inside `act`, so the
      // state updates the abort sets off are flushed before the assertions —
      // advancing the clock drains the microtask queue but does not itself make
      // React commit.
      await act(async () => {
        await vi.advanceTimersByTimeAsync(11_000)
      })

      expect(screen.getByTestId('product-card-10')).toBeInTheDocument()
      expect(screen.getByTestId('product-card-11')).toBeInTheDocument()
      expect(screen.queryByText(/something went wrong/i)).not.toBeInTheDocument()
    } finally {
      vi.useRealTimers()
    }
  })

  it('suppresses the favourites section while a search is active', async () => {
    // The section is unfiltered, so leaving it up would contradict the results.
    currentParams = new URLSearchParams('q=nginx')
    mockApi([10])
    render(<CatalogPage />)

    await waitFor(() => expect(screen.getByTestId('product-card-11')).toBeInTheDocument())
    expect(favoritesSection()).not.toBeInTheDocument()
  })

  it('suppresses the favourites section while a category filter is active', async () => {
    const user = userEvent.setup()
    mockApi([10])
    render(<CatalogPage />)

    await waitFor(() => expect(favoritesSection()).toBeInTheDocument())
    await user.click(screen.getAllByRole('button', { name: 'Networking' })[0])
    await waitFor(() => expect(favoritesSection()).not.toBeInTheDocument())
  })

  it('requests the favourites in the active language', async () => {
    mockApi([])
    render(<CatalogPage />)

    await waitFor(() => expect(mockedGet).toHaveBeenCalledWith('/api/favorites?lang=en'))
  })
})

// Issue #91: search, category and paging happen in the database now. The page
// used to fetch the whole catalogue and filter it in the browser.
describe('CatalogPage server-side filtering and paging', () => {
  const catalogCalls = () =>
    mockedGet.mock.calls.map((call) => String(call[0])).filter((path) => path.startsWith('/api/catalog'))

  it('asks the endpoint for a page, not for everything', async () => {
    mockApi([])
    render(<CatalogPage />)

    await waitFor(() => expect(catalogCalls().length).toBeGreaterThan(0))
    expect(catalogCalls()[0]).toContain('limit=24')
    expect(catalogCalls()[0]).toContain('offset=0')
  })

  it('sends the search term to the database instead of filtering in the browser', async () => {
    currentParams = new URLSearchParams('q=nginx')
    mockApi([])
    render(<CatalogPage />)

    // Debounced, so this is the request that arrives a moment after the keystroke.
    await waitFor(() => expect(catalogCalls().some((path) => path.includes('search=nginx'))).toBe(true))
  })

  it('sends the chosen category to the database', async () => {
    const user = userEvent.setup()
    mockApi([])
    render(<CatalogPage />)

    await waitFor(() => expect(screen.getByTestId('product-card-10')).toBeInTheDocument())
    await user.click(screen.getAllByRole('button', { name: 'Networking' })[0])

    await waitFor(() => expect(catalogCalls().some((path) => path.includes('categoryId=2'))).toBe(true))
  })

  it('offers more only when there is more, and appends the next page', async () => {
    const third = { ...products[0], id: 12, name: 'Third Product' } as Product
    mockedGet.mockImplementation((async (path: string) => {
      if (path.startsWith('/api/catalog')) {
        // Two of three on the first page, the rest on the second.
        return path.includes('offset=0')
          ? catalogPage(products, 3)
          : catalogPage([third], 3, 2)
      }
      if (path.startsWith('/api/admin/categories')) return categories
      if (path.startsWith('/api/favorites')) return []
      return []
    }) as never)

    const user = userEvent.setup()
    render(<CatalogPage />)

    const more = await screen.findByRole('button', { name: /show more/i })
    expect(screen.getByText('2 / 3 products')).toBeInTheDocument()

    await user.click(more)

    await waitFor(() => expect(screen.getByTestId('product-card-12')).toBeInTheDocument())
    // The first page is still there — appended, not replaced.
    expect(screen.getByTestId('product-card-10')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /show more/i })).not.toBeInTheDocument()
  })

  it('shows no load-more button when the page holds everything', async () => {
    mockApi([])
    render(<CatalogPage />)

    await waitFor(() => expect(screen.getByTestId('product-card-10')).toBeInTheDocument())
    expect(screen.queryByRole('button', { name: /show more/i })).not.toBeInTheDocument()
  })

  it('keeps an off-page favourite visible if un-starring it fails (#138)', async () => {
    // `addShelfRow`, used to restore a rolled-back row, only knows how to
    // rebuild it from `products` — which this favourite was never fetched
    // into. The rollback has to restore the row it captured instead, or the
    // card disappears for good with no way to retry.
    const user = userEvent.setup()
    const offPage = 99
    const offPageFavorite: FavoriteProduct = {
      productId: offPage,
      categoryId: 1,
      name: 'Starred but unloaded',
      description: 'On page three',
      imageAlt: null,
      createdAt: '',
    }
    mockedGet.mockImplementation((async (path: string) => {
      if (path.startsWith('/api/catalog')) return catalogPage(products, 40)
      if (path.startsWith('/api/admin/categories')) return categories
      if (path.startsWith('/api/favorites')) return [offPageFavorite]
      return []
    }) as never)
    mockedDel.mockRejectedValue(new Error('offline'))

    render(<CatalogPage />)
    await waitFor(() => expect(favoritesSection()).toBeInTheDocument())
    let section = favoritesSection()
    if (!section) throw new Error('favourites section missing')
    const card = within(section).getByTestId(`product-card-${offPage}`)
    await user.click(within(card).getByRole('button', { name: /remove from favorites/i }))

    await waitFor(() => expect(mockedDel).toHaveBeenCalledWith(`/api/favorites/${offPage}`))

    // Rolled back: the card must still be on the shelf.
    await waitFor(() => expect(favoritesSection()).toBeInTheDocument())
    section = favoritesSection()
    if (!section) throw new Error('favourites section missing')
    expect(within(section).getByTestId(`product-card-${offPage}`)).toBeInTheDocument()
  })

  it('shows a favourite that is not on the loaded page', async () => {
    // The shelf used to be filtered out of the loaded catalogue, so paging would
    // have hidden every favourite past the first page.
    const offPage = 99
    mockedGet.mockImplementation((async (path: string) => {
      if (path.startsWith('/api/catalog')) return catalogPage(products, 40)
      if (path.startsWith('/api/admin/categories')) return categories
      if (path.startsWith('/api/favorites')) {
        return [{
          productId: offPage,
          categoryId: 1,
          name: 'Starred but unloaded',
          description: 'On page three',
          imageAlt: null,
          createdAt: '',
        }] as FavoriteProduct[]
      }
      return []
    }) as never)

    render(<CatalogPage />)

    await waitFor(() => expect(favoritesSection()).toBeInTheDocument())
    const section = favoritesSection()
    if (!section) throw new Error('favourites section missing')
    expect(within(section).getByTestId(`product-card-${offPage}`)).toBeInTheDocument()
  })

  it('keeps the response for the category clicked last, even if it answers first (#138)', async () => {
    // Click a slow category, then a fast one, within the same tick a real
    // double-click would land in. Without a generation guard, whichever
    // response arrives LAST wins the race regardless of which category is
    // still selected — here that would be the slow, no-longer-selected one.
    const user = userEvent.setup()
    let resolveSlow: (v: ReturnType<typeof catalogPage>) => void = () => {}
    let resolveFast: (v: ReturnType<typeof catalogPage>) => void = () => {}
    let catalogCallCount = 0

    mockedGet.mockImplementation((async (path: string) => {
      if (path.startsWith('/api/catalog')) {
        catalogCallCount += 1
        if (catalogCallCount === 1) return catalogPage(products) // initial, unfiltered load
        if (path.includes('categoryId=1')) return new Promise((resolve) => { resolveSlow = resolve })
        if (path.includes('categoryId=2')) return new Promise((resolve) => { resolveFast = resolve })
        return catalogPage([])
      }
      if (path.startsWith('/api/admin/categories')) return categories
      if (path.startsWith('/api/favorites')) return []
      return []
    }) as never)

    render(<CatalogPage />)
    await waitFor(() => expect(screen.getByTestId('product-card-10')).toBeInTheDocument())

    await user.click(screen.getAllByRole('button', { name: 'Databases' })[0])
    await user.click(screen.getAllByRole('button', { name: 'Networking' })[0])

    // The category clicked last (Networking) answers first...
    resolveFast(catalogPage([products[1]]))
    await waitFor(() => expect(screen.getByTestId('product-card-11')).toBeInTheDocument())

    // ...then the stale, no-longer-selected category's slow answer lands.
    // It must not repaint the grid with Databases' result.
    resolveSlow(catalogPage([products[0]]))
    await waitFor(() => expect(screen.getByTestId('product-card-11')).toBeInTheDocument())
    expect(screen.queryByTestId('product-card-10')).not.toBeInTheDocument()
  })
})

/**
 * What a filtered catalogue says, as opposed to what it draws.
 *
 * The selection is carried by a background colour and the result set is
 * replaced without focus moving, so to anything that cannot compare two fills
 * the page is silent — and a filter that matched nothing is indistinguishable
 * from a catalogue that failed to load (#186).
 */
describe('CatalogPage announces its own state', () => {
  const sidebar = (name: string) => screen.getAllByRole('button', { name })[0]

  it('marks the category in effect, which the fill colour says only to the eye', async () => {
    const user = userEvent.setup()
    mockApi([])
    render(<CatalogPage />)
    await waitFor(() => expect(screen.getByTestId('product-card-10')).toBeInTheDocument())

    // "All products" is the state the page opens in.
    expect(sidebar('All products')).toHaveAttribute('aria-pressed', 'true')
    expect(sidebar('Databases')).toHaveAttribute('aria-pressed', 'false')

    await user.click(sidebar('Databases'))

    expect(sidebar('Databases')).toHaveAttribute('aria-pressed', 'true')
    expect(sidebar('All products')).toHaveAttribute('aria-pressed', 'false')
  })

  it('puts the result count in a live region, including when it is zero', async () => {
    // Zero is the announcement that matters most: it is the one a sighted user
    // reads off the empty state and everyone else used to get as silence.
    mockedGet.mockImplementation((async (path: string) => {
      if (path.startsWith('/api/catalog')) return catalogPage([])
      if (path.startsWith('/api/admin/categories')) return categories
      return []
    }) as never)
    render(<CatalogPage />)

    const status = await screen.findByRole('status')
    await waitFor(() => expect(status).toHaveTextContent('0 products'))
    expect(status).toHaveAttribute('aria-live', 'polite')
  })

  it('says so when loading more fails, instead of leaving a button that did nothing', async () => {
    const user = userEvent.setup()
    mockedGet.mockImplementation((async (path: string) => {
      if (path.startsWith('/api/catalog')) {
        if (path.includes('offset=0')) return catalogPage(products, 3)
        throw new Error('the second page is not coming')
      }
      if (path.startsWith('/api/admin/categories')) return categories
      return []
    }) as never)
    render(<CatalogPage />)

    await user.click(await screen.findByRole('button', { name: /show more/i }))

    // The cards already fetched stay: a failed append is not a failed page.
    expect(await screen.findByRole('alert')).toBeInTheDocument()
    expect(screen.getByTestId('product-card-10')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /show more/i })).toBeEnabled()
  })

describe('CatalogPage — the URL is where the query lives', () => {
  it('adopts a `q` that changed from outside, without a stale frame', async () => {
    // The search box is in the header, which navigates here — so arriving from
    // it, from a back/forward, or from a shared link changes the URL under this
    // page. As an effect the heading named the PREVIOUS term for a frame, beside
    // the right results (#469).
    currentParams = new URLSearchParams('q=nginx')
    mockApi([10])
    const { rerender } = render(<CatalogPage />)
    expect(await screen.findByText(/nginx/)).toBeInTheDocument()

    currentParams = new URLSearchParams('q=postgres')
    rerender(<CatalogPage />)
    expect(screen.getByText(/postgres/)).toBeInTheDocument()
    expect(screen.queryByText(/“nginx”/)).not.toBeInTheDocument()
  })

  /*
   * The other half — that the adoption is keyed on the URL VALUE changing, so a
   * local clear is not undone on the next render — is guarded on `InfraFilters`
   * instead (#462), where the search really is an editable box. Here the only
   * thing that clears it is a button inside the empty-result state, which this
   * harness cannot produce: `mockApi` controls the favourites, not whether the
   * catalogue comes back empty.
   */

})
})
