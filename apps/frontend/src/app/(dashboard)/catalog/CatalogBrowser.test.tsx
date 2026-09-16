import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type { Product, Category, FavoriteProduct, CatalogPage as CatalogPageData } from '@infrashelf/types'

const push = vi.fn()
const refresh = vi.fn()
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push, replace: vi.fn(), refresh }),
  usePathname: () => '/catalog',
}))

vi.mock('@/lib/api', () => ({
  get: vi.fn(),
  put: vi.fn(),
  del: vi.fn(),
}))

import { CatalogBrowser } from './CatalogBrowser'
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

/** The endpoint pages: one window of rows plus the total behind it (#91). */
const catalogPage = (items: Product[], total = items.length, offset = 0): CatalogPageData =>
  ({ items, total, limit: 24, offset }) as CatalogPageData

/**
 * A favourite as the API returns it — derived from the product so the shelf's
 * card is the same tile as the grid's.
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

type Overrides = Partial<Parameters<typeof CatalogBrowser>[0]>

const renderShop = (over: Overrides = {}) => {
  const props = {
    lang: 'en',
    initialPage: catalogPage(products),
    error: null,
    categories,
    initialFavorites: [] as FavoriteProduct[],
    search: '',
    categoryId: null,
    ...over,
  }
  const view = render(<CatalogBrowser {...props} />)
  return {
    ...view,
    /** Re-render as the server would after a navigation: new props, same component. */
    update: (next: Overrides) => view.rerender(<CatalogBrowser {...props} {...next} />),
  }
}

const favoritesSection = () => screen.queryByRole('region', { name: /my favorites/i })
const sidebar = (name: string) => screen.getAllByRole('button', { name })[0]

beforeEach(() => {
  push.mockReset()
  refresh.mockReset()
  mockedGet.mockReset()
  mockedPut.mockReset().mockResolvedValue(undefined as never)
  mockedDel.mockReset().mockResolvedValue(undefined as never)
})

