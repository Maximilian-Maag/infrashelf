import { readFileSync } from 'node:fs'
import { createHmac } from 'node:crypto'
import path from 'node:path'
import { expect, test, type Browser, type BrowserContext, type Locator, type Page } from '@playwright/test'

/**
 * Read a value from the backend's .env.
 *
 * The account these tests sign in as is the one the backend bootstrap creates
 * from ADMIN_EMAIL / ADMIN_PASSWORD, and those live in apps/backend/.env — which
 * Playwright does not load. Hardcoded defaults here used to be `root@local.dev`,
 * an account nothing ever creates, so a local run failed at auth.setup with an
 * opaque CredentialsSignin. CI is unaffected either way: it sets E2E_ADMIN_* and
 * ADMIN_* to the same values explicitly.
 *
 * Same hand-rolled parse as e2e/global-setup.ts, and for the same reason: no
 * dotenv dependency in the Playwright process.
 */
const fromBackendEnv = (key: string): string | undefined => {
  try {
    const content = readFileSync('./apps/backend/.env', 'utf-8')
    return content.match(new RegExp(`^${key}=(.+)$`, 'm'))?.[1]?.trim()
  } catch {
    return undefined
  }
}

export const rootEmail =
  process.env.E2E_ADMIN_EMAIL ?? process.env.ADMIN_EMAIL ?? fromBackendEnv('ADMIN_EMAIL') ?? 'admin@example.com'
export const rootPassword =
  process.env.E2E_ADMIN_PASSWORD ?? process.env.ADMIN_PASSWORD ?? fromBackendEnv('ADMIN_PASSWORD') ?? 'changeme'

/**
 * Where the root account's TOTP secret is kept between runs (issue #197).
 *
 * #197 makes a second factor mandatory for administrators, so signing in as root
 * is a two-step flow now and the suite has to be able to produce a code. On CI
 * the database is a fresh service container every run, so `auth.setup` enrols one
 * and writes the secret here; locally, against a database that persists, this is
 * what lets the next run finish the sign-in instead of being stuck at a code
 * field for a secret nobody kept.
 */
export const totpSecretFile = path.join(__dirname, '.auth/root-totp.txt')

/**
 * The saved root session every authenticated spec is seeded from.
 *
 * Here rather than in `auth.setup.ts` because a spec cannot import from that
 * file: doing so would re-register its `setup(...)` as a test of the importing
 * spec. The role matrix needs the path to open a root context of its own for
 * creating fixture accounts, so the constant has to live somewhere both can
 * reach — and one definition beats the same string written twice.
 */
export const rootStorageStateFile = path.join(__dirname, '.auth/root.json')

/** Base32 (RFC 4648, no padding) — how an authenticator secret is written down. */
function base32Decode(input: string): Buffer {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567'
  let bits = 0
  let value = 0
  const out: number[] = []
  for (const ch of input.replace(/[\s=]/g, '').toUpperCase()) {
    const idx = alphabet.indexOf(ch)
    if (idx === -1) continue
    value = (value << 5) | idx
    bits += 5
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 0xff)
      bits -= 8
    }
  }
  return Buffer.from(out)
}

/**
 * The current six-digit code for a secret (RFC 6238, SHA-1, 30 s).
 *
 * Its own implementation rather than an import from the backend: `e2e/` is not in
 * either app's module graph, and a copy of thirty lines beats a build-time
 * dependency between the suite and the thing it is testing. It is checked against
 * the backend's own implementation by the fact that a wrong code fails the login.
 */
export function totpCode(secretBase32: string, at = Date.now()): string {
  const key = base32Decode(secretBase32)
  const counter = Math.floor(at / 1000 / 30)
  const buf = Buffer.alloc(8)
  buf.writeUInt32BE(Math.floor(counter / 2 ** 32), 0)
  buf.writeUInt32BE(counter >>> 0, 4)
  const hmac = createHmac('sha1', key).update(buf).digest()
  const offset = hmac[hmac.length - 1] & 0x0f
  const binary =
    ((hmac[offset] & 0x7f) << 24) |
    ((hmac[offset + 1] & 0xff) << 16) |
    ((hmac[offset + 2] & 0xff) << 8) |
    (hmac[offset + 3] & 0xff)
  return String(binary % 1_000_000).padStart(6, '0')
}

