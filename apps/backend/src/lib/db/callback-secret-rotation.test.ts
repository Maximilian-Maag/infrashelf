import { describe, it, expect } from 'vitest'
import { readFileSync } from 'fs'
import { sql, inArray } from 'drizzle-orm'
import { db } from '@/lib/db/client'
import { deploymentEnvironments } from '@/lib/db/schema'
import { createCiSource } from '@/test/helpers'

/**
 * Migration 0025, run against the test database.
 *
 * The suite builds its schema from the DDL in `src/test/setup.ts` rather than by
 * replaying `drizzle/`, so a data migration gets no coverage unless a test reads
 * the file and executes it — which is what this does. It also means the SQL is
 * checked against a real Postgres, not just eyeballed.
 */
const MIGRATION_SQL = readFileSync(
  new URL('../../../drizzle/0025_rotate_reused_callback_secret.sql', import.meta.url),
  'utf8',
)

const PORTAL_GENERATED = /^ohc-cb-[0-9a-f]{64}$/

const seedEnv = async (name: string, webhookToken: string, callbackSecret: string) => {
  const [env] = await db
    .insert(deploymentEnvironments)
    .values({
      name,
      ciSourceId: (await createCiSource({ name: `CI-${name}` })).id,
      webhookUrl: 'https://gitlab.example.com/api/v4/projects/1/trigger/pipeline',
      webhookToken,
      callbackSecret,
    })
    .returning()
  return env
}

describe('migration 0025 — rotate reused callback secrets', () => {
  it('rotates a secret still equal to its webhook token, and a blank one, and leaves a rotated one alone', async () => {
    // What migration 0004's backfill produced for a legacy environment: the
    // inbound secret is the outbound GitLab trigger token, readable by any
    // Maintainer of the triggered project.
    const reused = await seedEnv('Reused', 'gitlab-trigger-token', 'gitlab-trigger-token')
    // The degenerate case migration 0006 skipped because it was not a duplicate.
    const blank = await seedEnv('Blank', 'unrelated-trigger-token', '')
    // Already rotated by an operator — must survive untouched, otherwise the
    // migration silently breaks working webhook configurations.
    const healthy = await seedEnv('Healthy', 'trigger', `ohc-cb-${'b'.repeat(64)}`)

    await db.execute(sql.raw(MIGRATION_SQL))

    const after = await db
      .select({ id: deploymentEnvironments.id, callbackSecret: deploymentEnvironments.callbackSecret })
      .from(deploymentEnvironments)
      .where(inArray(deploymentEnvironments.id, [reused.id, blank.id, healthy.id]))

    const byId = new Map(after.map((row) => [row.id, row.callbackSecret]))

    expect(byId.get(reused.id)).not.toBe('gitlab-trigger-token')
    expect(byId.get(reused.id)).toMatch(PORTAL_GENERATED)
    expect(byId.get(blank.id)).toMatch(PORTAL_GENERATED)
    expect(byId.get(healthy.id)).toBe(`ohc-cb-${'b'.repeat(64)}`)

    // Rotating two rows to the same value would violate the UNIQUE constraint
    // added by 0006; the assertion is here because the statement rotates them in
    // one UPDATE, where a constant expression would have done exactly that.
    expect(byId.get(reused.id)).not.toBe(byId.get(blank.id))
  })

  it('is safe to re-run: a second pass rotates nothing', async () => {
    const reused = await seedEnv('Reused', 'trigger-token', 'trigger-token')

    await db.execute(sql.raw(MIGRATION_SQL))
    const [first] = await db
      .select({ callbackSecret: deploymentEnvironments.callbackSecret })
      .from(deploymentEnvironments)

    await db.execute(sql.raw(MIGRATION_SQL))
    const [second] = await db
      .select({ callbackSecret: deploymentEnvironments.callbackSecret })
      .from(deploymentEnvironments)

    expect(first.callbackSecret).toMatch(PORTAL_GENERATED)
    expect(second.callbackSecret).toBe(first.callbackSecret)
    expect(reused.callbackSecret).toBe('trigger-token')
  })
})