describe('CatalogBrowser favourites', () => {
  it('marks the favourited product as pressed and the other as not', () => {
    renderShop({ initialFavorites: [favoriteOf(11)] })

    // Card 11 appears twice — once in the favourites section, once in the grid.
    const cards = screen.getAllByTestId('product-card-11')
    expect(cards).toHaveLength(2)
    // Both must agree; a starred card that renders unstarred in one place is a
    // bug the user would read as the toggle not working.
    for (const card of cards) {
      expect(within(card).getByRole('button', { name: /remove from favorites/i })).toBeInTheDocument()
    }
    const notFavorited = screen.getByTestId('product-card-10')
    expect(within(notFavorited).getByRole('button', { name: /add to favorites/i })).toBeInTheDocument()
  })

  it("labels a tile's picture with the description its uploader wrote", () => {
    // Not the product name, and not empty: each component used to decide that for
    // itself — the tile and the cart passed "", the detail page passed the name.
    renderShop()
    const card = screen.getByTestId('product-card-10')
    expect(within(card).getByRole('img', { name: 'A database server rack' })).toBeInTheDocument()
  })

  it('falls back to the product name when the picture has no description', () => {
    renderShop()
    const card = screen.getByTestId('product-card-11')
    expect(within(card).getByRole('img', { name: 'Nginx Gateway' })).toBeInTheDocument()
  })

  it('hides the favourites section entirely when nothing is starred', () => {
    // An empty shelf is worse than no shelf.
    renderShop()
    expect(favoritesSection()).not.toBeInTheDocument()
  })

  it('shows the favourites section once something is starred', () => {
    renderShop({ initialFavorites: [favoriteOf(10)] })

    const section = favoritesSection()
    if (!section) throw new Error('favourites section missing')
    expect(within(section).getByTestId('product-card-10')).toBeInTheDocument()
    expect(within(section).queryByTestId('product-card-11')).not.toBeInTheDocument()
  })

  it('PUTs on star and DELETEs on un-star', async () => {
    const user = userEvent.setup()
    renderShop()

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
    renderShop()
    expect(favoritesSection()).not.toBeInTheDocument()

    await user.click(within(screen.getByTestId('product-card-10')).getByRole('button', { name: /add to favorites/i }))
    await waitFor(() => expect(favoritesSection()).toBeInTheDocument())
  })

  it('rolls the star back when the request fails', async () => {
    // Otherwise the star claims a state the server never recorded.
    const user = userEvent.setup()
    mockedPut.mockRejectedValue(new Error('offline'))
    renderShop()

    await user.click(within(screen.getByTestId('product-card-10')).getByRole('button', { name: /add to favorites/i }))

    await waitFor(() =>
      expect(within(screen.getByTestId('product-card-10')).getByRole('button', { name: /add to favorites/i })).toBeInTheDocument(),
    )
    expect(favoritesSection()).not.toBeInTheDocument()
  })

  it('shows a favourite that is not on the loaded page', () => {
    // The shelf used to be filtered out of the loaded catalogue, so paging would
    // have hidden every favourite past the first page (#91).
    const offPage: FavoriteProduct = {
      productId: 99, categoryId: 1, name: 'Starred but unloaded',
      description: 'On page three', imageAlt: null, createdAt: '',
    }
    renderShop({ initialPage: catalogPage(products, 40), initialFavorites: [offPage] })

    const section = favoritesSection()
    if (!section) throw new Error('favourites section missing')
    expect(within(section).getByTestId('product-card-99')).toBeInTheDocument()
  })

  it('keeps an off-page favourite visible if un-starring it fails (#138)', async () => {
    // `addShelfRow`, used to restore a rolled-back row, only knows how to rebuild
    // it from `products` — which this favourite was never fetched into. The
    // rollback has to restore the row it captured instead, or the card disappears
    // for good with no way to retry.
    const user = userEvent.setup()
    const offPage: FavoriteProduct = {
      productId: 99, categoryId: 1, name: 'Starred but unloaded',
      description: 'On page three', imageAlt: null, createdAt: '',
    }
    mockedDel.mockRejectedValue(new Error('offline'))
    renderShop({ initialPage: catalogPage(products, 40), initialFavorites: [offPage] })

    const shelf = favoritesSection()
    if (!shelf) throw new Error('favourites section missing')
    await user.click(within(within(shelf).getByTestId('product-card-99')).getByRole('button', { name: /remove from favorites/i }))

    await waitFor(() => expect(mockedDel).toHaveBeenCalledWith('/api/favorites/99'))
    const after = favoritesSection()
    if (!after) throw new Error('the shelf was lost on rollback')
    expect(within(after).getByTestId('product-card-99')).toBeInTheDocument()
  })

  it('suppresses the favourites section while a search is active', () => {
    // The shelf is unfiltered, so leaving it up would contradict the results.
    renderShop({ initialFavorites: [favoriteOf(10)], search: 'nginx' })
    expect(favoritesSection()).not.toBeInTheDocument()
  })

  it('suppresses the favourites section while a category filter is active', () => {
    renderShop({ initialFavorites: [favoriteOf(10)], categoryId: 2 })
    expect(favoritesSection()).not.toBeInTheDocument()
  })

  it('adopts the stars the server read, without a stale frame', () => {
    // A `router.refresh()` or a navigation hands over what the server read, which
    // is the authority — and it arrives during render, not a frame later (#469).
    const { update } = renderShop({ initialFavorites: [] })
    expect(favoritesSection()).not.toBeInTheDocument()

    update({ initialFavorites: [favoriteOf(10)] })
    expect(favoritesSection()).toBeInTheDocument()
  })
})

/**
 * The filters are the URL now (#472). A category was `useState`, so a filtered
 * shop could not be sent to anyone and Back left the shop entirely.
 */
