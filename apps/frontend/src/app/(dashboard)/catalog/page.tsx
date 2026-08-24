'use client'

import { useState, useEffect, useCallback, useRef } from 'react'
import { useSession } from 'next-auth/react'
import { useSearchParams } from 'next/navigation'
import type { Product, Category, CatalogPage as CatalogPageData, FavoriteProduct } from '@open-hybrid-cloud/types'
import { get, put, del } from '@/lib/api'
import { t } from '@/lib/i18n'
import { useLang } from '@/lib/useLang'
import { SkeletonCard } from '@/components/ui/Skeleton'
import { ProductCard } from './ProductCard'

/** One screenful of cards. The endpoint caps what it will serve at 100. */
const PAGE_SIZE = 24

/** How long to wait after a keystroke before asking the database (#91). */
const SEARCH_DEBOUNCE_MS = 300

export default function CatalogPage() {
  const { data: session } = useSession()
  const token = (session as unknown as { apiToken?: string })?.apiToken
  const searchParams = useSearchParams()
  const lang = useLang()

  const [products, setProducts] = useState<Product[]>([])
  // Matches for the current filters, which is more than the page in hand.
  const [total, setTotal] = useState(0)
  const [categories, setCategories] = useState<Category[]>([])
  const [search, setSearch] = useState(searchParams.get('q') ?? '')
  const [selectedCategory, setSelectedCategory] = useState<number | null>(null)
  const [loading, setLoading] = useState(true)
  const [loadingMore, setLoadingMore] = useState(false)
  const [error, setError] = useState(false)
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
      if (!token) return
      get<FavoriteProduct[]>(`/api/favorites?lang=${lang}`, token)
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
    [token, lang],
  )

  const load = useCallback(async () => {
    if (!token) return
    // Claimed before the request goes out, so a response can tell whether it
    // is still the newest one asked for by the time it comes back.
    const generation = ++loadGeneration.current
    setLoading(true)
    setError(false)
    try {
      const [page, cats] = await Promise.all([
        get<CatalogPageData>(pageUrl(0), token),
        get<Category[]>('/api/admin/categories', token),
      ])
      // A newer load has started since this one went out (another category
      // click, or the debounced search firing) — its answer belongs to a
      // filter that is no longer selected, so it must not overwrite what the
      // newer request will (or already did) produce (#138).
      if (loadGeneration.current !== generation) return
      setProducts(page?.items ?? [])
      setTotal(page?.total ?? 0)
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
  }, [token, pageUrl, loadFavorites])

  useEffect(() => { void load() }, [load])

  /**
   * The next page, appended.
   *
   * Offset by what is already held rather than by a page number: the two agree
   * while nothing changes underneath, and when something does, "carry on from
   * what I have" is the more defensible of the two.
   */
  const loadMore = async () => {
    if (!token || loadingMore) return
    setLoadingMore(true)
    try {
      const page = await get<CatalogPageData>(pageUrl(products.length), token)
      setProducts((prev) => [...prev, ...(page?.items ?? [])])
      setTotal(page?.total ?? 0)
    } catch {
      // Keep what is on screen; the button stays available for another go.
    } finally {
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
    if (!token || favoriteBusy.has(productId)) return
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
      if (wasFavorited) await del(`/api/favorites/${productId}`, token)
      else await put(`/api/favorites/${productId}`, {}, token)
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

  const renderCard = (product: {
    id: number
    categoryId: number
    name: string
    description: string
    imageAlt?: string | null
  }) => (
    <ProductCard
      key={product.id}
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
          <h3 className="font-bold text-xs text-slate-500 mb-3 uppercase tracking-wide">{t('categories', lang)}</h3>
          <ul className="space-y-1">
            <li>
              <button
                onClick={() => setSelectedCategory(null)}
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
        {/* Favourites shortcut. Hidden entirely when empty rather than shown as
            an empty shelf, and suppressed while searching or filtering so it
            cannot contradict the result set below it. */}
        {favoriteCards.length > 0 && !search && selectedCategory === null && (
          <section className="mb-6" aria-labelledby="favorites-heading">
            <h2 id="favorites-heading" className="text-xl font-bold text-slate-800 mb-3">
              {t('myFavorites', lang)}
            </h2>
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-4">
              {favoriteCards.map(renderCard)}
            </div>
          </section>
        )}

        <div className="mb-4 flex items-center justify-between flex-wrap gap-2">
          <div>
            {search ? (
              <h2 className="text-xl font-bold text-slate-800">
                {t('resultsFor', lang)}: <span style={{ color: 'var(--bp-text)' }}>&ldquo;{search}&rdquo;</span>
              </h2>
            ) : (
              <>
                <h2 className="text-xl font-bold text-slate-800">{t('productCatalog', lang)}</h2>
                <p className="text-sm text-slate-500 mt-0.5">{t('productCatalogSubtitle', lang)}</p>
              </>
            )}
          </div>
          {total > 0 && (
            <span className="text-sm text-slate-500">
              {products.length < total
                ? `${products.length} / ${total} ${t('products', lang)}`
                : `${total} ${t('products', lang)}`}
            </span>
          )}
        </div>

        {/* Mobile category pills */}
        {categories.length > 0 && (
          <div className="flex flex-wrap gap-2 mb-4 md:hidden">
            <button
              onClick={() => setSelectedCategory(null)}
              className="inline-flex min-h-11 items-center rounded-full px-4 py-1 text-sm font-medium transition-colors"
              style={selectedCategory === null ? { backgroundColor: 'var(--bp)', color: 'var(--bp-ink)' } : { backgroundColor: '#f1f5f9', color: '#475569' }}
            >
              {t('all', lang)}
            </button>
            {categories.map((cat) => (
              <button
                key={cat.id}
                onClick={() => setSelectedCategory(cat.id === selectedCategory ? null : cat.id)}
                className="inline-flex min-h-11 items-center rounded-full px-4 py-1 text-sm font-medium transition-colors"
                style={selectedCategory === cat.id ? { backgroundColor: 'var(--bp)', color: 'var(--bp-ink)' } : { backgroundColor: '#f1f5f9', color: '#475569' }}
              >
                {cat.name}
              </button>
            ))}
          </div>
        )}

        {loading ? (
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-4">
            {Array.from({ length: 8 }).map((_, i) => <SkeletonCard key={i} />)}
          </div>
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
            <p className="font-semibold text-slate-500">{t('noProducts', lang)}</p>
            {search && (
              <button onClick={() => setSearch('')} className="text-sm mt-2 inline-flex min-h-11 items-center hover:underline" style={{ color: 'var(--bp-text)' }}>
                ← {t('allProducts', lang)}
              </button>
            )}
          </div>
        ) : (
          <>
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-4">
              {products.map(renderCard)}
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
              </div>
            )}
          </>
        )}
      </div>
    </div>
  )
}
