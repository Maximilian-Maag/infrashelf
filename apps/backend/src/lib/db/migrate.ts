import path from 'node:path'
import { readMigrationFiles } from 'drizzle-orm/migrator'
import type postgres from 'postgres'

// PostgreSQL error codes that mean the object already exists — safe to skip
// when the DB was seeded via db:push instead of the migration runner.
const IDEMPOTENT_PG_CODES = new Set(['42P07', '42701', '42710'])

/** Where the .sql files live, relative to the process — `apps/backend/drizzle`. */
export const migrationsFolder = (cwd = process.cwd()): string => path.join(cwd, 'drizzle')

/**
 * Apply every migration this database has not seen, tracked by hash.
 *
 * Lives here rather than inside bootstrap because the test suite builds its
 * database with it too. It used to build one from a hand-written copy of the DDL
 * in `src/test/setup.ts` — a third description of the schema alongside
 * `schema.ts` and `drizzle/*.sql`, which had drifted from both: five CHECK
 * constraints production does not have, a missing `audit_log.user_id` foreign
 * key, seven missing indexes and two stale colour defaults (#147). A copy cannot
 * drift only if there is no copy.
 *
 * Takes the raw `postgres` client rather than the db singleton: bootstrap runs
 * against the app's connection and the suite against its own per-worker one, and
 * DDL has nothing to gain from going through Drizzle.
 */
export const applyMigrations = async (client: postgres.Sql, cwd = process.cwd()): Promise<void> => {
  const migrations = readMigrationFiles({ migrationsFolder: migrationsFolder(cwd) })

  await client`
    CREATE TABLE IF NOT EXISTS "__drizzle_migrations" (
      id serial PRIMARY KEY,
      hash text NOT NULL,
      created_at bigint
    )
  `

  // One SELECT for the whole set rather than one per migration. The suite calls
  // this once per test file — 150 times against a database that is already up to
  // date — and in that case the round trips are the entire cost.
  const applied = new Set(
    (await client<{ hash: string }[]>`SELECT hash FROM "__drizzle_migrations"`).map((row) => row.hash),
  )

  for (const migration of migrations) {
    if (applied.has(migration.hash)) continue

    for (const statement of migration.sql) {
      const trimmed = statement.trim()
      if (!trimmed) continue
      try {
        await client.unsafe(trimmed)
      } catch (e: unknown) {
        const code = (e as { code?: string })?.code
        if (IDEMPOTENT_PG_CODES.has(code ?? '')) {
          console.warn(`[migrate] skipped (${code}): ${trimmed.slice(0, 100)}`)
          continue
        }
        throw e
      }
    }

    await client`INSERT INTO "__drizzle_migrations" (hash, created_at) VALUES (${migration.hash}, ${migration.folderMillis})`
    console.warn(`[migrate] applied: ${migration.hash.slice(0, 8)}`)
  }
}
