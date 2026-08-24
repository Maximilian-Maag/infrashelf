import { test, expect, type APIRequestContext } from '@playwright/test'
import { loginAsRoot } from './helpers'
import { apiAsRoot, tryDelete } from './api'

/**
 * Issue #156. The callback-secret test below created a CI source AND a deployment
 * environment and deleted neither, so every run — local and CI — added two more
 * global rows for the next run's list assertions to sift through.
 *
 * Two changes fix that. The names are fixed strings under one prefix rather than
 * clock-derived ones, so a run that dies mid-test leaves rows the NEXT run reuses
 * instead of adding to a pile; and the fixtures are swept through the API before
 * and after every test, whatever the browser managed to do.
 *
 * (The clock-derived names had a second cost. `E2E Env CB 1787319807500` once
 * failed a green build against an unrelated `not.toContainText('500')`, because a
 * timestamp is thirteen digits of anything. That assertion has since been replaced
 * — see `expectNoServerError` in e2e/helpers.ts — but naming a fixture after the
 * clock is what put the digits on the page in the first place.)
 */

/** Everything this file creates is named with this prefix, and swept on it. */
const FIXTURE_PREFIX = 'E2E Env Spec'

let root: APIRequestContext

const sweepFixtures = async () => {
  // Environments first: a CI source cannot be deleted while one refers to it.
  for (const collection of ['/api/admin/environments', '/api/admin/ci-sources']) {
    const res = await root.get(collection)
    if (!res.ok()) continue
    const rows = (await res.json()) as { id: number; name: string }[]
    for (const row of rows.filter((r) => r.name.startsWith(FIXTURE_PREFIX))) {
      await tryDelete(root, `${collection}/${row.id}`)
    }
  }
}

test.beforeAll(async () => {
  root = await apiAsRoot()
})

test.afterAll(async () => {
  await root.dispose()
})

