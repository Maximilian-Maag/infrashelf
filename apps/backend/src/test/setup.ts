import { afterAll, beforeAll, beforeEach } from 'vitest'
import { drizzle } from 'drizzle-orm/postgres-js'
import postgres from 'postgres'
import * as schema from '@/lib/db/schema'
import { getTableName, sql } from 'drizzle-orm'
import { migrate } from 'drizzle-orm/postgres-js/migrator'
import { join } from 'node:path'
import { acquireTestDatabase, wipeIfUnaccountedFor } from './database'

// Claimed at MODULE scope, before any test file is imported: the app's db
// singleton reads process.env.DATABASE_URL when its module first loads, so a URL
// decided later in beforeAll would arrive too late to matter.
const acquired = await acquireTestDatabase(process.env.DATABASE_URL ?? '')
process.env.DATABASE_URL = acquired.url
console.warn(`[test] database: ${acquired.name}`)

// Module-level client for setup/teardown — tests use the app's db singleton.
const client = postgres(acquired.url)
export const testDb = drizzle(client, { schema })

// Every table the suite writes to. Order no longer matters for truncation (see
// TRUNCATE_ALL below), but it is kept dependency-ordered because it reads as the
// schema's shape and new tables get added in the right place by habit.
export const TABLES = [
  schema.auditLog,
  // Narrowing rows outlive nothing: they cascade from both sides, but a test
  // that leaves one behind narrows a parameter for the NEXT test, which then
  // sees it apply nowhere (#275).
  schema.parameterProjects,
  schema.approvalDelegations,
  schema.sessions,
  schema.userRecoveryCodes,
  schema.userTotp,
  schema.webauthnChallenges,
  schema.webauthnLoginChallenges,
  schema.webauthnCredentials,
  schema.productFavorites,
  schema.orderComments,
  schema.productVersions,
  schema.cartItems,
  schema.infrastructureElements,
  schema.orders,
  schema.pipelineStacks,
  schema.productWebhooks,
  schema.productEnvironmentSizes,
  schema.productEnvironments,
  schema.parameters,
  schema.productTranslations,
  schema.productImages,
  schema.products,
  schema.categories,
  // Deployment windows and the holiday cache (#330). Independent of everything
  // else, but a test that writes a window or a holiday and leaves it behind
  // changes whether the NEXT test's order may deploy — which reads as a flaky
  // scheduler rather than as leaked state.
  schema.deploymentWindows,
  schema.holidays,
  // Drift observations (#108). Independent of everything else.
  schema.unclaimedStates,
  // Deployment windows already truncate above; this is the report side (#108).
  // Before deployment_environments: integrations.environment_id references it.
  schema.integrations,
  schema.deploymentEnvironments,
  schema.ciSources,
  schema.projects,
  schema.users,
  schema.costCenters,
  schema.exchangeRates,
  // Singleton tables. In the list because a test that rewrites the branding or
  // the AI config must not leak it into the next one — the quietest failure
  // there is, a suite that passes alone and fails in a full run. Their one row
  // is put back by `beforeEach`, below, so "truncated" does not mean "absent".
  schema.branding,
  schema.appConfig,
  schema.holidayFeedState,
  schema.driftReportState,
] as const

beforeAll(async () => {
  /*
   * A statement that cannot finish must FAIL, not hang.
   *
   * Set on the database, so every connection the app opens afterwards inherits
   * it. Without it a query that blocks on a lock waits for ever: the suite stops
   * making progress and the CI job dies on its own timeout, minutes later, with
   * nothing saying which test or which statement. That is what the
   * `createDelegation` deadlock did once the audit_log FK was added (#195) — an
   * in-transaction `logAudit` on the pool connection blocks on the transaction's
   * own `FOR UPDATE`, and only one backend is waiting, so Postgres' deadlock
   * detector never fires either.
   *
   * Fifteen seconds is far past any legitimate statement here — the slowest is
   * this DDL, which runs once and takes well under a second — and short enough
   * that the failure names itself: "canceling statement due to statement timeout".
   */
  await testDb.execute(sql.raw(`ALTER DATABASE "${acquired.name}" SET statement_timeout = '15s'`))
  await client.unsafe(`SET statement_timeout = '15s'`)

  /*
   * The schema comes from the MIGRATIONS, not from a copy of them (#147).
   *
   * This used to be ~400 lines of hand-written DDL — a third definition of the
   * schema beside `lib/db/schema.ts` and `drizzle/*.sql`, and the only one of
   * the three that had drifted. Column by column it was:
   *
   *   * CHECK constraints on five tables that exist in no migration, so an
   *     out-of-range enum was REFUSED under test and stored happily in
   *     production — a test double stricter than the thing it stands in for,
   *     which is the wrong direction;
   *   * `callback_secret DEFAULT ''` and `rate DEFAULT 1`, neither of them real,
   *     so a row the suite could insert was one production would reject;
   *   * a different `branding.primary_color` default;
   *   * nine indexes missing, so query plans under test were not the deployed
   *     ones.
   *
   * And the cost of keeping it: every new column had to be added in two places,
   * which is how migration 0034 came to need a second edit here on the same day
   * it was written.
   *
   * Running the real files removes the copy AND buys something the copy never
   * could — the migrations are now exercised on every suite run, so one that
   * does not apply fails here rather than in a deployment.
   *
   * Idempotent by construction: the migrator reads `drizzle.__drizzle_migrations`
   * and applies only what is missing, so the cost after the first file in a
   * worker is one SELECT. Each worker holds its own database under an advisory
   * lock (see `acquireTestDatabase`), so no two of them migrate the same one.
   */
  // A schema the journal does not account for is not stale, it is unusable —
  // and it stays that way until someone drops the database by hand (#308).
  if (await wipeIfUnaccountedFor(client)) {
    console.warn(`[test] ${acquired.name} held a schema no migration claimed; rebuilt it from empty`)
  }

  await migrate(testDb, { migrationsFolder: join(process.cwd(), 'drizzle') })

})

