import { redirect } from 'next/navigation'
import { auth } from '@/lib/auth'
import { apiRequest, ApiError } from '@/lib/api'
import { expiredLoginUrl } from '@/lib/session'

/**
 * The API, called from the server with the signed-in caller's token.
 *
 * Two modules rather than one, and the split is not cosmetic. `lib/api.ts` is in
 * the CLIENT bundle — every client component imports it — so anything it
 * imports goes to the browser too. Reading the session from there, even behind a
 * `typeof window` check and a dynamic `import()`, put the whole NextAuth server
 * configuration into the built client chunks; the strings `auth/login/mfa` and
 * `NEXTAUTH_SECRET` were in them. Nothing secret leaked (Next does not inline a
 * non-`NEXT_PUBLIC_` env value into a client bundle), but shipping the auth
 * config to the browser is not something to do on purpose.
 *
 * So: server components import `get` from here, client components import it from
 * `@/lib/api`, and the browser reaches the same endpoints through `/api/proxy`,
 * which attaches the token server-side.
 *
 * Two modules read `session.apiToken`, and only two: this one, and the proxy
 * route that stands in for it on the browser's behalf. Both run server-side.
 * That pair is the security boundary issue #146 closed — widening it is what
 * puts the token back within reach of client JavaScript.
 */
const bearer = async (): Promise<string | undefined> => {
  if (typeof window !== 'undefined') {
    // A backstop, and worth being honest about what it can and cannot do. It
    // cannot prevent the bundling: `@/lib/auth` is a static import at the top of
    // this file, so a client component importing this module has already pulled
    // the auth config into the browser bundle at BUILD time, long before this
    // line runs. What it does is make the mistake fail loudly at runtime instead
    // of working by accident.
    //
    // The thing that actually holds the boundary is that no client component
    // imports this module, and that is checked rather than hoped for:
    // `server_only_module_not_in_client` in policy/routes.rego denies a file
    // carrying 'use client' that imports it.
    throw new Error('lib/serverApi is server-only — client code must use lib/api')
  }
  const session = await auth()
  return (session as { apiToken?: string } | null)?.apiToken
}

/**
 * A 401 on the server means the session is over — so end it here too (#427).
 *
 * `lib/session.ts` says this already: "anything that ends a session early — a
 * revoked session (#37), a rotated signing secret, clock skew — shows up as a
 * 401, and lib/api.ts turns a 401 into a sign-out and a trip to
 * /login?expired=1". That was only ever true in the BROWSER. `endExpiredSession`
 * returns immediately when there is no `window`, on the stated grounds that "the
 * middleware and the dashboard layout have already made this decision" — and for
 * a revoked session they have not. The middleware checks the cookie, which is
 * valid; the layout checks the token's `exp`, which has not passed. Neither can
 * see that the session row was revoked.
 *
 * So a signed-out user pressing Back reached a dashboard page that fetched a 401
 * and threw it at the error boundary: HTTP 500, on the way out of a shared
 * device, instead of the login screen. `signout.spec` saw it as "the session
 * survived the sign-out", because the URL never left /orders.
 *
 * `redirect()` throws, which is how Next signals it. Two consequences:
 *   - it must not be caught. `lib/section.ts` rethrows it explicitly, and any new
 *     `try` around a server fetch has to do the same.
 *   - `expiredLoginUrl('/')` rather than the current path, matching the dashboard
 *     layout's own expiry redirect: a server component cannot see the request's
 *     URL without threading it down, and sending someone back to the page that
 *     just refused them is not obviously right anyway.
 */
const endSessionOn401 = async <T>(call: Promise<T>): Promise<T> => {
  try {
    return await call
  } catch (e) {
    if (e instanceof ApiError && e.status === 401) redirect(expiredLoginUrl('/'))
    throw e
  }
}

export const get = async <T>(path: string) =>
  endSessionOn401(apiRequest<T>(path, { token: await bearer() }))

export const post = async <T>(path: string, body: unknown) =>
  endSessionOn401(apiRequest<T>(path, { method: 'POST', body, token: await bearer() }))

export const put = async <T>(path: string, body: unknown) =>
  endSessionOn401(apiRequest<T>(path, { method: 'PUT', body, token: await bearer() }))

export const del = async <T>(path: string) =>
  endSessionOn401(apiRequest<T>(path, { method: 'DELETE', token: await bearer() }))
