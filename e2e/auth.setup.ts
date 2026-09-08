import { test as setup, expect } from '@playwright/test'
import path from 'path'
import { mkdirSync, writeFileSync } from 'node:fs'
import {
  rootEmail,
  rootPassword,
  rootStorageStateFile,
  totpCode,
  totpSecretFile,
  totpStepOf,
  waitForTotpStepAfter,
  completeSecondFactor,
} from './helpers'

// Re-exported under its original name so nothing that referred to it has to
// change; the path itself now lives in helpers, where a spec can also reach it.
export const rootAuthFile = rootStorageStateFile

// Three times Playwright's 30s default. This one test pays the whole suite's
// cold-start bill: `next dev` compiles /login, /api/login-challenge, the NextAuth
// handler and the dashboard on first request, and the sign-in waits on all four
// in series. A measured cold run on a loaded machine spends ~9s + ~6s + ~6s + ~9s
// and lands at ~32s — over the default, with nothing wrong. The two-step sign-in
// (#36) added the /api/login-challenge compile to that chain; 30s had no room
// left for it.
setup.setTimeout(90_000)

setup('authenticate as root', async ({ page }) => {
  await page.goto('/login')
  // From helpers, which fall back to the account the backend bootstrap actually
  // creates. This file used to carry its own copy of the defaults, so fixing them
  // in helpers.ts alone would have left every authenticated run still failing.
  await page.getByLabel(/email address/i).fill(rootEmail)
  await page.getByLabel(/password/i).fill(rootPassword)
  await page.getByRole('button', { name: /sign in/i }).click()
  // Generous on purpose: the suite runs against `next dev`, which compiles the
  // login route, the challenge route, the auth handler and the destination page
  // on first request. A cold login is measured in tens of seconds, so a tight
  // budget made this setup — and therefore every authenticated test — flaky for
  // a reason that has nothing to do with the app. Kept under the test timeout
  // above so a real failure reports as "still on /login", not "test timed out".
  // Two-step already, if a previous run enrolled the factor and the database
  // survived. On CI the database is a fresh container, so this is a no-op there.
  await completeSecondFactor(page)
  await page.waitForURL((url) => !url.pathname.includes('/login'), { timeout: 75_000 })

  await enrolSecondFactorIfRequired(page)

  // The guarantee every other spec is built on: this session reaches the
  // dashboard rather than being bounced to the enrolment screen.
  //
  // Asserted here because the alternative already happened. The setup's only
  // check used to be "signing in worked", which is true for an administrator who
  // owes a second factor — they sign in and are then refused every route. It
  // reported ✓, saved the storageState, and 330 assertions failed across every
  // other spec on missing headings, none of which pointed at this file.
  //
  // A setup that cannot produce a usable session must fail AS THE SETUP.
  await page.goto('/')
  await expect(page.getByRole('link', { name: /browse catalog/i })).toBeVisible({ timeout: 60_000 })
  expect(page.url(), 'the saved session still owes a second factor').not.toContain('enroll2fa')

  await page.context().storageState({ path: rootAuthFile })
})

/**
 * Enrol the root account's authenticator, if #197 is asking for one.
 *
 * The suite cannot skip this and it should not want to: a second factor is
 * mandatory for administrators now, so an authenticated root session is one that
 * has been through this. Everything else in the suite would otherwise be testing
 * a state no real administrator can be in — signed in and refused every route.
 *
 * Driven through the UI rather than seeded into the database, because the secret
 * is stored as an AES-256-GCM envelope and a fixture that wrote a plaintext one
 * would prove nothing. This is the enrolment a person does, and it doubles as the
 * only end-to-end coverage that path has.
 */
