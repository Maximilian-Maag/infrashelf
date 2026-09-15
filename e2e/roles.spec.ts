import { test, expect } from './fixtures'
import { type Browser, type BrowserContext, type Page } from '@playwright/test'
import {
  createAccount,
  expectNoServerError,
  hydrated,
  roleNeedsSecondFactor,
  rootStorageStateFile,
  signInAsAccount,
  type TestAccount,
  type TestRole,
} from './helpers'

/**
 * What each role may do, checked as that role.
 *
 * ── Why this file exists ─────────────────────────────────────────────────────
 * Every other spec in this suite signs in as root. That is one account, holding
 * the highest of three ranks, and it cannot see a permission bug by
 * construction — so the suite had no coverage at all of the two roles that do
 * the actual work.
 *
 * What it cost: `GET /api/admin/categories` was gated on `root` while the
 * catalogue page fetched it, in the same `Promise.all` as the products, to build
 * its category filter. Every project manager and every admin got a 403 there,
 * the rejection took the products down with it, and the shop rendered as an
 * error page. For everyone except root. Thirty assertions in `catalog.spec.ts`
 * stayed green the whole time, because the one account they run as was the one
 * account for which the page worked. The operator found it by creating a project
 * manager by hand.
 *
 * ── The two halves ──────────────────────────────────────────────────────────
 * `ENDPOINTS` is the permission matrix, taken from the `requireAuth` /
 * `requireRole` call in each backend route handler, and asserted through the
 * proxy with each role's own session. It is the half that would have caught the
 * bug above in one line, and it is cheap: one request per cell, no page loads.
 *
 * `PAGES` is reachability — every screen a role's navigation offers it must
 * actually render, with its data, as that role. A 403 on a page's data does not
 * have to look like an error page (the product detail page degrades to a missing
 * breadcrumb), so the endpoint half cannot replace this one.
 *
 * ── Keeping it honest ───────────────────────────────────────────────────────
 * When a route's guard changes, its row here has to change with it, and the row
 * is the assertion — a table nobody updates is a table that passes. The
 * `expected` field is written as the roles that ARE allowed rather than a
 * minimum rank, so a row cannot silently widen when the rank order is edited.
 */

/** The three roles, lowest rank first — `ROLE_RANK` in the backend's auth middleware. */
const ALL_ROLES: TestRole[] = ['project_manager', 'admin', 'root']

/** Everyone who is signed in at all. */
const EVERYONE: TestRole[] = ['project_manager', 'admin', 'root']

/** `requireRole('admin')` — an admin and anyone above. */
const ADMIN_UP: TestRole[] = ['admin', 'root']

/** `requireRole('root')`. */
const ROOT_ONLY: TestRole[] = ['root']

/**
 * Admin and NOT root — the category a rank cannot express.
 *
 * `requireRole('admin')` admits root by rank, and for one endpoint that is the
 * wrong answer: `listDelegations` refuses root outright with "Root does not
 * participate in approval delegation", and says why in its own comment — without
 * it, the role that is deliberately outside the approval workflow could still
 * enumerate every active admin through that endpoint.
 *
 * This row is the reason the table is written as the set of roles that ARE
 * allowed rather than as a minimum rank. A minimum-rank model cannot represent
 * "admin but not root" at all, and the first run of this matrix flagged exactly
 * this cell — as a failure of the table, which is what it was.
 */
const ADMIN_NOT_ROOT: TestRole[] = ['admin']

interface EndpointRule {
  /** Path on the backend, as the browser asks for it (the proxy prefix is added). */
  path: string
  /** The roles the route's own guard admits. */
  allowed: TestRole[]
  /** Why it is that set — the reason belongs with the rule, not in a commit message. */
  why: string
}

