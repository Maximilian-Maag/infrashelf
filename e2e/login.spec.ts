import { test, expect } from './fixtures'
import { rootEmail, rootPassword, completeSecondFactor } from './helpers'

test.describe('Login page', () => {
  // A fresh root sign-in is two-step since #197, and a TOTP code is single-use —
  // so it may have to wait out the rest of a thirty-second window before it can
  // present one. Playwright's default test timeout is exactly thirty seconds,
  // which made that wait indistinguishable from a broken form.
  test.setTimeout(90_000)

  test.beforeEach(async ({ page }) => {
    await page.goto('/login')
  })

  test('shows the login form', async ({ page }) => {
    await expect(page.getByRole('textbox', { name: /email/i })).toBeVisible()
    await expect(page.getByRole('textbox', { name: /password/i })).toBeVisible()
    await expect(page.getByRole('button', { name: /sign in|log in/i })).toBeVisible()
  })

  test('shows an error for invalid credentials', async ({ page }) => {
    await page.getByRole('textbox', { name: /email/i }).fill('nobody@example.com')
    await page.getByRole('textbox', { name: /password/i }).fill('wrongpassword')
    await page.getByRole('button', { name: /sign in|log in/i }).click()

    await expect(page.getByText(/invalid email or password|invalid credentials|incorrect|wrong/i)).toBeVisible({ timeout: 5000 })
  })

  test('redirects to dashboard after successful login', async ({ page }) => {
    // Requires the test admin user to exist in the DB (seeded by bootstrap)
    const email = rootEmail
    const password = rootPassword

    await page.getByRole('textbox', { name: /email/i }).fill(email)
    await page.getByRole('textbox', { name: /password/i }).fill(password)
    await page.getByRole('button', { name: /sign in|log in/i }).click()

    // Root holds a second factor since #197, so this is a two-step sign-in.
    await completeSecondFactor(page)
    await expect(page).not.toHaveURL(/\/login/, { timeout: 15_000 })
  })

  /**
   * The case that broke CI on #36 and blocked the whole suite.
   *
   * The two-step sign-in put a `POST /api/login-challenge` in front of every
   * login, and the proxy matcher still protected it — so the form's own
   * fetch was 307'd to /login, came back as HTML instead of JSON, and the sign-in
   * died as "Invalid email or password". `auth.setup.ts` failed on it, and with it
   * all 243 authenticated tests.
   *
   * Retargeted by #197. This used to assert that root signs in in ONE step, which
   * was true when a second factor was optional and root had none; root now has one
   * by the time this runs, so that premise is gone. What the test is actually for
   * survives it: the hop must answer as ITSELF — a JSON 200 from
   * /api/login-challenge — rather than being swallowed by the proxy and
   * coming back as an HTML redirect. That is the regression, and it is invisible
   * from the destination alone.
   */
  test('the challenge hop answers as itself rather than being swallowed', async ({ page, context }) => {
    // A genuinely signed-out browser — this project carries the shared root
    // storageState, and the proxy only redirects the unauthenticated.
    await context.clearCookies()
    await page.goto('/login')

    const challenge = page.waitForResponse(
      (r) => new URL(r.url()).pathname === '/api/login-challenge' && r.request().method() === 'POST',
    )

    await page.getByRole('textbox', { name: /email/i }).fill(rootEmail)
    await page.getByRole('textbox', { name: /password/i }).fill(rootPassword)
    await page.getByRole('button', { name: /sign in|log in/i }).click()

    const res = await challenge
    // A 307 here is the regression: the proxy swallowing the hop. So is any
    // response that is not JSON — the form reads this with `fetch` and an HTML
    // login page parses as nothing.
    expect(res.status()).toBe(200)
    expect(await res.json()).toMatchObject({ ok: true })

    // And the sign-in completes, whichever number of steps it takes.
    await completeSecondFactor(page)
    await expect(page).not.toHaveURL(/\/login/, { timeout: 15_000 })
  })

  test('keeps the user on the login page after failed attempt', async ({ page }) => {
    await page.getByRole('textbox', { name: /email/i }).fill('bad@example.com')
    await page.getByRole('textbox', { name: /password/i }).fill('bad')
    await page.getByRole('button', { name: /sign in|log in/i }).click()

    await page.waitForTimeout(1000)
    await expect(page).toHaveURL(/\/login/)
  })
})