describe('CatalogBrowser — the URL is where the query lives', () => {
  it('navigates when a category is picked', async () => {
    const user = userEvent.setup()
    renderShop()

    await user.click(sidebar('Networking'))
    expect(push).toHaveBeenCalledWith('/catalog?category=2')
  })

  it('clears the category when the one in effect is picked again', async () => {
    const user = userEvent.setup()
    renderShop({ categoryId: 2 })

    await user.click(sidebar('Networking'))
    expect(push).toHaveBeenCalledWith('/catalog')
  })

  it('keeps the search when the category changes', async () => {
    const user = userEvent.setup()
    renderShop({ search: 'nginx', initialPage: catalogPage([]) })

    await user.click(sidebar('Databases'))
    expect(push).toHaveBeenCalledWith('/catalog?q=nginx&category=1')
  })

  it('drops the search from the empty state, and keeps the category', async () => {
    // The way out of "nothing matched" is to stop searching — not to lose the
    // category the shopper had also chosen.
    const user = userEvent.setup()
    renderShop({ search: 'nginx', categoryId: 1, initialPage: catalogPage([]) })

    // The second one: the first is the sidebar's, which is the category filter.
    await user.click(screen.getAllByRole('button', { name: /all products/i })[1])
    expect(push).toHaveBeenCalledWith('/catalog?category=1')
  })

  it('marks the category in effect, which the fill colour says only to the eye', () => {
    const { update } = renderShop()

    expect(sidebar('All products')).toHaveAttribute('aria-pressed', 'true')
    expect(sidebar('Databases')).toHaveAttribute('aria-pressed', 'false')

    update({ categoryId: 1 })

    expect(sidebar('Databases')).toHaveAttribute('aria-pressed', 'true')
    expect(sidebar('All products')).toHaveAttribute('aria-pressed', 'false')
  })

  it('names the term in its heading', () => {
    renderShop({ search: 'nginx' })
    expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent('nginx')
  })

  it('adopts the page the server rendered, without a stale frame', () => {
    // As an effect the previous query's cards sat under the new query's heading
    // and count for a frame (#469).
    const { update } = renderShop()
    expect(screen.getByTestId('product-card-10')).toBeInTheDocument()

    update({ initialPage: catalogPage([products[1]]), categoryId: 2 })

    expect(screen.queryByTestId('product-card-10')).not.toBeInTheDocument()
    expect(screen.getByTestId('product-card-11')).toBeInTheDocument()
  })
})

describe('CatalogBrowser paging', () => {
  const third = { ...products[0], id: 12, name: 'Third Product' } as Product

  it('offers more only when there is more, and appends the next page', async () => {
    const user = userEvent.setup()
    mockedGet.mockResolvedValue(catalogPage([third], 3, 2) as never)
    renderShop({ initialPage: catalogPage(products, 3) })

    expect(screen.getByText('2 / 3 products')).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: /show more/i }))

    await waitFor(() => expect(screen.getByTestId('product-card-12')).toBeInTheDocument())
    // The first page is still there — appended, not replaced.
    expect(screen.getByTestId('product-card-10')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /show more/i })).not.toBeInTheDocument()
  })

  it('continues from what it holds, under the same query', async () => {
    const user = userEvent.setup()
    mockedGet.mockResolvedValue(catalogPage([third], 3, 2) as never)
    renderShop({ initialPage: catalogPage(products, 3), search: 'nginx', categoryId: 2 })

    await user.click(screen.getByRole('button', { name: /show more/i }))

    const asked = new URL(String(mockedGet.mock.calls[0][0]), 'http://x').searchParams
    expect(asked.get('offset')).toBe('2')
    expect(asked.get('search')).toBe('nginx')
    expect(asked.get('categoryId')).toBe('2')
  })

  it('shows no load-more button when the page holds everything', () => {
    renderShop()
    expect(screen.queryByRole('button', { name: /show more/i })).not.toBeInTheDocument()
  })

  it('says so when loading more fails, instead of leaving a button that did nothing', async () => {
    const user = userEvent.setup()
    mockedGet.mockRejectedValue(new Error('the second page is not coming'))
    renderShop({ initialPage: catalogPage(products, 3) })

    await user.click(screen.getByRole('button', { name: /show more/i }))

    // The cards already fetched stay: a failed append is not a failed page.
    expect(await screen.findByRole('alert')).toBeInTheDocument()
    expect(screen.getByTestId('product-card-10')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /show more/i })).toBeEnabled()
  })

  it('drops a page that answers after the query it belongs to was left (#138)', async () => {
    /*
     * "Show more", then a category click before the answer lands. The append
     * belongs to the query that has been navigated away from, and putting it
     * under the new query's heading is the same bug the old generation counter
     * guarded — reached through the server rather than through a second fetch.
     */
    const user = userEvent.setup()
    let release: (page: CatalogPageData) => void = () => {}
    mockedGet.mockReturnValue(new Promise((resolve) => { release = resolve }) as never)
    const { update } = renderShop({ initialPage: catalogPage(products, 3) })

    await user.click(screen.getByRole('button', { name: /show more/i }))
    // The server answers the category click first.
    update({ initialPage: catalogPage([products[1]], 1), categoryId: 2 })
    // ...and only then does the append land.
    release(catalogPage([third], 3, 2))

    await waitFor(() => expect(screen.getByTestId('product-card-11')).toBeInTheDocument())
    expect(screen.queryByTestId('product-card-12')).not.toBeInTheDocument()
  })
})