const ENDPOINTS: EndpointRule[] = [
  // ── The shop. A project manager's job is here, so all of it is requireAuth. ──
  { path: '/api/catalog', allowed: EVERYONE, why: 'browsing the shop is the project manager job' },
  {
    path: '/api/admin/categories',
    allowed: EVERYONE,
    why: 'the catalogue page and the product breadcrumb both read this to name a category — it is the shop navigation, not an admin table, and gating it on root broke the whole shop for everyone below root',
  },
  {
    path: '/api/admin/cost-centers',
    allowed: EVERYONE,
    why: 'the order form cannot be filled in without the cost-centre list; writing one is still admin',
  },
  {
    path: '/api/admin/exchange-rates',
    allowed: EVERYONE,
    why: 'every price on every page is converted with these; refreshing them is still root',
  },
  { path: '/api/cart', allowed: EVERYONE, why: 'ordering is the project manager job' },
  { path: '/api/orders', allowed: EVERYONE, why: 'own orders; the service scopes the rows, not the guard' },
  { path: '/api/projects', allowed: EVERYONE, why: 'a project is what an order is placed against' },
  { path: '/api/infrastructure', allowed: EVERYONE, why: 'what the caller has provisioned' },
  { path: '/api/infrastructure/facets', allowed: EVERYONE, why: 'the filters over that list' },
  { path: '/api/costs', allowed: EVERYONE, why: 'what the caller is spending' },
  { path: '/api/dashboard', allowed: EVERYONE, why: 'the landing page every role sees' },
  { path: '/api/favorites', allowed: EVERYONE, why: 'the stars on the catalogue tiles' },
  { path: '/api/sessions', allowed: EVERYONE, why: 'signing yourself out elsewhere (#37)' },
  { path: '/api/users/me', allowed: EVERYONE, why: 'the app shell cannot draw without it' },

  // ── Oversight. Approving and auditing are an admin's job, not a shopper's. ──
  { path: '/api/approvals', allowed: ADMIN_UP, why: 'approving is the admin job' },
  {
    path: '/api/approvals/delegations',
    allowed: ADMIN_NOT_ROOT,
    why: 'who may approve in your place — and root is refused BY THE SERVICE, not by rank, because it does not participate in the approval workflow and this endpoint would otherwise let it enumerate every active admin',
  },
  { path: '/api/audit', allowed: ADMIN_UP, why: 'the audit trail is oversight, not self-service' },
  {
    path: '/api/infrastructure/export',
    allowed: ADMIN_UP,
    why: 'the export crosses every owner, unlike the list it exports',
  },

  // ── Configuring the portal. Root only: this is what the product IS. ──
  { path: '/api/admin/users', allowed: ROOT_ONLY, why: 'creating accounts and handing out roles' },
  { path: '/api/admin/products', allowed: ROOT_ONLY, why: 'what the shop sells' },
  { path: '/api/admin/ci-sources', allowed: ROOT_ONLY, why: 'holds pipeline credentials' },
  { path: '/api/admin/integrations', allowed: ROOT_ONLY, why: 'holds external-system credentials' },
  { path: '/api/admin/branding', allowed: ROOT_ONLY, why: 'a portal-wide singleton' },
  { path: '/api/admin/config/smtp', allowed: ROOT_ONLY, why: 'holds mail credentials' },
  { path: '/api/admin/config/ai', allowed: ROOT_ONLY, why: 'holds an API key' },

  // ── The middle rank. These two are why `admin` is not just a lesser root. ──
  { path: '/api/admin/environments', allowed: ADMIN_UP, why: 'deployment targets are an admin concern' },
  { path: '/api/admin/parameters', allowed: ADMIN_UP, why: 'the shared parameter library' },
]

interface PageRule {
  path: string
  allowed: TestRole[]
  /**
   * Something that only appears once the page's own data has arrived.
   *
   * Takes the timeout rather than hardcoding one, because it is used in both
   * directions: generously when waiting for content to appear, and briefly when
   * checking that a role above its rank is NOT shown it. A 30-second budget on
   * the negative case would put minutes on the run waiting for things that are
   * correctly never going to happen.
   */
  ready: (page: Page, timeout: number) => Promise<void>
}

/**
 * The generous budget, for content that is supposed to arrive. CI runs a cold
 * `next dev`, so the first render of a route compiles it.
 */
const READY_MS = 30_000

/**
 * The brief one, for content that is supposed to NEVER arrive. Thirty seconds
 * apiece across every forbidden page would add minutes to the run waiting for
 * things that are correctly not going to happen.
 */
