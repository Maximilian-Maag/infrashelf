'use client'

import { useEffect, useRef, useState, useTransition } from 'react'
import { useRouter, usePathname } from 'next/navigation'
import type { Product, Category, CatalogPage as CatalogPageData, FavoriteProduct } from '@infrashelf/types'
import { get, put, del } from '@/lib/api'
import { t } from '@/lib/i18n'
import { Alert } from '@/components/ui/Alert'
import { ProductCard } from './ProductCard'
import { catalogQuery } from './query'

interface Props {
  lang: string
  /** The first window of products the SERVER read, or null when its read failed. */
  initialPage: CatalogPageData | null
  /** The technical reason that read failed, for the panel that replaces the grid. */
  error: string | null
  /** The filter's options. Empty when the category list could not be read — the shop still works. */
  categories: Category[]
  /** The stars, as the server read them. Empty when that read failed: an outage costs the stars, not the shop. */
  initialFavorites: FavoriteProduct[]
  /** The `q` in the URL. The search box itself is in the header, which navigates here. */
  search: string
  /** The `category` in the URL, or null for all products. */
  categoryId: number | null
}

/**
 * The catalogue, around the page of products the server already read (#472).
 *
 * What is left in the browser is what the server cannot answer: a star being
 * toggled, and a second page being appended to the one in hand. The filters are
 * not here any more — a category is a URL now, so clicking one navigates and the
 * server answers, which is what makes a filtered shop something you can send
 * someone, and what makes Back go back to the previous category instead of out
 * of the shop entirely.
 */
