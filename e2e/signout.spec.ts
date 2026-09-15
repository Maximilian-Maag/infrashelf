import { test, expect } from './fixtures'
import { type Page } from '@playwright/test'
import {
  completeSecondFactor,
  createAccount,
  hydrated,
  rootStorageStateFile,
  signInAsAccount,
  signOutViaMenu,
  waitForTotpStepAfter,
  totpStepOf,
  type TestAccount,
  type TestRole,
} from './helpers'

/**
 * Every role signs out, and the session is actually over (#362).
 *
 * ── Why this exists ─────────────────────────────────────────────────────────
 * Signing out was covered once, as root, by a test that asserted the browser
 * landed on `/login`. Then #359 shipped a sign-out button that did nothing at
 * all in every deployed environment, and this suite stayed green.
 *
 * It stayed green for a reason worth writing down, because it is the reason a
 * test can be present and prove nothing. The button awaited
 * `clearServiceWorkerCaches()`, which awaited `navigator.serviceWorker.ready` —
 * a promise that never settles when no worker activates. In the Docker image
 * `/sw.js` was missing, so registration failed and the await hung; under `next
 * dev` the file is served from the source tree, the worker registered, and the
 * hang could not happen HERE. The environment the tests run in was the one
 * environment where the bug did not exist.
 *
 * ── What is asserted ────────────────────────────────────────────────────────
 * Landing on `/login` is not the claim. A client-side redirect can put the
 * browser there with the session cookie entirely intact — which is exactly the
 * failure a shared machine punishes. So each role's round trip is:
 *
 *   sign in → sign out → the cookie no longer works → sign in again
 *
 * and "no longer works" is checked twice: a navigation that must bounce, and an
 * API call through the proxy that must be refused. The second matters because
 * the first can pass on a cached page.
 *
 * ── What is deliberately not here ───────────────────────────────────────────
 * A test for the 401 handler in `lib/api.ts`, which shares the broken await and
 * is worse there (`endingSession` latches, so a throw would leave every later
 * expiry doing nothing). Four shapes were tried and each proved nothing:
 *
 *   - a document `goto` is answered by the proxy, so it redirects with the
 *     handler deleted;
 *   - an in-app move to a server-rendered page (/projects) makes no browser
 *     fetch at all — it simply sat there;
 *   - an in-app move to a client-rendered one (/catalog) has the router's own
 *     RSC request 401 first and fall back to a document load, which the
 *     proxy redirects;
 *   - a form submit with no navigation is the right SHAPE, but never sees a 401.
 *
 * The last one is worth writing down, because it is not obvious and it wasted a
 * long time. Deleting `authjs.session-token` does not end the session: NextAuth's
 * SessionProvider polls `/api/auth/session`, and the rolling refresh puts the
 * cookie straight back — measured at under three seconds, after which the proxy
 * authorises again. It is not an authorisation hole (a page fetch made while the
 * cookie is genuinely absent gets `401 {"error":"Not signed in"}`), it is simply
 * that a client-side cookie delete is not an expiry.
 *
 * Simulating one faithfully means revoking the session SERVER-side — the app has
 * per-session revocation from #37 — and that belongs with the cross-account work
 * in #363, which already needs a second signed-in account to do it. Unit coverage
 * holds this path until then.
 */

/**
 * Sign in again in the SAME context, after a sign-out.
 *
 * Not `signInAsAccount`, which opens a fresh context: a new context proves
 * nothing about the old session, and the round trip is the subject here. The
 * TOTP secret comes from the first sign-in, so a second-factor role re-enters
 * the real two-step path rather than skipping it.
 */
async function signInAgain(page: Page, account: TestAccount, secret: string | null): Promise<void> {
  if (secret) await waitForTotpStepAfter(totpStepOf())
  await page.goto('/login')
  await page.getByLabel(/email address/i).fill(account.email)
  await page.getByLabel(/password/i).fill(account.password)
  await page.getByRole('button', { name: /sign in/i }).click()
  await completeSecondFactor(page, secret ?? undefined)
  await page.waitForURL((url) => !url.pathname.includes('/login'), { timeout: 75_000 })
  await hydrated(page)
}

const ROLES: TestRole[] = ['project_manager', 'admin', 'root']

/** Written out, because `a admin` and `a root` read like a typo in the report. */
const ARTICLE: Record<TestRole, string> = {
  project_manager: 'a project manager',
  admin: 'an admin',
  root: 'the root account',
}

