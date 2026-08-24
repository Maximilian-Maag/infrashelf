import { test, expect } from '@playwright/test'
import { loginAsRoot, expectNoServerError } from './helpers'

test.describe('Infrastructure', () => {
  test.beforeEach(async ({ page }) => {
    await loginAsRoot(page)
    await page.goto('/infrastructure')
  })

  test('infrastructure page loads without error', async ({ page }) => {
    await expect(page).not.toHaveURL(/\/login/)
    await expectNoServerError(page)
  })

  test('shows page title "Infrastructure"', async ({ page }) => {
    await expect(page.getByRole('heading', { name: /^infrastructure$/i })).toBeVisible()
  })

  test('shows infrastructure subtitle', async ({ page }) => {
    await expect(page.getByText(/deployed infrastructure elements grouped by project/i)).toBeVisible()
  })

  test('shows infrastructure elements or empty state', async ({ page }) => {
    // Either empty state message or at least one Card element with project infrastructure
    const emptyState = page.getByText(/no infrastructure elements yet/i)
    const hasEmpty = await emptyState.isVisible()
    if (hasEmpty) {
      await expect(emptyState).toBeVisible()
    } else {
      // Infrastructure elements exist — verify no 500 error
      await expectNoServerError(page)
    }
  })

  test('navigates to infrastructure from top nav', async ({ page }) => {
    await page.goto('/')
    await page.getByRole('link', { name: /^infrastructure$/i }).first().click()
    await expect(page).toHaveURL(/\/infrastructure/)
  })

  // Issue #154. This returned on an empty list and otherwise asserted only
  // `expectNoServerError` — it had never once looked at a badge, despite its name.
  // The seeded stack always has two elements, so there is always a badge to read.
  test('every infrastructure element shows a status badge', async ({ page }) => {
    const rows = page.locator('a[href^="/infrastructure/"]')
    await expect(rows.first()).toBeVisible({ timeout: 10000 })

    // The badge vocabulary is fixed (components/ui/StatusBadge.tsx): an element is
    // Active, Decommissioning or Decommissioned, and a failed deployment is stored
    // 'active' but shown as failed. Anything else means the badge fell through to
    // the raw enum value, which is the regression worth catching.
    const count = await rows.count()
    expect(count).toBeGreaterThan(0)
    for (let i = 0; i < count; i++) {
      // Scoped to the row, not the page: the filter bar's Status select carries
      // the same words as <option>s, so an unscoped text match would "find" a
      // badge for a row that has none.
      const header = rows.nth(i).locator('xpath=..')
      await expect(
        header.getByText(/^(active|decommissioning…|decommissioned|failed)$/i),
        'a row with no status badge claims nothing about what it is',
      ).toHaveCount(1)
    }
  })
})

