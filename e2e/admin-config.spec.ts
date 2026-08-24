import { test, expect, type APIRequestContext } from '@playwright/test'
import { loginAsRoot } from './helpers'
import { apiAsRoot, expectOk } from './api'

/**
 * Issue #156. Every describe below writes a GLOBAL singleton — branding, the SMTP
 * settings, the AI settings — and none of them used to put anything back. Two of
 * them still write plausible-looking production values ("smtp.example.com",
 * "claude-opus-4-5") into a database other specs and the a11y gate then read.
 *
 * So the configuration is captured once, restored once, and the tests in between
 * are free to be as destructive as they need to be.
 *
 * Issue #154 is the last test in the file: "clicking Refresh Rates triggers a
 * refresh" asserted that the button was in one of its two possible states, which
 * is true before the click, during it and after it.
 */

let root: APIRequestContext

interface Branding {
  shopName?: string
  shopSubtitle?: string
  primaryColor?: string
  secondaryColor?: string
  imprintText?: string
}
interface SmtpConfig {
  host: string
  port: number
  from: string
  user: string
  tls: boolean
}
interface AiConfig {
  provider: string
  endpoint: string
  model: string
}

let originalBranding: Branding
let originalSmtp: SmtpConfig
let originalAi: AiConfig

test.beforeAll(async () => {
  root = await apiAsRoot()
  originalBranding = (await (
    await expectOk(await root.get('/api/admin/branding'), 'read branding')
  ).json()) as Branding
  originalSmtp = (await (
    await expectOk(await root.get('/api/admin/config/smtp'), 'read SMTP config')
  ).json()) as SmtpConfig
  originalAi = (await (
    await expectOk(await root.get('/api/admin/config/ai'), 'read AI config')
  ).json()) as AiConfig
})

test.afterAll(async () => {
  // Best effort and never fatal: teardown must not decide the verdict. Each PUT
  // resends the values that were there before this file ran.
  await root.put('/api/admin/branding', {
    data: {
      shopName: originalBranding.shopName,
      shopSubtitle: originalBranding.shopSubtitle,
      primaryColor: originalBranding.primaryColor,
      secondaryColor: originalBranding.secondaryColor,
      imprintText: originalBranding.imprintText ?? '',
    },
  })
  // SMTP and AI can only be restored when there was something there: their PUT
  // schemas require a non-empty host/from and a non-empty model, so an
  // unconfigured portal cannot be described back into place through this endpoint.
  // What is left behind in that case is fixed — the same unresolvable `.invalid`
  // host and the same model string on every run — so the database stops growing,
  // which is the part of #156 that actually hurt.
  if (originalSmtp.host && originalSmtp.from) {
    await root.put('/api/admin/config/smtp', { data: originalSmtp })
  }
  if (originalAi.model) {
    await root.put('/api/admin/config/ai', { data: originalAi })
  }
  await root.dispose()
})

test.describe('Admin - Branding Configuration', () => {
  test.beforeEach(async ({ page }) => {
    await loginAsRoot(page)
    await page.goto('/admin/branding')
    await expect(page.getByRole('button', { name: /save/i })).toBeVisible({ timeout: 8000 })
  })

  test('branding page shows title and form fields', async ({ page }) => {
    await expect(page.getByRole('heading', { name: /^branding$/i, level: 1 })).toBeVisible()
    await expect(page.getByLabel(/shop name/i)).toBeVisible()
    await expect(page.getByLabel(/subtitle/i)).toBeVisible()
    // color labels are not htmlFor-linked inputs; check the label text is visible
    await expect(page.getByText(/^primary color$/i)).toBeVisible()
    await expect(page.getByText(/^secondary color$/i)).toBeVisible()
  })

  test('saving branding shows success toast and the value survives a reload', async ({ page }) => {
    // A real edit rather than re-saving the same value: saving a field back onto
    // itself cannot tell a working Save from one that discards its input. The
    // afterAll above is what makes an edit safe here.
    const subtitle = page.getByLabel(/subtitle/i)
    await subtitle.fill('E2E subtitle')
    await page.getByRole('button', { name: /save/i }).click()
    await expect(page.getByText(/branding saved/i)).toBeVisible({ timeout: 8000 })

    await page.reload()
    await expect(page.getByLabel(/subtitle/i)).toHaveValue('E2E subtitle', { timeout: 10000 })
  })
})