const DENIED_PROBE_MS = 3_000

/**
 * A page is "reachable" when its own content renders — not merely when it responds.
 *
 * Each `ready` waits for something that requires the page's data to have loaded,
 * because that is where a permission bug shows up. A blanket
 * `expectNoServerError` would have passed on the broken catalogue: it renders an
 * in-page error state, inside `<main>`, with none of the strings that helper
 * looks for.
 */
const PAGES: PageRule[] = [
  {
    path: '/',
    allowed: EVERYONE,
    ready: async (page, timeout) => {
      await expect(page.getByRole('link', { name: /browse catalog/i })).toBeVisible({ timeout })
    },
  },
  {
    path: '/catalog',
    allowed: EVERYONE,
    ready: async (page, timeout) => {
      // The count or the empty state — both prove the products request came back.
      // This is the assertion the bug failed: the page showed neither, only its
      // error state.
      await expect(
        page.getByText(/\d+ products/i).or(page.getByText(/no products found/i)).first(),
      ).toBeVisible({ timeout })
    },
  },
  {
    path: '/orders',
    allowed: EVERYONE,
    ready: async (page, timeout) => {
      await expect(page.getByRole('heading', { name: /^orders$/i, level: 1 })).toBeVisible({ timeout })
    },
  },
  {
    path: '/projects',
    allowed: EVERYONE,
    ready: async (page, timeout) => {
      await expect(page.getByRole('heading', { name: /^projects$/i, level: 1 })).toBeVisible({ timeout })
    },
  },
  {
    path: '/infrastructure',
    allowed: EVERYONE,
    ready: async (page, timeout) => {
      await expect(page.getByRole('heading', { name: /^infrastructure$/i, level: 1 })).toBeVisible({ timeout })
    },
  },
  {
    path: '/costs',
    allowed: EVERYONE,
    ready: async (page, timeout) => {
      await expect(page.getByRole('heading', { name: /costs/i, level: 1 })).toBeVisible({ timeout })
    },
  },
  {
    path: '/cart',
    allowed: EVERYONE,
    ready: async (page, timeout) => {
      await expect(page.getByRole('heading', { name: /cart/i, level: 1 })).toBeVisible({ timeout })
    },
  },
  {
    path: '/settings',
    allowed: EVERYONE,
    ready: async (page, timeout) => {
      await expect(page.getByRole('heading', { name: /settings/i, level: 1 })).toBeVisible({ timeout })
    },
  },
  {
    path: '/approvals',
    allowed: ADMIN_UP,
    ready: async (page, timeout) => {
      await expect(page.getByRole('heading', { name: /approvals/i, level: 1 })).toBeVisible({ timeout })
    },
  },
  {
    path: '/audit',
    allowed: ADMIN_UP,
    ready: async (page, timeout) => {
      await expect(page.getByRole('heading', { name: /audit/i, level: 1 })).toBeVisible({ timeout })
    },
  },
  {
    path: '/admin/users',
    allowed: ROOT_ONLY,
    ready: async (page, timeout) => {
      await expect(page.getByRole('button', { name: /add user/i })).toBeVisible({ timeout })
    },
  },
  {
    path: '/admin/categories',
    allowed: ROOT_ONLY,
    ready: async (page, timeout) => {
      await expect(page.getByRole('heading', { name: /categories/i, level: 1 })).toBeVisible({ timeout })
    },
  },
]

/** The navigation links a role is offered — `TopNav.tsx`, in the same three tiers. */
const NAV_FOR: Record<TestRole, { shown: RegExp[]; hidden: RegExp[] }> = {
  project_manager: {
    shown: [/^home$/i, /^catalog$/i, /^orders$/i, /^projects$/i, /^infrastructure$/i, /^costs$/i],
    hidden: [/^approvals$/i, /^audit$/i, /^admin$/i],
  },
  admin: {
    shown: [/^catalog$/i, /^orders$/i, /^approvals$/i, /^audit$/i],
    hidden: [/^admin$/i],
  },
  root: {
    shown: [/^catalog$/i, /^orders$/i, /^approvals$/i, /^audit$/i, /^admin$/i],
    hidden: [],
  },
}

