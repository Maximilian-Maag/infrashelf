import { describe, it, expect } from 'vitest'
import { getTableName, is } from 'drizzle-orm'
import { PgTable } from 'drizzle-orm/pg-core'
import * as schema from '@/lib/db/schema'
import { TABLES } from './setup'

/**
 * Every table the schema declares is truncated between tests.
 *
 * Added because a new table is not. `webauthn_login_challenges` (#241) was
 * declared in `schema.ts`, migrated, and simply never added to `TABLES` — so its
 * rows survived the per-test reset and leaked into the next test. It surfaced
 * as a duplicate-key error, which is the lucky version: the table has a primary
 * key that happened to collide. A table without one would have leaked silently,
 * and the failure would have landed on some unrelated test months later.
 *
 * Nothing else catches it. The list is hand-maintained, `TRUNCATE ... CASCADE`
 * only reaches tables that REFERENCE one in the list, and a standalone table
 * references nothing.
 *
 * An opt-out list rather than none, because "truncate everything" is not quite
 * the rule — see `drizzle_migrations`.
 */
const NOT_TRUNCATED = new Set<string>([])

/**
 * Every table `schema.ts` exports, by its database name.
 *
 * Cast through `unknown[]` first: `Object.values(schema)` is a union of ~40
 * distinct `PgTableWithColumns<...>` types, and a `value is PgTable` predicate is
 * not assignable to a parameter of that union — the narrow types carry literal
 * table names that the general one does not.
 */
const declaredTableNames = (): string[] =>
  (Object.values(schema) as unknown[])
    .filter((value): value is PgTable => is(value, PgTable))
    .map((table) => getTableName(table))

describe('the per-test reset covers the whole schema', () => {
  it('truncates every table declared in schema.ts', () => {
    const declared = declaredTableNames()
    const truncated = new Set<string>(TABLES.map((table) => getTableName(table)))
    const missing = declared.filter((name) => !truncated.has(name) && !NOT_TRUNCATED.has(name))

    expect(
      missing,
      `Tables in schema.ts that no test resets — add them to TABLES in src/test/setup.ts:\n  ${missing.join('\n  ')}`,
    ).toEqual([])
  })

  it('does not name a table that no longer exists', () => {
    // The other direction: a TRUNCATE naming a dropped table fails every test in
    // the suite at once, which is loud but tells you nothing about which entry.
    const declared = new Set<string>(declaredTableNames())
    const stale = TABLES.map((table): string => getTableName(table)).filter((name) => !declared.has(name))
    expect(stale).toEqual([])
  })
})