export function CatalogBrowser({
  lang,
  initialPage,
  error,
  categories,
  initialFavorites,
  search,
  categoryId,
}: Props) {
  const router = useRouter()
  const pathname = usePathname()
  const [isPending, startTransition] = useTransition()

  const [products, setProducts] = useState<Product[]>(initialPage?.items ?? [])
  // Matches for the current filters, which is more than the page in hand.
  const [total, setTotal] = useState(initialPage?.total ?? 0)
  // False when the search matched more rows than the server was willing to
  // count. The number is then a floor, and printing it bare would state
  // something untrue (#236).
  const [totalIsExact, setTotalIsExact] = useState(initialPage?.totalIsExact ?? true)
  const [loadingMore, setLoadingMore] = useState(false)
  // Kept apart from the server's `error`: that one replaces the grid, and a
  // failed "load more" must not throw away the cards already on screen.
  const [loadMoreError, setLoadMoreError] = useState(false)

  /*
   * Adopt the page the server just rendered — a category click, a search, a
   * Back, or the language switcher's `router.refresh()` — during render rather
   * than in an effect (#469).
   *
   * `products` is not a mirror of the prop: "load more" appends to it, and that
   * is the whole reason it is state at all. But a NEW server answer replaces it,
   * appended rows included, because those rows belong to the query that has just
   * been navigated away from. As an effect the old query's cards sat under the
   * new query's heading and count for a frame.
   */
  const [shownPage, setShownPage] = useState(initialPage)
  if (initialPage !== shownPage) {
    setShownPage(initialPage)
    setProducts(initialPage?.items ?? [])
    setTotal(initialPage?.total ?? 0)
    setTotalIsExact(initialPage?.totalIsExact ?? true)
    setLoadMoreError(false)
  }

  /*
   * The same answer, reachable from inside a request that is already in flight.
   *
   * `loadMore` closes over the render it was created in, so comparing `shownPage`
   * there compares the old value with itself — it cannot see that a navigation
   * has since replaced the grid. A ref is the one thing a running handler and a
   * later render share. Synced in an effect rather than written during render,
   * which is the rule about refs and renders, and it carries no state so nothing
   * cascades.
   */
  const currentPage = useRef(initialPage)
  useEffect(() => { currentPage.current = initialPage }, [initialPage])

  // Favourited product ids. Held as a Set so a card can answer "am I starred?"
  // without scanning a list per render.
  const [favorites, setFavorites] = useState<Set<number>>(new Set(initialFavorites.map((f) => f.productId)))
  // The shelf renders from this, not from the loaded page: the catalogue is
  // paged, so a favourite can easily be a product this browser has not fetched
  // (#91).
  const [favoriteItems, setFavoriteItems] = useState<FavoriteProduct[]>(initialFavorites)
  const [favoriteBusy, setFavoriteBusy] = useState<Set<number>>(new Set())

  /*
   * The same adoption for the stars, and for the same reason: a `router.refresh()`
   * or a navigation hands over what the SERVER read, which is the authority. A
   * star toggled optimistically since then has already been written, so the two
   * agree; if the write failed, the rollback below has already undone it.
   */
  const [shownFavorites, setShownFavorites] = useState(initialFavorites)
  if (initialFavorites !== shownFavorites) {
    setShownFavorites(initialFavorites)
    setFavorites(new Set(initialFavorites.map((f) => f.productId)))
    setFavoriteItems(initialFavorites)
  }

  /** Navigate: the filters are the URL now. */
  const go = (changes: Record<string, string | null>) => {
    const next = new URLSearchParams()
    if (search) next.set('q', search)
    if (categoryId !== null) next.set('category', String(categoryId))
    for (const [key, value] of Object.entries(changes)) {
      if (value === null) next.delete(key)
      else next.set(key, value)
    }
    const qs = next.toString()
    startTransition(() => {
      // push, not replace: picking a category is a deliberate move, and Back
      // returning to the previous category is the behaviour this page did not
      // have while the filter lived in `useState` (#472).
      router.push(qs ? `${pathname}?${qs}` : pathname)
    })
  }

  const selectCategory = (id: number | null) =>
    go({ category: id === null || id === categoryId ? null : String(id) })

  /**
   * The next page, appended.
   *
   * Offset by what is already held rather than by a page number: the two agree
   * while nothing changes underneath, and when something does, "carry on from
   * what I have" is the more defensible of the two.
   */
  const loadMore = async () => {
    if (loadingMore) return
    setLoadingMore(true)
    setLoadMoreError(false)
    // What the grid held when this was asked for. A navigation replaces the grid
    // from the server while this request is in flight, and its answer belongs to
    // the query that was navigated away from — appending it would put the old
    // query's products under the new query's heading (#138).
    const asked = currentPage.current
    try {
      const page = await get<CatalogPageData>(
        catalogQuery({ lang, search, categoryId, offset: products.length }),
      )
      if (currentPage.current !== asked) return
      setProducts((prev) => [...prev, ...(page?.items ?? [])])
      setTotal(page?.total ?? 0)
      setTotalIsExact(page?.totalIsExact ?? true)
    } catch {
      if (currentPage.current !== asked) return
      // Keep what is on screen; the button stays available for another go — but
      // say so. Swallowed, the failure and a successful append that happened to
      // return nothing look identical, and to anyone not counting cards the
      // button simply did nothing (#186).
      setLoadMoreError(true)
    } finally {
      // Not guarded: this button belongs to the grid on screen whichever query
      // filled it, and leaving it spinning forever would be the worse failure.
      setLoadingMore(false)
    }
  }

  /** The shelf row for a product on the current page, appended if it is not already there. */
  const addShelfRow = (rows: FavoriteProduct[], productId: number): FavoriteProduct[] => {
    if (rows.some((f) => f.productId === productId)) return rows
    const product = products.find((p) => p.id === productId)
    if (!product) return rows
    return [
      {
        productId,
        categoryId: product.categoryId,
        name: product.name,
        description: product.description,
        imageAlt: product.imageAlt,
        createdAt: new Date().toISOString(),
      },
      ...rows,
    ]
  }

  async function toggleFavorite(productId: number) {
    if (favoriteBusy.has(productId)) return
    const wasFavorited = favorites.has(productId)
    // Captured before the optimistic update below removes it. A rollback needs to
    // restore the exact row the shelf was showing, not re-derive it via
    // `addShelfRow` — that reads from `products`, which does not have a favourite
    // the browser never fetched a page containing, and un-starring one of those
    // while the API is down would otherwise lose the card for good (#138).
    const previousRow = favoriteItems.find((f) => f.productId === productId)

    // Optimistic: the star is the whole feedback, so waiting a round trip to
    // fill it in reads as a dead button.
    setFavorites((prev) => {
      const next = new Set(prev)
      if (wasFavorited) next.delete(productId)
      else next.add(productId)
      return next
    })
    // The shelf moves with the star. Its rows come from the server — which is
    // what lets it show a favourite from a page this browser never fetched (#91)
    // — but a click has to land on it immediately, so the row is synthesised
    // from the grid card that was clicked.
    setFavoriteItems((prev) => (wasFavorited ? prev.filter((f) => f.productId !== productId) : addShelfRow(prev, productId)))
    setFavoriteBusy((prev) => new Set(prev).add(productId))

    try {
      if (wasFavorited) await del(`/api/favorites/${productId}`)
      else await put(`/api/favorites/${productId}`, {})
    } catch {
      // Roll back rather than leave the star claiming something the server did
      // not record.
      setFavorites((prev) => {
        const next = new Set(prev)
        if (wasFavorited) next.add(productId)
        else next.delete(productId)
        return next
      })
      setFavoriteItems((prev) => {
        if (!wasFavorited) return prev.filter((f) => f.productId !== productId)
        if (prev.some((f) => f.productId === productId)) return prev
        // Restore the captured row rather than calling `addShelfRow`: this is the
        // un-favourite path, so the product may not be on the loaded page, and
        // `addShelfRow`'s `products.find` would silently drop it.
        return previousRow ? [previousRow, ...prev] : prev
      })
    } finally {
      setFavoriteBusy((prev) => {
        const next = new Set(prev)
        next.delete(productId)
        return next
      })
    }
  }

  const categoryName = (id: number) => categories.find((c) => c.id === id)?.name

  // `level` is passed at each call site rather than defaulted here: the two grids
  // sit at different depths in the outline, and `.map(renderCard)` would have
  // handed the array index to it.
  const renderCard = (
    product: {
      id: number
      categoryId: number
      name: string
      description: string
      imageAlt?: string | null
    },
    level: 2 | 3,
  ) => (
    <ProductCard
      key={product.id}
      level={level}
      id={product.id}
      name={product.name}
      description={product.description}
      imageAlt={product.imageAlt}
      categoryName={categoryName(product.categoryId)}
      favorited={favorites.has(product.id)}
      busy={favoriteBusy.has(product.id)}
      onToggleFavorite={() => toggleFavorite(product.id)}
      lang={lang}
    />
  )

  // From the favourites payload, which carries everything a card needs. It used
  // to be drawn from the loaded catalogue — which worked only because the whole
  // catalogue was loaded, and would silently hide any favourite past the first
  // page now that it is not (#91).
  const favoriteCards = favoriteItems.map((f) => ({
    id: f.productId,
    categoryId: f.categoryId,
    name: f.name,
    description: f.description,
    imageAlt: f.imageAlt,
  }))

  return (
    <div className="flex gap-6">
      {/* Category sidebar */}
      <aside className="hidden md:block w-52 shrink-0">
        <div className="bg-white rounded-lg border border-slate-200 p-4 sticky top-28">
          <h2 className="font-bold text-xs text-slate-600 mb-3 uppercase tracking-wide">{t('categories', lang)}</h2>
          <ul className="space-y-1">
            <li>
              <button
                onClick={() => selectCategory(null)}
                // Which filter is in effect is otherwise carried by the fill
                // colour alone, so a screen-reader user hears a list of
                // identical buttons and cannot tell a filtered result set from
                // a broken one (WCAG 1.4.1, 4.1.2 — #186).
                aria-pressed={categoryId === null}
                className="w-full text-left flex min-h-11 items-center px-3 py-1.5 rounded text-sm transition-colors font-semibold"
                style={categoryId === null ? { backgroundColor: 'var(--bp)', color: 'var(--bp-ink)' } : { color: '#475569' }}
                onMouseEnter={(e) => { if (categoryId !== null) (e.currentTarget as HTMLElement).style.backgroundColor = '#f1f5f9' }}
                onMouseLeave={(e) => { if (categoryId !== null) (e.currentTarget as HTMLElement).style.backgroundColor = '' }}
              >
                {t('allProducts', lang)}
              </button>
            </li>
            {categories.map((cat) => (
              <li key={cat.id}>
                <button
                  onClick={() => selectCategory(cat.id)}
                  aria-pressed={categoryId === cat.id}
                  className="w-full text-left flex min-h-11 items-center px-3 py-1.5 rounded text-sm transition-colors"
                  style={categoryId === cat.id ? { backgroundColor: 'var(--bp)', color: 'var(--bp-ink)', fontWeight: 600 } : { color: '#475569' }}
                  onMouseEnter={(e) => { if (categoryId !== cat.id) (e.currentTarget as HTMLElement).style.backgroundColor = '#f1f5f9' }}
                  onMouseLeave={(e) => { if (categoryId !== cat.id) (e.currentTarget as HTMLElement).style.backgroundColor = '' }}
                >
                  {cat.name}
                </button>
              </li>
            ))}
          </ul>
        </div>
      </aside>

      {/* Main content */}
      <div className="flex-1 min-w-0">
        {/* The page's <h1>, and it comes BEFORE the favourites shelf on purpose.
            It used to be an <h2> sitting below that shelf, so /catalog — the
            second-busiest route here — had no level-one heading at all, and
            simply promoting it in place would have put the h1 after the
            favourites' h2 and its h3 cards: a heading-order skip on the way
            back down. Moving it up makes the outline read h1 → h2 → h3 in DOM
            order, which is the order a screen reader walks it in (#185). */}
        <div className="mb-4 flex items-center justify-between flex-wrap gap-2">
          <div>
            {search ? (
              <h1 className="text-xl font-bold text-slate-800">
                {t('resultsFor', lang)}: <span style={{ color: 'var(--bp-text)' }}>&ldquo;{search}&rdquo;</span>
              </h1>
            ) : (
              <>
                <h1 className="text-xl font-bold text-slate-800">{t('productCatalog', lang)}</h1>
                <p className="text-sm text-slate-600 mt-0.5">{t('productCatalogSubtitle', lang)}</p>
              </>
            )}
          </div>
          {/* The result count is the only thing that says a search or a filter
              did anything: the grid below is replaced without focus moving, so
              a screen-reader user gets no feedback at all otherwise (WCAG
              4.1.3). Rendered unconditionally rather than only when there are
              matches, because "0 products" is the announcement that matters
              most — a filter that found nothing and a catalogue that failed to
              load are otherwise the same silence. InfraFilters already does
              this; this is the same wiring (#186). */}
          <span
            className="text-sm text-slate-600"
            role="status"
            aria-live="polite"
            // The navigation IS the load now, so the pending transition is what
            // "busy" means here.
            aria-busy={isPending}
          >
            {/* "500+" rather than "500" once the count hit its cap: the
                number is a floor there, and a bare figure claims a precision
                the server did not spend the work to have (#236). */}
            {error
              ? ''
              : products.length < total
                ? `${products.length} / ${total}${totalIsExact ? '' : '+'} ${t('products', lang)}`
                : `${total}${totalIsExact ? '' : '+'} ${t('products', lang)}`}
          </span>
        </div>

        {/* Favourites shortcut. Hidden entirely when empty rather than shown as
            an empty shelf, and suppressed while searching or filtering so it
            cannot contradict the result set below it. */}
        {favoriteCards.length > 0 && !search && categoryId === null && (
          <section className="mb-6" aria-labelledby="favorites-heading">
            <h2 id="favorites-heading" className="text-xl font-bold text-slate-800 mb-3">
              {t('myFavorites', lang)}
            </h2>
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-4">
              {favoriteCards.map((p) => renderCard(p, 3))}
            </div>
          </section>
        )}

        {/* Mobile category pills */}
        {categories.length > 0 && (
          <div className="flex flex-wrap gap-2 mb-4 md:hidden">
            <button
              onClick={() => selectCategory(null)}
              aria-pressed={categoryId === null}
              className="inline-flex min-h-11 items-center rounded-full px-4 py-1 text-sm font-medium transition-colors"
              style={categoryId === null ? { backgroundColor: 'var(--bp)', color: 'var(--bp-ink)' } : { backgroundColor: '#f1f5f9', color: '#475569' }}
            >
              {t('all', lang)}
            </button>
            {categories.map((cat) => (
              <button
                key={cat.id}
                onClick={() => selectCategory(cat.id)}
                aria-pressed={categoryId === cat.id}
                className="inline-flex min-h-11 items-center rounded-full px-4 py-1 text-sm font-medium transition-colors"
                style={categoryId === cat.id ? { backgroundColor: 'var(--bp)', color: 'var(--bp-ink)' } : { backgroundColor: '#f1f5f9', color: '#475569' }}
              >
                {cat.name}
              </button>
            ))}
          </div>
        )}

        {error ? (
          <div className="text-center py-20 bg-white rounded-lg border border-slate-200">
            <p className="font-semibold text-slate-700">{t('somethingWentWrong', lang)}</p>
            {/* The reason, unlocalised and in the same register `SectionError`
                uses: the sentence above is for the shopper, this is for whoever
                has to fix it. */}
            <p className="mt-1 font-mono text-xs text-slate-600">{error}</p>
            <button
              onClick={() => startTransition(() => router.refresh())}
              className="text-sm mt-3 inline-flex min-h-11 items-center hover:underline"
              style={{ color: 'var(--bp-text)' }}
            >
              {t('tryAgain', lang)}
            </button>
          </div>
        ) : products.length === 0 ? (
          <div className="text-center py-20 bg-white rounded-lg border border-slate-200">
            <svg className="h-14 w-14 mx-auto mb-4 text-slate-200" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1} d="M19 11H5m14 0a2 2 0 012 2v6a2 2 0 01-2 2H5a2 2 0 01-2-2v-6a2 2 0 012-2m14 0V9a2 2 0 00-2-2M5 11V9a2 2 0 012-2m0 0V5a2 2 0 012-2h6a2 2 0 012 2v2M7 7h10" />
            </svg>
            <p className="font-semibold text-slate-600">{t('noProducts', lang)}</p>
            {search && (
              <button
                onClick={() => go({ q: null })}
                className="text-sm mt-2 inline-flex min-h-11 items-center hover:underline"
                style={{ color: 'var(--bp-text)' }}
              >
                ← {t('allProducts', lang)}
              </button>
            )}
          </div>
        ) : (
          <>
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-4">
              {products.map((p) => renderCard(p, 2))}
            </div>

            {/* Only when there is genuinely more to fetch — a button that says
                "load more" and then loads nothing is worse than no button. */}
            {products.length < total && (
              <div className="mt-6 text-center">
                <button
                  onClick={loadMore}
                  disabled={loadingMore}
                  className="rounded-md min-h-11 px-5 py-2.5 text-sm font-semibold disabled:opacity-50 disabled:cursor-not-allowed hover:opacity-90 transition-opacity"
                  style={{ backgroundColor: 'var(--bp)', color: 'var(--bp-ink)' }}
                >
                  {loadingMore ? t('loading', lang) : t('loadMore', lang)}
                </button>
                {loadMoreError && (
                  <div className="mt-3">
                    <Alert>{t('somethingWentWrong', lang)}</Alert>
                  </div>
                )}
              </div>
            )}
          </>
        )}
      </div>
    </div>
  )
}