async function enrolSecondFactorIfRequired(page: import('@playwright/test').Page): Promise<void> {
  // Ask for the dashboard, then wait for whichever screen answers.
  //
  // This used to read `page.url()` the instant the sign-in navigation left
  // `/login`, and return early unless it already said `/settings`. The
  // middleware's redirect to the enrolment screen lands AFTER that — so the
  // check sampled `/`, concluded nothing was owed, skipped the enrolment, and
  // saved a storageState for an account with no second factor. Every
  // authenticated test then bounced to `/settings?enroll2fa=1` and failed on a
  // missing heading, while this setup reported ✓, because signing in is all it
  // asserts. One CI run took 11s and skipped it; the next took 32s and did it.
  //
  // Racing two locators rather than sleeping: the enrolment prompt and a marker
  // that only the dashboard has. Whichever appears first is the answer, and
  // neither appearing is a real failure rather than something to shrug at.
  await page.goto('/')
  const passwordField = page.getByLabel(/confirm with your password/i)
  // Why each side gave up, kept for the error below.
  //
  // These used to be discarded (`() => null`), and a `Promise.race` resolves on
  // the FIRST settle — including a rejection. A strict mode violation rejects
  // instantly rather than waiting out the timeout, so when #374 put a second
  // copy of the page in the DOM for 200ms, this returned `null` in 1.2s and
  // reported "neither screen appeared" about a page that was plainly showing the
  // enrolment prompt. The reason was in the discarded rejection all along.
  const why: string[] = []
  const outcome = await Promise.race([
    passwordField.waitFor({ state: 'visible', timeout: 60_000 }).then(
      () => 'enrol' as const,
      (e: unknown) => { why.push(`enrolment prompt: ${e instanceof Error ? e.message : String(e)}`); return null },
    ),
    page
      .getByRole('link', { name: /browse catalog/i })
      .waitFor({ state: 'visible', timeout: 60_000 })
      .then(
        () => 'ready' as const,
        (e: unknown) => { why.push(`dashboard: ${e instanceof Error ? e.message : String(e)}`); return null },
      ),
  ])

  if (outcome === 'ready') return
  if (outcome !== 'enrol') {
    // Neither screen. Saying so here costs one clear error; staying quiet costs
    // the whole suite failing later on symptoms that point at the wrong file.
    throw new Error(
      `After signing in, neither the dashboard nor the second-factor enrolment prompt appeared. ` +
        `Currently at ${page.url()}.` +
        (why.length ? `\n\nWhat each side reported:\n  - ${why.join('\n  - ')}` : ''),
    )
  }

  await passwordField.fill(rootPassword)
  await page.getByRole('button', { name: /set up/i }).click()

  // The setup key, shown once. Whitespace is presentation — the secret is the
  // base32 without it.
  const shown = await page.locator('code').first().innerText()
  const secret = shown.replace(/\s/g, '')
  mkdirSync(path.dirname(totpSecretFile), { recursive: true })
  writeFileSync(totpSecretFile, secret)

  // The step this code belongs to. Confirming spends it — `twoFactor.ts` records
  // the accepted step and refuses anything at or below — so the sign-in below has
  // to wait for a step this account has not used.
  const confirmedAtStep = totpStepOf()
  await page.getByLabel(/authentication code/i).fill(totpCode(secret))
  await page.getByRole('button', { name: /activate/i }).click()

  // The recovery codes appear only on success, so they are what proves the
  // factor is confirmed rather than merely started.
  await page.getByText(/recovery codes/i).first().waitFor({ timeout: 30_000 })

  // Sign in again from scratch rather than waiting for the open session's token
  // to catch up.
  //
  // The card clears the "must enrol" flag through NextAuth's `update()`, and the
  // backend stops refusing the moment `confirm` returns — but the cookie the
  // middleware reads is rewritten asynchronously, and the first version of this
  // raced it and sat on /settings until it timed out. A fresh sign-in mints a
  // token that is simply correct, and it costs a few seconds once per run.
  //
  // It also means the saved storageState comes from the two-step sign-in that is
  // now the real path for an administrator, rather than from a session that
  // happened to predate the requirement.
  await waitForTotpStepAfter(confirmedAtStep)
  await page.context().clearCookies()
  await page.goto('/login')
  await page.getByLabel(/email address/i).fill(rootEmail)
  await page.getByLabel(/password/i).fill(rootPassword)
  await page.getByRole('button', { name: /sign in/i }).click()
  await completeSecondFactor(page)
  await page.waitForURL((url) => !url.pathname.includes('/login'), { timeout: 75_000 })

  // And the gate is lifted: the dashboard is reachable rather than bouncing back
  // to the enrolment screen.
  await page.goto('/')
  await page.waitForURL((url) => !url.pathname.includes('/settings'), { timeout: 30_000 })
}
