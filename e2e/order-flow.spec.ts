import { test, expect } from '@playwright/test'
import { loginAsRoot, expectNoServerError } from './helpers'

test.describe('Product Detail Page', () => {
  test('product detail page loads from a catalogue tile', async ({ page }) => {
    await loginAsRoot(page)
    await page.goto('/catalog')

    // Wait for catalog to finish loading (client component)
    // `^details\b`, not `^details$`: every tile's Details link carries the product
    // name in an sr-only span (WCAG 2.4.9), so its accessible name is "Details: <product>".
    const placeOrderLinks = page.getByRole('link', { name: /^details\b/i })
    const noProducts = page.getByText(/no products found/i)
    await expect(placeOrderLinks.or(noProducts).first()).toBeVisible({ timeout: 10000 })

    if (await noProducts.isVisible()) {
      test.skip()
      return
    }

    // Navigate to product detail
    await placeOrderLinks.first().click()
    await expect(page).toHaveURL(/\/catalog\/\d+/)
    await expectNoServerError(page)
  })

  test('product detail page shows description and environments', async ({ page }) => {
    await loginAsRoot(page)
    await page.goto('/catalog')

    const placeOrderLinks = page.getByRole('link', { name: /^details\b/i })
    const noProducts = page.getByText(/no products found/i)
    await expect(placeOrderLinks.or(noProducts).first()).toBeVisible({ timeout: 10000 })
    if (await noProducts.isVisible()) { test.skip(); return }

    await placeOrderLinks.first().click()
    await expect(page).toHaveURL(/\/catalog\/\d+/)

    // Product detail always shows the page header with product name
    // and either a description or the available environments section
    await expect(page.locator('h1, h2').first()).toBeVisible()
  })

  test('product detail page shows order form with environment selector', async ({ page }) => {
    await loginAsRoot(page)
    await page.goto('/catalog')

    const placeOrderLinks = page.getByRole('link', { name: /^details\b/i })
    const noProducts = page.getByText(/no products found/i)
    await expect(placeOrderLinks.or(noProducts).first()).toBeVisible({ timeout: 10000 })
    if (await noProducts.isVisible()) { test.skip(); return }

    await placeOrderLinks.first().click()
    await expect(page).toHaveURL(/\/catalog\/\d+/)

    // The order form always renders with environment and project selects
    await expect(page.getByLabel(/select environment/i).or(page.getByText(/available environments/i))).toBeVisible({ timeout: 5000 })
  })
})

