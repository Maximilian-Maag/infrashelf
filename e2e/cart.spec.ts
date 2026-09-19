import { test, expect } from './fixtures'
import { appears, loginAsRoot, requireSeeded } from './helpers'

// Issue #28. The cart is per user and persisted server-side, so what is asserted
// here is that an added item survives a reload and that checkout's validation gate
// is reachable. Each test cleans up after itself so the run is repeatable.
test.describe('Shopping cart', () => {
  test.beforeEach(async ({ page }) => {
    await loginAsRoot(page)
  })

  /** Add the first catalogue product to the cart. Returns false if none exists. */
  const addFirstProduct = async (page: import('@playwright/test').Page) => {
    await page.goto('/catalog')
    // `^details\b`, not `^details$`: every tile's Details link carries the product
    // name in an sr-only span (WCAG 2.4.9), so its accessible name is "Details: <product>".
    const order = page.getByRole('link', { name: /^details\b/i }).first()
    const noProducts = page.getByText(/no products/i)
    await expect(order.or(noProducts)).toBeVisible({ timeout: 10000 })
    if (await noProducts.isVisible()) return false

    await order.click()
    // Waited for, not counted. `count()` here ran before the product page had
    // rendered and answered 0, so this helper returned false and every test
    // using it skipped — the `toBeVisible` below would have waited, but it came
    // one line too late (#332).
    const addButton = page.getByRole('button', { name: /add to cart/i })
    if (!(await appears(addButton))) return false

    // The environment select next to Add to cart; skip when nothing is offered.
    const envSelect = page.locator('form, div').filter({ has: addButton }).last().getByLabel(/environment/i).first()
    const options = await envSelect.locator('option:not([value=""])').count()
    if (options === 0) return false
    await envSelect.selectOption({ index: 1 })

    await addButton.click()
    await expect(page.getByText(/added to cart/i)).toBeVisible({ timeout: 8000 })
    return true
  }

  test('the cart is reachable from the navigation', async ({ page }) => {
    await page.goto('/')
    await page.getByRole('link', { name: /^cart$/i }).first().click()
    await expect(page).toHaveURL(/\/cart/)
    await expect(page.getByRole('heading', { name: /^cart$/i })).toBeVisible({ timeout: 8000 })
  })

  test('an empty cart says so instead of showing a checkout form', async ({ page }) => {
    await page.goto('/cart')
    const empty = page.getByText(/your cart is empty/i)
    const checkout = page.getByRole('button', { name: /check out/i })
    await expect(empty.or(checkout)).toBeVisible({ timeout: 10000 })
    if (await empty.isVisible()) {
      await expect(checkout).toHaveCount(0)
    }
  })

  test('the product page offers Add to cart alongside the order form', async ({ page }) => {
    await page.goto('/catalog')
    const order = page.getByRole('link', { name: /^details\b/i }).first()
    const noProducts = page.getByText(/no products/i)
    await expect(order.or(noProducts)).toBeVisible({ timeout: 10000 })
    requireSeeded(!(await noProducts.isVisible()), 'no product on /catalog to open')

    await order.click()
    // Both paths are offered: collect for later, or order right now.
    await expect(page.getByRole('button', { name: /add to cart/i })).toBeVisible({ timeout: 10000 })
    await expect(page.getByRole('button', { name: /place order/i })).toBeVisible()
  })

  test('an added item persists across a reload and can be removed', async ({ page }) => {
    requireSeeded(await addFirstProduct(page), 'nothing on /catalog could be added to the cart')

    await page.goto('/cart')
    const firstItem = page.locator('[data-testid^="cart-item-"]').first()
    await expect(firstItem).toBeVisible({ timeout: 10000 })

    await page.reload()
    await expect(page.locator('[data-testid^="cart-item-"]').first()).toBeVisible({ timeout: 10000 })

    // Clean up, which also exercises removal.
    await page.getByRole('button', { name: /empty cart/i }).click()
    await expect(page.getByText(/your cart is empty/i)).toBeVisible({ timeout: 8000 })
  })

  test('checkout needs a project chosen first', async ({ page }) => {
    requireSeeded(await addFirstProduct(page), 'nothing on /catalog could be added to the cart')

    await page.goto('/cart')
    const checkout = page.getByRole('button', { name: /check out/i })
    await expect(checkout).toBeVisible({ timeout: 10000 })

    const projectSelect = page.getByLabel(/^project/i)
    const chosen = await projectSelect.inputValue()
    if (chosen === '') {
      // With several projects nothing is preselected, so checkout stays inert.
      await expect(checkout).toBeDisabled()
    }

    await page.getByRole('button', { name: /empty cart/i }).click()
    await expect(page.getByText(/your cart is empty/i)).toBeVisible({ timeout: 8000 })
  })

  /*
   * Issue #501: the per-line Remove was a real button in the middle of the row
   * with its own horizontal padding zeroed, so the only control that looked like
   * one was "Empty cart" — and every test above cleans up with THAT, including the
   * one whose name says "can be removed". The placement in this test is measured,
   * not asserted by convention: it is the whole of the bug and jsdom has no layout.
   */
  test('a line is removed by a control that reads as one, at the row edge', async ({ page }) => {
    requireSeeded(await addFirstProduct(page), 'nothing on /catalog could be added to the cart')

    await page.goto('/cart')
    const row = page.locator('[data-testid^="cart-item-"]').first()
    await expect(row).toBeVisible({ timeout: 10000 })

    const rowId = await row.getAttribute('data-testid')
    const remove = row.getByRole('button', { name: /^remove:/i })
    await expect(remove).toBeVisible()

    // Trailing edge of the row, level with the top of it — not mid-row under the
    // quantity field, which is where a shopper stopped finding it.
    const [removeBox, nameBox, quantityBox] = await Promise.all([
      remove.boundingBox(),
      row.getByRole('link').first().boundingBox(),
      row.getByLabel(/quantity/i).boundingBox(),
    ])
    expect(removeBox!.x).toBeGreaterThan(nameBox!.x)
    expect(removeBox!.y).toBeLessThan(quantityBox!.y)

    // WCAG 2.5.5 needs a 44px target; giving the padding back must not have cost
    // it, which is what zeroing it was probably working around.
    expect(removeBox!.height).toBeGreaterThanOrEqual(44)

    await remove.click()
    await expect(page.locator(`[data-testid="${rowId}"]`)).toHaveCount(0, { timeout: 8000 })

    // Repeatable: the cart is shared per user and other specs add to it.
    const emptyCart = page.getByRole('button', { name: /empty cart/i })
    if (await appears(emptyCart)) {
      await emptyCart.click()
      await expect(page.getByText(/your cart is empty/i)).toBeVisible({ timeout: 8000 })
    }
  })
})
