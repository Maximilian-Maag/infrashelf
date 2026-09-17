import { test, expect } from './fixtures'
import { loginAsRoot } from './helpers'

/**
 * The Foreman comparison screen (#111), through the browser.
 *
 * The seeded database has no Foreman integration, and that is what makes this
 * test worth running rather than a reason to skip it: the refusal is the path an
 * operator hits first, and it has to arrive as a sentence they can act on rather
 * than as an empty report that reads like a clean estate.
 */
test.describe('Admin - Foreman reconciliation', () => {
  test.beforeEach(async ({ page }) => {
    await loginAsRoot(page)
    await page.goto('/admin/integrations/foreman')
    await expect(page.getByRole('heading', { name: /foreman reconciliation/i, level: 1 })).toBeVisible({
      timeout: 8000,
    })
  })

  test('waits to be asked rather than reconciling on load', async ({ page }) => {
    await expect(page.getByText(/choose an environment and run the comparison/i)).toBeVisible()
    // Nothing to run against yet, so the button cannot be pressed by accident.
    await expect(page.getByRole('button', { name: /run reconciliation/i })).toBeDisabled()
  })

  test('says why the comparison cannot be made when no Foreman is configured', async ({ page }) => {
    const select = page.getByLabel(/^environment/i)
    await select.selectOption({ index: 1 })
    await page.getByRole('button', { name: /run reconciliation/i }).click()

    // 409 from the API, and the sentence names what to do about it.
    await expect(page.getByText(/no foreman integration is available/i)).toBeVisible({ timeout: 15000 })
    // And no report is rendered beside the refusal — an empty comparison would
    // read as an estate with nothing wrong with it.
    await expect(page.getByRole('heading', { name: /not ordered here/i })).not.toBeVisible()
  })
})