/** The RFC 6238 step a moment falls in — the 30-second window a code belongs to. */
export const totpStepOf = (at = Date.now()): number => Math.floor(at / 1000 / 30)

/**
 * Wait until the current step is past `step`.
 *
 * A TOTP code is single-use: `twoFactor.ts` records the step of an accepted code
 * and refuses anything at or below it, which is what stops a code read over a
 * shoulder being replayed for the rest of its window. So two sign-ins inside the
 * same thirty seconds cannot both use the same code — the second is refused, and
 * the login page says "Invalid email or password", which is exactly as
 * informative as it is meant to be and no help at all here.
 *
 * Costs up to thirty seconds, and only when it is actually needed.
 */
/**
 * The last step this process presented a code for, per secret.
 *
 * Per worker, which is all it can be — Playwright workers are separate processes.
 * The retry in `completeSecondFactor` is what covers the gap between them.
 *
 * Keyed by secret rather than one number for the whole process, because the role
 * matrix signs in as more than one account: a step spent on root's authenticator
 * says nothing about an admin's, since `twoFactor.ts` records the accepted step
 * against the USER. One shared counter was still correct — it only ever waits too
 * long — but it made every extra account pay up to thirty seconds for a code
 * nobody had used.
 */
const lastSpentStep = new Map<string, number>()

export async function waitForTotpStepAfter(step: number): Promise<void> {
  while (totpStepOf() <= step) {
    await new Promise((resolve) => setTimeout(resolve, 1_000))
  }
}

/** The stored root secret, or null when nothing has enrolled one yet. */
export function storedRootTotpSecret(): string | null {
  try {
    const value = readFileSync(totpSecretFile, 'utf-8').trim()
    return value === '' ? null : value
  } catch {
    return null
  }
}

/**
 * Finish a sign-in that came back asking for a second factor.
 *
 * Returns false when this account has none, so a caller can use it
 * unconditionally.
 *
 * The wait is a race and not an `isVisible()`, which is what the first version of
 * this got wrong: the code field appears only after the challenge round trip, so
 * asking whether it is visible the instant the button is clicked always answered
 * no, and the caller then sat on `waitForURL` until it timed out. Racing the field
 * against the navigation resolves as soon as either happens, and cannot hang on
 * an account that needs no code.
 */
export async function completeSecondFactor(
  page: Page,
  secretOverride?: string,
): Promise<boolean> {
  const codeField = page.getByLabel(/authentication code/i).first()
  const needsCode = await Promise.race([
    codeField
      .waitFor({ state: 'visible', timeout: 60_000 })
      .then(() => true)
      .catch(() => false),
    page
      .waitForURL((url) => !url.pathname.includes('/login'), { timeout: 60_000 })
      .then(() => false)
      .catch(() => false),
  ])
  if (!needsCode) return false

  const secret = secretOverride ?? storedRootTotpSecret()
  if (!secret) {
    throw new Error(
      `The sign-in is asking for a second factor and no secret is stored at ${totpSecretFile}. ` +
        'The account already has an authenticator this run did not enrol — drop the e2e database ' +
        '(`make test-db`) so the bootstrap starts clean, or clear its user_totp row.',
    )
  }
  // Wait for a step this process has not already spent, BEFORE filling.
  //
  // Reactive retry was not enough: a rejected code costs a failed submit plus up
  // to thirty seconds of waiting, and Playwright's default test timeout is
  // thirty. auth.setup spends two codes of its own, and every fresh sign-in after
  // it lands in the same window — so the first attempt was usually the spent one
  // and the test died mid-wait with a code field on screen and no error, which
  // reads like the form is broken.
  //
  // Proactive turns that into one wait and one submit. The retry below stays for
  // the case this cannot see: a parallel worker spending the step from under us.
  await waitForTotpStepAfter(lastSpentStep.get(secret) ?? -1)

  // Up to three steps, because the code has to be one this account has not spent.
  // Codes are single-use and the suite runs in parallel workers, so a step can be
  // spent by another worker — or by the enrolment that just confirmed one — with
  // no way to know from here except being refused. Retrying on the next step is
  // the only answer that does not depend on guessing who spent what.
  for (let attempt = 0; attempt < 2; attempt++) {
    const step = totpStepOf()
    lastSpentStep.set(secret, step)
    await codeField.fill(totpCode(secret))
    // Not /^sign in$/: the step-two button says "Verify" since #240, because
    // repeating the password step's wording read as being asked to log in again.
    await page.getByRole('button', { name: /^verify$/i }).click()

    const signedIn = await page
      .waitForURL((url) => !url.pathname.includes('/login'), { timeout: 15_000 })
      .then(() => true)
      .catch(() => false)
    if (signedIn) return true

    // Still on /login: either the code was spent, or the credentials are wrong
    // and no amount of waiting will help. Only the first is worth a retry, and
    // the page cannot tell us which — so try the next step and let the caller's
    // own timeout end it if this is the second case.
    await waitForTotpStepAfter(step)
  }
  return true
}

