import { test, expect } from './fixtures'
import type { Page } from '@playwright/test'
import { loginAsRoot, expectNoServerError } from './helpers'

test.describe('Admin area', () => {
  test.beforeEach(async ({ page }) => {
    await loginAsRoot(page)
  })

  test('admin panel is accessible to root user', async ({ page }) => {
    await page.goto('/admin')
    await expect(page).not.toHaveURL(/\/login/)
    await expect(page.locator('body')).not.toContainText('Forbidden')
  })

  test('admin dashboard shows page title', async ({ page }) => {
    await page.goto('/admin')
    await expect(page.getByRole('heading', { name: /admin dashboard/i })).toBeVisible()
  })

  test('admin dashboard shows all section cards', async ({ page }) => {
    await page.goto('/admin')
    // Links include description text in accessible name, so use partial match (no $ anchor)
    await expect(page.getByRole('link', { name: /^categories/i })).toBeVisible()
    await expect(page.getByRole('link', { name: /^products/i })).toBeVisible()
    await expect(page.getByRole('link', { name: /^deployment environments/i })).toBeVisible()
    await expect(page.getByRole('link', { name: /^users/i })).toBeVisible()
    await expect(page.getByRole('link', { name: /^branding/i })).toBeVisible()
    await expect(page.getByRole('link', { name: /^cost centers/i })).toBeVisible()
    await expect(page.getByRole('link', { name: /^ci sources/i })).toBeVisible()
    await expect(page.getByRole('link', { name: /^global parameters/i })).toBeVisible()
    await expect(page.getByRole('link', { name: /^smtp config/i })).toBeVisible()
    await expect(page.getByRole('link', { name: /^ai config/i })).toBeVisible()
    await expect(page.getByRole('link', { name: /^exchange rates/i })).toBeVisible()
  })

  test('user management page loads', async ({ page }) => {
    await page.goto('/admin/users')
    await expect(page).not.toHaveURL(/\/login/)
    await expectNoServerError(page)
  })

  test('categories page loads', async ({ page }) => {
    await page.goto('/admin/categories')
    await expect(page).not.toHaveURL(/\/login/)
    await expectNoServerError(page)
  })

  test('products page loads', async ({ page }) => {
    await page.goto('/admin/products')
    await expect(page).not.toHaveURL(/\/login/)
    await expectNoServerError(page)
  })

  test('environments page loads', async ({ page }) => {
    await page.goto('/admin/environments')
    await expect(page).not.toHaveURL(/\/login/)
    await expectNoServerError(page)
  })

  test('cost centers page loads', async ({ page }) => {
    await page.goto('/admin/cost-centers')
    await expect(page).not.toHaveURL(/\/login/)
    await expectNoServerError(page)
  })

  test('branding page loads', async ({ page }) => {
    await page.goto('/admin/branding')
    await expect(page).not.toHaveURL(/\/login/)
    await expectNoServerError(page)
  })

  test('SMTP config page loads', async ({ page }) => {
    await page.goto('/admin/config/smtp')
    await expect(page).not.toHaveURL(/\/login/)
    await expectNoServerError(page)
  })

  test('AI config page loads', async ({ page }) => {
    await page.goto('/admin/config/ai')
    await expect(page).not.toHaveURL(/\/login/)
    await expectNoServerError(page)
  })

  test('exchange rates page loads', async ({ page }) => {
    await page.goto('/admin/exchange-rates')
    await expect(page).not.toHaveURL(/\/login/)
    await expectNoServerError(page)
  })

  test('CI sources page loads', async ({ page }) => {
    await page.goto('/admin/ci-sources')
    await expect(page).not.toHaveURL(/\/login/)
    await expectNoServerError(page)
  })

  test('global parameters page loads', async ({ page }) => {
    await page.goto('/admin/parameters')
    await expect(page).not.toHaveURL(/\/login/)
    await expectNoServerError(page)
  })

  test('approvals page is accessible to root user', async ({ page }) => {
    await page.goto('/approvals')
    await expect(page).not.toHaveURL(/\/login/)
    await expectNoServerError(page)
  })

  test('audit log page is accessible to root user', async ({ page }) => {
    await page.goto('/audit')
    await expect(page).not.toHaveURL(/\/login/)
    await expectNoServerError(page)
  })

  /*
   * A context that never had a session, rather than one emptied just now (#454).
   *
   * This used to be `clearCookies()` on the signed-in context followed straight
   * by `goto`, and it failed about one run in two. The trace of a failing run
   * says why: the navigation carried the cookie anyway —
   *
   *     GET 200 /admin   cookie: authjs.session-token=eyJhbGciOiJkaXIiLCJ…
   *
   * while every request after it carried only `callback-url` and `csrf-token`.
   * The clear did happen; the navigation issued before it reached the network
   * stack. So the server rendered the admin page correctly and the test was
   * asserting against a precondition it had not established — which is why the
   * failure showed a fully authenticated page rather than a slow redirect.
   *
   * `storageState` is passed EXPLICITLY as empty, and that is the whole trick.
   * `browser.newContext()` inherits the project's `use` options — which is how
   * `baseURL` reaches it, and also how the root storage state would. A bare
   * `newContext()` here was signed in as root and failed six times out of six,
   * which is at least an honest failure: the cookie race failed one in two.
   */
  test('unauthenticated user is redirected to /login from /admin', async ({ browser }) => {
    const anonymous = await browser.newContext({ storageState: { cookies: [], origins: [] } })
    try {
      const page = await anonymous.newPage()
      await page.goto('/admin')
      await expect(page).toHaveURL(/\/login/, { timeout: 6000 })
    } finally {
      await anonymous.close()
    }
  })

  test('new product page loads', async ({ page }) => {
    await page.goto('/admin/products/new')
    await expect(page).not.toHaveURL(/\/login/)
    await expectNoServerError(page)
  })
})

