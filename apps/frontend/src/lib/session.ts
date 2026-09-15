/**
 * When the backend session dies, and how everything finds out.
 *
 * Two clocks used to run independently: the NextAuth cookie (30 days by default)
 * and the backend JWT it carries as `apiToken` (24 h, see the backend's
 * `lib/auth/jwt.ts`). For the 29 days in between, the cookie said "signed in"
 * while every API call came back 401 — a page that looks logged in, holds no
 * data, and explains nothing (issue #103).
 *
 * #103 pinned the two together with one shared constant. #37 took that constant
 * away: a session's lifetime is now a per-session decision — 8 h normally, 30 days
 * with "remember me" — so no single number can describe every session, and a
 * session can also end early because someone revoked it.
 *
 * What replaces the shared constant is stricter, not looser:
 *
 *  - `SESSION_COOKIE_MAX_AGE_SECONDS` sizes the cookie to the longest session the
 *    backend will ever issue. It is a ceiling, not a promise.
 *  - The exact end of *this* session travels on the session itself, as the
 *    token's own `exp` (`apiTokenExp`), and the middleware and the dashboard
 *    layout refuse to render past it. That is per-session and exact, which the
 *    shared constant never was.
 *  - Anything that ends a session early — a revoked session (#37), a rotated
 *    signing secret, clock skew — shows up as a 401, and a 401 turns into a
 *    sign-out and a trip to `/login?expired=1`. In the browser that is
 *    `lib/api.ts`; on the server it is `lib/serverApi.ts`, which had to be
 *    taught it (#427). This comment used to name only the first and imply the
 *    second was covered by the middleware and the dashboard layout — and for a
 *    REVOKED session neither of them can be: the cookie is valid and the token's
 *    `exp` has not passed, so both wave it through and only the backend knows.
 *    The result was a 500 where the login screen belonged.
 *
 * So the failure mode #103 fixed cannot return: the cookie outliving a short
 * session is exactly the case `isApiTokenExpired` is checked for on every
 * request.
 */

/**
 * Lifetime of an ordinary session, in seconds.
 *
 * Mirrors `DEFAULT_SESSION_TTL_SECONDS` in the backend's `lib/auth/sessions.ts`.
 * Nothing here enforces it — the backend decides, and the token says so — but the
 * two must not disagree, because this is the number the UI quotes.
 */
export const DEFAULT_SESSION_MAX_AGE_SECONDS = 8 * 60 * 60

/**
 * Lifetime of a "remember me" session, in seconds. The maximum the backend will
 * issue; mirrors `REMEMBER_ME_SESSION_TTL_SECONDS`.
 */
export const REMEMBER_ME_SESSION_MAX_AGE_SECONDS = 30 * 24 * 60 * 60

/**
 * How long the NextAuth cookie is allowed to live.
 *
 * The ceiling, because one static config value has to cover both lifetimes and a
 * cookie that expired before its session would sign a "remember me" user out
 * after 8 h — the same class of bug as #103, in the other direction. A cookie that
 * outlives its session is caught on every request by `isApiTokenExpired`.
 */
export const SESSION_COOKIE_MAX_AGE_SECONDS = REMEMBER_ME_SESSION_MAX_AGE_SECONDS

/**
 * Seconds of slack before an `exp` counts as past.
 *
 * A token with two seconds left is not worth starting a page render with, and a
 * little clock skew between the frontend and backend containers should not be the
 * difference between a rendered page and a 401.
 */
const EXPIRY_SKEW_SECONDS = 30

/**
 * The `exp` claim of a JWT, without verifying it.
 *
 * Deliberately unverified: this is our own token on its way back to the backend,
 * which validates it properly on every request. Reading the claim here only
 * decides whether it is worth trying — treating it as an authority would be a
 * mistake, treating it as a hint is what stops the pointless 401.
 *
 * Uses `atob` rather than `Buffer`, because the middleware runs in the Edge
 * runtime where `Buffer` does not exist.
 */
export const apiTokenExpiry = (token: string): number | null => {
  const payload = token.split('.')[1]
  if (!payload) return null
  try {
    const base64 = payload.replace(/-/g, '+').replace(/_/g, '/')
    const padded = base64.padEnd(base64.length + ((4 - (base64.length % 4)) % 4), '=')
    const claims: unknown = JSON.parse(atob(padded))
    const exp = (claims as { exp?: unknown }).exp
    return typeof exp === 'number' && Number.isFinite(exp) ? exp : null
  } catch {
    // A token we cannot read is not a token we should act on: say "no expiry
    // known" and let the backend be the one to reject it.
    return null
  }
}

/**
 * Is this session's backend token past its expiry?
 *
 * `undefined`/`null` means "no expiry recorded" — a session issued before this
 * existed, or a token whose claims could not be read. Those are treated as *not*
 * expired on purpose: the backend still gets to decide, and the 401 path catches
 * it. Guessing "expired" here would sign people out of working sessions.
 */
export const isApiTokenExpired = (exp: number | null | undefined, nowMs: number = Date.now()): boolean =>
  typeof exp === 'number' && exp * 1000 <= nowMs + EXPIRY_SKEW_SECONDS * 1000

/** Where an ended session sends you, keeping the way back. */
export const expiredLoginUrl = (pathname: string): string => {
  const params = new URLSearchParams({ expired: '1' })
  if (pathname && pathname !== '/login') params.set('callbackUrl', pathname)
  return `/login?${params.toString()}`
}
