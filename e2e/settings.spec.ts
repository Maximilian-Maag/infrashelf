import { test, expect, type APIRequestContext } from '@playwright/test'
import { loginAsRoot, expectNoServerError } from './helpers'
import { apiAsRoot, expectOk } from './api'

/**
 * Issue #156. The profile test used to rename the root user — the account every
 * other spec signs in as and whose name the dashboard greets — and put nothing
 * back. It hid that by re-saving the CURRENT name, which is a no-op that also
 * cannot tell a working Save from one that throws its input away.
 *
 * So the name is captured once, a real change is made, and the original is
 * restored afterwards.
 */
let root: APIRequestContext
let originalName: string

test.beforeAll(async () => {
  root = await apiAsRoot()
  originalName = (
    (await (await expectOk(await root.get('/api/users/me'), 'read profile')).json()) as {
      name: string
    }
  ).name
})

test.afterAll(async () => {
  await root.put('/api/users/me', { data: { name: originalName } })
  await root.dispose()
})

test.describe('Settings', () => {
  test.beforeEach(async ({ page }) => {
    await loginAsRoot(page)
    await page.goto('/settings')
  })

  test('settings page loads without error', async ({ page }) => {
    await expect(page).not.toHaveURL(/\/login/)
    await expectNoServerError(page)
  })

  test('shows Profile section', async ({ page }) => {
    await expect(page.getByRole('heading', { name: /^profile$/i })).toBeVisible()
  })

  test('shows Email field that is disabled', async ({ page }) => {
    const emailInput = page.getByLabel(/^email$/i)
    await expect(emailInput).toBeVisible()
    await expect(emailInput).toBeDisabled()
  })

  test('shows Name field that is editable', async ({ page }) => {
    const nameInput = page.getByLabel(/^name/i).first()
    await expect(nameInput).toBeVisible()
    await expect(nameInput).toBeEnabled()
  })

  test('shows Save Profile button', async ({ page }) => {
    await expect(page.getByRole('button', { name: /save profile/i })).toBeVisible()
  })

  test('shows Change Password section', async ({ page }) => {
    await expect(page.getByRole('heading', { name: /change password/i })).toBeVisible()
  })

  test('shows Current Password field', async ({ page }) => {
    await expect(page.getByLabel(/current password/i)).toBeVisible()
  })

  test('shows New Password field', async ({ page }) => {
    await expect(page.getByLabel(/^new password/i)).toBeVisible()
  })

  test('shows Confirm New Password field', async ({ page }) => {
    await expect(page.getByLabel(/confirm new password/i)).toBeVisible()
  })

  test('shows Change Password button', async ({ page }) => {
    await expect(page.getByRole('button', { name: /^change password$/i })).toBeVisible()
  })

  test('mismatched passwords show error message', async ({ page }) => {
    await page.getByLabel(/current password/i).fill('currentpass')
    await page.getByLabel(/^new password/i).fill('newpassword1')
    await page.getByLabel(/confirm new password/i).fill('differentpassword')
    await page.getByRole('button', { name: /^change password$/i }).click()
    await expect(page.getByText(/passwords do not match/i)).toBeVisible()
  })

  test('updating the profile name saves it', async ({ page }) => {
    const changed = `${originalName} (e2e)`
    await page.getByLabel(/^name/i).first().fill(changed)
    await page.getByRole('button', { name: /save profile/i }).click()
    await expect(page.getByText(/profile updated/i)).toBeVisible({ timeout: 10000 })

    // "Updated" is a toast. Whether anything was stored is the actual claim, and
    // re-saving the existing name — which is what this used to do — could never
    // have distinguished the two.
    await page.reload()
    await expect(page.getByLabel(/^name/i).first()).toHaveValue(changed, { timeout: 15000 })

    // Put it back immediately rather than only in afterAll: the name is rendered
    // in the header of every page, and the tests after this one share the stack.
    await expectOk(
      await root.put('/api/users/me', { data: { name: originalName } }),
      'restore the profile name',
    )
  })

  // ── Active sessions (#37) ──────────────────────────────────────────────────

  test('shows the Active sessions card with this session in it', async ({ page }) => {
    await expect(page.getByRole('heading', { name: /active sessions/i })).toBeVisible()
    // The session doing the looking is always in the list, and always labelled:
    // it is the one row that must not offer a sign-out button.
    await expect(page.getByText(/this device/i)).toBeVisible()
  })

  test('does not offer to sign the current session out of itself', async ({ page }) => {
    const row = page.getByRole('row').filter({ hasText: /this device/i })
    await expect(row).toHaveCount(1)
    await expect(row.getByRole('button')).toHaveCount(0)
  })

  test('never renders the session token or its hash', async ({ page }) => {
    // Only a digest is stored and the digest is not served either; a 64-character
    // hex string anywhere on this page would mean one of those two broke.
    const card = page.locator('main')
    await expect(card).not.toContainText(/\b[0-9a-f]{64}\b/)
  })

  test('wrong current password shows an error on password change', async ({ page }) => {
    await page.getByLabel(/current password/i).fill('wrongpassword')
    await page.getByLabel(/^new password/i).fill('NewPassword123!')
    await page.getByLabel(/confirm new password/i).fill('NewPassword123!')
    await page.getByRole('button', { name: /^change password$/i }).click()
    // The backend rejects a wrong current password — some error message appears
    await expect(
      page.getByText(/invalid|incorrect|wrong|unauthorized|failed/i)
    ).toBeVisible({ timeout: 8000 })
  })
})
