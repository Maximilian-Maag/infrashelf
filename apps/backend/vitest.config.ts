import { defineConfig } from 'vitest/config'
import path from 'path'
import { testDatabaseUrl } from './src/test/database'

/**
 * Stryker wraps every expression in the source tree in a mutant switch, so the
 * same test is several times slower under a mutation run than under an ordinary
 * one. Vitest's default 5s per-test limit is generous for the second and not for
 * the first — and the failure is silent in the worst way: Stryker aborts its
 * DRY RUN with "There were failed tests in the initial test run", never mutates
 * anything, and reports no score. The nightly backend leg had been doing exactly
 * that, so `thresholds.break = 80` was enforcing nothing at all.
 *
 * Raised only under Stryker, which sets STRYKER_MUTATOR_WORKER in each test
 * runner process. Read here rather than under `src/`, where the policy gate
 * treats an env access as an operator-facing setting needing an `.env.example`
 * entry — and Stryker sets this one itself.
 *
 * An ordinary run used to keep vitest's default 5s, on the argument that a test
 * genuinely taking six seconds is worth being told about. The argument is sound
 * and the number was not: this suite runs four workers against ONE Postgres, and
 * a budget of five seconds measures how busy that server is at least as much as
 * it measures the code.
 *
 * That is #282 — a full run reporting exactly one failure, a different test each
 * time, every one of them passing alone. The theory was a blocked TRUNCATE; the
 * diagnostic added to `src/test/setup.ts` disproves it, reporting an EMPTY
 * `pg_stat_activity` every time the reset ran slow. Nothing is holding a lock.
 * The server is simply saturated, and the tests that lose are whichever ones
 * happened to be doing the most I/O at the time.
 *
 * 15s, then. Still tight enough to catch a test that has genuinely gone wrong —
 * nothing here does real work for fifteen seconds — and slack enough that a
 * queue on a shared server is not reported as a failing assertion.
 *
 * This is a default for the ordinary case and says nothing about the four specs
 * that wait on a Postgres row lock: those override it per test with
 * `LOCK_TEST_TIMEOUT_MS` from `src/test/timeouts.ts`, because a wait longer than
 * the timeout that kills the test never prints its own diagnostic (#386).
 */
const underMutationTesting = process.env.STRYKER_MUTATOR_WORKER !== undefined

export default defineConfig({
  test: {
    testTimeout: 15_000,
    hookTimeout: 15_000,
    ...(underMutationTesting ? { testTimeout: 60_000, hookTimeout: 60_000 } : {}),
    globals: true,
    environment: 'node',
    // Records the tree this run started on, once, before any worker exists — the
    // per-file setup compares itself against it and refuses to report on a run
    // whose tree moved underneath it (#543, `src/test/treeGuard.ts`).
    globalSetup: ['./src/test/globalSetup.ts'],
    // Stryker copies the whole source tree into .stryker-tmp/sandbox-*/ while a
    // mutation run is in progress. Those copies contain test files, so an ordinary
    // `vitest run` picks them up: the suite doubles, and the copies fail against a
    // mutated source — which looks like a broken working tree.
    exclude: ['**/node_modules/**', '**/dist/**', '**/.stryker-tmp/**'],
    setupFiles: ['./src/test/setup.ts'],
    env: {
      // Per working directory, so a mutation run in .stryker-tmp/sandbox-* and an
      // ordinary run in the checkout do not truncate each other's tables. Set
      // TEST_DB_SUFFIX to separate two runs started by hand in one checkout.
      DATABASE_URL: testDatabaseUrl(),
      JWT_SECRET: 'test-jwt-secret-32-chars-minimum!!',
      ADMIN_EMAIL: 'root@test.dev',
      ADMIN_PASSWORD: 'testpassword123',
      // 64 hex characters, so the integration registry (issue #111) is enabled
      // for the suite. Tests that need the UNCONFIGURED behaviour delete this
      // from process.env for the duration of the test — see
      // lib/crypto/secrets.test.ts, and note that the key cache in that module
      // is keyed on the raw value precisely so that works.
      SECRET_ENCRYPTION_KEY: '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
    },
    coverage: {
      provider: 'v8',
      reporter: ['text', 'lcov'],
      include: ['src/**/*.ts'],
      exclude: ['src/test/**', 'src/**/*.test.ts'],
    },
    // Files in parallel, each on its own database.
    //
    // `src/test/setup.ts` claims a database at module scope, and Vitest evaluates
    // the setup file once per test file — so concurrent files claim different
    // names through the advisory-lock fall-through in `src/test/database.ts`
    // (`..._2`, `..._3`, …). Nothing is shared between them, which is what makes
    // this safe; before, one shared database made it impossible.
    //
    // Capped rather than left to the default (CPUs - 1): every worker holds a
    // database and a connection pool, and the Postgres they all talk to is the
    // same one, so past a point the workers only queue on it. MAX_CANDIDATES in
    // database.ts is the hard ceiling on this number.
    maxWorkers: 4,
    // Tests WITHIN a file stay sequential: they share the fixtures that the
    // `beforeEach` truncation sets up, so making them concurrent would break them
    // for real rather than merely slowly.
    sequence: { concurrent: false },
  },
  resolve: {
    alias: { '@': path.resolve(__dirname, './src') },
  },
})