// Issue #31. The filters live in the URL rather than in component state, so the
// contract worth pinning is: a control writes to the URL, and a URL renders the
// controls filled in. Both hold with or without infrastructure present.
test.describe('Infrastructure filtering', () => {
  test.beforeEach(async ({ page }) => {
    await loginAsRoot(page)
    await page.goto('/infrastructure')
    await expect(page.getByRole('heading', { name: /^filters$/i })).toBeVisible({ timeout: 8000 })
  })

  test('choosing a status puts it in the URL', async ({ page }) => {
    await page.getByLabel(/^status$/i).selectOption('active')
    await expect(page).toHaveURL(/[?&]status=active/)
  })

  test('a searched term reaches the URL after the debounce', async ({ page }) => {
    // By role, not by label alone: the page header carries a global-search submit
    // button whose accessible name is also "Search".
    await page.getByRole('searchbox', { name: /^search$/i }).fill('nginx')
    await expect(page).toHaveURL(/[?&]search=nginx/, { timeout: 8000 })
  })

  test('filters combine rather than replace each other', async ({ page }) => {
    await page.getByLabel(/^status$/i).selectOption('active')
    await expect(page).toHaveURL(/status=active/)
    await page.getByLabel(/deployed from/i).fill('2026-01-01')
    await expect(page).toHaveURL(/status=active/)
    await expect(page).toHaveURL(/deployedFrom=2026-01-01/)
  })

  test('a bookmarked filtered URL renders its controls already set', async ({ page }) => {
    await page.goto('/infrastructure?status=decommissioned&search=web&deployedFrom=2026-02-01')
    await expect(page.getByLabel(/^status$/i)).toHaveValue('decommissioned')
    await expect(page.getByRole('searchbox', { name: /^search$/i })).toHaveValue('web')
    await expect(page.getByLabel(/deployed from/i)).toHaveValue('2026-02-01')
  })

  test('Failed is offered as a status and reaches the URL', async ({ page }) => {
    // Issue #29 gave the list a Failed badge; issue #31's filter has to be able to
    // ask for it, or "Active" quietly includes rows the badge calls failed.
    await page.getByLabel(/^status$/i).selectOption('failed')
    await expect(page).toHaveURL(/[?&]status=failed/)
    await expectNoServerError(page)
  })

  test('the "all" option is selectable, so a filter can be undone in place', async ({ page }) => {
    await page.goto('/infrastructure?status=active')
    // Select's own placeholder renders disabled; the filter bar uses a real
    // option so "all statuses" stays reachable without clearing everything.
    await page.getByLabel(/^status$/i).selectOption('')
    await expect(page).not.toHaveURL(/status=/)
  })

  test('Clear filters appears only when filtered and strips the query string', async ({ page }) => {
    const clear = page.getByRole('button', { name: /clear filters/i })
    await expect(clear).toBeHidden()

    await page.getByLabel(/^status$/i).selectOption('active')
    await expect(clear).toBeVisible()
    await clear.click()
    await expect(page).toHaveURL(/\/infrastructure$/)
  })

  test('an over-narrow filter shows the no-match state, not the never-deployed one', async ({ page }) => {
    await page.goto('/infrastructure?search=zzz-no-such-infrastructure-zzz')
    await expect(page.getByText(/no infrastructure matches these filters/i)).toBeVisible({ timeout: 8000 })
  })

  test('the result count is announced in a live region', async ({ page }) => {
    const status = page.locator('[role="status"][aria-live="polite"]')
    await expect(status).toContainText(/matching elements/i)
  })
})

// Issue #33. The export is admin-and-above and must carry the active filters, so
// it is the URL the button builds that matters, not the bytes it returns.
test.describe('Infrastructure export', () => {
  test.beforeEach(async ({ page }) => {
    await loginAsRoot(page)
  })

  test('Export buttons are offered to root', async ({ page }) => {
    await page.goto('/infrastructure')
    await expect(page.getByRole('button', { name: /export csv/i })).toBeVisible({ timeout: 8000 })
    await expect(page.getByRole('button', { name: /export pdf/i })).toBeVisible()
    await expect(page.getByLabel(/include parameters/i)).toBeVisible()
  })

  test('the export request carries the active filters', async ({ page }) => {
    await page.goto('/infrastructure?status=active&search=web')
    await expect(page.getByRole('button', { name: /export csv/i })).toBeVisible({ timeout: 8000 })

    const request = page.waitForRequest((r) => r.url().includes('/api/infrastructure/export'))
    await page.getByRole('button', { name: /export csv/i }).click()
    const url = new URL((await request).url())

    expect(url.searchParams.get('format')).toBe('csv')
    expect(url.searchParams.get('status')).toBe('active')
    expect(url.searchParams.get('search')).toBe('web')
    // The token travels in the Authorization header, never the query string.
    expect(url.search).not.toContain('Bearer')
  })

  test('ticking Include parameters is reflected in the request', async ({ page }) => {
    await page.goto('/infrastructure')
    await expect(page.getByRole('button', { name: /export csv/i })).toBeVisible({ timeout: 8000 })

    await page.getByLabel(/include parameters/i).check()
    const request = page.waitForRequest((r) => r.url().includes('/api/infrastructure/export'))
    await page.getByRole('button', { name: /export csv/i }).click()
    expect(new URL((await request).url()).searchParams.get('includeParameters')).toBe('true')
  })

  test('the CSV download succeeds', async ({ page }) => {
    await page.goto('/infrastructure')
    await expect(page.getByRole('button', { name: /export csv/i })).toBeVisible({ timeout: 8000 })

    const response = page.waitForResponse((r) => r.url().includes('/api/infrastructure/export'))
    await page.getByRole('button', { name: /export csv/i }).click()
    const res = await response
    expect(res.status()).toBe(200)
    expect(res.headers()['content-type']).toContain('text/csv')
    // Not the body: Chromium does not retain the payload of a Content-Disposition
    // attachment for response.text(), so it comes back empty here regardless of
    // what was served. The inventory header is pinned where it can be read —
    // apps/backend/src/app/api/infrastructure/export/route.test.ts.
  })

  test('the PDF download succeeds', async ({ page }) => {
    await page.goto('/infrastructure')
    await expect(page.getByRole('button', { name: /export pdf/i })).toBeVisible({ timeout: 8000 })

    const response = page.waitForResponse((r) => r.url().includes('/api/infrastructure/export'))
    await page.getByRole('button', { name: /export pdf/i }).click()
    const res = await response
    expect(res.status()).toBe(200)
    expect(res.headers()['content-type']).toContain('application/pdf')
  })
})

