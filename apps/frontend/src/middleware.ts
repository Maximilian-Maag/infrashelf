import { auth } from '@/lib/auth'
import { NextResponse } from 'next/server'
import { isApiTokenExpired } from '@/lib/session'

export default auth((req) => {
  // Two reasons to send someone to the login page, and they read differently to
  // the person: never signed in, versus signed in and the session ran out. The
  // second used to have no handling at all — the page rendered, every API call
  // came back 401, and the user was left on a shell with no data and no
  // explanation (#103).
  const expired = isApiTokenExpired(req.auth?.apiTokenExp)

  if (!req.auth || expired) {
    const loginUrl = new URL('/login', req.url)
    loginUrl.searchParams.set('callbackUrl', req.nextUrl.pathname)
    if (expired) loginUrl.searchParams.set('expired', '1')
    return NextResponse.redirect(loginUrl)
  }

  // An administrator who owes a second factor goes to the one page where they can
  // set one up (issue #197). This is a convenience, not the control: the backend
  // refuses every route except the enrollment endpoints for such a session, so
  // skipping this redirect gains nothing but a 403.
  //
  // /settings is excluded or the redirect would loop, and /api is excluded
  // because these are the frontend's own routes — sending a `fetch` to an HTML
  // page is how #36 turned every sign-in into "invalid credentials".
  if (
    req.auth.mustEnrollSecondFactor &&
    !req.nextUrl.pathname.startsWith('/settings') &&
    !req.nextUrl.pathname.startsWith('/api')
  ) {
    const setup = new URL('/settings', req.url)
    setup.searchParams.set('enroll2fa', '1')
    return NextResponse.redirect(setup)
  }
})

export const config = {
  matcher: [
    /*
     * Protect all routes except:
     *   - /login and /impressum (public pages)
     *   - /api/auth/* (NextAuth internal endpoints)
     *   - /api/login-challenge (step one of signing in — see below)
     *   - the PWA's own files (see below)
     *   - Next.js static files and images
     *
     * /api/login-challenge is reached by someone who is BY DEFINITION not signed
     * in yet, so leaving it in the protected set made the middleware 307 the
     * form's POST to /login. `fetch` followed that redirect, the form got the
     * login page instead of JSON, and every sign-in — second factor or not —
     * died as "Invalid email or password" without ever reaching the backend
     * (#36). Anything added under /api here needs the same thought: an endpoint
     * that is part of signing in cannot require being signed in.
     *
     * /api/proxy is exempt for the same reason in a different key (#146): it is
     * how the browser reaches the backend API, so it is fetched, not navigated
     * to. A middleware 307 to /login would be followed by `fetch` and the caller
     * would parse the login page as its JSON. The route does its own auth check
     * and answers 401, which lib/api.ts already turns into a sign-out.
     *
     * sw.js, manifest.webmanifest, the two icons and /offline are the PWA's own
     * files, and #148 does not work with any of them behind the session — found
     * while serving production builds (#374). None of the three is a request a
     * browser will follow a redirect for and retry:
     *
     *   - A MANIFEST is fetched with credentials OMITTED, per spec, unless its
     *     link carries `crossorigin="use-credentials"` — which Next's generated
     *     metadata link does not. So it 307'd to /login for every visitor,
     *     signed in or not, and the install prompt had no manifest to read. The
     *     point of #148 — the operator's name and colours on a home screen —
     *     was unreachable in the one place it exists for.
     *   - A SERVICE WORKER script behind a redirect is refused outright ("The
     *     script resource is behind a redirect, which is disallowed"), and
     *     registration runs from the root layout, which renders on /login too.
     *     A first-time visitor is signed out by definition, so the worker never
     *     installed at all; an administrator who still owes a second factor is
     *     redirected on every path, so it never installed for them either.
     *   - /offline is precached at install and is the ONLY page the worker
     *     caches. Redirected, the install caches a login page, and the offline
     *     fallback offers a sign-in form with no network to sign in over.
     *
     * None of it is session data: the icons and the worker are static build
     * output, /offline carries no data by construction, and the manifest is the
     * `branding` row — already served publicly by /api/public/branding, which
     * is where the dashboard shell itself reads it from.
     */
    '/((?!login|impressum|api/auth|api/login-challenge|api/ping|api/proxy|sw\\.js|manifest\\.webmanifest|icon-maskable\\.svg|icon\\.svg|offline|_next/static|_next/image|favicon\\.ico).*)',
  ],
}