export async function loginAs(page: Page, email: string, password: string): Promise<void> {
  await page.goto('/login')
  await page.getByLabel(/email address/i).fill(email)
  await page.getByLabel(/password/i).fill(password)
  await page.getByRole('button', { name: /sign in/i }).click()
  // An administrator's sign-in is two-step since #197; an ordinary account's is
  // not, and this is a no-op for them.
  await completeSecondFactor(page)
  await page.waitForURL((url) => !url.pathname.includes('/login'), { timeout: 8000 })
}

export async function loginAsRoot(page: Page): Promise<void> {
  // Fast path: skip re-login when already authenticated (e.g. via storageState)
  await page.goto('/')
  if (!page.url().includes('/login')) return
  await page.getByLabel(/email address/i).fill(rootEmail)
  await page.getByLabel(/password/i).fill(rootPassword)
  await page.getByRole('button', { name: /sign in/i }).click()
  await completeSecondFactor(page)
  await page.waitForURL((url) => !url.pathname.includes('/login'), { timeout: 10000 })
}

/**
 * Assert the page is not a server error, without the false positives.
 *
 * Every spec used to assert `expect(page.locator('body')).not.toContainText('500')`,
 * which reads as "no server error" and means "the digits 500 appear nowhere on the
 * page". It failed a green build the first time a fixture was named with a
 * timestamp ending in 500 (`E2E Env CB 1787319807500`), and it would equally fail
 * on a price, a port, a disk size or a product called "500GB SSD".
 *
 * What actually distinguishes an error page: Next.js renders its own shell with no
 * <main> landmark and one of a small set of headings. So assert the application
 * frame rendered, and that the error text is absent — neither of which any amount
 * of ordinary content can trip.
 */
export async function expectNoServerError(page: Page): Promise<void> {
  await expect(page.locator('main')).toBeVisible()
  await expect(page.locator('body')).not.toContainText('Internal Server Error')
  await expect(page.locator('body')).not.toContainText('Application error')
  await expect(page.locator('body')).not.toContainText('This page could not be found')
}

/**
 * Whether a locator turns up within the budget.
 *
 * `count()` does not wait. Guarding on it straight after a click or a
 * navigation reads the page before it has rendered, answers 0, and — in front of
 * a `test.skip` — skips the test. Every run. `addFirstProduct` did exactly that:
 * `count()` on the Add-to-cart button on the line BEFORE the `toBeVisible` that
 * would have waited for it, so the whole cart suite skipped for months and the
 * report said "skipped", not "broken" (#332).
 *
 * Use this for any precondition read after the page has been asked to change.
 */
export const appears = async (locator: Locator, timeout = 15_000): Promise<boolean> =>
  locator
    .first()
    .waitFor({ state: 'visible', timeout })
    .then(() => true)
    .catch(() => false)