// Issue #39: quick reorder. The link carries the element and its project, and the
// order form finds the element in that project's template list — no new endpoint.
test.describe('Infrastructure quick reorder', () => {
  test.beforeEach(async ({ page }) => {
    await loginAsRoot(page)
    await page.goto('/infrastructure')
  })

  test('every element offers Reorder, including decommissioned ones', async ({ page }) => {
    const emptyState = page.getByText(/no infrastructure elements yet/i)
    // `^reorder\b`, not `^reorder$`: the link carries the product name and the
    // element id in an sr-only span, because two elements can be provisioned from
    // the same product and the product name alone would not tell them apart
    // (WCAG 2.4.9).
    const reorder = page.getByRole('link', { name: /^reorder\b/i }).first()
    await expect(reorder.or(emptyState)).toBeVisible({ timeout: 10000 })
    if (await emptyState.isVisible()) { test.skip(); return }

    // Reprovisioning a torn-down element is exactly when the original
    // parameters are hardest to reconstruct, so the link is not status-gated.
    const href = await reorder.getAttribute('href')
    expect(href).toMatch(/^\/catalog\/\d+\?fromInfra=\d+&projectId=\d+$/)
  })

  test('Reorder lands on the product page with the form pre-filled', async ({ page }) => {
    const emptyState = page.getByText(/no infrastructure elements yet/i)
    const reorder = page.getByRole('link', { name: /^reorder\b/i }).first()
    await expect(reorder.or(emptyState)).toBeVisible({ timeout: 10000 })
    if (await emptyState.isVisible()) { test.skip(); return }

    await reorder.click()
    // Generous, for the same reason auth.setup.ts waits 30s: the suite runs against
    // `next dev`, which compiles the destination route on first request, and under
    // parallel workers that takes well over the 5s default.
    await expect(page).toHaveURL(/\/catalog\/\d+\?fromInfra=\d+/, { timeout: 30_000 })
    await expect(page.getByText(/parameters were pre-filled from this element/i)).toBeVisible({ timeout: 10000 })
    // Scoped to the order form: the buy box has an environment select of its own,
    // and it starts empty by design.
    await expect(page.locator('#order').getByLabel(/environment/i)).not.toHaveValue('')
  })

  test('the pre-fill can be cleared with "start fresh"', async ({ page }) => {
    const emptyState = page.getByText(/no infrastructure elements yet/i)
    const reorder = page.getByRole('link', { name: /^reorder\b/i }).first()
    await expect(reorder.or(emptyState)).toBeVisible({ timeout: 10000 })
    if (await emptyState.isVisible()) { test.skip(); return }

    await reorder.click()
    const templates = page.getByLabel(/load parameters from existing/i)
    await expect(templates).toBeVisible({ timeout: 30_000 })
    // Selectable, not a disabled placeholder — otherwise arriving via a reorder
    // link would leave the user with no way back to an empty form.
    await templates.selectOption('')
    await expect(templates).toHaveValue('')
  })
})

