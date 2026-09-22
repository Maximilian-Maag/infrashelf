import { NextResponse, type NextRequest } from 'next/server'
import type { Result } from '@/lib/services/result'

export const toResponse = <T>(result: Result<T>, successStatus = 200): NextResponse =>
  result.ok
    ? NextResponse.json(result.data ?? { success: true }, { status: successStatus })
    : NextResponse.json(
        // `code` is spelled out through the spread rather than set to undefined,
        // so a refusal that carries one is the only shape that changes. A client
        // switching on it is asking "is this the refusal I can answer", and an
        // absent key answers that the same way `undefined` does (#509).
        { error: result.message, ...(result.code ? { code: result.code } : {}) },
        { status: result.status },
      )

/**
 * A path segment as a positive database id, or null if it is not one.
 *
 * `parseInt` is the wrong tool for a route parameter: it reads a leading number
 * and discards the rest, so `/products/1abc/image` and `/products/1.5/image`
 * both resolve to product 1 and quietly act on a record the caller never asked
 * for. Digits only, then a safe-integer check so an id beyond 2^53 cannot
 * silently become a different number.
 */
export const parseRouteId = (raw: string): number | null => {
  if (!/^\d+$/.test(raw)) return null
  const id = Number(raw)
  return Number.isSafeInteger(id) && id > 0 ? id : null
}

/**
 * The 400 a route returns for a path segment that is not an id.
 *
 * Exists so adopting `parseRouteId` at the ~45 sites that still used `parseInt`
 * costs two lines each and they all answer alike. `what` names the segment, so
 * `/api/products/1abc/webhooks/x` says which of the two ids was wrong.
 */
export const invalidId = (what = 'id'): NextResponse =>
  NextResponse.json({ error: `Invalid ${what}` }, { status: 400 })

/**
 * The languages this deployment can have translation rows for.
 *
 * The same 25 as `SUPPORTED_LANGUAGES` in the frontend's `lib/i18n.ts` and as
 * `LANGUAGES` in `lib/ai/index.ts`.
 */
const SUPPORTED_LANGUAGES = new Set([
  'bg', 'cs', 'da', 'de', 'el', 'en', 'es', 'et', 'fi', 'fr', 'ga', 'hr', 'hu',
  'it', 'lt', 'lv', 'mt', 'nl', 'pl', 'pt', 'ro', 'ru', 'sk', 'sl', 'sv',
])

/**
 * The language to render product text in for this request.
 *
 * `?lang=xx`, validated against the languages that can actually have a
 * translation row, falling back to English. Validating matters less for safety
 * than for honesty: the value is a bound parameter, so an unknown code is not a
 * SQL problem — it just silently misses every row and lands on the English arm
 * of the fallback chain, which reads as a translation gap rather than as a typo
 * in a URL.
 *
 * Every read path that renders a product name takes one of these. Nine of them
 * hardcoded `'en'`, which is how a German user came to see their own cart, order
 * history and approvals queue in English (#162).
 */
export const requestLang = (req: NextRequest): string => {
  const requested = new URL(req.url).searchParams.get('lang')
  return requested && SUPPORTED_LANGUAGES.has(requested) ? requested : 'en'
}
