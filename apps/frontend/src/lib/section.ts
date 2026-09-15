import { unstable_rethrow } from 'next/navigation'
import { ApiError } from '@/lib/api'

/**
 * One panel of a page that is allowed to fail on its own (#415).
 *
 * `Promise.allSettled` is the right combinator for a page whose sections are
 * independent — one failed panel should not blank the others. What it does not
 * do is keep the REASON. Every page built this way wrote the same line:
 *
 *     const products = res.status === 'fulfilled' ? (res.value ?? []) : []
 *
 * and with it, a 500, a 401, a timeout and a backend that is still starting all
 * render as an empty table. "No products exist" and "the request for products
 * failed" are different facts with different fixes, and the screen said the
 * first for both — alarming in the wrong direction for an operator, and for e2e
 * a transient failure that surfaces as `element(s) not found` with nothing in
 * the job log. This is the same class as #399: the combinator that tolerates a
 * failure also eats the reason for it.
 *
 * `error` is deliberately the TECHNICAL reason and is not translated. The
 * sentence a user reads comes from `t('unexpectedError')` in `SectionError`;
 * this is the part an operator quotes into a bug report, and a localised
 * `Bad Gateway` helps nobody diagnose anything.
 */
export interface Section<T> {
  data: T
  /** `HTTP 502: Bad Gateway`, or `null` when the section loaded. */
  error: string | null
}

const describe = (reason: unknown): string => {
  if (reason instanceof ApiError) return `HTTP ${reason.status}: ${reason.message}`
  if (reason instanceof Error) return reason.message
  return String(reason)
}

/**
 * Turn a settled result into the section's data plus its reason for failing.
 *
 * `what` names the section in the server log — the third thing the issue asks
 * for, so that a failure a user reloads past still leaves a trace. Server-side
 * only: these helpers are called from server components, where `console.error`
 * reaches the container log rather than a browser console nobody is watching.
 */
export const section = <T>(
  result: PromiseSettledResult<T | null | undefined>,
  fallback: T,
  what: string,
): Section<T> => {
  if (result.status === 'fulfilled') {
    return { data: result.value ?? fallback, error: null }
  }
  /*
   * A `redirect()` is not a failed section (#427).
   *
   * Next signals `redirect()` and `notFound()` by THROWING, so an ended session
   * arrives here looking exactly like a 500 — and turning it into a red banner
   * would swallow the navigation and leave a signed-out user on the page that
   * refused them. This is the hazard `lib/api.ts` names: "redirect() from inside
   * a fetch helper would be swallowed by the very Promise.allSettled that hid
   * the problem in the first place". It is only not swallowed because of this
   * line.
   */
  unstable_rethrow(result.reason)
  const error = describe(result.reason)
  console.error(`[page] could not load ${what}: ${error}`)
  return { data: fallback, error }
}
