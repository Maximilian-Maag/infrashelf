# Mutation Testing Guide

Line coverage says a line ran; it does not say an assertion would notice if that
line were wrong. [StrykerJS](https://stryker-mutator.io/) answers the second
question: it rewrites the source one small change at a time (`>` → `>=`, `&&` →
`||`, a string literal → `""`) and reruns the tests that cover that line. A
mutant the suite still passes on — a **survivor** — marks behaviour nothing
asserts.

Both apps are wired up:

```bash
pnpm --filter frontend test:mutation     # jsdom suite, minutes
pnpm --filter backend  test:mutation     # real Postgres, hours — see below
pnpm test:mutation                       # both, backend first
```

Reports land in `apps/<app>/reports/mutation/<app>.html` (git-ignored). Open one
and read the survivors; the score itself matters less than the list.

Narrow a run to what you are working on — this is the normal way to use the tool:

```bash
pnpm --filter backend test:mutation -- --mutate 'src/lib/services/orders.ts'
pnpm --filter frontend test:mutation -- --mutate 'src/components/forms/**/*.tsx'
```

---

## Prerequisites

The backend suite talks to a real database, so the same prerequisite as
`pnpm --filter backend test` applies: Postgres up (`make dev` or the compose
file in `infra/docker-host/`) with the `infrashelf_test` database
present. A mutation run starts with an unmutated dry run and aborts on the first
failure, so a suite that is red for unrelated reasons stops Stryker before it
mutates anything.

Parallel runs no longer collide, though they used to and the failure looked like
a config problem: `src/test/database.ts` now derives the database name from the
working directory, and each Stryker worker runs in its own
`.stryker-tmp/sandbox-*` copy of the tree, so each already has a database of its
own. `TEST_DB_SUFFIX` separates the one case a directory cannot — two runs
started by hand in the same checkout.

**Unset `TEST_DB_SUFFIX` before a Stryker run.** The suffix is applied *instead
of* the working-directory hash, not alongside it, and Stryker passes the
environment through to every worker — so a suffix that is set makes all the
sandboxes share one database, which is the exact collision the per-directory
naming exists to prevent. It is easy to have one set without noticing: it is the
normal way to keep two hand-started vitest runs apart.

### The databases pile up

Every sandbox gets a database and nothing ever removes it. That is the price of
the per-directory naming, and it is not small: one developer's Postgres held
**328** `infrashelf_test_*` databases, about 3 GB, almost all of them from
Stryker runs months old.

```sh
pnpm --filter backend test:db:prune          # lists what it would drop
pnpm --filter backend test:db:prune --yes    # drops it
```

It only touches names beginning with `infrashelf_test`, and it skips any
database it cannot take the advisory lock for — so a suite running in another
terminal keeps its own. Dropping the database this checkout uses is harmless: the
next run recreates it from the migrations, in about a second.

Old databases are not merely untidy. One created before #147 has the full schema
and no migration journal, and the migrator, which only ever adds, fails on it
with `relation "app_config" already exists` in `beforeAll` — the same way, for
ever. Since #308 the suite notices that shape and rebuilds the database from
empty instead of failing, but pruning is still the cheaper habit.

Expect it to be slow. One measured data point: mutating
`src/lib/tfparser/index.ts` alone (116 mutants, ~4 covering tests each) takes
**12m40s**, because every mutant reruns DB-backed route tests at roughly 6s a
piece. Scoping the run with `--mutate` is the difference between a coffee break
and an overnight job. The frontend is a different animal entirely: 130 mutants
in `src/lib/contrast.ts` finish in 70 seconds.

---

## Why the two configs differ

`apps/frontend/stryker.config.mjs` is close to stock. The jsdom tests share no
state, so Stryker runs its default number of workers, and everything under `src`
is in scope: a component with no test costs nothing to include, because a mutant
no test covers is reported as "no coverage" without running anything.

`apps/backend/stryker.config.mjs` carries three deliberate deviations:

- **`concurrency: 4`.** It was 1, on the belief that parallel workers would wipe
  each other's fixtures in a shared database. They do not — see the per-sandbox
  database naming above — and four matches the suite's own `maxWorkers`, past
  which the workers only queue on the same Postgres.
- **`ignoreStatic: true`.** A mutant in module-level code (a zod schema built at
  import time, a top-level constant) cannot be attributed to any single test, so
  Stryker falls back to running the *entire* suite for it — hours per mutant
  here. Those mutants are reported as "ignored" instead of measured.
- **`mutate` scoped to `src/lib/**`.** The service layer is where the logic
  lives; the route handlers in `src/app/api` are mostly wrappers around it. Add
  them explicitly (`--mutate 'src/app/api/**/*.ts'`) when you want them checked.

Both configs also name the plugin explicitly:

```js
plugins: ['@stryker-mutator/vitest-runner'],
```

Stryker's default plugin glob (`@stryker-mutator/*`) does not follow the
symlinks pnpm puts in `node_modules`, so without this line it finds no test
runner at all and fails with `Cannot find TestRunner plugin "vitest"`.

---

## Making the backend run faster

The database is no longer the ceiling — `concurrency` is 4. Treat that as the
practical maximum rather than a starting point: `stryker.config.mjs` says why,
which is that every worker talks to the SAME Postgres, so past four they mostly
queue on it. Raising it is a thing to measure, not to assume.

What costs the hours is that every mutant reruns route tests against a live
Postgres at roughly 6s a piece, so the lever that still works is scope: prefer
`--mutate` on the file you are actually changing.

### Scoring one file

The nightly judges everything; when you want a number for one file — the file you
just wrote tests for, say — dispatch the workflow with a scope:

```bash
gh workflow run mutation.yml -f scope='src/lib/services/commitGates.ts'
```

The scope overrides `mutate` for BOTH legs of the matrix, and each leg checks
whether the scope names a file of its own before it starts Stryker: a leg with no
match skips itself with a `::notice::` and the run stays green, because a glob
that matches nothing is a configuration error to Stryker ("No tests were
executed"), not a no-op. Score the file in the leg that owns it; read the number
from the job summary, or `incremental.json` in the `mutation-report-<app>`
artifact when you want it per file.

---

## In CI

Three places, and they are not asking the same question.

| Where | When | What a red run means |
|---|---|---|
| `.github/workflows/ci.yml` | never | — a per-PR mutation run is far too slow to gate a merge on, and #245 settled that it is not what the number is for |
| `.github/workflows/mutation.yml` | nightly on `dev`, plus `workflow_dispatch` | "did it get worse?" — it blocks nothing. `thresholds.break` is a ratchet set just below the last measured score, so a red run means a REGRESSION rather than "not finished yet" |
| `.github/workflows/mutation-release-gate.yml` | pull requests whose **base** is `main` | the release does not meet 90% — from `ENFORCE_FROM` onwards. Until that date the job reports the number and passes |

The release gate is the one the owner's 90% belongs to: the branch model is `dev`
on the dev server, `staging` on staging and `main` in production, and the score
has to hold at the last hop, not on every branch that reaches `dev`.

Two things about it are worth knowing before you read a run:

- **The 90 lives in the workflow, not in `thresholds.break`.** `break` is a
  ratchet that tracks the last measured score so the nightly can only improve
  (#245); a release gate reading that ratchet would wave through whatever the
  suite managed that week. The workflow's `RELEASE_THRESHOLD` is the number that
  does not move.
- **It runs without `--incremental`.** The nightly reuses cached verdicts for
  code Stryker believes has not changed, which is a fair trade for a trend line
  and the wrong basis for a decision to ship.

It also skips itself when a promotion moves nothing but `docs/`, `infra/` and
Markdown — an hour of runner time buys nothing there. The `Mutation gate` job
always runs and reports that skip as a pass, so it is the name to put in branch
protection: a required check that gets skipped stays pending forever and wedges
the merge it was meant to guard.

### Why it starts as a report

It cannot pass today. Both legs now produce a number — the 2026-09-13 nightly
scored **72.89** on the backend and **37.48** on the frontend — and both are
below the 90 a release needs. This repository's own rule, from `README.md`, is
that a gate which cannot pass yet ships naming the issue that will promote it,
because one that starts red teaches people to click past it.

`ENFORCE_FROM` in the workflow is the date that stops being an excuse. Nothing
believes 37.48 → 90 happens by then; what happens is that the gate starts
blocking `main` and somebody decides in the open — raise the score, or move the
date with the reason written next to it. Run the workflow by hand with
`enforce: true` to see what that day will look like.