// Issue #29. The Retry action only appears for a deployment whose ORDER failed —
// the element itself is stored 'active' either way — so this asserts the gating
// and the confirmation, which hold whatever the stack happens to contain.
test.describe('Infrastructure retry', () => {
  test.beforeEach(async ({ page }) => {
    await loginAsRoot(page)
    await page.goto('/infrastructure')
  })

  test('Retry is absent for deployments that did not fail', async ({ page }) => {
    const emptyState = page.getByText(/no infrastructure elements yet/i)
    const anyRow = page.getByRole('link', { name: /^reorder\b/i }).first()
    await expect(anyRow.or(emptyState)).toBeVisible({ timeout: 10000 })
    if (await emptyState.isVisible()) { test.skip(); return }

    // Every row offering Retry must also be showing the failed badge.
    const retries = page.getByRole('button', { name: /^retry$/i })
    const failedBadges = page.getByText(/deployment failed/i)
    expect(await retries.count()).toBe(await failedBadges.count())
  })

  test('a failed deployment shows the failed state rather than claiming to be active', async ({ page }) => {
    const failedBadge = page.getByText(/deployment failed/i).first()
    if (await failedBadge.count() === 0) { test.skip(); return }
    await expect(failedBadge).toBeVisible()

    // Decommission is not offered — tearing down something never provisioned
    // would fire a destroy against nothing.
    const row = page.locator('div').filter({ has: failedBadge }).last()
    await expect(row.getByRole('button', { name: /decommission/i })).toHaveCount(0)
  })

  test('Retry asks for confirmation and says the parameters are reused', async ({ page }) => {
    const retry = page.getByRole('button', { name: /^retry$/i }).first()
    if (await retry.count() === 0) { test.skip(); return }

    await retry.click()
    const dialog = page.locator('dialog[open]')
    await expect(dialog.getByRole('heading', { name: /retry deployment/i })).toBeVisible()
    await expect(dialog.getByText(/same parameters/i)).toBeVisible()

    await dialog.getByRole('button', { name: /cancel/i }).click()
    await expect(dialog).not.toBeVisible()
  })
})

// Issue #30. Setting a schedule works out of the box; acting on it needs an
// external sweep (see README → Scheduled decommissioning), so what is asserted
// here is the storing, the badge and the clearing.
test.describe('Infrastructure scheduled decommissioning', () => {
  // Serial: both tests below act on the FIRST active element, and one of them sets
  // a schedule the other expects to be absent. Locally the suite is fullyParallel,
  // so without this they race each other — CI already runs with workers: 1, which
  // is why this only ever showed up once the database had data to act on.
  test.describe.configure({ mode: 'serial' })

  test.beforeEach(async ({ page }) => {
    await loginAsRoot(page)
    await page.goto('/infrastructure')
  })

  test('an active element offers automatic decommissioning', async ({ page }) => {
    const emptyState = page.getByText(/no infrastructure elements yet/i)
    const schedule = page.getByRole('button', { name: /automatic decommissioning/i }).first()
    await expect(schedule.or(emptyState)).toBeVisible({ timeout: 10000 })
    if (await emptyState.isVisible()) { test.skip(); return }

    await schedule.click()
    const dialog = page.locator('dialog[open]')
    await expect(dialog.getByRole('heading', { name: /schedule decommissioning/i })).toBeVisible()
    await expect(dialog.getByLabel(/scheduled for/i)).toBeVisible()
    // Confirm is inert until a time is chosen. The field is cleared first so this
    // holds whatever the element already had — the dialog pre-fills an existing
    // schedule, and a previous run that failed mid-way can leave one behind.
    await dialog.getByLabel(/scheduled for/i).fill('')
    await expect(dialog.getByRole('button', { name: /confirm/i })).toBeDisabled()
    await dialog.getByRole('button', { name: /cancel/i }).click()
    await expect(dialog).not.toBeVisible()
  })

  test('a stored schedule shows as a badge and can be cleared again', async ({ page }) => {
    const emptyState = page.getByText(/no infrastructure elements yet/i)
    const schedule = page.getByRole('button', { name: /automatic decommissioning/i }).first()
    await expect(schedule.or(emptyState)).toBeVisible({ timeout: 10000 })
    if (await emptyState.isVisible()) { test.skip(); return }

    await schedule.click()
    let dialog = page.locator('dialog[open]')
    await dialog.getByLabel(/scheduled for/i).fill('2099-06-01T14:30')
    await dialog.getByRole('button', { name: /confirm/i }).click()

    // The badge on the row, not the dialog's field label: every row renders a
    // closed <dialog> whose label is also "Scheduled for", and it comes first in
    // the DOM — so `.first()` matched a hidden element and could never be visible.
    const badge = page.locator('span').filter({ hasText: /^scheduled for /i })
    await expect(badge.first()).toBeVisible({ timeout: 30_000 })

    // Clean up so the run is repeatable — and prove Clear works.
    await page.getByRole('button', { name: /automatic decommissioning/i }).first().click()
    dialog = page.locator('dialog[open]')
    await expect(dialog.getByLabel(/scheduled for/i)).toHaveValue('2099-06-01T14:30')
    await dialog.getByRole('button', { name: /clear schedule/i }).click()
    await expect(badge).toHaveCount(0, { timeout: 30_000 })
  })

  test('a past time is refused by the server', async ({ page }) => {
    const emptyState = page.getByText(/no infrastructure elements yet/i)
    const schedule = page.getByRole('button', { name: /automatic decommissioning/i }).first()
    await expect(schedule.or(emptyState)).toBeVisible({ timeout: 10000 })
    if (await emptyState.isVisible()) { test.skip(); return }

    await schedule.click()
    const dialog = page.locator('dialog[open]')
    // The `min` attribute only constrains the picker, so the server is the guard.
    await dialog.getByLabel(/scheduled for/i).fill('2020-01-01T00:00')
    await dialog.getByRole('button', { name: /confirm/i }).click()

    await expect(dialog.getByRole('alert')).toContainText(/future/i, { timeout: 8000 })
    await expect(dialog).toBeVisible()
  })
})