/**
 * One statement for every table, not one statement per table.
 *
 * This runs before every one of ~1300 tests, and each `TRUNCATE` is its own
 * transaction waiting on its own commit — so the loop it replaces spent the suite
 * doing 26,000 round trips to Postgres. `TRUNCATE a, b, c` truncates them
 * together, in one transaction, and `CASCADE` no longer has anything to reach for
 * because every referencing table is already in the list. FK order stops
 * mattering for the same reason.
 */
const TRUNCATE_ALL = `TRUNCATE TABLE ${TABLES.map((table) => `"${getTableName(table)}"`).join(', ')} RESTART IDENTITY CASCADE`

/**
 * The four singleton rows the app assumes exist, put back after the truncate.
 *
 * `getBranding` and the config reader both read row 1 and have no answer for its
 * absence, so these are part of an empty database rather than fixtures. They are
 * in TABLES as well, so a test that rewrites the branding does not leak it into
 * the next one.
 *
 * NOT `exchange_rates`, deliberately. It was seeded once in `beforeAll` and has
 * been in TABLES all along, so the EUR row survived exactly one test — and the
 * suite is written against that: `exchangeRates.test.ts` asserts an empty table
 * ("empty after truncate") and exact row sets. A missing rate degrades to the
 * original currency rather than breaking anything, so there is nothing to put
 * back.
 *
 * In the same statement as the truncate, so it is still one round trip per test.
 */
const RESET_ALL = `${TRUNCATE_ALL};
  INSERT INTO branding (id) VALUES (1) ON CONFLICT DO NOTHING;
  INSERT INTO app_config (id) VALUES (1) ON CONFLICT DO NOTHING;
  INSERT INTO holiday_feed_state (id) VALUES (1) ON CONFLICT DO NOTHING;
  INSERT INTO drift_report_state (id) VALUES (1) ON CONFLICT DO NOTHING`

/**
 * How long the per-test reset may take before it is worth explaining itself.
 *
 * The reset is one round trip and normally costs single-digit milliseconds. A
 * second means something is holding a lock on one of these tables, and that is
 * the moment worth capturing — afterwards, all anybody sees is a different test
 * failing for a reason of its own.
 */
const SLOW_RESET_MS = 1_000

/**
 * Say WHY the suite stalled, at the moment it stalls.
 *
 * #282: a full run intermittently reports exactly one failed test, a different
 * one each time, and every one of them passes when its file is run alone. The
 * standing theory was a query from a previous test still in flight on the app's
 * pool, blocking this TRUNCATE's ACCESS EXCLUSIVE lock until something timed
 * out. That theory is now unsupported — there is not one un-awaited database
 * write left in `apps/backend/src` — but "unsupported" is not "disproved", and
 * the runs that produced the report were captured with a filter that threw the
 * error message away.
 *
 * So rather than guess again: when the reset is slow, print what Postgres says
 * is in the way. A blocked TRUNCATE names its blocker here; an ordinary busy
 * server shows nothing and the run continues. Either way the next occurrence
 * arrives with its own evidence instead of needing another six runs to catch.
 */
const explainSlowReset = async (elapsedMs: number): Promise<void> => {
  try {
    const blockers = await testDb.execute(sql`
      SELECT pid, state, wait_event_type, wait_event,
             left(query, 120) AS query,
             EXTRACT(EPOCH FROM (NOW() - COALESCE(xact_start, query_start)))::int AS age_s
      FROM pg_stat_activity
      WHERE datname = current_database()
        AND pid <> pg_backend_pid()
        AND state <> 'idle'
      ORDER BY age_s DESC NULLS LAST
      LIMIT 5
    `)
    console.warn(
      `[test] reset took ${elapsedMs}ms (#282). Other activity on this database:\n` +
        JSON.stringify(blockers, null, 2),
    )
  } catch (e) {
    // The diagnostic must never be the reason a run fails.
    console.warn(`[test] reset took ${elapsedMs}ms (#282); could not read pg_stat_activity:`, e)
  }
}

beforeEach(async () => {
  const started = Date.now()
  await testDb.execute(sql.raw(RESET_ALL))
  const elapsed = Date.now() - started
  if (elapsed >= SLOW_RESET_MS) await explainSlowReset(elapsed)
})

afterAll(async () => {
  await client.end()
  // Releases the advisory lock on this run's database, freeing the name for the
  // next run in this directory.
  await acquired.release()
})