test.describe('signing out', () => {
  // Each role signs in for real, including the second factor where the role
  // needs one, so these are slow by construction rather than by accident.
  test.describe.configure({ timeout: 240_000 })

  for (const role of ROLES) {
    test(`${ARTICLE[role]} can sign out, and the session is over`, async ({ browser }) => {
      const rootContext = await browser.newContext({ storageState: rootStorageStateFile })
      const rootPage = await rootContext.newPage()
      let account: TestAccount
      try {
        account = await createAccount(rootPage, role)
      } finally {
        await rootContext.close()
      }

      const { page, context, secret } = await signInAsAccount(browser, account)
      try {
        // Signed in: an authenticated page renders as this account.
        await page.goto('/orders')
        await hydrated(page)
        expect(page.url()).not.toContain('/login')

        await signOutViaMenu(page)

        /*
         * The claim. A client-side redirect to /login can happen with the
         * cookie still valid, so the session has to be probed rather than
         * inferred from the URL.
         */
        await page.goto('/orders')
        await expect(page, 'the session survived the sign-out').toHaveURL(/\/login/, { timeout: 30_000 })

        // And through the API, which does not care what the router did. The
        // browser reaches the backend only via /api/proxy (#146).
        //
        // `/api/proxy/api/orders`, not `/api/proxy/orders`: the proxy forwards
        // `/api/proxy/<path>` to `<API_URL>/<path>`, so the shorter form asks
        // the backend for `/orders` and gets a 404 that says nothing about the
        // session. It only looked right because a signed-OUT request is
        // refused by the proxy before the path matters.
        const refused = await context.request.get('/api/proxy/api/orders', { failOnStatusCode: false })
        expect(
          [401, 403].includes(refused.status()),
          `the proxy still served this session (HTTP ${refused.status()})`,
        ).toBe(true)

        // Closed loop: the same account can get back in afterwards, so the
        // sign-out ended a session rather than breaking an account.
        await signInAgain(page, account, secret)
        await page.goto('/orders')
        await hydrated(page)
        expect(page.url()).not.toContain('/login')
      } finally {
        await context.close()
      }
    })
  }

  /*
   * The deployed condition, reproduced (#359, #360).
   *
   * Under `next dev` the service worker registers, because `public/` is served
   * from the source tree — which is precisely why the suite could not see the
   * bug. In the Docker image `public/` was missing, `/sw.js` 404'd, registration
   * failed, and `navigator.serviceWorker.ready` never settled; the sign-out
   * button awaited it and the session never ended.
   *
   * Making the browser answer 404 for `/sw.js` puts this test in the deployed
   * environment's shoes without needing the image. Against the pre-fix code it
   * hangs and fails; the Dockerfile guard is a unit test, but this is the one
   * that proves the app survives the condition rather than merely that the file
   * is copied.
   */
  test('signs out even when the service worker cannot be fetched', async ({ browser }) => {
    const rootContext = await browser.newContext({ storageState: rootStorageStateFile })
    const rootPage = await rootContext.newPage()
    let account: TestAccount
    try {
      account = await createAccount(rootPage, 'project_manager')
    } finally {
      await rootContext.close()
    }

    /*
     * The route goes on BEFORE the first navigation, not after signing in.
     *
     * The root layout registers the worker, so `/login` already asks for
     * `/sw.js`. Installed afterwards, the interception would miss the
     * registration that matters and the test would quietly run WITH a working
     * worker — passing while proving nothing. `swRequests` is the receipt.
     */
    const swRequests: string[] = []
    const { page, context } = await signInAsAccount(browser, account, async (ctx) => {
      await ctx.route('**/sw.js', (route) => {
        swRequests.push(route.request().url())
        // Exactly what the deployed image did: the file is simply not there.
        return route.fulfill({ status: 404, body: 'Not Found' })
      })
    })
    try {
      await page.goto('/orders')
      await hydrated(page)

      expect(
        swRequests.length,
        'the page never asked for /sw.js, so this test reproduced nothing',
      ).toBeGreaterThan(0)

      await signOutViaMenu(page)

      await page.goto('/orders')
      await expect(page, 'the sign-out hung on a worker that never arrived').toHaveURL(/\/login/, {
        timeout: 30_000,
      })
    } finally {
      await context.close()
    }
  })
})