test.describe('Admin - Environment Management', () => {
  test.beforeEach(async ({ page }) => {
    // Before, not only after: a fixed name is only safe if leftovers are cleared
    // first, and this is what makes a run that died mid-test self-healing.
    await sweepFixtures()
    await loginAsRoot(page)
    await page.goto('/admin/environments')
    await expect(page.getByRole('button', { name: /add environment/i })).toBeVisible({ timeout: 8000 })
  })

  // The create/edit/delete test removes its own rows through the UI — that IS the
  // test. This catches what a failure on the way there left behind.
  test.afterEach(async () => {
    await sweepFixtures()
  })

  test('environments page shows title and Add Environment button', async ({ page }) => {
    await expect(page.getByRole('heading', { name: /deployment environments/i, level: 1 })).toBeVisible()
    await expect(page.getByRole('button', { name: /add environment/i })).toBeVisible()
  })

  test('Add Environment modal has Name, CI Source, and URL fields', async ({ page }) => {
    await page.getByRole('button', { name: /add environment/i }).click()
    const dialog = page.locator('dialog[open]')
    await expect(dialog.getByLabel(/^name/i)).toBeVisible()
    await expect(dialog.getByLabel(/ci source/i)).toBeVisible()
    await expect(dialog.getByLabel(/webhook url/i)).toBeVisible()
    await expect(dialog.getByRole('button', { name: /^save$/i })).toBeVisible()
  })

  test('can create, edit and delete an environment when a CI source exists', async ({ page }) => {
    // First ensure a CI source exists (create one via UI if needed)
    await page.goto('/admin/ci-sources')
    await expect(page.getByRole('button', { name: /add ci source/i })).toBeVisible({ timeout: 8000 })

    const ciName = `${FIXTURE_PREFIX} CI (crud)`

    // Create a CI source for the environment to use
    await page.getByRole('button', { name: /add ci source/i }).click()
    const ciDialog = page.locator('dialog[open]')
    await ciDialog.getByLabel(/^name/i).fill(ciName)
    await ciDialog.getByLabel(/^url/i).fill('https://gitlab.example.com')
    await ciDialog.getByLabel(/^access token/i).fill('glpat-token')
    await ciDialog.getByRole('button', { name: /^save$/i }).click()
    await expect(page.getByText(ciName)).toBeVisible({ timeout: 8000 })

    // Now go to environments
    await page.goto('/admin/environments')
    await expect(page.getByRole('button', { name: /add environment/i })).toBeVisible({ timeout: 8000 })

    const envName = `${FIXTURE_PREFIX} (crud)`

    // --- Create environment ---
    await page.getByRole('button', { name: /add environment/i }).click()
    const addDialog = page.locator('dialog[open]')
    await addDialog.getByLabel(/^name/i).fill(envName)
    // Select the CI source we just created
    const ciSelect = addDialog.getByLabel(/ci source/i)
    await ciSelect.selectOption({ label: ciName })
    await addDialog.getByLabel(/webhook url/i).fill('https://gitlab.example.com/api/v4/projects/1/trigger/pipeline')
    await addDialog.getByLabel(/webhook token/i).fill('test-token')
    await addDialog.getByRole('button', { name: /^save$/i }).click()
    await expect(page.locator('dialog[open]')).not.toBeVisible({ timeout: 8000 })
    await expect(page.getByText(envName)).toBeVisible({ timeout: 8000 })

    // --- Edit environment ---
    const envRow = page.locator('div').filter({ has: page.getByText(envName) }).filter({ has: page.getByRole('button', { name: /^edit$/i }) }).last()
    await envRow.getByRole('button', { name: /^edit$/i }).click()
    const editDialog = page.locator('dialog[open]')
    const updatedEnvName = `${envName} Updated`
    await editDialog.getByLabel(/^name/i).fill(updatedEnvName)
    await editDialog.getByRole('button', { name: /^save$/i }).click()
    await expect(page.locator('dialog[open]')).not.toBeVisible({ timeout: 8000 })
    await expect(page.getByText(updatedEnvName)).toBeVisible({ timeout: 8000 })

    // --- Delete environment ---
    const updatedEnvRow = page.locator('div').filter({ has: page.getByText(updatedEnvName) }).filter({ has: page.getByRole('button', { name: /^delete$/i }) }).last()
    await updatedEnvRow.getByRole('button', { name: /^delete$/i }).click()
    await expect(page.getByRole('heading', { name: /delete environment/i })).toBeVisible()
    await page.getByRole('button', { name: /^delete$/i }).last().click()
    await expect(page.locator('dialog[open]')).not.toBeVisible({ timeout: 8000 })
    await expect(page.getByText(updatedEnvName)).not.toBeVisible({ timeout: 8000 })

    // --- Clean up CI source ---
    await page.goto('/admin/ci-sources')
    await expect(page.getByText(ciName)).toBeVisible({ timeout: 8000 })
    const ciRow = page.locator('div').filter({ has: page.getByText(ciName) }).filter({ has: page.getByRole('button', { name: /^delete$/i }) }).last()
    await ciRow.getByRole('button', { name: /^delete$/i }).click()
    await page.getByRole('button', { name: /^delete$/i }).last().click()
    await expect(page.locator('dialog[open]')).not.toBeVisible({ timeout: 8000 })
  })

  // Migration 0004: callback secret is portal-generated and rotatable
  // independently from the outbound trigger token. Verify the Edit modal
  // exposes Reveal + Regenerate, and that Regenerate produces a fresh
  // `ohc-cb-<hex>` value that persists on re-reveal.
  test('Edit modal reveals and regenerates the callback secret', async ({ page }) => {
    // Ensure at least one CI source + one environment exist
    await page.goto('/admin/ci-sources')
    await expect(page.getByRole('button', { name: /add ci source/i })).toBeVisible({ timeout: 8000 })
    const ciName = `${FIXTURE_PREFIX} CI (callback)`
    await page.getByRole('button', { name: /add ci source/i }).click()
    let dialog = page.locator('dialog[open]')
    await dialog.getByLabel(/^name/i).fill(ciName)
    await dialog.getByLabel(/^url/i).fill('https://gitlab.example.com')
    await dialog.getByLabel(/^access token/i).fill('glpat-token')
    await dialog.getByRole('button', { name: /^save$/i }).click()
    await expect(page.getByText(ciName)).toBeVisible({ timeout: 8000 })

    await page.goto('/admin/environments')
    const envName = `${FIXTURE_PREFIX} CB (callback)`
    await page.getByRole('button', { name: /add environment/i }).click()
    dialog = page.locator('dialog[open]')
    await dialog.getByLabel(/^name/i).fill(envName)
    await dialog.getByLabel(/ci source/i).selectOption({ label: ciName })
    await dialog.getByLabel(/webhook url/i).fill('https://gitlab.example.com/api/v4/projects/1/trigger/pipeline')
    await dialog.getByLabel(/webhook token/i).fill('glptt-outbound-only')
    await dialog.getByRole('button', { name: /^save$/i }).click()
    await expect(page.getByText(envName)).toBeVisible({ timeout: 8000 })

    // Open Edit
    const envRow = page.locator('div').filter({ has: page.getByText(envName) }).filter({ has: page.getByRole('button', { name: /^edit$/i }) }).last()
    await envRow.getByRole('button', { name: /^edit$/i }).click()
    dialog = page.locator('dialog[open]')
    await expect(dialog.getByText(/callback secret/i)).toBeVisible()

    // Reveal current secret
    await dialog.getByRole('button', { name: /reveal current/i }).click()
    const revealed = dialog.locator('input[readonly]')
    await expect(revealed).toBeVisible({ timeout: 5000 })
    const firstValue = await revealed.inputValue()
    expect(firstValue).toMatch(/^ohc-cb-[0-9a-f]{64}$/)

    // Regenerate — the edit modal's Regenerate opens a confirmation modal
    // (the app uses a Modal, not a native confirm()); confirm it there.
    await dialog.getByRole('button', { name: /^regenerate$/i }).click()
    const regenConfirm = page.getByRole('dialog', { name: /regenerate callback secret/i })
    await regenConfirm.getByRole('button', { name: /^regenerate$/i }).click()
    // New value replaces old one
    await expect.poll(async () => await revealed.inputValue()).not.toBe(firstValue)
    const newValue = await revealed.inputValue()
    expect(newValue).toMatch(/^ohc-cb-[0-9a-f]{64}$/)

    // Close + reopen the modal to confirm the new value is persisted
    await dialog.getByRole('button', { name: /^cancel$/i }).click()
    await envRow.getByRole('button', { name: /^edit$/i }).click()
    dialog = page.locator('dialog[open]')
    await dialog.getByRole('button', { name: /reveal current/i }).click()
    await expect(dialog.locator('input[readonly]')).toHaveValue(newValue, { timeout: 5000 })
  })
})