test.describe('Order Placement Flow', () => {
  test('can submit an order and see it in the orders list', async ({ page }) => {
    await loginAsRoot(page)
    await page.goto('/catalog')

    // Wait for catalog to load
    const placeOrderLinks = page.getByRole('link', { name: /^details\b/i })
    const noProducts = page.getByText(/no products found/i)
    await expect(placeOrderLinks.or(noProducts).first()).toBeVisible({ timeout: 10000 })
    if (await noProducts.isVisible()) { test.skip(); return }

    await placeOrderLinks.first().click()
    await expect(page).toHaveURL(/\/catalog\/\d+/)

    // Check if environments are available (product may have zero environments configured)
    // Scoped to the order form: the buy box has an environment select of its own,
    // so an unscoped label match is ambiguous. (It used to match nothing at all —
    // "Select environment…" is the placeholder option, not the label — so this
    // test always skipped here.)
    const envSelect = page.locator('#order').getByLabel(/environment/i)
    const noEnvText = page.getByText(/no environments|not configured/i)
    await expect(envSelect.or(noEnvText).first()).toBeVisible({ timeout: 5000 })
    if (await noEnvText.isVisible()) { test.skip(); return }

    // Check if there are selectable environment options (not just placeholder)
    const envOptions = envSelect.locator('option').filter({ hasNot: page.locator('[disabled]') })
    const optCount = await envOptions.count()
    if (optCount <= 1) { test.skip(); return } // only placeholder option

    // Select the first real environment
    await envSelect.selectOption({ index: 1 })

    // Select a project if available
    const projectSelect = page.locator('#order').getByLabel(/project/i)
    if (await projectSelect.isVisible()) {
      const projectOptions = projectSelect.locator('option')
      if (await projectOptions.count() > 1) {
        await projectSelect.selectOption({ index: 1 })
      }
    }

    // A required parameter needs a value this test cannot invent per product, so
    // fill the text inputs generically and skip if anything required is still empty.
    const requiredInputs = page.locator('#order input[required]')
    for (let i = 0; i < await requiredInputs.count(); i++) {
      const input = requiredInputs.nth(i)
      if ((await input.inputValue()) === '') await input.fill('e2e-order-flow')
    }

    // Submit the order
    const submitButton = page.locator('#order').getByRole('button', { name: /place order/i })
    if (!await submitButton.isVisible()) { test.skip(); return }
    await submitButton.click()

    // Should redirect to /orders after submission
    await expect(page).toHaveURL(/\/orders/, { timeout: 10000 })
  })

  test('order detail page shows order information', async ({ page }) => {
    await loginAsRoot(page)
    await page.goto('/orders')

    // Wait for orders table
    const table = page.getByRole('table')
    await expect(table).toBeVisible({ timeout: 5000 })

    // Find any order link (#N format)
    const orderLinks = page.getByRole('link').filter({ hasText: /^#\d+$/ })
    const count = await orderLinks.count()
    if (count === 0) { test.skip(); return }

    await orderLinks.first().click()
    // 30s, like auth.setup.ts: the suite runs against `next dev`, which compiles
    // /orders/[id] on first request, and under parallel workers that outlasts the
    // 5s default. (These two tests only started running once the database had
    // orders in it — see issue #89.)
    await expect(page).toHaveURL(/\/orders\/\d+/, { timeout: 30_000 })
    await expectNoServerError(page)

    // Order detail always shows these sections
    await expect(page.getByText(/product/i).first()).toBeVisible()
    await expect(page.getByText(/status/i).first()).toBeVisible()
    await expect(page.getByText(/environment/i).first()).toBeVisible()
    await expect(page.getByRole('link', { name: /back to orders/i })).toBeVisible()
  })

  test('Back to Orders button on order detail navigates to orders list', async ({ page }) => {
    await loginAsRoot(page)
    await page.goto('/orders')

    const orderLinks = page.getByRole('link').filter({ hasText: /^#\d+$/ })
    if (await orderLinks.count() === 0) { test.skip(); return }

    await orderLinks.first().click()
    // 30s, like auth.setup.ts: the suite runs against `next dev`, which compiles
    // /orders/[id] on first request, and under parallel workers that outlasts the
    // 5s default. (These two tests only started running once the database had
    // orders in it — see issue #89.)
    await expect(page).toHaveURL(/\/orders\/\d+/, { timeout: 30_000 })

    await page.getByRole('link', { name: /back to orders/i }).click()
    await expect(page).toHaveURL(/\/orders$/)
  })
})

test.describe('Catalog - Category Filter', () => {
  /**
   * The catalogue's own count line: "N products", or "N / M products" when paged.
   * The line is only rendered when `total > 0` (catalog/page.tsx), so a category
   * holding nothing shows the empty state instead — which is a count of zero, and
   * a perfectly good contribution to the sum below.
   */
  const totalShown = async (page: import('@playwright/test').Page): Promise<number> => {
    const counter = page.getByText(/\d+\s+products/i).first()
    const empty = page.getByText(/no products/i).first()
    await expect(counter.or(empty)).toBeVisible({ timeout: 10000 })
    if ((await counter.count()) === 0) return 0

    const text = (await counter.textContent()) ?? ''
    const match = /(?:(\d+)\s*\/\s*)?(\d+)\s+products/i.exec(text)
    expect(match, `could not read a product count out of "${text}"`).toBeTruthy()
    return Number(match![2])
  }

  /**
   * Issue #154. The old test picked its category button with
   *   page.getByRole('button').filter({ hasNot: page.getByText(/all products|^all$/i) })
   * which matches EVERY button on the page that is not the All pill — the header's
   * search submit, the language switcher, the favourite stars. It clicked whichever
   * came first and then asserted only that the page still rendered tiles, so it
   * never once checked that the product list had been filtered.
   *
   * The invariant asserted instead is one that holds for any catalogue: a product
   * belongs to exactly one category, so the per-category counts must add up to the
   * unfiltered total. That fails loudly if the filter is ignored (every category
   * would report the total), if it over-filters, or if it drops a product.
   */
  test('each category filters the list, and the categories partition it', async ({ page }) => {
    await loginAsRoot(page)
    await page.goto('/catalog')

    const sidebar = page.locator('aside')
    const allProducts = sidebar.getByRole('button', { name: /all products/i })
    await expect(allProducts).toBeVisible({ timeout: 10000 })
    await expect(page.getByRole('link', { name: /^details\b/i }).first()).toBeVisible({
      timeout: 10000,
    })

    const unfiltered = await totalShown(page)
    expect(unfiltered).toBeGreaterThan(0)

    // The first <li> is "All products"; the rest are the categories themselves.
    const items = sidebar.locator('li')
    const categoryCount = (await items.count()) - 1
    expect(categoryCount, 'the seeded catalogue always has at least one category').toBeGreaterThan(0)

    let summed = 0
    for (let i = 1; i <= categoryCount; i++) {
      const settled = page.waitForResponse(
        (r) => r.url().includes('/api/catalog') && r.request().method() === 'GET',
      )
      await items.nth(i).getByRole('button').click()
      await settled
      await expectNoServerError(page)
      summed += await totalShown(page)
    }

    expect(
      summed,
      'the per-category counts must add up to the unfiltered total — a filter that ' +
        'is ignored makes every category report the whole catalogue',
    ).toBe(unfiltered)

    // And the filter can be undone in place.
    const restored = page.waitForResponse(
      (r) => r.url().includes('/api/catalog') && r.request().method() === 'GET',
    )
    await allProducts.click()
    await restored
    expect(await totalShown(page)).toBe(unfiltered)
  })
})
