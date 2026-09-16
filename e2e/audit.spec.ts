import { test, expect } from './fixtures'
import { loginAsRoot, expectNoServerError } from './helpers'

test.describe('Audit log', () => {
  test.beforeEach(async ({ page }) => {
    await loginAsRoot(page)
    await page.goto('/audit')
  })

  test('audit page loads without error', async ({ page }) => {
    await expect(page).not.toHaveURL(/\/login/)
    await expectNoServerError(page)
  })

  test('shows page title "Audit Log"', async ({ page }) => {
    await expect(page.getByRole('heading', { name: /audit log/i })).toBeVisible()
  })

  test('shows audit subtitle', async ({ page }) => {
    await expect(page.getByText(/track all actions and changes/i)).toBeVisible()
  })

  test('shows User ID filter input', async ({ page }) => {
    await expect(page.getByLabel(/user id/i)).toBeVisible()
  })

  test('shows Action filter input with placeholder Any', async ({ page }) => {
    await expect(page.getByLabel(/^action$/i)).toBeVisible()
    await expect(page.getByLabel(/^action$/i)).toHaveAttribute('placeholder', 'Any')
  })

  test('shows From date filter', async ({ page }) => {
    await expect(page.getByLabel(/^from$/i)).toBeVisible()
    await expect(page.getByLabel(/^from$/i)).toHaveAttribute('type', 'date')
  })

  test('shows To date filter', async ({ page }) => {
    await expect(page.getByLabel(/^to$/i)).toBeVisible()
    await expect(page.getByLabel(/^to$/i)).toHaveAttribute('type', 'date')
  })

  test('shows Export CSV button', async ({ page }) => {
    await expect(page.getByRole('button', { name: /export csv/i })).toBeVisible()
  })

  test('shows Export PDF button', async ({ page }) => {
    await expect(page.getByRole('button', { name: /export pdf/i })).toBeVisible()
  })

  test('shows table with expected column headers when entries exist', async ({ page }) => {
    // Table is always rendered (even when empty), so just check it's visible
    const table = page.getByRole('table')
    await expect(table).toBeVisible()

    // Only check column headers if there are actual data rows (not just the empty-state row)
    const hasEntries = !(await page.getByText(/no audit entries found/i).isVisible())
    if (hasEntries) {
      await expect(page.getByRole('columnheader', { name: /^id$/i })).toBeVisible()
      await expect(page.getByRole('columnheader', { name: /^user$/i })).toBeVisible()
      await expect(page.getByRole('columnheader', { name: /^action$/i })).toBeVisible()
      await expect(page.getByRole('columnheader', { name: /^entity$/i })).toBeVisible()
      await expect(page.getByRole('columnheader', { name: /^details$/i })).toBeVisible()
      await expect(page.getByRole('columnheader', { name: /^date$/i })).toBeVisible()
    }
  })

  /*
   * The pager is links now, not buttons (#471).
   *
   * Its predecessor read `page.getByRole('button', { name: /next/i })` at
   * document level, which also matches the dev-tools button `next dev` injects
   * into every page. That button is always there, so the guard was reporting on
   * the overlay rather than on the table — whenever the overlay happened to
   * mount first the body ran against a table with no pagination and failed on a
   * Previous that was never rendered, and the rest of the time the assertion did
   * not run at all. It had therefore never once checked what it is named after.
   *
   * What is worth asserting has changed with the mechanism: page two used to be
   * component state, so all it could show was that a counter moved. It is a URL
   * now, which is the point of the change — a filtered page of the audit log is
   * something one administrator sends another — so that is what this checks.
   */
  test('pagination pages through the log when there is more than one page', async ({ page }) => {
    const rows = page.getByRole('row')
    await expect(rows.first()).toBeVisible({ timeout: 15_000 })

    const next = page.getByRole('link', { name: /next/i })

    // No pager is a legitimate state, not a reason to skip: it means the log fits
    // on one page, and that is worth asserting rather than shrugging at. A pager
    // that failed to render over 20+ entries would otherwise read as "fits on one
    // page" for ever.
    if ((await next.count()) === 0) {
      expect(await rows.count(), 'no pager, so the log must fit on one page').toBeLessThanOrEqual(21)
      // Page one is the bare URL, and nothing may have put an offset on it.
      await expect(page).toHaveURL(/\/audit$/)
      return
    }

    // Previous is absent on page one rather than disabled: a disabled <a> is not
    // a thing the platform has.
    await expect(page.getByRole('link', { name: /previous/i })).toHaveCount(0)

    await next.click()

    await expect(page).toHaveURL(/offset=20/)
    await expect(page.getByRole('link', { name: /previous/i })).toBeVisible()
    // And it is a real destination: reloading it lands on the same page rather
    // than back at the top of the log.
    await page.reload()
    await expect(page).toHaveURL(/offset=20/)
  })

  /*
   * The filters are in the URL, which is the whole point of #471: /audit is
   * where one administrator tells another "look at what happened here", and
   * before this the only thing that could be shared was instructions for
   * reproducing the view.
   */
  test('a filtered view is a URL', async ({ page }) => {
    await page.getByLabel(/^action$/i).fill('login')
    await expect(page).toHaveURL(/action=login/)

    // Arriving at that URL cold shows the same filtered view, filter bar
    // included, with no client fetch needed to get there.
    await page.goto('/audit?action=login')
    await expect(page.getByLabel(/^action$/i)).toHaveValue('login')
    await expectNoServerError(page)
  })
})