/**
 * A precondition the demo seed is supposed to satisfy.
 *
 * Locally, with no demo data, this is an honest skip and the message says which
 * command fixes it. In CI it is a failure, because the shards run
 * `src/seed-demo.ts` before the suite and `seedDemoData` is not vague about what
 * it writes: one category, three products with their environment offerings and
 * parameters, a project, cost centres, three orders (completed, pending and
 * failed) and two infrastructure elements. On that database an empty catalogue,
 * an empty orders list or an empty approvals queue is not an unmet precondition
 * — it is a defect, and #285 is the story of what happens when a suite reports
 * one as a skip.
 *
 * Every call passes a reason whether it fails or skips. 63 of the 64 skips in
 * this suite used to be a bare `test.skip()`, which announces nothing: the
 * report could not distinguish "no demo data on my laptop" from "the catalogue
 * is throwing 500s" (#332). Policy rule 19 now holds that.
 */
export function requireSeeded(ok: boolean, reason: string): void {
  if (ok) return
  if (process.env.E2E_SEEDED === '1') {
    throw new Error(`${reason} — but this run seeded the demo data, so this is a defect, not a missing fixture`)
  }
  test.skip(true, `${reason} — seed the demo data (make db-seed-demo)`)
}

/**
 * A precondition that needs a PIPELINE STACK, which is a different switch.
 *
 * `seedDemoData` writes a stack only when `DEMO_CI_URL` points at a CI that will
 * answer, because provisioning fires a trigger the moment an order is placed and
 * against the default `.invalid` host that fails and the order is refused. So a
 * seeded database is not enough for anything that orders — `DEMO_CI_URL` is, and
 * it is the switch the message has to name.
 *
 * Same shape as #322's fix in `provisioning.spec.ts`: unset, skip and say so;
 * set, a missing stack is the regression the test exists to catch.
 */
export function requireStack(ok: boolean, reason: string): void {
  if (ok) return
  if (process.env.DEMO_CI_URL?.trim()) {
    throw new Error(`${reason} — but DEMO_CI_URL is set, so the demo should have seeded a pipeline stack (#157)`)
  }
  test.skip(true, `${reason} — set DEMO_CI_URL so the demo seeds a pipeline stack (#157)`)
}

/**
 * Wait until React has taken over the page, then hand back control.
 *
 * Playwright's actionability checks cannot see hydration. A Next.js `<Link>` is
 * in the server HTML, so it is visible, enabled and stable — and clicking it
 * before the router is mounted follows nothing. The click reports success, the
 * page stays where it is, and the failure surfaces later as a URL assertion
 * timing out, which reads as a routing bug rather than a timing one.
 *
 * `HydrationMarker` sets `data-hydrated` on `<html>` from an effect in the root
 * layout, which is the first moment any of this is true.
 *
 * Call it after `goto` and before the first click on a page. It is a wait, not
 * an assertion: a page that never hydrates fails at whatever the test does
 * next, with that test's own message, rather than here with a generic one.
 *
 * After a click that navigates, pass `path`. Next preserves the root layout
 * across a client-side navigation, so the bare attribute is still `true` from
 * the page you left and the wait returns at once, having established nothing —
 * which is worse than not waiting, because it reads like a guarantee.
 * `data-hydrated-path` follows the route, so `hydrated(page, /^\/orders\/\d+$/)`
 * waits for the page you actually arrived at.
 *
 * ── AND the streamed copy has to be gone (#374) ──────────────────────────────
 *
 * A production build STREAMS. `next start` sends the shell first and delivers
 * each Suspense boundary's real content later, parked in a `<div hidden
 * id="S:0">` at the end of `<body>`, where an inline script then moves it into
 * place. For the ~200ms between those two events the page's content is in the
 * document TWICE — once where it belongs, once in the staging div.
 *
 * `getByRole` never saw this, because a `[hidden]` subtree is not in the
 * accessibility tree. `getByText`, `getByLabel` and CSS locators do see it, and
 * they see it as a strict mode violation: "resolved to 2 elements", one of them
 * the same `<p>` or the same `<input>`. Duplicate `id`s too — `locator('#order')`
 * matched two nodes.
 *
 * Which is how #374 presented. `next dev` does not stream like this, so moving
 * the e2e jobs onto production builds failed fifteen tests across four specs
 * that nobody had touched, plus `auth.setup` itself: its `Promise.race` on two
 * locators got an instant rejection from the strict mode violation rather than a
 * timeout, and reported "neither the dashboard nor the enrolment prompt
 * appeared" about a page that was showing the enrolment prompt.
 *
 * So this waits for the staging divs to drain, and every page-level locator in
 * the suite is sound again without being rewritten. Same reasoning as the `goto`
 * wrapper in fixtures.ts: 249 call sites cannot each remember a rule.
 */
