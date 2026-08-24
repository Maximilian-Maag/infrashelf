import { test, expect } from '@playwright/test'
import { loginAsRoot, expectNoServerError } from './helpers'

// Issue #32. What the report contains depends on what the stack has provisioned,
// so the contracts pinned here are the ones that hold either way: the page renders,
// the filters live in the URL, the figures are labelled as sums rather than a
// projection, and the export carries the visible filters.
test.describe('Cost dashboard', () => {
  test.beforeEach(async ({ page }) => {
    await loginAsRoot(page)
    await page.goto('/costs')
  })

  test('the costs page loads without error', async ({ page }) => {
    await expect(page).not.toHaveURL(/\/login/)
    await expectNoServerError(page)
  })

  test('shows the title, subtitle and total', async ({ page }) => {
    await expect(page.getByRole('heading', { name: /^costs$/i })).toBeVisible()
    await expect(page.getByText(/spending on provisioned infrastructure/i)).toBeVisible()
    await expect(page.getByText(/total spend/i)).toBeVisible()
  })

  test('says the total is not a projection', async ({ page }) => {
    // The catalogue stores a price with no billing period, so a run rate cannot be
    // derived from it — the disclaimer is part of the feature, not decoration.
    await expect(page.getByText(/not a projection over a period/i)).toBeVisible()
  })

  // Issue #154. Every one of the four tests below used to bail with a bare
  // `return` — not even `test.skip()`, so the run recorded a pass — the moment the
  // stack had nothing provisioned, which on CI's empty database was always. The
  // demo data provisions two infrastructure elements at known prices (see
  // apps/backend/src/lib/bootstrap/demo.ts), so there is always spend to report and
  // the branch is gone.
  test('shows all four breakdowns', async ({ page }) => {
    await expect(page.getByRole('heading', { name: /per project/i })).toBeVisible({
      timeout: 10000,
    })
    await expect(page.getByRole('heading', { name: /per cost centre/i })).toBeVisible()
    await expect(page.getByRole('heading', { name: /per product/i })).toBeVisible()
    await expect(page.getByRole('heading', { name: /per environment/i })).toBeVisible()
    // A breakdown with no rows is the same silence as no breakdown at all.
    await expect(page.getByText(/no spending recorded for this range/i)).toHaveCount(0)
  })

  // Issue #106. The charts are inline SVG with no client JavaScript, so what is
  // pinned here is that they render server-side and that the data behind them is
  // reachable as text — the two things that would silently regress.
  test('offers a month-over-month comparison card whatever the window holds', async ({ page }) => {
    // Rendered even when the window covers one month, where it says so rather than
    // comparing against a month the filter excluded.
    await expect(page.getByRole('heading', { name: /month over month/i })).toBeVisible({
      timeout: 10000,
    })
  })

  test('draws the trend and the share charts', async ({ page }) => {
    await expect(page.getByRole('heading', { name: /spend over time/i })).toBeVisible({
      timeout: 10000,
    })

    // The picture carries an accessible name, not just a shape.
    await expect(page.getByRole('img', { name: /spend over time/i })).toBeVisible()
    await expect(page.getByRole('heading', { name: /share of total.*per project/i })).toBeVisible()
    await expect(
      page.getByRole('heading', { name: /share of total.*per cost centre/i }),
    ).toBeVisible()
  })

  test('keeps the not-a-projection caveat attached to every chart, not just the total', async ({
    page,
  }) => {
    // A column per month looks exactly like a monthly run rate, which these figures
    // are not. One caveat at the top of the page would not be read next to a chart.
    await expect(page.getByRole('heading', { name: /spend over time/i })).toBeVisible({
      timeout: 10000,
    })
    expect(await page.getByText(/not a projection over a period/i).count()).toBeGreaterThan(1)
  })

  test('the trend exposes its figures as a table, not only as an SVG', async ({ page }) => {
    await expect(page.getByRole('heading', { name: /spend over time/i })).toBeVisible({
      timeout: 10000,
    })

    // Collapsed by default; the point is that nothing is gated behind seeing it.
    await page.getByText(/^details$/i).first().click()
    const table = page.getByRole('table').filter({
      has: page.getByRole('columnheader', { name: /^month$/i }),
    })
    await expect(table.getByRole('columnheader', { name: /^month$/i })).toBeVisible()
    // And it has figures in it, not just headers — a details panel that opens on
    // an empty table is the same silence the SVG would have been.
    await expect(table.getByRole('row')).not.toHaveCount(1)
  })

  test('navigates to costs from the top nav', async ({ page }) => {
    await page.goto('/')
    await page.getByRole('link', { name: /^costs$/i }).first().click()
    await expect(page).toHaveURL(/\/costs/)
  })
})