test.describe('Admin - SMTP Configuration', () => {
  test.beforeEach(async ({ page }) => {
    await loginAsRoot(page)
    await page.goto('/admin/config/smtp')
    await expect(page.getByRole('button', { name: /save configuration/i })).toBeVisible({ timeout: 8000 })
  })

  test('SMTP page shows title and form fields', async ({ page }) => {
    await expect(page.getByRole('heading', { name: /smtp/i, level: 1 })).toBeVisible()
    await expect(page.getByLabel(/^host/i)).toBeVisible()
    await expect(page.getByLabel(/^port/i)).toBeVisible()
    await expect(page.getByLabel(/from address/i)).toBeVisible()
    await expect(page.getByLabel(/username/i)).toBeVisible()
    await expect(page.getByRole('button', { name: /save configuration/i })).toBeVisible()
  })

  test('filling SMTP fields and saving shows success', async ({ page }) => {
    // `.invalid` is reserved by RFC 2606 and can never resolve, so a run that
    // somehow leaves this behind cannot make the portal mail a real host.
    await page.getByLabel(/^host/i).fill('smtp.e2e.invalid')
    await page.getByLabel(/^port/i).fill('587')
    await page.getByLabel(/from address/i).fill('noreply@e2e.invalid')
    await page.getByRole('button', { name: /save configuration/i }).click()
    await expect(page.getByText(/smtp.*saved|saved.*smtp/i)).toBeVisible({ timeout: 8000 })
  })
})

test.describe('Admin - AI Configuration', () => {
  test.beforeEach(async ({ page }) => {
    await loginAsRoot(page)
    await page.goto('/admin/config/ai')
    await expect(page.getByRole('button', { name: /save/i })).toBeVisible({ timeout: 8000 })
  })

  test('AI config page shows title and provider/model fields', async ({ page }) => {
    await expect(page.getByRole('heading', { name: /ai/i, level: 1 })).toBeVisible()
    await expect(page.getByLabel(/provider/i)).toBeVisible()
    await expect(page.getByLabel(/model/i)).toBeVisible()
    await expect(page.getByLabel(/api key/i)).toBeVisible()
  })

  test('AI provider dropdown has expected options', async ({ page }) => {
    const providerSelect = page.getByLabel(/provider/i)
    await expect(providerSelect.locator('option', { hasText: /claude|anthropic/i })).toBeAttached()
    await expect(providerSelect.locator('option', { hasText: /^OpenAI$/ })).toBeAttached()
    await expect(providerSelect.locator('option', { hasText: /ollama/i })).toBeAttached()
  })

  test('saving AI config shows success toast', async ({ page }) => {
    await page.getByLabel(/model/i).fill('e2e-model')
    await page.getByRole('button', { name: /save/i }).click()
    await expect(page.getByText(/ai.*saved|saved.*ai/i)).toBeVisible({ timeout: 8000 })
  })
})

test.describe('Admin - Exchange Rates', () => {
  test.beforeEach(async ({ page }) => {
    await loginAsRoot(page)
    await page.goto('/admin/exchange-rates')
    // Wait for the exchange rates table to load
    await expect(page.getByRole('button', { name: /refresh rates/i })).toBeVisible({ timeout: 8000 })
  })

  test('exchange rates page shows title and Refresh Rates button', async ({ page }) => {
    await expect(page.getByRole('heading', { name: /exchange rates/i, level: 1 })).toBeVisible()
    await expect(page.getByRole('button', { name: /refresh rates/i })).toBeVisible()
  })

  test('exchange rates table shows currency columns', async ({ page }) => {
    // Table component always renders a <table> element (empty state shown inside it)
    await expect(page.getByRole('table')).toBeVisible({ timeout: 8000 })
    await expect(page.getByRole('columnheader', { name: /currency/i })).toBeVisible()
    await expect(page.getByRole('columnheader', { name: /rate/i })).toBeVisible()
  })

  test('clicking Refresh Rates asks the server to refresh', async ({ page }) => {
    // Issue #154. The old assertion was
    //   expect(refreshingButton.or(refreshRatesButton)).toBeVisible()
    // — the button is in one of its two states before the click, during it and
    // after it, so it could not fail and said nothing about the click.
    //
    // What "triggers a refresh" means at this seam is a POST to the refresh
    // endpoint, so that is what is pinned. Deliberately NOT its status code: the
    // handler calls out to EXCHANGE_RATE_API_URL, and asserting 200 would make
    // this test a check on a third party (CI points it at the WireMock stub; a
    // developer's machine may point it at the live service, or nowhere).
    const refresh = page.waitForRequest(
      (r) => r.url().includes('/api/admin/exchange-rates/refresh') && r.method() === 'POST',
    )
    await page.getByRole('button', { name: /refresh rates/i }).click()
    await refresh

    // …and the table is re-read afterwards rather than left showing pre-refresh
    // figures. The button coming back is how the page says the round trip ended.
    await expect(page.getByRole('button', { name: /refresh rates/i })).toBeEnabled({
      timeout: 15000,
    })
  })
})
