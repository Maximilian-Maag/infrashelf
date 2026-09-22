import { expiredLoginUrl } from '@/lib/session'

/**
 * Only the SERVER branch below uses this now, so it prefers the server-reachable
 * URL — the same order `(dashboard)/layout.tsx` and the login-challenge route
 * already use. It used to serve both sides and had the precedence the other way
 * round, which in Docker meant the frontend container calling the address the
 * BROWSER reaches the API at. The browser no longer comes through here at all:
 * it goes to PROXY_PREFIX on this origin (#146).
 */
const API_URL = process.env.API_URL ?? process.env.NEXT_PUBLIC_API_URL ?? ''

/**
 * Where the browser sends an API call: this origin, never the API host.
 *
 * The backend JWT used to be handed to client JavaScript so it could set its own
 * Authorization header — readable from `/api/auth/session` and serialised into
 * every dashboard page's RSC payload as a `token={token}` prop. Any XSS on this
 * origin therefore bought 24 hours of full API access as that user, replayable
 * from anywhere, because a bearer token is not bound to an origin (issue #146).
 *
 * Now the browser sends the NextAuth session cookie — HttpOnly, so script cannot
 * read it — and `app/api/proxy/[...path]/route.ts` attaches the Authorization
 * header on the server. See that file for what the proxy will and will not do.
 */
export const PROXY_PREFIX = '/api/proxy'

/**
 * Which of the two ways to reach the API this call takes.
 *
 * On the server the API is called directly with the bearer token, because there
 * it is not a leak — it never crosses the wire to a browser. In the browser it
 * goes through this origin's proxy with no token at all.
 *
 * Checked at call time rather than at module load, because this module is
 * imported by server components and client components alike. Client components
 * are server-RENDERED too, so the browser branch has to be the one that is safe
 * when it is wrong — and it is, because it sends no credential of its own.
 * Nothing here fetches during render in any case: client components load in
 * `useEffect` or in an event handler.
 */
const inBrowser = (): boolean => typeof window !== 'undefined'

type RequestOptions = {
  method?: string
  body?: unknown
  isFormData?: boolean
  /**
   * SERVER ONLY, and set in exactly one place: `lib/serverApi.ts`, which reads it
   * from the session. It is not on `get`/`post`/`put`/`del`, so client code has
   * no way to reach it — and no token to put in it, which is the point of #146.
   * Ignored outright in the browser branch below.
   *
   * This module cannot fetch the token itself, however tempting: it is in the
   * CLIENT bundle, and importing `@/lib/auth` from here — even dynamically —
   * drags the whole NextAuth server configuration into it. That was measured,
   * not assumed: the built chunks carried `auth/login/mfa` and the auth config
   * until this was split out.
   */
  token?: string
  /**
   * Abort this request.
   *
   * `fetch` has no timeout of its own: a connection that is accepted and then
   * says nothing leaves the promise pending for ever, and a caller that
   * `await`s it never runs its `finally`. A rejection a caller can handle is
   * always recoverable; a promise that never settles is not, which is why the
   * caller has to be able to put a bound on it.
   */
  signal?: AbortSignal
}

export class ApiError extends Error {
  constructor(
    public readonly status: number,
    message: string,
    /**
     * The backend's machine-readable refusal code, when it sent one (#509).
     *
     * The message is what to show; this is what to ACT on. Two refusals that need
     * different handling arrive as the same 409 with different prose, and a UI that
     * branches on the sentence breaks silently the first time somebody rewords it.
     */
    public readonly code?: string,
  ) {
    super(message)
  }
}

/**
 * Set once a sign-out is under way.
 *
 * A dead token fails every in-flight request at once — a page fetches half a
 * dozen things in parallel — and without this each 401 would start its own
 * sign-out and the redirects would race.
 */
let endingSession = false