export async function hydrated(page: Page, path?: RegExp): Promise<void> {
  await page
    .waitForFunction(
      (source: string | null) => {
        const el = document.documentElement
        if (el.dataset.hydrated !== 'true') return false
        // React's own staging containers for streamed Suspense content. Matched
        // by the `S:` id prefix rather than by `[hidden]` alone: the root layout
        // leaves an empty `<div hidden>` of its own in place permanently, and
        // waiting for THAT to go would wait 15s on every single navigation.
        if (document.querySelector('div[hidden][id^="S:"]') !== null) return false
        return source === null || new RegExp(source).test(el.dataset.hydratedPath ?? '')
      },
      path ? path.source : null,
      { timeout: 15_000 },
    )
    .catch(() => {})
}

/**
 * The page's own alerts, without the one Next.js puts there.
 *
 * Next's App Router renders `<div role="alert" id="__next-route-announcer__">`
 * into every page to announce client-side navigations. It is empty, it is
 * always present, and it means `getByRole('alert')` can never resolve to one
 * element — so any assertion written as "an alert is shown" fails with a strict
 * mode violation rather than with anything about the alert (#296).
 *
 * Excluded by id rather than by emptiness: an announcer that happens to be
 * mid-announcement has text, and a test should not depend on that timing.
 */
export const pageAlerts = (page: Page) =>
  page.locator('[role="alert"]:not(#__next-route-announcer__)')

/* ────────────────────────────────────────────────────────────────────────────
 * Roles
 *
 * Everything below exists because the suite could only sign in as root, and a
 * root-only suite cannot see a role bug. It did not: `GET /api/admin/categories`
 * was gated on `root` while the catalogue page fetched it to build the category
 * filter, so the shop rendered as an error for every project manager and every
 * admin — and 30 catalogue assertions stayed green throughout, because the one
 * account they run as was the one account that worked.
 *
 * So the matrix needs real accounts of each role, and that means three things
 * root did not: creating them, signing in from a context that is NOT seeded with
 * root's cookies, and — for the administrative roles — enrolling the second
 * factor #197 makes mandatory before the session can reach anything.
 * ──────────────────────────────────────────────────────────────────────────── */

/** The three roles, ranked as `ROLE_RANK` in the backend's auth middleware ranks them. */
export type TestRole = 'project_manager' | 'admin' | 'root'

/** An account this suite created, and the credentials to sign in as it. */
export interface TestAccount {
  id: number
  email: string
  password: string
  name: string
  role: TestRole
}

/**
 * Whether this role owes a second factor before its session can do anything.
 *
 * The backend's `TWO_FACTOR_ROLES` in the same words. A copy, because `e2e/` is
 * not in either app's module graph — and a wrong copy fails loudly here rather
 * than quietly: a role listed that should not be waits for an enrolment screen
 * that never appears, and one omitted that should not be gets a session refused
 * on every route.
 */
export const roleNeedsSecondFactor = (role: TestRole): boolean =>
  role === 'admin' || role === 'root'

/**
 * A fresh account of the given role, created through the API as the caller.
 *
 * Through the API rather than the Add User dialog because this is a fixture, not
 * the thing under test — `admin-users.spec.ts` covers the dialog. `page.request`
 * shares the context's cookies, so this goes out as whoever `page` is signed in
 * as, which for the `chromium` project is root. Creating a user is root-only, so
 * a non-root caller gets a 403 here and the message says so rather than leaving a
 * later assertion to fail on a missing account.
 *
 * The password satisfies the backend's 8-character minimum and is the same for
 * every fixture account: these exist for the length of one run against a
 * disposable database, and a per-account secret would only have to be threaded
 * somewhere to be read back.
 */