test.describe('Cost dashboard filtering', () => {
  test.beforeEach(async ({ page }) => {
    await loginAsRoot(page)
    await page.goto('/costs')
    await expect(page.getByRole('heading', { name: /^filters$/i })).toBeVisible({ timeout: 8000 })
  })

  test('choosing a preset puts it in the URL', async ({ page }) => {
    await page.getByLabel(/time range/i).selectOption('last3Months')
    await expect(page).toHaveURL(/[?&]range=last3Months/)
  })

  test('all time is expressed as the absence of the parameter', async ({ page }) => {
    await page.goto('/costs?range=currentMonth')
    await expect(page.getByLabel(/time range/i)).toHaveValue('currentMonth')
    await page.getByLabel(/time range/i).selectOption('all')
    // The API's default is no lower bound, so "all time" needs no parameter.
    await expect(page).toHaveURL(/\/costs$/)
  })

  test('the date inputs appear only for a custom range', async ({ page }) => {
    await expect(page.getByLabel(/^from$/i)).toBeHidden()
    await page.getByLabel(/time range/i).selectOption('custom')
    await expect(page.getByLabel(/^from$/i)).toBeVisible({ timeout: 8000 })
    await expect(page.getByLabel(/^to$/i)).toBeVisible()
  })

  test('a custom range reaches the URL and is reported without error', async ({ page }) => {
    await page.goto('/costs?range=custom&from=2026-01-01&to=2026-12-31')
    await expect(page.getByLabel(/^from$/i)).toHaveValue('2026-01-01')
    await expect(page.getByLabel(/^to$/i)).toHaveValue('2026-12-31')
    await expect(page.getByText(/total spend/i)).toBeVisible()
  })

  test('an inverted custom range is refused rather than shown as zero spend', async ({ page }) => {
    // The server rejects from > to; the page must say something went wrong instead
    // of rendering zeros, which would read as "nothing was spent".
    await page.goto('/costs?range=custom&from=2026-12-31&to=2026-01-01')
    await expect(page.getByRole('alert')).toBeVisible({ timeout: 8000 })
  })

  test('a project filter can be set and undone in place', async ({ page }) => {
    // The demo data always provides a project, so the old `test.skip()` on an
    // empty option list has nothing left to guard against.
    const projectSelect = page.getByLabel(/^project$/i)
    await expect(projectSelect.locator('option:not([value=""])').first()).toBeAttached()

    await projectSelect.selectOption({ index: 1 })
    await expect(page).toHaveURL(/[?&]projectId=\d+/)
    // A real empty option, not Select's disabled placeholder.
    await page.getByLabel(/^project$/i).selectOption('')
    await expect(page).not.toHaveURL(/projectId=/)
  })

  test('Clear filters appears only when filtered and strips the query string', async ({ page }) => {
    const clear = page.getByRole('button', { name: /clear filters/i })
    await expect(clear).toBeHidden()

    await page.getByLabel(/time range/i).selectOption('currentMonth')
    await expect(clear).toBeVisible()
    await clear.click()
    await expect(page).toHaveURL(/\/costs$/)
  })
})

test.describe('Cost dashboard export', () => {
  test.beforeEach(async ({ page }) => {
    await loginAsRoot(page)
  })

  test('the export request carries the active filters', async ({ page }) => {
    await page.goto('/costs?range=last3Months')
    await expect(page.getByRole('button', { name: /export csv/i })).toBeVisible({ timeout: 8000 })

    const request = page.waitForRequest(
      (r) => r.url().includes('/api/costs/export') && r.method() === 'GET',
    )
    await page.getByRole('button', { name: /export csv/i }).click()
    const url = new URL((await request).url())

    expect(url.searchParams.get('format')).toBe('csv')
    expect(url.searchParams.get('range')).toBe('last3Months')
    // The token travels in the Authorization header, never the query string.
    expect(url.search).not.toContain('Bearer')
  })

  test('the CSV download succeeds', async ({ page }) => {
    await page.goto('/costs')
    await expect(page.getByRole('button', { name: /export csv/i })).toBeVisible({ timeout: 8000 })

    const response = page.waitForResponse((r) => r.url().includes('/api/costs/export'))
    await page.getByRole('button', { name: /export csv/i }).click()
    const res = await response
    expect(res.status()).toBe(200)
    expect(res.headers()['content-type']).toContain('text/csv')
    // Not the body: Chromium does not retain the payload of a Content-Disposition
    // attachment for response.text(), so it comes back empty here regardless of
    // what was served. The exact per-order header is pinned where it can be read —
    // apps/backend/src/app/api/costs/route.test.ts.
  })

  test('the PDF download succeeds', async ({ page }) => {
    await page.goto('/costs')
    await expect(page.getByRole('button', { name: /export pdf/i })).toBeVisible({ timeout: 8000 })

    const response = page.waitForResponse(
      (r) => r.url().includes('/api/costs/export') && r.request().method() === 'GET',
    )
    await page.getByRole('button', { name: /export pdf/i }).click()
    const res = await response
    expect(res.status()).toBe(200)
    expect(res.headers()['content-type']).toContain('application/pdf')
  })
})
