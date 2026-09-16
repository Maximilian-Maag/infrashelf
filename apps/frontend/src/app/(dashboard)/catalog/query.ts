/**
 * The catalogue's query string, in one place.
 *
 * The page asks for the first window while it renders on the server; the browser
 * asks for the next one when "load more" is pressed. Two callers, one shape —
 * and they must agree, because the second continues the first: a search or a
 * category spelled differently between them would append rows from a different
 * query onto the grid in hand (#472).
 *
 * Not a client module and not a server one: plain functions, imported by both.
 */

/** One screenful of cards. The endpoint caps what it will serve at 100. */
export const PAGE_SIZE = 24

export interface CatalogQuery {
  lang: string
  /** The search term, or '' for none. Already trimmed by whoever read the URL. */
  search: string
  categoryId: number | null
  offset: number
}

export const catalogQuery = ({ lang, search, categoryId, offset }: CatalogQuery): string => {
  const params = new URLSearchParams({
    lang,
    limit: String(PAGE_SIZE),
    offset: String(offset),
  })
  if (search) params.set('search', search)
  if (categoryId !== null) params.set('categoryId', String(categoryId))
  return `/api/catalog?${params.toString()}`
}

/**
 * `?category=` as an id, or null.
 *
 * Decimal digits and nothing else. The backend refuses `categoryId=abc` with a
 * 400 rather than ignoring it — "your filter matched everything" being the more
 * misleading answer — and this page would rather show the whole catalogue than
 * an error over a URL somebody trimmed by hand, so anything unreadable is simply
 * no filter.
 */
export const parseCategory = (raw: string | undefined): number | null => {
  if (!raw || !/^\d+$/.test(raw)) return null
  const value = Number(raw)
  return Number.isSafeInteger(value) && value > 0 ? value : null
}