export async function createAccount(page: Page, role: TestRole): Promise<TestAccount> {
  // Unique per account, not per run: the e2e database persists locally, and a
  // fixed address collides with the row a previous run left behind (the backend
  // answers 409, which reads as "the API is broken" from the assertion that
  // follows).
  const stamp = `${Date.now()}-${Math.floor(Math.random() * 1e6)}`
  const email = `e2e-${role.replace(/_/g, '-')}-${stamp}@example.com`
  const password = 'E2eRole123!'
  const name = `E2E ${role} ${stamp}`

  const res = await page.request.post('/api/proxy/api/admin/users', {
    data: { email, name, role, password, active: true },
  })
  if (!res.ok()) {
    throw new Error(
      `Could not create the ${role} fixture account: ${res.status()} ${await res.text()}. ` +
        'Creating a user is root-only — this helper has to be called from a root session.',
    )
  }
  const created = (await res.json()) as { id: number }
  return { id: created.id, email, password, name, role }
}

/**
 * Enrol a second factor for the account `page` is signed in as, and return the secret.
 *
 * The generalised form of what `auth.setup.ts` does for root, and driven through
 * the UI for the same reason: the secret is stored as an AES-256-GCM envelope, so
 * a fixture that wrote a plaintext one into the database would prove nothing and
 * would not let the account sign in either.
 *
 * Call it on a session that has just been bounced to `/settings?enroll2fa=1`.
 * Returns the base32 secret, which the caller needs to sign this account in again
 * — including the sign-in this function itself performs at the end, since the
 * cookie the middleware reads is rewritten asynchronously and reading it too
 * early is what made the first version of root's enrolment hang on /settings.
 */
export async function enrolSecondFactorFor(page: Page, account: TestAccount): Promise<string> {
  const passwordField = page.getByLabel(/confirm with your password/i)
  await passwordField.waitFor({ state: 'visible', timeout: 60_000 })
  await passwordField.fill(account.password)
  await page.getByRole('button', { name: /set up/i }).click()

  // The setup key, shown once. Whitespace is presentation; the secret is the
  // base32 without it.
  const shown = await page.locator('code').first().innerText()
  const secret = shown.replace(/\s/g, '')

  // Confirming SPENDS this step — `twoFactor.ts` records the accepted step and
  // refuses anything at or below it — so record it before the sign-in below asks
  // for another code against the same secret.
  const confirmedAtStep = totpStepOf()
  lastSpentStep.set(secret, confirmedAtStep)
  await page.getByLabel(/authentication code/i).fill(totpCode(secret))
  await page.getByRole('button', { name: /activate/i }).click()

  // The recovery codes appear only on success, so they are what proves the factor
  // is confirmed rather than merely started.
  await page.getByText(/recovery codes/i).first().waitFor({ timeout: 30_000 })

  return secret
}

/**
 * A page signed in as `account`, in a context of its own.
 *
 * A context of its own is the whole point: the `chromium` project seeds every
 * context from `e2e/.auth/root.json`, so a test that merely navigates is root no
 * matter whose password it typed. `browser.newContext()` with no `storageState`
 * starts with no cookies at all, which is the only way to be somebody else here.
 *
 * The caller owns the returned context and must close it — `test.afterEach` or a
 * `finally`. Left open, its browser process outlives the test.
 *
 * For an administrative role this also walks the mandatory enrolment (#197):
 * such an account signs in perfectly well and is then refused every route until
 * it has a factor, which is a state no real administrator can stay in and not one
 * worth asserting against.
 */
