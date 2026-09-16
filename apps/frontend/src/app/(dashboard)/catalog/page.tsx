'use client'

import { useState, useEffect, useCallback, useRef } from 'react'
import { useSearchParams } from 'next/navigation'
import type { Product, Category, CatalogPage as CatalogPageData, FavoriteProduct } from '@infrashelf/types'
import { get, put, del } from '@/lib/api'
import { t } from '@/lib/i18n'
import { useLang } from '@/lib/useLang'
import { SkeletonCard, LoadingRegion } from '@/components/ui/Skeleton'
import { Alert } from '@/components/ui/Alert'
import { ProductCard } from './ProductCard'

/** One screenful of cards. The endpoint caps what it will serve at 100. */
const PAGE_SIZE = 24

/** How long to wait after a keystroke before asking the database (#91). */
const SEARCH_DEBOUNCE_MS = 300

/**
 * How long the category filter may keep the catalogue waiting.
 *
 * Generous, because this is not a latency budget — a slow answer still produces
 * a working filter and is worth having. It is the bound past which "slow" stops
 * being a possible explanation, and beyond which the shop is better off drawn
 * without its filter than not drawn at all.
 */
const CATEGORIES_TIMEOUT_MS = 10_000

/**
 * A signal that aborts after `ms`.
 *
 * Its own three lines rather than `AbortSignal.timeout`, which is not something
 * every environment this file is exercised in provides — the page's own tests run
 * under jsdom, and a missing static would throw on the call rather than fail an
 * assertion, which reads as the page being broken. `AbortController` and
 * `setTimeout` are everywhere.
 *
 * The timer is not cleared. It holds nothing but a reference to a controller
 * whose signal no longer has a listener once the fetch has settled, and firing
 * `abort()` on a settled request does nothing at all.
 */
const deadline = (ms: number): AbortSignal => {
  const controller = new AbortController()
  setTimeout(() => controller.abort(), ms)
  return controller.signal
}

