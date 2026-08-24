import { test, expect, type APIRequestContext } from '@playwright/test'
import { loginAs } from './helpers'
import { apiAsRoot, ensureUser, type FixtureUser } from './api'

const protectedRoutes = [
  '/',
  '/catalog',
  '/orders',
  '/projects',
  '/infrastructure',
  '/settings',
  '/approvals',
  '/audit',
  '/admin',
]

test.describe('Authentication & route protection', () => {
  test.beforeEach(async ({ page }) => {
    await page.context().clearCookies()
  })

  for (const route of protectedRoutes) {
    test(`unauthenticated access to ${route} redirects to /login`, async ({ page }) => {
      await page.goto(route)
      await expect(page).toHaveURL(/\/login/, { timeout: 6000 })
    })
  }

  test('login page is publicly accessible', async ({ page }) => {
    await page.goto('/login')
    await expect(page).toHaveURL(/\/login/)
    await expect(page.getByRole('button', { name: /sign in/i })).toBeVisible()
  })

  test('redirect preserves callbackUrl after login', async ({ page }) => {
    await page.goto('/orders')
    await expect(page).toHaveURL(/\/login\?callbackUrl/, { timeout: 6000 })
  })
})

/**
 * Issue #154. The old assertion here was `not.toHaveURL(/\/admin$/)`, which cannot
 * tell "the project manager was turned away" from "nobody was signed in at all" —
 * a failed login also leaves the browser somewhere that is not /admin. So the test
 * would have passed just as happily if the sign-in it depends on had silently
 * broken, which is the one failure it most needed to notice.
 *
 * What it asserts now is both halves of the claim: the session IS live, and it is
 * turned away from /admin — to `/` specifically, which is where admin/page.tsx
 * sends a non-root caller.
 */
test.describe('Role-based access control', () => {
  // Its own clean context: this describe signs in as somebody else, and borrowing
  // root's storageState only to overwrite it makes the starting state ambiguous.
  test.use({ storageState: { cookies: [], origins: [] } })

  let root: APIRequestContext
  let pm: FixtureUser

  test.beforeAll(async () => {
    root = await apiAsRoot()
    // A stable fixture account rather than `e2e-pm-${Date.now()}@example.com`,
    // which created a new user on every run and left it behind whenever the
    // browser-driven cleanup at the end did not get that far (#156).
    pm = await ensureUser(root, 'project_manager', 'rbac-pm')
  })

  test.afterAll(async () => {
    await root.dispose()
  })

  test('a project manager is signed in, and still turned away from /admin', async ({ page }) => {
    await loginAs(page, pm.email, pm.password)

    // Half one: the session is real. Without this the rest proves nothing.
    await expect(page.getByText(pm.name)).toBeVisible({ timeout: 30_000 })
    await page.goto('/orders')
    await expect(page).toHaveURL(/\/orders$/)
    await expect(page.getByRole('heading', { name: /^orders$/i })).toBeVisible({ timeout: 30_000 })

    // Half two: /admin is root-only, and the redirect goes to the dashboard —
    // not to /login, which is what "not /admin" would also have accepted.
    await page.goto('/admin')
    await expect(page).toHaveURL(/localhost:\d+\/$/, { timeout: 30_000 })
    await expect(page).not.toHaveURL(/\/login/)
    await expect(page.getByRole('heading', { name: /admin dashboard/i })).toHaveCount(0)
  })

  test('a project manager sees no admin navigation to follow', async ({ page }) => {
    await loginAs(page, pm.email, pm.password)
    await page.goto('/')

    // Turning the page away is the guard; not offering the link is the part the
    // user actually experiences.
    await expect(page.getByRole('link', { name: /^admin$/i })).toHaveCount(0)
    await expect(page.getByRole('link', { name: /^approvals$/i })).toHaveCount(0)
    await expect(page.getByRole('link', { name: /^catalog$/i })).toBeVisible()
  })
})
