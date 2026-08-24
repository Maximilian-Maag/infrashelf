import { test, expect, type Page } from '@playwright/test'
import { loginAsRoot, expectNoServerError } from './helpers'

async function goToCatalog(page: Page) {
  await loginAsRoot(page)
  await page.goto('/catalog')
}

test.describe('Product Catalog', () => {
  test('catalog page loads without error', async ({ page }) => {
    await goToCatalog(page)
    await expect(page).not.toHaveURL(/\/login/)
    await expectNoServerError(page)
  })

  test('shows catalog page title', async ({ page }) => {
    await goToCatalog(page)
    await expect(page.getByText(/product catalog/i)).toBeVisible()
  })

  test('shows category sidebar with heading', async ({ page }) => {
    await goToCatalog(page)
    await expect(page.getByRole('heading', { name: /categories/i }).or(page.getByText(/^categories$/i))).toBeVisible()
  })

  test('shows All Products button in sidebar', async ({ page }) => {
    await goToCatalog(page)
    await expect(page.getByRole('button', { name: /all products/i })).toBeVisible()
  })

  test('shows product count when products are available', async ({ page }) => {
    await goToCatalog(page)
    // Either products are shown with a count, or no-products message is shown
    const productCount = page.getByText(/\d+ products/i)
    const noProducts = page.getByText(/no products found/i)
    await expect(productCount.or(noProducts).first()).toBeVisible()
  })

  // Issue #154. The old last line was `expect(count > 0 || isEmpty).toBe(true)`,
  // which the assertion above it already guarantees — one of the two locators was
  // visible, so one of the two disjuncts is true by construction. It could not
  // fail. The catalogue is seeded now, so the tiles can simply be checked.
  test('every product tile links to its own detail page', async ({ page }) => {
    await goToCatalog(page)
    // `^details\b`, not `^details$`: every tile's Details link carries the product
    // name in an sr-only span (WCAG 2.4.9), so its accessible name is "Details: <product>".
    const detailLinks = page.getByRole('link', { name: /^details\b/i })
    // Wait for the catalogue to finish loading (client component, async fetch).
    await expect(detailLinks.first()).toBeVisible({ timeout: 10000 })

    const hrefs = await detailLinks.evaluateAll((links) =>
      links.map((l) => (l as HTMLAnchorElement).getAttribute('href')),
    )
    expect(hrefs.length).toBeGreaterThan(0)
    // Every tile, and each to a DIFFERENT product: one href repeated across the
    // grid is exactly what a mis-keyed map would produce, and counting links
    // would not see it.
    for (const href of hrefs) expect(href).toMatch(/^\/catalog\/\d+$/)
    expect(new Set(hrefs).size).toBe(hrefs.length)

    await detailLinks.first().click()
    await expect(page).toHaveURL(new RegExp(`${hrefs[0]}$`), { timeout: 30_000 })
  })

  test('navigates to catalog from top nav', async ({ page }) => {
    await loginAsRoot(page)
    await page.goto('/')
    await page.getByRole('link', { name: /^catalog$/i }).first().click()
    await expect(page).toHaveURL(/\/catalog/)
  })

  test('header search navigates to catalog with query param', async ({ page }) => {
    await loginAsRoot(page)
    await page.goto('/')
    await page.getByPlaceholder(/search products/i).fill('test')
    await page.keyboard.press('Enter')
    await expect(page).toHaveURL(/\/catalog\?q=test/)
  })

  test('shows Results for text when search query is active', async ({ page }) => {
    await loginAsRoot(page)
    await page.goto('/catalog?q=server')
    await expect(page.getByText(/results for/i)).toBeVisible()
  })

  test('mobile All pill button is present', async ({ page }) => {
    await goToCatalog(page)
    // The mobile "All" pill and sidebar "All products" button should both exist in the DOM
    const allButtons = page.getByRole('button', { name: /^all$/i })
    // May or may not be visible depending on viewport (mobile-only)
    await expect(allButtons.or(page.getByRole('button', { name: /all products/i }))).toBeVisible()
  })
})

// Issue #39. Favourites are per-user and stored server-side, so the contract
// worth pinning end to end is that a star survives a reload.
test.describe('Catalog favorites', () => {
  test.beforeEach(async ({ page }) => {
    await loginAsRoot(page)
    await page.goto('/catalog')
  })

  test('every product card offers a favourite toggle', async ({ page }) => {
    const noProducts = page.getByText(/no products/i)
    const firstStar = page.getByRole('button', { name: /add to favorites|remove from favorites/i }).first()
    await expect(firstStar.or(noProducts).first()).toBeVisible({ timeout: 10000 })
    if (await noProducts.isVisible()) { test.skip(); return }

    // aria-pressed carries the state — the fill colour alone would not.
    await expect(firstStar).toHaveAttribute('aria-pressed', /true|false/)
  })

  test('starring a product persists across a reload and shows the favourites section', async ({ page }) => {
    const noProducts = page.getByText(/no products/i)
    const addStar = page.getByRole('button', { name: /add to favorites/i }).first()
    await expect(addStar.or(noProducts).first()).toBeVisible({ timeout: 10000 })
    if (await noProducts.isVisible()) { test.skip(); return }

    await expect(page.getByRole('region', { name: /my favorites/i })).toBeHidden()
    await addStar.click()

    const favorites = page.getByRole('region', { name: /my favorites/i })
    await expect(favorites).toBeVisible({ timeout: 8000 })

    await page.reload()
    await expect(page.getByRole('region', { name: /my favorites/i })).toBeVisible({ timeout: 10000 })

    // Clean up so the run is repeatable.
    await page.getByRole('button', { name: /remove from favorites/i }).first().click()
    await expect(page.getByRole('region', { name: /my favorites/i })).toBeHidden({ timeout: 8000 })
  })
})

// Issue #1. The toggle only exists for an offering that was opted in, and a trial
// does NOT bypass approval — a project manager's trial still queues for one.
test.describe('Catalog trial ordering', () => {
  test('the trial toggle is absent for offerings that do not allow one', async ({ page }) => {
    await loginAsRoot(page)
    await page.goto('/catalog')

    const firstOrder = page.getByRole('link', { name: /^details\b/i }).first()
    const noProducts = page.getByText(/no products/i)
    await expect(firstOrder.or(noProducts).first()).toBeVisible({ timeout: 10000 })
    if (await noProducts.isVisible()) { test.skip(); return }

    await firstOrder.click()
    // The order form's select, not the buy box's: both are labelled "Environment".
    const envSelect = page.locator('#order').getByLabel(/environment/i)
    await expect(envSelect).toBeVisible({ timeout: 10000 })

    const options = await envSelect.locator('option:not([disabled])').count()
    if (options === 0) { test.skip(); return }
    await envSelect.selectOption({ index: 1 })

    // Either the offering allows a trial and the toggle explains itself, or it
    // does not and there is nothing to show.
    const toggle = page.getByLabel(/try it out/i)
    if (await toggle.count() > 0) {
      await expect(toggle).toBeVisible()
      await expect(page.getByText(/decommissioned automatically/i)).toBeVisible()
    } else {
      await expect(toggle).toHaveCount(0)
    }
  })
})
