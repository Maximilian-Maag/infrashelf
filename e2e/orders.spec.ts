import { test, expect } from '@playwright/test'
import { loginAsRoot, expectNoServerError } from './helpers'

test.describe('Orders', () => {
  test.beforeEach(async ({ page }) => {
    await loginAsRoot(page)
    await page.goto('/orders')
  })

  test('orders page loads without error', async ({ page }) => {
    await expect(page).not.toHaveURL(/\/login/)
    await expectNoServerError(page)
  })

  test('shows page title "Orders"', async ({ page }) => {
    await expect(page.getByRole('heading', { name: /^orders$/i })).toBeVisible()
  })

  test('shows orders subtitle', async ({ page }) => {
    await expect(page.getByText(/view and manage your infrastructure orders/i)).toBeVisible()
  })

  test('shows orders table structure', async ({ page }) => {
    // The Table component always renders a <table> even when empty
    await expect(page.getByRole('table')).toBeVisible()
  })

  test('shows table column headers', async ({ page }) => {
    const table = page.getByRole('table')
    await expect(table).toBeVisible()
    // Check all 6 column headers are rendered in the table
    await expect(table.getByRole('columnheader').nth(0)).toBeVisible()
    await expect(table.getByRole('columnheader').nth(1)).toBeVisible()
    await expect(table.getByRole('columnheader').nth(2)).toBeVisible()
    await expect(table.getByRole('columnheader').nth(3)).toBeVisible()
    await expect(table.getByRole('columnheader').nth(4)).toBeVisible()
    await expect(table.getByRole('columnheader').nth(5)).toBeVisible()
  })

  test('shows empty state message or order rows', async ({ page }) => {
    // The table renders either data rows or a "No orders yet." cell
    const table = page.getByRole('table')
    await expect(table).toBeVisible()
    await expect(table.getByRole('row').first()).toBeVisible()
  })

  // Issue #154. This was `if (count > 0) { … }` with no `else`: on CI's empty
  // database it clicked nothing, asserted nothing and reported passed. The seeded
  // catalogue always has orders — three of them, in three different states (see
  // apps/backend/src/lib/bootstrap/demo.ts) — so "there might not be any" is not a
  // state this can be in any more.
  test('an order row links to that order, not merely to an order', async ({ page }) => {
    const orderLinks = page.getByRole('link').filter({ hasText: /^#\d+$/ })
    await expect(orderLinks.first()).toBeVisible({ timeout: 10000 })

    const label = ((await orderLinks.first().textContent()) ?? '').trim()
    expect(label).toMatch(/^#\d+$/)

    await orderLinks.first().click()
    // 30s, like auth.setup.ts: `next dev` compiles /orders/[id] on first request.
    await expect(page).toHaveURL(new RegExp(`/orders/${label.slice(1)}$`), { timeout: 30_000 })
    await expect(page.getByRole('heading', { name: /order details/i })).toBeVisible({
      timeout: 10000,
    })
  })
})

// Issue #34. Root can write internal notes, so this run exercises both kinds and
// cleans up after itself.
test.describe('Order comments', () => {
  test.beforeEach(async ({ page }) => {
    await loginAsRoot(page)
  })

  const openFirstOrder = async (page: import('@playwright/test').Page) => {
    await page.goto('/orders')
    const detailLinks = page.getByRole('link', { name: /^#\d+$/ })
    const noOrders = page.getByText(/no orders/i)
    await expect(detailLinks.first().or(noOrders)).toBeVisible({ timeout: 10000 })
    if (await noOrders.isVisible()) return false
    await detailLinks.first().click()
    await expect(page.getByRole('heading', { name: /comments/i })).toBeVisible({ timeout: 10000 })
    return true
  }

  test('the order detail page carries a comment thread', async ({ page }) => {
    if (!(await openFirstOrder(page))) { test.skip(); return }

    await expect(page.getByLabel(/add comment/i)).toBeVisible()
    // Empty box, nothing to post.
    await expect(page.getByRole('button', { name: /add comment/i })).toBeDisabled()
  })

  test('a posted comment appears immediately and survives a reload', async ({ page }) => {
    if (!(await openFirstOrder(page))) { test.skip(); return }

    const body = `e2e comment ${Date.now()}`
    await page.getByLabel(/add comment/i).fill(body)
    await page.getByRole('button', { name: /add comment/i }).click()

    await expect(page.getByText(body)).toBeVisible({ timeout: 8000 })
    await page.reload()
    await expect(page.getByText(body)).toBeVisible({ timeout: 10000 })

    // Clean up, which also exercises delete.
    const item = page.locator('li').filter({ hasText: body })
    await item.getByRole('button', { name: /delete/i }).click()
    await expect(page.getByText(body)).toHaveCount(0, { timeout: 8000 })
  })

  test('an edited comment is marked as edited', async ({ page }) => {
    if (!(await openFirstOrder(page))) { test.skip(); return }

    const body = `e2e edit ${Date.now()}`
    await page.getByLabel(/add comment/i).fill(body)
    await page.getByRole('button', { name: /add comment/i }).click()
    await expect(page.getByText(body)).toBeVisible({ timeout: 8000 })

    const item = page.locator('li').filter({ hasText: body })
    await item.getByRole('button', { name: /edit/i }).click()
    const editBox = item.getByRole('textbox')
    await editBox.fill(`${body} revised`)
    await item.getByRole('button', { name: /save changes/i }).click()

    // Shown as edited rather than silently rewritten under a reader who replied.
    await expect(page.locator('li').filter({ hasText: `${body} revised` }).getByText(/\(edited\)/i))
      .toBeVisible({ timeout: 8000 })

    await page.locator('li').filter({ hasText: `${body} revised` })
      .getByRole('button', { name: /delete/i }).click()
    await expect(page.getByText(`${body} revised`)).toHaveCount(0, { timeout: 8000 })
  })

  test('root can post an internal note and it is labelled as one', async ({ page }) => {
    if (!(await openFirstOrder(page))) { test.skip(); return }

    const body = `e2e internal ${Date.now()}`
    await page.getByLabel(/add comment/i).fill(body)
    await page.getByLabel(/internal note/i).check()
    await page.getByRole('button', { name: /add comment/i }).click()

    const item = page.locator('li').filter({ hasText: body })
    await expect(item.getByText(/internal note/i)).toBeVisible({ timeout: 8000 })
    // The toggle resets, so the next comment does not silently inherit it.
    await expect(page.getByLabel(/internal note/i)).not.toBeChecked()

    await item.getByRole('button', { name: /delete/i }).click()
    await expect(page.getByText(body)).toHaveCount(0, { timeout: 8000 })
  })
})

// Issue #38. The order detail page renders from the snapshot taken at order time,
// so it reports what was approved rather than today's catalogue.
test.describe('Order product snapshot', () => {
  test('the detail page says which configuration it is showing', async ({ page }) => {
    await loginAsRoot(page)
    await page.goto('/orders')
    const detailLinks = page.getByRole('link', { name: /^#\d+$/ })
    const noOrders = page.getByText(/no orders/i)
    await expect(detailLinks.first().or(noOrders)).toBeVisible({ timeout: 10000 })
    if (await noOrders.isVisible()) { test.skip(); return }

    await detailLinks.first().click()
    await expect(page.getByRole('heading', { name: /order details/i })).toBeVisible({ timeout: 10000 })

    // Either the order has a snapshot and says the values are from order time, or
    // it predates snapshots and says that instead. Silence would be the bug.
    const asOrdered = page.getByText(/values are from the moment the order was placed/i)
    const noSnapshot = page.getByText(/predates snapshots/i)
    await expect(asOrdered.or(noSnapshot)).toBeVisible()
  })
})
