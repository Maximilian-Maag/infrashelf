import { test, expect } from './fixtures'
import { loginAsRoot } from './helpers'

/**
 * The integration registry (#111), through the browser.
 *
 * The unit tests pin the wire bodies; what only a real run can show is that the
 * page is reachable as root, that the form the API requires can actually be
 * filled in — the failure mode has no default, so a create that never picks one
 * is refused — and that a probe against a system nobody can reach reports it
 * rather than failing the request.
 */
test.describe('Admin - Integrations', () => {
  test.beforeEach(async ({ page }) => {
    await loginAsRoot(page)
    await page.goto('/admin/integrations')
    await expect(page.getByRole('button', { name: /add integration/i })).toBeVisible({ timeout: 8000 })
  })

  test('integrations page shows its title and the add button', async ({ page }) => {
    await expect(page.getByRole('heading', { name: /integrations/i, level: 1 })).toBeVisible()
    await expect(page.getByRole('button', { name: /add integration/i })).toBeVisible()
  })

  test('the add dialog carries the system, URL, binding and failure mode', async ({ page }) => {
    await page.getByRole('button', { name: /add integration/i }).click()
    const dialog = page.locator('dialog[open]')
    await expect(dialog.getByLabel(/^system/i)).toBeVisible()
    await expect(dialog.getByLabel(/^name/i)).toBeVisible()
    await expect(dialog.getByLabel(/^url/i)).toBeVisible()
    await expect(dialog.getByLabel(/^environment/i)).toBeVisible()
    await expect(dialog.getByLabel(/^authentication/i)).toBeVisible()
    await expect(dialog.getByLabel(/^on failure/i)).toBeVisible()
    // Nothing is preselected: the column exists so that somebody decided it.
    await expect(dialog.getByLabel(/^on failure/i)).toHaveValue('')
  })

  test('can create, probe and delete an integration', async ({ page }) => {
    const name = `E2E Foreman ${Date.now()}`

    // --- Create. Bound to nothing, because a portal-wide row of this kind is
    // the one shape that cannot collide with an environment-bound one. ---
    await page.getByRole('button', { name: /add integration/i }).click()
    const addDialog = page.locator('dialog[open]')
    await addDialog.getByLabel(/^system/i).selectOption('foreman')
    await addDialog.getByLabel(/^name/i).fill(name)
    // A port nothing is listening on: the probe has to come back as "not
    // reachable" rather than as a failed request, and that is the point of it.
    await addDialog.getByLabel(/^url/i).fill('http://127.0.0.1:9')
    await addDialog.getByLabel(/^authentication/i).selectOption('none')
    await addDialog.getByLabel(/^on failure/i).selectOption('best_effort')
    await addDialog.getByRole('button', { name: /^save$/i }).click()
    await expect(page.locator('dialog[open]')).not.toBeVisible({ timeout: 8000 })
    await expect(page.getByText(name)).toBeVisible({ timeout: 8000 })

    const row = page
      .locator('div')
      .filter({ has: page.getByText(name) })
      .filter({ has: page.getByRole('button', { name: /^test connection$/i }) })
      .last()

    // --- Probe. Unreachable is an answer, not an error. ---
    await row.getByRole('button', { name: /^test connection$/i }).click()
    await expect(row.getByText(/not reachable/i)).toBeVisible({ timeout: 15000 })
    // And the row is still there: a failed probe records health, it does not
    // remove or disable anything.
    await expect(page.getByText(name)).toBeVisible()

    // --- Delete ---
    await row.getByRole('button', { name: /^delete$/i }).click()
    await expect(page.getByRole('heading', { name: /delete integration/i })).toBeVisible()
    await page.getByRole('button', { name: /^delete$/i }).last().click()
    await expect(page.locator('dialog[open]')).not.toBeVisible({ timeout: 8000 })
    await expect(page.getByText(name)).not.toBeVisible({ timeout: 8000 })
  })
})
