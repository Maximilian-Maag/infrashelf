import { auth } from '@/lib/auth'
import { redirect } from 'next/navigation'
import type { Category, CatalogPage as CatalogPageData, FavoriteProduct } from '@infrashelf/types'
import { get } from '@/lib/serverApi'
import { section } from '@/lib/section'
import { getLang } from '@/lib/getLang'
import { CatalogBrowser } from './CatalogBrowser'
import { catalogQuery, parseCategory } from './query'

// The search term and the category live in the URL (#472), so every distinct
// query is its own render — nothing here may be cached across them.
export const dynamic = 'force-dynamic'

/**
 * How long the category filter may keep the catalogue waiting.
 *
 * Generous, because this is not a latency budget — a slow answer still produces
 * a working filter and is worth having. It is the bound past which "slow" stops
 * being a possible explanation, and beyond which the shop is better off drawn
 * without its filter than not drawn at all.
 *
 * It matters MORE here than it did in the browser. `allSettled` makes a category
 * rejection harmless, but a request that is accepted and then never answered is
 * not a rejection: `fetch` has no timeout, the promise stays pending, and the
 * `await` never returns. In the browser that left the shop on its skeleton; on
 * the server it leaves the shopper on a blank response with the products already
 * read and nothing rendered. Raised by CodeRabbit on #324, and carried across.
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

const first = (raw: string | string[] | undefined) => (Array.isArray(raw) ? raw[0] : raw)

interface Props {
  searchParams: Promise<Record<string, string | string[] | undefined>>
}

export default async function CatalogPage({ searchParams }: Props) {
  const session = await auth()
  if (!session) redirect('/login')

  const lang = await getLang()
  const params = await searchParams
  // The search box is in the header, which navigates here with `q`.
  const search = first(params.q)?.trim() ?? ''
  const categoryId = parseCategory(first(params.category))

  /*
   * `allSettled`, not `all`: the products are what this page IS, and the other
   * two only decorate them. Joined by `Promise.all` these shared one fate, and a
   * 403 on the categories put the whole shop behind the error state with a
   * perfectly good page of products in hand — which is exactly how this page
   * looked to every non-root account (#323). The filter is worth degrading; the
   * catalogue is not.
   */
  const [pageRes, catsRes, favsRes] = await Promise.allSettled([
    get<CatalogPageData>(catalogQuery({ lang, search, categoryId, offset: 0 })),
    get<Category[]>('/api/admin/categories', deadline(CATEGORIES_TIMEOUT_MS)),
    // Same language as the cards: the shelf renders product names.
    get<FavoriteProduct[]>(`/api/favorites?lang=${lang}`),
  ])

  /*
   * A rejected list is NOT an empty shop, and it carries the reason (#415).
   * `section` also rethrows the redirect an ended session throws from inside
   * `get`, which this `allSettled` would otherwise collect as a failed shelf
   * (#427).
   */
  const list = section<CatalogPageData | null>(pageRes, null, 'catalog')
  // Degrade, both of them, and independently: an unpopulated filter is still a
  // working shop, and a favourites outage costs the stars rather than the
  // catalogue. Logged server-side rather than shown, which is what `section`
  // is for.
  const categories = section(catsRes, [] as Category[], 'catalog categories').data
  const favorites = section(favsRes, [] as FavoriteProduct[], 'favorites').data

  return (
    <CatalogBrowser
      lang={lang}
      initialPage={list.data}
      error={list.error}
      categories={categories}
      initialFavorites={favorites}
      search={search}
      categoryId={categoryId}
    />
  )
}