/**
 * What a filtered catalogue says, as opposed to what it draws.
 *
 * The selection is carried by a background colour and the result set is replaced
 * without focus moving, so to anything that cannot compare two fills the page is
 * silent — and a filter that matched nothing is indistinguishable from a
 * catalogue that failed to load (#186).
 */
describe('CatalogBrowser announces its own state', () => {
  it('puts the result count in a live region, including when it is zero', () => {
    // Zero is the announcement that matters most: it is the one a sighted user
    // reads off the empty state and everyone else used to get as silence.
    renderShop({ initialPage: catalogPage([]) })

    const status = screen.getByRole('status')
    expect(status).toHaveTextContent('0 products')
    expect(status).toHaveAttribute('aria-live', 'polite')
  })

  it('says the count is a floor when the server stopped counting', () => {
    // A bare figure would claim a precision the server did not spend the work to
    // have (#236).
    renderShop({ initialPage: { ...catalogPage(products, 500), totalIsExact: false } as CatalogPageData })
    expect(screen.getByRole('status')).toHaveTextContent('2 / 500+ products')
  })

  it('reports a failed read instead of an empty shop', () => {
    // "No products" during an outage reads as a catalogue nobody has filled in.
    renderShop({ initialPage: null, error: 'HTTP 502: Bad Gateway' })

    expect(screen.getByText(/something went wrong/i)).toBeInTheDocument()
    // The technical half, for whoever has to fix it — the same two registers
    // `SectionError` uses.
    expect(screen.getByText('HTTP 502: Bad Gateway')).toBeInTheDocument()
    expect(screen.queryByText(/no products/i)).not.toBeInTheDocument()
  })

  it('retries by asking the server again', async () => {
    const user = userEvent.setup()
    renderShop({ initialPage: null, error: 'HTTP 502: Bad Gateway' })

    await user.click(screen.getByRole('button', { name: /try again/i }))
    expect(refresh).toHaveBeenCalled()
  })

  it('offers the way out of an empty search, and not otherwise', () => {
    const empty = renderShop({ initialPage: catalogPage([]), search: 'nothing matches this' })
    expect(screen.getAllByRole('button', { name: /all products/i })).toHaveLength(2)
    empty.unmount()

    // Without a search there is nothing to clear — the shop really is empty.
    renderShop({ initialPage: catalogPage([]) })
    expect(screen.getAllByRole('button', { name: /all products/i })).toHaveLength(1)
  })
})
