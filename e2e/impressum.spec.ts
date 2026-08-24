import { test, expect, type APIRequestContext } from '@playwright/test'
import { apiAsRoot, expectOk } from './api'

/**
 * FA-15.3: the imprint is publicly readable at /impressum without a login.
 *
 * Issue #154. The old spec asserted the route was public and nothing else — no
 * redirect to /login and a status below 400 — which an empty /impressum satisfies
 * perfectly. And empty is exactly what it is by default: `imprintText` starts as
 * `''` (schema branding.imprint_text) and the page then renders "no imprint
 * configured" instead. So the requirement being claimed here — that the imprint is
 * *published* — was never checked.
 *
 * It cannot be checked without an imprint to publish, so this spec configures one,
 * reads it back through the public route, and puts branding back the way it found
 * it. Branding is a global singleton and the a11y gate re-scans pages under an
 * operator-chosen colour, so leaving it edited would be issue #156 in miniature.
 */

const IMPRINT = [
  'Open Hybrid Cloud e2e',
  'Musterstraße 1, 12345 Musterstadt',
  'Represented by: the end-to-end suite',
].join('\n')

interface Branding {
  imprintText?: string
  shopName?: string
  shopSubtitle?: string
  primaryColor?: string
  secondaryColor?: string
}

let root: APIRequestContext
let original: Branding

test.beforeAll(async () => {
  root = await apiAsRoot()
  original = (await (
    await expectOk(await root.get('/api/admin/branding'), 'read branding')
  ).json()) as Branding
  await expectOk(
    await root.put('/api/admin/branding', { data: { imprintText: IMPRINT } }),
    'set the imprint',
  )
})

test.afterAll(async () => {
  // Back to exactly what was there, including an empty imprint.
  await root.put('/api/admin/branding', { data: { imprintText: original?.imprintText ?? '' } })
  await root.dispose()
})

test.describe('Impressum (FA-15.3)', () => {
  // No session at all: the point of the requirement is that a visitor who has
  // never signed in can read it.
  test.use({ storageState: { cookies: [], origins: [] } })

  test('the configured imprint is served to a visitor who is not signed in', async ({ page }) => {
    const response = await page.goto('/impressum')

    expect(page.url()).toMatch(/\/impressum$/)
    expect(response?.status()).toBeLessThan(400)

    // The text, not just the route. Every line of it, because the imprint is a
    // legal notice and a page that drops half of it is not compliant either.
    await expect(page.getByRole('heading', { name: /imprint|impressum/i })).toBeVisible()
    for (const line of IMPRINT.split('\n')) {
      await expect(page.getByText(line)).toBeVisible()
    }
  })

  test('the imprint page carries the shop name and a way back', async ({ page }) => {
    await page.goto('/impressum')
    await expect(page.getByText(original.shopName ?? 'Open Hybrid Cloud')).toBeVisible()
    // A visitor who arrived here from the login page needs a way out that does not
    // require a session.
    await expect(page.getByRole('link', { name: /back|zurück/i })).toBeVisible()
  })
})
