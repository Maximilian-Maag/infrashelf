#!/usr/bin/env node
/**
 * Fail a Playwright run that skipped more tests than it is allowed to.
 *
 * A skip is invisible in a green summary. That is how #152 went unnoticed: CI
 * never seeded the e2e database, so 56 of 283 tests skipped — every pipeline
 * stack test, most of admin-products, the whole order flow — and the report said
 * `{"expected": 0, "skipped": 283, "ok": true}`. A run that executed nothing
 * reported success, for months.
 *
 * The count alone would be enough to fail the job. It would not be enough to fix
 * it, so this prints WHICH tests skipped and the reason each one gave — a skip
 * with `test.skip(true, 'nothing on /orders to open')` is a data problem, and one
 * with no annotation is a `fixme` somebody left behind.
 *
 *   node scripts/skip-budget.mjs e2e-results.json 3
 */
import { readFileSync } from 'node:fs'

const [file, rawBudget] = process.argv.slice(2)
if (!file || rawBudget === undefined) {
  console.error('usage: skip-budget.mjs <playwright-json> <budget>')
  process.exit(2)
}

const budget = Number(rawBudget)
if (!Number.isInteger(budget) || budget < 0) {
  console.error(`budget must be a whole number of tests, got "${rawBudget}"`)
  process.exit(2)
}

let report
try {
  report = JSON.parse(readFileSync(file, 'utf8'))
} catch (e) {
  // Louder than a missing-file trace: a run that produced no report is a run
  // whose skips nobody counted, which is the thing this exists to prevent.
  console.error(`could not read the Playwright JSON report at ${file}: ${e.message}`)
  process.exit(2)
}

/** Every spec in the report, however deeply the suites nest. */
function* specs(suite) {
  for (const s of suite.suites ?? []) yield* specs(s)
  for (const spec of suite.specs ?? []) yield spec
}

const skipped = []
for (const suite of report.suites ?? []) {
  for (const spec of specs(suite)) {
    for (const test of spec.tests ?? []) {
      /*
       * Did this test END UP skipped — not "was it ever skipped once".
       *
       * `test.status` is Playwright's own verdict and covers both a
       * declaration-time `test.skip` and a runtime `test.skip(cond, reason)`:
       * a runtime skip rewrites the test's expected status, so the outcome is
       * 'skipped' either way. It is the same field `stats.skipped` is built
       * from, which is what made #152's report say `"skipped": 283`.
       *
       * The old check ALSO counted any test with a skipped RESULT, and that is
       * the wrong question in a serial group. When one test there fails,
       * Playwright skips the rest of the group and then retries the whole
       * group — so a test that flaked once and passed on the retry has results
       * `['skipped', 'passed']`. It ran. It passed. Playwright reported
       * `skipped: 0, flaky: 1`, and this script reported one skip and failed a
       * job whose accessibility gate was entirely green (#374): the branding
       * describe block is `mode: 'serial'`, its first test flaked on a contrast
       * assertion, and the test after it was collateral.
       *
       * So: the LAST result is the one that says what happened. A test still
       * skipped at the end of its retries counts, and it stays counted even if
       * the group failed — that job fails on the failure anyway, and a skip
       * hidden behind a failure is exactly the thing worth printing.
       */
      const results = test.results ?? []
      const ended = results[results.length - 1]?.status
      if (test.status !== 'skipped' && ended !== 'skipped') continue
      const reason = test.annotations?.find((a) => a.type === 'skip' || a.type === 'fixme')?.description
      skipped.push(`${spec.file} › ${spec.title}${reason ? ` — ${reason}` : ''}`)
    }
  }
}

const stats = report.stats ?? {}
console.log(
  `${stats.expected ?? '?'} passed, ${stats.unexpected ?? '?'} failed, ${skipped.length} skipped (budget ${budget})`,
)

if (skipped.length <= budget) process.exit(0)

console.error(`\n${skipped.length} tests skipped, which is more than the ${budget} this job allows:\n`)
for (const line of skipped) console.error(`  ${line}`)
console.error(
  '\nA skipped test is not a passing test. If the database has nothing to walk to, seed it;\n' +
    'if the test is genuinely not applicable here, say so in the budget rather than in silence.',
)
process.exit(1)
