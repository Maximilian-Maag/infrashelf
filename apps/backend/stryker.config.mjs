// @ts-check
/** @type {import('@stryker-mutator/api/core').PartialStrykerOptions} */
const config = {
  testRunner: 'vitest',
  // Declared explicitly: Stryker's default plugin glob ('@stryker-mutator/*')
  // does not follow the symlinks pnpm puts in node_modules, so autodiscovery
  // finds no test runner at all.
  plugins: ['@stryker-mutator/vitest-runner'],
  vitest: { configFile: 'vitest.config.ts' },
  coverageAnalysis: 'perTest',
  reporters: ['html', 'clear-text', 'progress'],
  htmlReporter: { fileName: 'reports/mutation/backend.html' },

  // Was 1, on the belief that parallel workers would wipe each other's fixtures.
  // They do not: every Stryker worker runs in its own `.stryker-tmp/sandbox-*`
  // directory, and `src/test/database.ts` derives the database name from the
  // working directory — so each sandbox already had its own database. Four
  // workers, matching the suite's own `maxWorkers`, because they all queue on the
  // same Postgres past that point.
  concurrency: 4,

  // Default scope is the business logic in src/lib. The route handlers under
  // src/app/api are thin wrappers around these services; widen the run with
  // `pnpm test:mutation -- --mutate 'src/app/api/**/*.ts'` to cover them.
  mutate: [
    'src/lib/**/*.ts',
    '!src/lib/db/schema.ts', // table declarations — no behaviour to mutate
    '!src/lib/openapi/**', // spec plumbing, asserted by shape rather than behaviour
    '!src/**/*.test.ts',
  ],

  // Only our own TypeScript, and this is why the backend had no score at all.
  //
  // Stryker prepends `// @ts-nocheck` to every file it copies that its
  // `disableTypeChecks` glob matches — and the default reaches beyond `src`. It
  // was rewriting `public/swagger-ui/swagger-ui-bundle.js`, a VENDORED asset
  // committed so the docs page serves same-origin files, and
  // `api/docs/route.test.ts` compares that file byte-for-byte against the copy
  // in node_modules to catch a swagger-ui bump that skipped the vendoring
  // script. Sixteen bytes of banner, inserted after the license comment, and
  // the comparison was false:
  //
  //   repo    …LICENSE.txt */\n!function webpackUniversalModuleDefinition
  //   sandbox …LICENSE.txt */\n// @ts-nocheck\n\n!function webpackUniversal…
  //
  // One failed test in the dry run aborts the whole run — "There were failed
  // tests in the initial test run" — so every nightly since this test was
  // written died before mutating anything, and `thresholds.break` was enforcing
  // nothing at all. The test was right; the sandbox was lying to it.
  disableTypeChecks: 'src/**/*.{ts,tsx}',

  // A static mutant (module-level code, e.g. a zod schema built at import time)
  // cannot be attributed to individual tests, so Stryker reruns the whole suite
  // for each one — hours against a live database. They are reported as "ignored"
  // instead. Drop this once a full run is cheap enough to afford them.
  ignoreStatic: true,

  // Database round trips make individual tests slow enough that the default 5s
  // net timeout yields false "timeout" verdicts instead of real survivors.
  timeoutMS: 30000,
  timeoutFactor: 2,

  // The DRY run is a different clock from `timeoutMS`, and its default is five
  // minutes for the whole suite. Overrunning it fails the same silent way a
  // per-test timeout does: no mutants, no score, and a `thresholds.break` that
  // enforced nothing.
  //
  // Sixty, not the twenty this used to say. The old number was justified as
  // "far more than the ~1 minute CI has needed" — but that minute was the dry
  // run ABORTING on the swagger-ui test above, not completing. The first run
  // that actually finished took **17 minutes 39 seconds** for 3,167 tests, on
  // an idle 8-core machine; a shared runner is slower than that, and twenty
  // would have swapped one silent no-score failure for another.
  //
  // The job itself allows 330 minutes, so this costs nothing when it is not
  // needed. That is the point: this number exists to never be the reason there
  // is no score.
  dryRunTimeoutMinutes: 60,

  // `break` is a RATCHET: it follows the last measured score, so this run fails
  // when the suite gets WORSE and not merely because it is not finished yet.
  //
  // It used to be 90 — the target from #245 — against scores of 72.89 (backend)
  // and 37.48 (frontend), so both legs exited 1 every single night. The
  // intention behind that was a standing statement that the suite is not where
  // it is meant to be, and the number in the job summary was to be the thing to
  // read. In practice it cost the run its only job: a permanently red workflow
  // cannot distinguish "still climbing" from "something actually broke", which
  // is precisely the distinction the 2026-08-24 frontend cancellations needed
  // and did not get. A red nightly now means a REGRESSION.
  //
  // Set below the last completed nightly (2026-09-13) with a little headroom, so
  // ordinary run-to-run wobble is not a failure:
  //   backend  72.89 -> break 70
  //   frontend 37.48 -> break 35
  // Raise them as the score climbs. That is the ratchet, and #245 tracks it.
  //
  // The 90 that decides whether something SHIPS is not this one. It lives in
  // .github/workflows/mutation-release-gate.yml and compares against its own
  // RELEASE_THRESHOLD — deliberate, because a release gate reading a ratchet
  // would pass whatever the suite happened to manage that night.
  //
  // `high`/`low` are unchanged: 90 is still the target and 80 still the floor
  // the report colours against. Note what the score is measured over — `mutate`
  // deliberately includes files with no test at all so they show as blind spots,
  // so a low number can mean "untested file added" rather than "assertions got
  // worse". Roughly two thirds of the frontend gap is files with no test near
  // them at all.
  thresholds: { high: 90, low: 80, break: 70 },
}

export default config
