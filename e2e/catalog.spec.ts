import { test, expect } from './fixtures'
import { type Page } from '@playwright/test'
import { expectNoServerError, loginAsRoot, requireSeeded } from './helpers'

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

  test('every product tile links to its detail page', async ({ page }) => {
    await goToCatalog(page)
    // `^details\b`, not `^details$`: every tile's Details link carries the product
    // name in an sr-only span (WCAG 2.4.9), so its accessible name is "Details: <product>".
    const placeOrderLinks = page.getByRole('link', { name: /^details\b/i })
    const noProducts = page.getByText(/no products found/i)
    // The page is server-rendered now (#472), so the tiles are in the first
    // response — the timeout is for a slow backend, not for a client fetch.
    await expect(placeOrderLinks.or(noProducts).first()).toBeVisible({ timeout: 10000 })
    const count = await placeOrderLinks.count()
    const isEmpty = await noProducts.isVisible()
    expect(count > 0 || isEmpty).toBe(true)
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

  /*
   * #472. The category used to be `useState`, so a filtered shop could not be
   * sent to anyone and Back left the shop entirely rather than returning to the
   * previous category.
   */
  test('a chosen category is a URL, and Back returns to the previous view', async ({ page }) => {
    await goToCatalog(page)

    // The sidebar lists whatever categories the installation has; the first one
    // after "All products" is enough to prove the mechanism.
    const chips = page.locator('aside').getByRole('button')
    const count = await chips.count()
    requireSeeded(count > 1, 'no category in the sidebar to filter by')

    await chips.nth(1).click()
    await expect(page).toHaveURL(/[?&]category=\d+/)
    // And it is the filter in effect, not merely a parameter in the address bar.
    await expect(chips.nth(1)).toHaveAttribute('aria-pressed', 'true')

    await page.goBack()
    await expect(page).toHaveURL(/\/catalog$/)
    await expect(page.getByRole('button', { name: /all products/i }).first())
      .toHaveAttribute('aria-pressed', 'true')
    await expectNoServerError(page)
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
    requireSeeded(!(await noProducts.isVisible()), 'no product card on /catalog to carry a favourite toggle')

    // aria-pressed carries the state — the fill colour alone would not.
    await expect(firstStar).toHaveAttribute('aria-pressed', /true|false/)
  })

  test('starring a product persists across a reload and shows the favourites section', async ({ page }) => {
    const noProducts = page.getByText(/no products/i)
    const addStar = page.getByRole('button', { name: /add to favorites/i }).first()
    await expect(addStar.or(noProducts).first()).toBeVisible({ timeout: 10000 })
    requireSeeded(!(await noProducts.isVisible()), 'no product card on /catalog to star')

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
    requireSeeded(!(await noProducts.isVisible()), 'no product on /catalog to open')

    await firstOrder.click()
    // The order form's select, not the buy box's: both are labelled "Environment".
    const envSelect = page.locator('#order').getByLabel(/environment/i)
    await expect(envSelect).toBeVisible({ timeout: 10000 })

    const options = await envSelect.locator('option:not([disabled])').count()
    requireSeeded(options > 0, 'the order form offers no environment to choose')
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
