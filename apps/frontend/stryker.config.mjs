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
  htmlReporter: { fileName: 'reports/mutation/frontend.html' },

  // jsdom tests hold no shared state, so the default concurrency applies.
  // Everything under src is in scope: components and helpers without a test
  // file cost nothing to include (they are reported as "no coverage" without
  // running a single test) and they show where the suite has blind spots.
  mutate: [
    'src/**/*.{ts,tsx}',
    '!src/test/**', // setup only
    '!src/types/**', // type declarations
    '!src/**/*.test.{ts,tsx}',
    // The 25 language tables are ~5,000 module-level string literals. Mutating one
    // asks "would a test notice if this German label changed", and the answer is no
    // by design: nothing asserts individual translations, only that a language does
    // not fall back to English wholesale. Including them cost more than half the
    // run's mutants for no signal — a full run was estimated at 38 hours, 97% of it
    // on these.
    '!src/lib/i18n.ts',
  ],

  /*
   * ── Cosmetic mutants are excluded AT THE LINE, not by turning a mutator off ──
   *
   * A presentational component is mostly markup, and Stryker counts every
   * `className` string and `style={{…}}` object as a mutant. `ProductCard` is the
   * measured example: 14 solid behavioural tests took it to 52%, and every one of
   * the eleven survivors was styling — three style objects and two hover handlers
   * setting `borderColor`. Killing those means asserting inline CSS and
   * simulating hover, which produces tests that break on every restyle and catch
   * no defects. The score would go up; the suite would get worse.
   *
   * So a line that carries ONLY appearance is marked in the source:
   *
   *     // Stryker disable next-line all: hover decoration — see stryker.config.mjs
   *     onMouseEnter={(e) => (e.currentTarget.style.borderColor = 'var(--bp)')}
   *
   * The same file then scores 100% over 12 mutants that all mean something.
   *
   * Three rules for using it, because an exclusion that is easy to reach for
   * stops meaning anything:
   *
   *  1. ONLY appearance. If a reader could act differently because the line
   *     changed — a label, an href, an aria attribute, a disabled state, a
   *     branch — it is behaviour and it gets a test instead.
   *  2. The disable names its reason. "brand colours", not "cosmetic".
   *  3. Put the attribute on its own line first, so the disable covers the style
   *     and not the `className` beside it that a test legitimately kills.
   *  4. Excluding an ATTRIBUTE needs the comment IN THE ATTRIBUTE LIST, as
   *     above. A JSX child comment over the element —
   *
   *         {/* Stryker disable next-line all: … *\/}
   *         <div className="…" style={{ backgroundColor: 'var(--bp)' }}>
   *
   *     compiles, reads correctly, and excludes nothing: it does not reach the
   *     attribute's mutants. Measured on #437 — 36 survivors with that comment,
   *     36 without, 33 once it moved into the attribute list. Moving the words
   *     `Stryker disable` to the START of the child comment, which is the usual
   *     suggestion, changes nothing; the position relative to the mutant is what
   *     matters, not the text.
   *
   *     The child form is not useless — it is right for excluding a JSX CHILD,
   *     which is what `SectionError.tsx` uses it for. Only attributes need the
   *     other placement.
   *
   *     So: always confirm an exclusion by the mutant COUNT falling, never by the
   *     comment looking correct. Both forms compile and neither warns.
   *
   * NOT `mutator.excludedMutations`. Turning off `StringLiteral` globally would
   * also stop mutating every URL, every i18n key and every status string — the
   * mutants most worth having. The cost of doing it per line is that somebody has
   * to look at each one, which is the point.
   *
   * The precedent is `i18n.ts` in `mutate` below: excluded because nothing
   * asserts an individual translation, only that a language does not fall back
   * wholesale. Same argument, finer grain.
   */

  // Static mutants — code that runs once at import time — cannot be attributed to
  // individual tests, so Stryker reruns the whole suite for each one. Measured on
  // this app: 51% of mutants were static and accounted for an estimated 97% of the
  // runtime. Reported as "ignored" instead, the same call the backend config
  // already made. The cost is real: module-level constants and configuration
  // objects are no longer covered by the score.
  // Our own sources only, matching the backend, where the default cost every
  // nightly its score: Stryker prepends `// @ts-nocheck` to each file its
  // `disableTypeChecks` glob matches, the default reaches past `src`, and a
  // vendored asset a test compared byte-for-byte came back sixteen bytes long.
  //
  // Nothing is broken here — this sandbox does not currently copy `public/` at
  // all, so `sw.js` was never rewritten. Pinned anyway, because the two configs
  // disagreeing on which files Stryker may edit is the kind of difference that
  // is only ever noticed by the next person to lose a night's run to it.
  disableTypeChecks: 'src/**/*.{ts,tsx}',

  ignoreStatic: true,

  // The dry run is its own clock, defaulting to five minutes for the whole
  // suite. The frontend's takes ~50 seconds, so this is headroom rather than a
  // fix — but overrunning it produces no score at all, silently, and a gate that
  // can vanish without saying so is worth one line to prevent.
  dryRunTimeoutMinutes: 20,

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
  thresholds: { high: 90, low: 80, break: 35 },
}

export default config