/**
 * A 401 means the session is over, not that this one request was unlucky.
 *
 * Before this, every caller decided for itself: server components turned the
 * rejection into an empty list (`Promise.allSettled` → `[]`), client components
 * showed whatever error text they had, and the user sat on a page that looked
 * logged in with no data and no way out but finding the sign-out item in a menu
 * (#103).
 *
 * Only the browser acts here. On the server the middleware and the dashboard
 * layout have already made this decision, and `redirect()` from inside a fetch
 * helper would be swallowed by the very `Promise.allSettled` that hid the
 * problem in the first place.
 */
const endExpiredSession = async (): Promise<void> => {
  if (typeof window === 'undefined') return
  if (endingSession) return
  // Already on the login page: signing out again would loop.
  if (window.location.pathname === '/login') return

  endingSession = true
  // Imported here, not at module scope: this module is used by server components
  // too, and `next-auth/react` is a client library.
  const { signOut } = await import('next-auth/react')
  // The other way a session ends. Same reason as the menu item: the caches must
  // not survive it (#148). Imported here for the same reason `signOut` is —
  // this module is reachable from server components.
  const { clearServiceWorkerCaches } = await import('@/lib/serviceWorker')
  /*
   * Guarded, and here it matters more than on the menu item (#359).
   *
   * `endingSession` latches to stop a burst of 401s each starting a sign-out,
   * so a throw on this line would not merely skip one redirect — it would leave
   * the latch set and every later expiry silently do nothing, for the life of
   * the page. Cache-clearing is best-effort; ending the session is not.
   */
  try {
    await clearServiceWorkerCaches()
  } catch {
    // Tidiness failed. The session still has to end.
  }
  await signOut({ redirectTo: expiredLoginUrl(window.location.pathname) })
}

export const apiRequest = async <T>(
  path: string,
  { method = 'GET', body, isFormData = false, token, signal }: RequestOptions = {},
): Promise<T> => {
  const browser = inBrowser()
  const headers: Record<string, string> = {}
  // Never in the browser, whatever was passed. A token reaching client code is
  // the bug this whole change exists to prevent, so the browser branch does not
  // send one even if one somehow arrives here (#146).
  if (token && !browser) headers['Authorization'] = `Bearer ${token}`
  if (body && !isFormData) headers['Content-Type'] = 'application/json'

  const res = await fetch(`${browser ? PROXY_PREFIX : API_URL}${path}`, {
    method,
    headers,
    body: isFormData ? (body as FormData) : body ? JSON.stringify(body) : undefined,
    cache: 'no-store',
    signal,
  })

  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: res.statusText }))
    if (res.status === 401) await endExpiredSession()
    // Read as a string rather than cast: the body comes from over there, and a
    // `code` that is not a string is a code no caller can switch on safely.
    throw new ApiError(res.status, err.error ?? res.statusText, typeof err.code === 'string' ? err.code : undefined)
  }

  if (res.status === 204) return undefined as T
  return res.json()
}

export const get = <T>(path: string, signal?: AbortSignal) => apiRequest<T>(path, { signal })

export const post = <T>(path: string, body: unknown) =>
  apiRequest<T>(path, { method: 'POST', body })

export const put = <T>(path: string, body: unknown) =>
  apiRequest<T>(path, { method: 'PUT', body })

// PATCH for a request that acts on a resource without replacing it — the
// holiday feed's preview and refresh, which change nothing about the
// representation a PUT would send (#330).
export const patch = <T>(path: string, body: unknown) =>
  apiRequest<T>(path, { method: 'PATCH', body })

/**
 * `signal` for the same reason `get` has one: a caller that must not hang.
 *
 * The sign-out menu revokes this session before ending it, and a `catch` is no
 * defence against a connection that is accepted and then says nothing — the
 * promise simply never settles, which is exactly how #359 turned the only
 * sign-out affordance in the app into a button that did nothing.
 */
export const del = <T>(path: string, signal?: AbortSignal) =>
  apiRequest<T>(path, { method: 'DELETE', signal })
