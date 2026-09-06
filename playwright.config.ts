import { defineConfig, devices } from '@playwright/test'

/**
 * The specs that edit something the whole database shares (#364).
 *
 * Each creates, renames or deletes a global entity and then asserts on a list —
 * `admin-environments` deletes "the last row with a Delete button" — so two of
 * them running at once interfere by construction. They are their own project,
 * and `ci.yml` runs that project at `--workers=1` after the parallel pass.
 *
 * A spec belongs here if it mutates a global and reads a list. Getting it wrong
 * does not fail the spec that forgot: it fails whichever unlucky spec was
 * reading the list at the time, which is why this list is worth keeping honest.
 */
const SINGLETON_SPECS = [
  '**/admin.spec.ts',
  '**/admin-categories.spec.ts',
  '**/admin-ci-sources.spec.ts',
  '**/admin-config.spec.ts',
  '**/admin-cost-centers.spec.ts',
  '**/admin-environments.spec.ts',
  '**/admin-parameters.spec.ts',
  '**/admin-pipeline-stacks.spec.ts',
  '**/admin-products.spec.ts',
  '**/admin-users.spec.ts',
]

export default defineConfig({
  testDir: './e2e',
  globalSetup: './e2e/global-setup.ts',
  /*
   * ── Why this used to be serial, and what changed (#364) ─────────────────
   *
   * `workers: 1` on CI had two reasons. Both were true; both are now dealt with
   * rather than tolerated.
   *
   *   1. Both apps were served by `next dev`, which compiles a route the first
   *      time it is requested — inside the test's own 30s clock. Ten Chromium
   *      workers on a 4-vCPU runner starved it and plain `page.goto` calls blew
   *      past the timeout: run 31807504622, four failures and three flakes,
   *      every one a navigation timeout with no assertion or API error in it.
   *      That was the reason to serve production builds instead, and it is
   *      what #364 set out to do — but the `webServer` change was never
   *      actually made, so CI still runs `next dev` and the objection was
   *      never removed. It was also never TESTED: at two workers there was no
   *      starvation at all, across four shards, so the concern turns out to
   *      bite somewhere above that rather than immediately. #374 is the
   *      experiment to run properly; until then this stays where the evidence
   *      is, and `workers` is deliberately a fraction rather than a big
   *      number.
   *
   *   2. A group of specs mutates GLOBAL singletons — CI sources, environments,
   *      products, categories, users, branding, SMTP and AI config — against one
   *      shared database and then asserts on list contents;
   *      `admin-environments` deletes "the last row with a Delete button". Two
   *      of those at once interfere by construction, whatever the CPU count.
   *
   * The second is solved by SPLITTING THE SUITE, not by a lock. A lock was tried
   * first and is the wrong mechanism: Playwright charges the wait against each
   * test's timeout, so queued tests time out rather than queue — measured at 8
   * timeouts across seven specs at four workers, against 30/30 passing without
   * it. So the singleton specs are their own project, and `ci.yml` runs that
   * project at `--workers=1` in a second pass while everything else runs
   * parallel.
   *
   * A note the old comment got right and worth keeping: the specs do NOT
   * conflict over the saved root session. Each test gets an independent
   * BrowserContext seeded FROM `e2e/.auth/root.json`, and signing out in one
   * neither rewrites that file nor invalidates another's cookie. The coupling
   * was always the database, and the wrong reason would have justified the
   * wrong fix (#156).
   *
   * Sharding stays as the second axis: `ci.yml` runs four `--shard`s, each a
   * whole machine with its own Postgres, seed and servers. Four remains right —
   * past roughly four, the fixed setup every shard pays in full starts to
   * dominate what is left of the suite to divide.
   */
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  /*
   * Half the machine, rather than a number picked for one machine.
   *
   * The runner shares its vCPUs with Postgres, two Node servers and Chromium, so
   * the useful figure is a fraction rather than a constant — and a constant
   * tuned on a 4-vCPU runner is wrong the day the runner changes.
   *
   * Measured locally on shard 1, retries off, on an 8-core box: 2m52s at one
   * worker, 2m44s at two, 2m04s at four. Sublinear, because much of this suite
   * waits on sign-ins rather than on CPU — which is also why oversubscribing
   * would cost more than it returns.
   *
   * And measured on the runner, which is the number that counts: the slowest
   * shard went from 796s to 720s, and shard 1 from 437s to 309s.
   *
   * The singleton pass overrides this to 1 on the command line.
   */
  workers: process.env.CI ? '50%' : undefined,
  reporter: [['html', { open: 'never' }], ['list']],
  use: {
    baseURL: process.env.E2E_BASE_URL ?? 'http://localhost:3000',
    trace: 'on-first-retry',
    screenshot: 'only-on-failure',
  },
  projects: [
    // Login once and save session — runs before authenticated tests
    {
      name: 'setup',
      testMatch: /auth\.setup\.ts/,
    },
    // Authenticated tests reuse the saved root session
    {
      name: 'chromium',
      use: {
        ...devices['Desktop Chrome'],
        storageState: 'e2e/.auth/root.json',
      },
      dependencies: ['setup'],
      // Everything except the specs below, which cannot run beside each other.
      testIgnore: SINGLETON_SPECS,
    },
    {
      name: 'chromium-singletons',
      use: {
        ...devices['Desktop Chrome'],
        storageState: 'e2e/.auth/root.json',
      },
      dependencies: ['setup'],
      testMatch: SINGLETON_SPECS,
    },
  ],
  /*
   * Production builds in CI, `next dev` locally (#374).
   *
   * `next dev` compiles a route the first time it is requested, inside the
   * test's own 30s clock. `next start` serves a build, so that cost moves to the
   * `build` job — which already makes exactly this build and publishes it, so no
   * job compiles twice.
   *
   * Locally it stays `dev`: somebody running one spec wants their edit
   * reflected without a rebuild, and one worker's compile starves nothing.
   *
   * If `next start` reports "Could not find a production build", the artifact
   * did not land where it should. `upload-artifact` roots the archive at the
   * least common ancestor of its paths, so the two `.next` directories arrive
   * as `backend/.next` and `frontend/.next` — the download must use
   * `path: apps`, not `path: .`.
   */
  webServer: [
    {
      command: process.env.CI ? 'pnpm --filter backend start' : 'pnpm --filter backend dev',
      url: 'http://localhost:3001/api/health',
      reuseExistingServer: true,
      timeout: 180_000,
    },
    {
      command: process.env.CI ? 'pnpm --filter frontend start' : 'pnpm --filter frontend dev',
      url: 'http://localhost:3000/api/ping',
      reuseExistingServer: true,
      timeout: 180_000,
    },
  ],
})