export async function signInAsAccount(
  browser: Browser,
  account: TestAccount,
  /**
   * Run against the fresh context BEFORE anything is loaded in it.
   *
   * For anything that has to be in place from the very first navigation — a
   * route interception, most obviously. The root layout mounts the service
   * worker registration, so `/login` itself already asks for `/sw.js`: a route
   * installed after this function returns is installed too late to affect the
   * registration, and a test that meant to run without a worker quietly runs
   * with one (#362).
   */
  onContext?: (context: BrowserContext) => Promise<void>,
): Promise<{ page: Page; context: BrowserContext; secret: string | null }> {
  const context = await browser.newContext({ storageState: undefined })
  // Both inside the try, so the cleanup at the bottom covers them: a hook that
  // rejects — or a `newPage` that fails — would otherwise leak the context and
  // leave its browser process outliving the run.
  let page: Page
  try {
    if (onContext) await onContext(context)
    page = await context.newPage()
    await page.goto('/login')
    await page.getByLabel(/email address/i).fill(account.email)
    await page.getByLabel(/password/i).fill(account.password)
    await page.getByRole('button', { name: /sign in/i }).click()
    // A brand-new account has no factor yet, so there is no code to give — the
    // sign-in is one step and this is a no-op. The enrolment below is what makes
    // the NEXT one two-step.
    await completeSecondFactor(page)
    await page.waitForURL((url) => !url.pathname.includes('/login'), { timeout: 75_000 })

    if (!roleNeedsSecondFactor(account.role)) {
      await hydrated(page)
      return { page, context, secret: null }
    }

    const secret = await enrolSecondFactorFor(page, account)

    // Sign in again from scratch rather than waiting for the open session's token
    // to catch up: `confirm` clears the flag on the backend at once, but the
    // cookie the middleware reads is rewritten asynchronously. A fresh sign-in
    // mints a token that is simply correct, and it is also the two-step path a
    // real administrator takes.
    await waitForTotpStepAfter(lastSpentStep.get(secret) ?? -1)
    await context.clearCookies()
    await page.goto('/login')
    await page.getByLabel(/email address/i).fill(account.email)
    await page.getByLabel(/password/i).fill(account.password)
    await page.getByRole('button', { name: /sign in/i }).click()
    await completeSecondFactor(page, secret)
    await page.waitForURL((url) => !url.pathname.includes('/login'), { timeout: 75_000 })

    // The guarantee the matrix rests on, asserted here rather than left to the
    // first test that trips over it: this session reaches the app instead of
    // being bounced back to the enrolment screen. auth.setup.ts learned this the
    // expensive way — a setup that cannot produce a usable session must fail AS
    // THE SETUP.
    await page.goto('/')
    await page.waitForURL((url) => !url.pathname.includes('/settings'), { timeout: 30_000 })
    if (page.url().includes('enroll2fa')) {
      throw new Error(`The ${account.role} session still owes a second factor after enrolling one.`)
    }
    await hydrated(page)

    return { page, context, secret }
  } catch (error) {
    // Otherwise a failure in here leaks the context, and its browser process
    // outlives the run.
    await context.close()
    throw error
  }
}

/**
 * Sign out through the account menu, the way a user does.
 *
 * Generous timeout, and deliberately so: the button awaits cache-clearing
 * before it ends the session, and #359 was precisely that step never finishing
 * — the only sign-out affordance in the app doing nothing while telling the
 * user it had.
 */
export async function signOutViaMenu(page: Page): Promise<void> {
  await page.getByText(/my account/i).click()
  await page.getByRole('button', { name: /sign out/i }).click()
  await page.waitForURL(/\/login/, { timeout: 30_000 })

  /*
   * And then wait for the SESSION to be REFUSED, not just for the page to move.
   *
   * Two things this deliberately does not assert. Not the URL alone: the
   * redirect to /login is client-side and `signout.spec` says in its own
   * comment that it can land while the cookie is still valid. And not the
   * absence of the cookie either, which is what this checked first and was the
   * wrong question — under #391 a `/api/auth/session` read already in flight
   * re-mints the cookie after sign-out has cleared it, so a browser can be
   * holding a token that authenticates nothing.
   *
   * What matters is whether the session still opens doors. The backend checks
   * every token against the `sessions` table, so once the row is revoked the
   * answer is 401 whatever the cookie says — and that is the property worth
   * waiting for, because it is the one a user walking away depends on.
   */
  await expect
    .poll(
      async () => (await page.context().request.get('/api/proxy/orders', { failOnStatusCode: false })).status(),
      { timeout: 30_000, message: 'the session still opened the API after the sign-out' },
    )
    .toBeGreaterThanOrEqual(401)
}