/**
 * Create a fixture account of `role`, from a root context of this file's own.
 *
 * Its own context rather than the test's `page`: the root role's tests run as
 * the bootstrap root session, but the other two roles need an account to exist
 * BEFORE they have a session at all, and creating one is root-only.
 */
async function provisionAccount(browser: Browser, role: TestRole): Promise<TestAccount> {
  const context = await browser.newContext({ storageState: rootStorageStateFile })
  try {
    return await createAccount(await context.newPage(), role)
  } finally {
    await context.close()
  }
}

/**
 * The signed-in session for a role, made once per role and shared by its tests.
 *
 * Once, because an administrative sign-in is not cheap: a fresh admin owes a
 * second factor (#197), so its session costs an account, an enrolment through
 * the UI, a wait for an unspent TOTP step and a second sign-in. Paying that per
 * test would put minutes on the suite for no extra coverage — every test in a
 * role's block asks a different question of the same session, which is exactly
 * what a session is for.
 */
interface RoleSession {
  page: Page
  context: BrowserContext | null
  account: TestAccount | null
}

for (const role of ALL_ROLES) {
  // Serial: the tests in a block share one session, so a failure that leaves the
  // page somewhere unexpected should stop the block rather than cascade into
  // every later assertion as a mystery.
  test.describe.serial(`role: ${role}`, () => {
    let session: RoleSession

    test.beforeAll(async ({ browser }) => {
      /*
       * The HOOK's timeout, set inside the hook, and this is not the same thing
       * as the `test.setTimeout` below.
       *
       * A describe-level `test.setTimeout` sets the timeout of the TESTS in the
       * group. `beforeAll` keeps its own, at the 30-second default — and an
       * administrative sign-in cannot fit in that: it is an account creation, a
       * sign-in, an enrolment through the UI, a wait for a TOTP step nobody has
       * spent (up to 30s on its own) and a second sign-in, each against a `next
       * dev` that may still be compiling the route.
       *
       * Left at the default it does not fail as a timeout, either. Playwright
       * disposes the contexts when the hook is killed, so whatever request was in
       * flight rejects first and the run reports `apiRequestContext: Request
       * context disposed` from somewhere inside the hook — which reads as a bug
       * in the thing being set up. Worse, it passed or failed depending on how
       * long the TOTP wait happened to be, so it was a flake rather than a
       * failure.
       */
      test.setTimeout(roleNeedsSecondFactor(role) ? 240_000 : 120_000)

      if (role === 'root') {
        // The bootstrap root, already enrolled and saved by auth.setup. Creating a
        // second root would cost another enrolment to prove nothing new.
        const context = await browser.newContext({ storageState: rootStorageStateFile })
        const page = await context.newPage()
        await page.goto('/')
        await hydrated(page)
        session = { page, context, account: null }
        return
      }

      const account = await provisionAccount(browser, role)
      const { page, context } = await signInAsAccount(browser, account)
      session = { page, context, account }
    })

    // Generous, and the administrative roles need it most: their `beforeAll`
    // waits for a TOTP step nobody has spent, which alone can be thirty seconds,
    // on top of two cold sign-ins through `next dev`.
    test.setTimeout(role === 'project_manager' ? 120_000 : 240_000)

    test.afterAll(async () => {
      await session?.context?.close()
    })

    test('signs in and reaches the application', async () => {
      await expect(session.page).not.toHaveURL(/\/login/)
      // Not merely "not on /login": an administrator who owes a second factor is
      // signed in and refused everything, which is the state auth.setup.ts was
      // fooled by. Being on the dashboard is the claim worth making.
      await expect(session.page).not.toHaveURL(/enroll2fa/)
      await expectNoServerError(session.page)
    })

    test('is offered exactly the navigation its role allows', async () => {
      const { page } = session
      await page.goto('/')
      await hydrated(page)
      const nav = page.getByRole('navigation', { name: /main navigation/i })

      for (const name of NAV_FOR[role].shown) {
        await expect(nav.getByRole('link', { name }), `${role} should be offered ${name}`).toBeVisible()
      }
      for (const name of NAV_FOR[role].hidden) {
        await expect(
          nav.getByRole('link', { name }),
          `${role} should NOT be offered ${name}`,
        ).toHaveCount(0)
      }
    })

    /**
     * The permission matrix, one request per row, as this role.
     *
     * One test rather than a test per row: these are 29 HTTP requests against an
     * already-warm session, and splitting them would multiply the sign-in above
     * by 29 for no extra signal. `soft` so a run reports every cell that is
     * wrong instead of the first — when a guard changes, knowing whether it
     * moved one route or twenty is the whole diagnosis.
     */
    test('the API admits and refuses exactly what its role allows', async () => {
      for (const rule of ENDPOINTS) {
        const res = await session.page.request.get(`/api/proxy${rule.path}`)
        const permitted = rule.allowed.includes(role)

        if (permitted) {
          expect
            .soft(res.status(), `${role} must be allowed GET ${rule.path} — ${rule.why}`)
            .toBeLessThan(400)
        } else {
          // 403 exactly, not "any error": a 401 would mean the session is not
          // being recognised at all, which is a different bug wearing the same
          // colour, and it is what the frontend turns into a global sign-out.
          expect
            .soft(res.status(), `${role} must be refused GET ${rule.path} — ${rule.why}`)
            .toBe(403)
        }
      }
    })

    test('every page its role allows renders its own content', async () => {
      const { page } = session
      for (const rule of PAGES.filter((p) => p.allowed.includes(role))) {
        await page.goto(rule.path)
        await hydrated(page)
        await expect(page, `${role} was bounced away from ${rule.path}`).not.toHaveURL(/\/login/)
        await expectNoServerError(page)
        await rule.ready(page, READY_MS)
      }
    })

    /**
     * A page above this role must not hand over its data.
     *
     * Asserted as an absence of the privileged content, not as a redirect: there
     * is no server-side role check on these routes — `proxy.ts` gates on
     * being signed in and on second-factor enrolment, and nothing else — so the
     * shell does render and the API is what refuses. That is worth knowing and
     * worth pinning: if a guard is added later this assertion still holds, and if
     * the API guard is ever relaxed by accident, it fails.
     */
    test('a page above its role does not hand over the data', async () => {
      const forbidden = PAGES.filter((p) => !p.allowed.includes(role))
      test.skip(forbidden.length === 0, 'root is the top rank — nothing is above it')

      const { page } = session
      for (const rule of forbidden) {
        await page.goto(rule.path)
        await hydrated(page)
        // A short budget on purpose: this is waiting for something that should
        // never arrive, and `ready` resolving at all is the failure.
        const showedItsData = await rule
          .ready(page, DENIED_PROBE_MS)
          .then(() => true)
          .catch(() => false)
        expect(
          showedItsData,
          `${rule.path} showed its privileged content to a ${role}`,
        ).toBe(false)
      }
    })
  })
}

/**
 * The regression that started all of this, kept as its own named test.
 *
 * The matrix above covers it twice over — the endpoint row and the `/catalog`
 * page row — but neither says WHY in a failure report, and this is the shape the
 * bug was reported in: an account was created, it could sign in, and the
 * catalogue said an error had occurred.
 */
test('a project manager can browse the catalogue, filter included (regression)', async ({ browser }) => {
  test.setTimeout(120_000)
  const account = await provisionAccount(browser, 'project_manager')
  const { page, context } = await signInAsAccount(browser, account)
  try {
    await page.goto('/catalog')
    await hydrated(page)

    // The products arrived.
    await expect(
      page.getByText(/\d+ products/i).or(page.getByText(/no products found/i)).first(),
    ).toBeVisible({ timeout: 30_000 })

    // And so did the category list, which is the part that was 403 — the sidebar
    // heading is rendered either way, so assert on the filter it builds.
    await expect(page.getByRole('button', { name: /all products/i })).toBeVisible()

    // The page's own error state, which is what a project manager used to get.
    await expect(page.getByText(/could not (be )?load/i)).toHaveCount(0)
  } finally {
    await context.close()
  }
})