export default function CatalogPage() {
  const searchParams = useSearchParams()
  const lang = useLang()

  const [products, setProducts] = useState<Product[]>([])
  // Matches for the current filters, which is more than the page in hand.
  const [total, setTotal] = useState(0)
  // False when the search matched more rows than the server was willing to
  // count. The number is then a floor, and printing it bare would state
  // something untrue (#236).
  const [totalIsExact, setTotalIsExact] = useState(true)
  const [categories, setCategories] = useState<Category[]>([])
  const [search, setSearch] = useState(searchParams.get('q') ?? '')
  const [selectedCategory, setSelectedCategory] = useState<number | null>(null)
  const [loading, setLoading] = useState(true)
  const [loadingMore, setLoadingMore] = useState(false)
  const [error, setError] = useState(false)
  // Kept apart from `error`: that one replaces the grid, and a failed "load
  // more" must not throw away the cards already on screen.
  const [loadMoreError, setLoadMoreError] = useState(false)
  // Favourited product ids. Held as a Set so a card can answer "am I starred?"
  // without scanning a list per render.
  const [favorites, setFavorites] = useState<Set<number>>(new Set())
  // The favourites shelf renders from this, not from the loaded page: the
  // catalogue is paged now, so a favourite can easily be a product this browser
  // has not fetched (#91).
  const [favoriteItems, setFavoriteItems] = useState<FavoriteProduct[]>([])
  const [favoriteBusy, setFavoriteBusy] = useState<Set<number>>(new Set())
  // Bumped on every toggle AND every load. The favourites request below is not
  // awaited, so a star clicked while it is in flight is NEWER than the answer
  // coming back — applying that answer would silently revert what the user just
  // did. Starring a product immediately after the page appeared did exactly that.
  const favoritesGeneration = useRef(0)
  // Same idea, for the catalogue fetch itself. `load()` refires on every
  // category click and every debounced search change, and those requests are
  // not serialised — a slow broad category clicked just before a fast one
  // must not have its answer land on top of the fast one's (#138).
  const loadGeneration = useRef(0)

  // sync URL search param into local state
  useEffect(() => {
    setSearch(searchParams.get('q') ?? '')
  }, [searchParams])

  // What has actually been asked of the database. Typing no longer filters a
  // list held in the browser, so every keystroke would otherwise be a request.
  const [appliedSearch, setAppliedSearch] = useState(search)
  useEffect(() => {
    const timer = setTimeout(() => setAppliedSearch(search), SEARCH_DEBOUNCE_MS)
    return () => clearTimeout(timer)
  }, [search])

  const pageUrl = useCallback(
    (offset: number) => {
      const params = new URLSearchParams({
        lang,
        limit: String(PAGE_SIZE),
        offset: String(offset),
      })
      if (appliedSearch) params.set('search', appliedSearch)
      if (selectedCategory !== null) params.set('categoryId', String(selectedCategory))
      return `/api/catalog?${params.toString()}`
    },
    [lang, appliedSearch, selectedCategory],
  )

  const loadFavorites = useCallback(
    (generation: number) => {
      get<FavoriteProduct[]>(`/api/favorites?lang=${lang}`)
        .then((favs) => {
          if (favoritesGeneration.current !== generation) return
          setFavorites(new Set((favs ?? []).map((f) => f.productId)))
          setFavoriteItems(favs ?? [])
        })
        .catch(() => {
          if (favoritesGeneration.current !== generation) return
          setFavorites(new Set())
          setFavoriteItems([])
        })
    },
    [lang],
  )

  const load = useCallback(async () => {
    // Claimed before the request goes out, so a response can tell whether it
    // is still the newest one asked for by the time it comes back.
    const generation = ++loadGeneration.current
    setLoading(true)
    setError(false)
    // The append failure belonged to the query being replaced. Left standing it
    // would sit above a grid it has nothing to do with (#186).
    setLoadMoreError(false)
    try {
      // allSettled, not all: the products are what this page IS, and the
      // category list only builds the filter beside them. Joined by `Promise.all`
      // these shared one fate, and a 403 on the categories put the whole shop
      // behind the error state with a perfectly good page of products in hand —
      // which is exactly how this page looked to every non-root account. The
      // filter is worth degrading; the catalogue is not.
      //
      // And the categories get a deadline, because allSettled alone does not
      // finish the job. It makes a category REJECTION harmless, but a request
      // that is accepted and then never answered is not a rejection: `fetch` has
      // no timeout, the promise stays pending, and the `await` above never
      // reaches its `finally` — so the shop sits on its skeleton for ever with
      // the products already in hand. Same failure this whole change is about,
      // reached by hanging instead of by 403. Raised by CodeRabbit on #324.
      const [pageRes, catsRes] = await Promise.allSettled([
        get<CatalogPageData>(pageUrl(0)),
        get<Category[]>('/api/admin/categories', deadline(CATEGORIES_TIMEOUT_MS)),
      ])
      if (pageRes.status === 'rejected') throw pageRes.reason
      const page = pageRes.value
      const cats = catsRes.status === 'fulfilled' ? catsRes.value : []
      // A newer load has started since this one went out (another category
      // click, or the debounced search firing) — its answer belongs to a
      // filter that is no longer selected, so it must not overwrite what the
      // newer request will (or already did) produce (#138).
      if (loadGeneration.current !== generation) return
      setProducts(page?.items ?? [])
      setTotal(page?.total ?? 0)
      setTotalIsExact(page?.totalIsExact ?? true)
      setCategories(cats ?? [])
      // Separately and non-fatally: a favourites outage should cost the stars,
      // not the whole catalogue.
      // Claim a generation for THIS load as well, not just for toggles: two loads
      // can overlap (a language change re-runs it), and the older one's answer
      // must not land on top of the newer one's.
      loadFavorites(++favoritesGeneration.current)
    } catch {
      if (loadGeneration.current !== generation) return
      // Surface a genuine fetch failure instead of showing an empty catalog,
      // which would look like "no products" during an outage.
      setError(true)
    } finally {
      if (loadGeneration.current === generation) setLoading(false)
    }
  }, [pageUrl, loadFavorites])

  useEffect(() => { void load() }, [load])

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
    /*
     * The same generation guard `load` uses, for the same reason.
     *
     * A search, a category or a language change while this request is in flight
     * replaces the grid with the new query's first page. Without the guard this
     * completion then appends the OLD query's products to it, overwrites its
     * total, or reports an append failure that belongs to a query nobody is
     * looking at any more.
     */
    const generation = loadGeneration.current
    try {
      const page = await get<CatalogPageData>(pageUrl(products.length))
      if (loadGeneration.current !== generation) return
      setProducts((prev) => [...prev, ...(page?.items ?? [])])
      setTotal(page?.total ?? 0)
      setTotalIsExact(page?.totalIsExact ?? true)
    } catch {
      if (loadGeneration.current !== generation) return
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
    favoritesGeneration.current += 1
    const wasFavorited = favorites.has(productId)
    // Captured before the optimistic update below removes it. A rollback
    // needs to restore the exact row the shelf was showing, not re-derive it
    // via `addShelfRow` — that reads from `products`, which does not have a
    // favourite the browser never fetched a page containing, and un-starring
    // one of those while the API is down would otherwise lose the card for
    // good (#138).
    const previousRow = favoriteItems.find((f) => f.productId === productId)

    // Optimistic: the star is the whole feedback, so waiting a round trip to
    // fill it in reads as a dead button.
    setFavorites((prev) => {
      const next = new Set(prev)
      if (wasFavorited) next.delete(productId)
      else next.add(productId)
      return next
    })
    // The shelf moves with the star. Its rows come from the server on load —
    // which is what lets it show a favourite from a page this browser never
    // fetched (#91) — but a click has to land on it immediately, so the row is
    // synthesised from the grid card that was clicked.
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
        // Restore the captured row rather than calling `addShelfRow`: this is
        // the un-favourite path, so the product may not be on the loaded
        // page, and `addShelfRow`'s `products.find` would silently drop it.
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

  const categoryName = (categoryId: number) => categories.find((c) => c.id === categoryId)?.name

  // `level` is passed at each call site rather than defaulted here: the two
  // grids sit at different depths in the outline, and `.map(renderCard)` would
  // have handed the array index to it.
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
                onClick={() => setSelectedCategory(null)}
                // Which filter is in effect is otherwise carried by the fill
                // colour alone, so a screen-reader user hears a list of
                // identical buttons and cannot tell a filtered result set from
                // a broken one (WCAG 1.4.1, 4.1.2 — #186).
                aria-pressed={selectedCategory === null}
                className="w-full text-left flex min-h-11 items-center px-3 py-1.5 rounded text-sm transition-colors font-semibold"
                style={selectedCategory === null ? { backgroundColor: 'var(--bp)', color: 'var(--bp-ink)' } : { color: '#475569' }}
                onMouseEnter={(e) => { if (selectedCategory !== null) (e.currentTarget as HTMLElement).style.backgroundColor = '#f1f5f9' }}
                onMouseLeave={(e) => { if (selectedCategory !== null) (e.currentTarget as HTMLElement).style.backgroundColor = '' }}
              >
                {t('allProducts', lang)}
              </button>
            </li>
            {categories.map((cat) => (
              <li key={cat.id}>
                <button
                  onClick={() => setSelectedCategory(cat.id === selectedCategory ? null : cat.id)}
                  aria-pressed={selectedCategory === cat.id}
                  className="w-full text-left flex min-h-11 items-center px-3 py-1.5 rounded text-sm transition-colors"
                  style={selectedCategory === cat.id ? { backgroundColor: 'var(--bp)', color: 'var(--bp-ink)', fontWeight: 600 } : { color: '#475569' }}
                  onMouseEnter={(e) => { if (selectedCategory !== cat.id) (e.currentTarget as HTMLElement).style.backgroundColor = '#f1f5f9' }}
                  onMouseLeave={(e) => { if (selectedCategory !== cat.id) (e.currentTarget as HTMLElement).style.backgroundColor = '' }}
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
            aria-busy={loading}
          >
            {/* "500+" rather than "500" once the count hit its cap: the
                number is a floor there, and a bare figure claims a precision
                the server did not spend the work to have (#236). */}
            {loading || error
              ? ''
              : products.length < total
                ? `${products.length} / ${total}${totalIsExact ? '' : '+'} ${t('products', lang)}`
                : `${total}${totalIsExact ? '' : '+'} ${t('products', lang)}`}
          </span>
        </div>

        {/* Favourites shortcut. Hidden entirely when empty rather than shown as
            an empty shelf, and suppressed while searching or filtering so it
            cannot contradict the result set below it. */}
        {favoriteCards.length > 0 && !search && selectedCategory === null && (
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
              onClick={() => setSelectedCategory(null)}
              aria-pressed={selectedCategory === null}
              className="inline-flex min-h-11 items-center rounded-full px-4 py-1 text-sm font-medium transition-colors"
              style={selectedCategory === null ? { backgroundColor: 'var(--bp)', color: 'var(--bp-ink)' } : { backgroundColor: '#f1f5f9', color: '#475569' }}
            >
              {t('all', lang)}
            </button>
            {categories.map((cat) => (
              <button
                key={cat.id}
                onClick={() => setSelectedCategory(cat.id === selectedCategory ? null : cat.id)}
                aria-pressed={selectedCategory === cat.id}
                className="inline-flex min-h-11 items-center rounded-full px-4 py-1 text-sm font-medium transition-colors"
                style={selectedCategory === cat.id ? { backgroundColor: 'var(--bp)', color: 'var(--bp-ink)' } : { backgroundColor: '#f1f5f9', color: '#475569' }}
              >
                {cat.name}
              </button>
            ))}
          </div>
        )}

        {loading ? (
          <LoadingRegion label={t('loading', lang)}>
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-4">
              {Array.from({ length: 8 }).map((_, i) => <SkeletonCard key={i} />)}
            </div>
          </LoadingRegion>
        ) : error ? (
          <div className="text-center py-20 bg-white rounded-lg border border-slate-200">
            <p className="font-semibold text-slate-700">{t('somethingWentWrong', lang)}</p>
            <button
              onClick={() => load()}
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
              <button onClick={() => setSearch('')} className="text-sm mt-2 inline-flex min-h-11 items-center hover:underline" style={{ color: 'var(--bp-text)' }}>
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
