# Testing

The suite has four levels, each with its own command and its own reason for
existing. This is the guide to writing tests here: where they go, what the gates
enforce, and the traps that have cost this repo a run.

`docs/TEST_PLAN.md` is a dated plan (2026-08-12) and lists what was recommended
then; `docs/guides/mutation-testing.md` is the mutation half. This file is how the
suite works now.

## The levels

| Level | Command | What it is |
|---|---|---|
| Backend unit + integration | `pnpm --filter backend test` | vitest, real Postgres, `*.test.ts` beside the module |
| Frontend unit + component | `pnpm --filter frontend test` | vitest, jsdom, Testing Library |
| Scripts | `pnpm test:scripts` | the root-level scripts (`scripts/*.mjs`), vitest |
| End to end | `make test-e2e` | Playwright, four shards, real stack |

`make test` runs the first three. Everything below needs the Postgres container
(`docker compose -f infra/docker-compose.dev.yml up -d --wait postgres`), which
`make dev` brings up.

Two more legs are not part of `make test` because they are slow:

```bash
pnpm test:coverage                    # both apps, v8 coverage
pnpm test:mutation                    # Stryker — hours; see the mutation guide
```

A single file, which is what you will actually run:

```bash
cd apps/backend && TEST_DB_SUFFIX=thing pnpm exec vitest run src/lib/foo.test.ts
```

`TEST_DB_SUFFIX` names the databases this run creates. Each test file gets its own
database, derived from the working directory and the suffix, so a run is
independent of any other; `pnpm --filter backend test:db:prune` removes the ones
left behind. Do not reuse a suffix across two concurrent runs.

## What a test has to be able to say

**Name the defect it would catch.** A test written to make a number go up — or to
raise a mutation score — makes the suite no more able to catch a regression than
before it was written. If you cannot say what breaks when the line under test
changes, the test is not ready.

**Mutation-verify it.** Break the line (or invert the condition) and watch the new
test go red, then restore. This is not ceremony: it has repeatedly found tests
that passed against the very bug they were named for, and it is the only way to
tell "asserted" from "executed". A small Python script that applies one mutation
at a time, runs just that file's test and restores in a `finally` turns this into
one command — and it should assert every source came back byte-identical, because
the failure mode is committing a mutation.

Key each mutation to the test files that must catch it, explicitly. A harness that
maps mutation indices to paths runs the wrong suite the moment a mutation is
inserted, and reports green — which reads either as "this guard is untested" or,
worse, as covered.

**Assert the effect, not the call.** `expect(service).toHaveBeenCalled()` passes
when the service is called with the wrong arguments. Assert what changed: the row,
the status, the header, the audit entry.

**Scope counts per stage or per row.** A file-level or global count passes when
the thing you are testing is broken and something else compensates. That is the
classic trap in this suite.

**A test whose name claims less than it checks is a finding.** Fix it in the same
PR as whatever you were doing.

## Where tests live

Beside the module (`src/lib/foo.ts` → `src/lib/foo.test.ts`), and for a route
handler that means a test that **imports** it — the gate reads import edges, not
filenames, because `sessions/route.test.ts` legitimately covers
`sessions/[id]/route.ts` from one directory over. A dynamic `await import(...)` is
not an import edge; if you need one for mocking reasons, import the module
statically and use `vi.hoisted` for the mocks (see
`app/api/auth/webauthn/route.test.ts` for the pattern and why).

A pure module — no database, no HTTP — is the cheapest test in the suite and the
most valuable per line: two files beside two modules, no fixtures, no seeded rows.

## The gates that enforce this

`make policy` (OPA, part of CI) denies, among others:

- **`route_has_a_test`** — every route handler must be imported by a test. A deny
  since #181, when the count reached zero.
- **`table_in_test_setup`** — every table in `schema.ts` must be emptied between
  tests. A table missing from that list leaks rows into the next test, which is
  how a suite passes alone and fails in a full run.
- **`translation_key_in_every_language`** — a new `Translations` key must exist in
  all 25 tables; a key in 2 of 25 passes every test and fails the gate.
- **`no_secret_column_in_select`** — a hand-written projection naming a credential
  column is denied unless the file and column are listed in
  `intentional_secret_reads` with the reason the value never leaves the process.

Lint runs with `--max-warnings 0`: no non-null assertions, no unused bindings —
including unused destructured ones.