test.describe('Admin - Internationalization', () => {
  /**
   * Not by accessible name. The switcher names itself in the page language now
   * (#186) — "Sprache: DE – Deutsch" once German is chosen — so a /language/i
   * match finds the toggle before the switch and nothing after it, which is
   * precisely the half of these tests that matters. `aria-expanded` is on this
   * button and on no other control the app renders — scoped to the header
   * because Next's dev-tools button carries one too, and the dev server is what
   * these tests run against.
   */
  const languageToggle = (page: Page) => page.locator('header button[aria-expanded]')

  test('language switcher is visible in header', async ({ page }) => {
    await loginAsRoot(page)
    await page.goto('/')
    // Language switcher shows current language code (e.g. "EN")
    await expect(languageToggle(page)).toBeVisible()
  })

  test('switching language updates UI text', async ({ page }) => {
    await loginAsRoot(page)
    await page.goto('/')

    await languageToggle(page).click()
    // Select German — button contains both code span "DE" and name span "Deutsch"
    await page.locator('button').filter({ has: page.locator('span').filter({ hasText: /^DE$/ }) }).click()

    // After switching, the catalog nav link changes from "Catalog" to "Katalog"
    await expect(page.getByRole('link', { name: 'Katalog', exact: true })).toBeVisible({ timeout: 5000 })

    // Switch back to English
    await languageToggle(page).click()
    await page.locator('button').filter({ has: page.locator('span').filter({ hasText: /^EN$/ }) }).click()
    await expect(page.getByRole('link', { name: /^catalog$/i })).toBeVisible({ timeout: 5000 })
  })

  test('selected language persists after page reload', async ({ page }) => {
    await loginAsRoot(page)
    await page.goto('/')

    // Switch to German
    await languageToggle(page).click()
    await page.locator('button').filter({ has: page.locator('span').filter({ hasText: /^DE$/ }) }).click()
    await expect(page.getByRole('link', { name: 'Katalog', exact: true })).toBeVisible({ timeout: 5000 })

    // Reload the page — lang cookie should persist the language
    await page.reload()
    await expect(page.getByRole('link', { name: 'Katalog', exact: true })).toBeVisible({ timeout: 5000 })

    // Switch back to English
    await languageToggle(page).click()
    await page.locator('button').filter({ has: page.locator('span').filter({ hasText: /^EN$/ }) }).click()
    await expect(page.getByRole('link', { name: /^catalog$/i })).toBeVisible({ timeout: 5000 })
  })
})