// Issue #96. The list is a list; the outputs, the parameters and the pipeline runs
// live on the element's own page. What is asserted here holds whether or not the
// stack has infrastructure: the way in, and what the page is made of.
test.describe('Infrastructure detail', () => {
  test.beforeEach(async ({ page }) => {
    await loginAsRoot(page)
    await page.goto('/infrastructure')
  })

  test('the row heading opens the element', async ({ page }) => {
    const emptyState = page.getByText(/no infrastructure elements yet/i)
    const firstRow = page.getByRole('link', { name: /^reorder\b/i }).first()
    await expect(firstRow.or(emptyState)).toBeVisible({ timeout: 10000 })
    if (await emptyState.isVisible()) { test.skip(); return }

    // The product name in the row, not the Reorder link beside it.
    await page.locator('a[href^="/infrastructure/"]').first().click()
    await expect(page).toHaveURL(/\/infrastructure\/\d+$/)
  })

  test('shows the outputs, the parameters and the pipelines', async ({ page }) => {
    const emptyState = page.getByText(/no infrastructure elements yet/i)
    const link = page.locator('a[href^="/infrastructure/"]').first()
    await expect(link.or(emptyState)).toBeVisible({ timeout: 10000 })
    if (await emptyState.isVisible()) { test.skip(); return }

    await link.click()
    await expect(page.getByRole('heading', { name: /^outputs$/i })).toBeVisible({ timeout: 10000 })
    await expect(page.getByRole('heading', { name: /^parameters$/i })).toBeVisible()
    await expect(page.getByRole('heading', { name: /^pipelines$/i })).toBeVisible()
    // The originating order is reachable — the element used to be a dead end.
    await expect(page.getByRole('link', { name: /^#\d+$/ })).toBeVisible()
  })

  test('never shows a sensitive parameter value', async ({ page }) => {
    const emptyState = page.getByText(/no infrastructure elements yet/i)
    const link = page.locator('a[href^="/infrastructure/"]').first()
    await expect(link.or(emptyState)).toBeVisible({ timeout: 10000 })
    if (await emptyState.isVisible()) { test.skip(); return }

    await link.click()
    await expect(page.getByRole('heading', { name: /^parameters$/i })).toBeVisible({ timeout: 10000 })

    // Whatever the demo data holds, a redacted value must never be the real one.
    const body = page.locator('body')
    if (await page.getByText(/hidden sensitive values/i).isVisible()) {
      await expect(body).toContainText('[redacted]')
    }
    await expect(body).not.toContainText('sup3rs3cret')
  })

  test('an unknown element is a 404, not a broken page', async ({ page }) => {
    await page.goto('/infrastructure/999999')

    // Deliberately NOT expectNoServerError. That helper asserts the not-found
    // text is absent, which is the exact opposite of what this test wants: the
    // not-found page IS the correct answer for an id that does not exist.
    //
    // Asserting the HTTP status does not work either — it is 200. The page is a
    // server component that calls notFound() only after awaiting the API, by
    // which point the dashboard layout has already streamed and the headers are
    // gone. Measured, not assumed: page.goto() reports 200 here.
    //
    // So assert what the user actually sees: the app frame rendered, it says
    // not-found, and it is not a server error.
    await expect(page.locator('main')).toBeVisible()
    await expect(page.getByText(/this page could not be found/i)).toBeVisible()
    await expect(page.locator('body')).not.toContainText('Internal Server Error')
    await expect(page.locator('body')).not.toContainText('Application error')
  })
})