## Traps this suite has paid for

- **Never move the working tree while a suite is running in it (#543).** vitest
  transforms each module once per run and serves that transform for the rest of
  it, so a `git checkout` mid-run makes the run read two revisions, mixed per
  module. `src/test/treeGuard.ts` now refuses such a run and names the files that
  differ. Start a full run only in a checkout nobody will touch, or in a
  `git worktree`.
- **A wholesale module mock hides shared constants.** `vi.mock('@/lib/ci', () =>
  ({…}))` appears in a dozen files; a constant exported from that module is
  `undefined` in all of them, and the failure is not a mock complaint but a
  splitter comparing against `undefined`. Put a rule two callers share in its own
  module.
- **A mocked `fetch` serves one call.** `mockResolvedValue(new Response(…))` hands
  the same body to every call and a body can be read once, so a test that provokes
  two calls gets a real answer for the first and `Body is unusable` for the rest.
  Use `mockImplementation(async () => new Response(…))` when more than one call is
  expected.
- **Mock a capability predicate as the real function answers**, not as `true`:
  `mockImplementation((p) => p === 'gitlab')`, or the test that relies on the
  unsupported provider fails for a reason that has nothing to do with the code.
- **Sending is fire-and-forget.** `await sendApprovalRequest(…)` returns before the
  transport is built, so an assertion on `createTransport` needs
  `await vi.waitFor(…)` — a bare assertion after the await passes or fails by
  timing.
- **One mock returning a row shape for two different reads.** A module that reads
  `app_config` twice in one call — once for its own columns and once through a
  helper — needs the mocked `select` to answer both.

## Mutation testing

The score is the fraction of mutants the suite kills. Two numbers matter and they
are different:

- the **ratchet** in each `stryker.config.mjs` (`thresholds.break`, 70 backend /
  35 frontend at the time of writing) follows the last measured score, so the
  nightly fails only when the suite gets WORSE;
- the **release threshold**, `RELEASE_THRESHOLD: '90'` in
  `.github/workflows/mutation-release-gate.yml`, decides whether something ships
  and does not move with the ratchet. It reports rather than blocks until
  `ENFORCE_FROM` (2026-11-01), which is a forcing function: on that date the gate
  starts blocking `main` and somebody has to decide in the open.

`thresholds.high: 90` and `low: 80` are the report's colours; `mutate` deliberately
includes files with no test at all so they show as blind spots, so a low score can
mean "an untested file was added" rather than "the assertions got worse". Two
thirds of the frontend gap is files with no test near them.

Read the report per file, not as one number: the useful view is
`no-coverage + survived` per file, biggest first, because a file with no test is
where the movement is and a survivor is an assertion that executes and pins
nothing. The nightly's report is an artifact of the `mutation.yml` run
(`mutation-report-backend`, `mutation-report-frontend`), and `incremental.json` in
it carries the per-file, per-mutant statuses.

A scoped run is the practical way to measure one file without spending a night:

```bash
gh workflow run mutation.yml -f scope='src/lib/services/foo.ts'
```

The dry run is the expensive part (the full backend suite), so a scoped run still
takes tens of minutes — but it gives a real before/after for the file you touched,
which is what a PR claiming a mutation improvement should quote.

Rules for raising the score, from #245:

1. cover the files with no test at all first — the biggest movement per unit of
   effort, and where real bugs have been hiding (every frontend bug fixed in one
   session was an untested `catch` or an untested conditional);
2. then read the survivors, which are assertions that are present but pin nothing;
3. raise `break` in the same PR that raises the score, never speculatively;
4. never write a test that only kills a mutant.

A hand-mutation of a message inside an unreachable branch is an equivalent mutant,
not a gap: say so in the PR rather than hunting for a test that cannot exist.

## End to end

`e2e/*.spec.ts` runs in four shards on separate runners, each with its own
Postgres and its own demo seed; a following job merges the four blob reports and
`scripts/skip-budget.mjs` judges the whole thing against a budget of 8 skipped
tests (the a11y suite is judged against 0). E2E does not run locally without a
migrated and seeded database and an enrolled admin second factor — verify it
through the shards on the PR.

A red shard is not always your diff: `E2E shard 3` holds the specs that share
global state and flakes on its own. If the failure is in a spec your change cannot
reach, re-run that job once before rewriting your work.
