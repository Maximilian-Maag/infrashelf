import path from 'node:path'
import { readMigrationFiles } from 'drizzle-orm/migrator'
import { db, client } from '@/lib/db/client'
import { users, branding, ciSources } from '@/lib/db/schema'
import { and, eq } from 'drizzle-orm'
import {
  encryptSecret,
  isEncryptedEnvelope,
  isSecretEncryptionConfigured,
} from '@/lib/crypto/secrets'
import bcrypt from 'bcryptjs'
import { encryptLegacyAppSecrets } from '@/lib/crypto/appSecrets'
import { reportConfigProblems } from '@/lib/config/validate'
import { insecureTransportRefusal, INSECURE_TRANSPORT_FLAG } from '@/lib/ci/transport'

// PostgreSQL error codes that mean the object already exists — safe to skip
// when the DB was seeded via db:push instead of the migration runner.
const IDEMPOTENT_PG_CODES = new Set(['42P07', '42701', '42710'])

async function runMigrations() {
  const migrationsFolder = path.join(process.cwd(), 'drizzle')
  const migrations = readMigrationFiles({ migrationsFolder })

  await client`
    CREATE TABLE IF NOT EXISTS "__drizzle_migrations" (
      id serial PRIMARY KEY,
      hash text NOT NULL,
      created_at bigint
    )
  `

  for (const migration of migrations) {
    const applied = await client`SELECT id FROM "__drizzle_migrations" WHERE hash = ${migration.hash}`
    if (applied.length > 0) continue

    for (const statement of migration.sql) {
      const trimmed = statement.trim()
      if (!trimmed) continue
      try {
        await client.unsafe(trimmed)
      } catch (e: unknown) {
        const code = (e as { code?: string })?.code
        if (IDEMPOTENT_PG_CODES.has(code ?? '')) {
          console.warn(`[bootstrap] skipped (${code}): ${trimmed.slice(0, 100)}`)
          continue
        }
        throw e
      }
    }

    await client`INSERT INTO "__drizzle_migrations" (hash, created_at) VALUES (${migration.hash}, ${migration.folderMillis})`
    console.warn(`[bootstrap] migration applied: ${migration.hash.slice(0, 8)}`)
  }
}

/**
 * Encrypt CI source tokens that predate encryption (#111).
 *
 * `ci_sources.access_token` was plain text while `integrations.credential` was
 * already encrypted. New and updated tokens are encrypted at the service, and
 * `readAccessToken` tolerates both — but tolerating plaintext forever is not the
 * goal, so the rows already in the database are converted here, once, the first
 * time a deployment boots with a key configured.
 *
 * Silent no-op without a key. A deployment that has not set one keeps working
 * with the tokens it has; `validate.ts` is where that is reported, and refusing
 * to boot over it would take an estate offline for a column that has been
 * plaintext all along.
 *
 * Per row rather than one UPDATE: each value needs its own random IV, which is
 * the whole point of the envelope, so there is nothing to batch. There are a
 * handful of CI sources in any real deployment.
 *
 * Values are never logged — only how many moved.
 */
/**
 * Encrypt ONE legacy token, only if it has not changed since it was read.
 *
 * Exported so the compare-and-swap can be tested for what it actually does. The
 * race it guards lives between a SELECT and an UPDATE in the loop below, and a
 * test that seeds the end state never enters that window — it just watches the
 * row get skipped, and passes whether or not the guard is there. Given the
 * previous value directly, the guard is the only thing deciding the outcome.
 *
 * Returns the number of rows actually written: 0 means somebody else got there
 * first, which is not an error.
 */
export const swapLegacyToken = async (id: number, previous: string): Promise<number> => {
  const updated = await db
    .update(ciSources)
    .set({ accessToken: encryptSecret(previous) })
    .where(and(eq(ciSources.id, id), eq(ciSources.accessToken, previous)))
    .returning({ id: ciSources.id })
  return updated.length
}

export const encryptLegacyCiTokens = async (): Promise<void> => {
  if (!isSecretEncryptionConfigured()) return

  const rows = await db
    .select({ id: ciSources.id, accessToken: ciSources.accessToken })
    .from(ciSources)

  const legacy = rows.filter((row) => !isEncryptedEnvelope(row.accessToken))
  if (legacy.length === 0) return

  /*
   * Compare-and-swap on the value we read, not a bare update by id.
   *
   * Between the SELECT above and this UPDATE an administrator can rotate the
   * token — `updateCiSource` writes a fresh envelope — and during a rolling
   * deploy a second backend instance is running this same backfill. A bare
   * `WHERE id = ...` would write the stale PLAINTEXT back over the new
   * credential, and the rotation would be silently lost.
   *
   * Guarding on the original value makes the write a no-op in exactly that case:
   * whoever got there first wins, and their value is already encrypted.
   */
  let converted = 0
  for (const row of legacy) {
    converted += await swapLegacyToken(row.id, row.accessToken)
  }

  // The count of rows actually written, not of rows considered — otherwise a
  // boot that changed nothing still claims to have converted something.
  if (converted > 0) {
    console.warn(
      `[bootstrap] encrypted ${converted} CI source access token(s) that were stored in plain text (#111)`,
    )
  }
}

let bootstrapped = false
/**
 * The bootstrap that is currently running, if one is (#416).
 *
 * The boolean above says "it finished". This says "it started", and the two are
 * different facts that the latch alone could not tell apart: it was set BEFORE
 * the work, so a second concurrent caller returned immediately and was told a
 * half-bootstrapped server was ready — migrations still running, no branding
 * row, legacy CI tokens unconverted.
 *
 * Holding the promise means every concurrent caller awaits the SAME work and
 * sees the same outcome, success or failure.
 */
let bootstrapping: Promise<void> | null = null

/**
 * CI sources this deployment can no longer talk to, named at boot.
 *
 * #329 turned plaintext http to a non-loopback CI host into a refusal. That is
 * the right default, but on an existing deployment it changes behaviour: an
 * on-premise GitLab configured as `http://` still LOOKS fine in the admin UI and
 * only fails when somebody places an order, as a provisioning error nobody
 * connects to an upgrade.
 *
 * So it is said once, at boot, on stderr, naming each source and the switch.
 * Never fatal, for the reason `reportConfigProblems` gives: a server that
 * refuses one operation is easier to diagnose than one that will not start.
 */
export const reportInsecureCiSources = async (): Promise<void> => {
  let rows: { name: string; url: string }[]
  try {
    rows = await db.select({ name: ciSources.name, url: ciSources.url }).from(ciSources)
  } catch {
    // Pre-migration, or a database that has no `ci_sources` yet. Nothing to say.
    return
  }

  const refused = rows.filter((row) => insecureTransportRefusal(row.url) !== null)
  if (refused.length === 0) return

  console.error(
    `[bootstrap] ${refused.length} CI source(s) cannot be used: ` +
      refused.map((r) => `${r.name} (${r.url})`).join(', ') +
      `. Every call to them carries a credential, so plaintext http off loopback is refused (#329). ` +
      `Move them to https, or set ${INSECURE_TRANSPORT_FLAG}=1 to accept the risk.`,
  )
}

export const runBootstrap = async (): Promise<void> => {
  if (bootstrapped) return

  /*
   * Join the run already in flight rather than starting a second one, and
   * rather than returning as though it had finished (#416).
   *
   * `??=` is the whole guard: the first caller creates the promise, every
   * caller after it awaits that same one. The latch is set only when the work
   * has actually finished, so it still means "bootstrap SUCCEEDED" and a failed
   * bootstrap is still retryable — `bootstrapping` is cleared either way.
   *
   * `reportConfigProblems` moved inside, so it is said once per attempt rather
   * than once per caller.
   */
  bootstrapping ??= (async () => {
    // Before anything else, and never fatal: a server that refuses logins is
    // easier to diagnose than one that will not start, but the reason has to be
    // on stderr at boot rather than surfacing later as a failed sign-in.
    reportConfigProblems()
    await bootstrapOnce()
  })()

  try {
    await bootstrapping
    bootstrapped = true
  } finally {
    // Cleared on both paths: after success the latch takes over, and after a
    // failure the next caller has to be able to try again.
    bootstrapping = null
  }
}

/**
 * Everything a first boot has to do, as one unit that either finishes or throws.
 *
 * Split out so `runBootstrap` above can release its latch on ANY failure. It
 * used to reset only around `runMigrations`, which was correct while that was
 * the only thing here that could throw — it is not any more. A transient
 * database error in the token backfill would otherwise leave the latch set with
 * the work half done, and every later call, including every health check, would
 * return immediately and report a ready server whose legacy tokens were never
 * converted and whose branding row may not exist.
 */
const bootstrapOnce = async (): Promise<void> => {
  await runMigrations()

  // Before anything reads a token, and after the migrations so the column is
  // certainly there. A failure here is a real one — a key that decrypts nothing
  // or a database that will not take the write — so it is not swallowed.
  await encryptLegacyCiTokens()

  // #556: same place, same reason — the SMTP password and the AI key in
  // `app_config` were stored in plain text while the credentials next door were
  // encrypted. Reported only when it converted something, so the boot log does not
  // claim work it did not do.
  const convertedSecrets = await encryptLegacyAppSecrets()
  if (convertedSecrets > 0) {
    console.warn(
      `[bootstrap] encrypted ${convertedSecrets} stored secret(s) that were kept in plain text (#556)`,
    )
  }

  // After the migrations, so `ci_sources` is certainly there, and awaited rather
  // than fired and forgotten: the point is that it lands in the boot log next to
  // the other startup lines rather than somewhere in the middle of the first
  // request.
  await reportInsecureCiSources()

  // Seed branding data if it does not exist
  const brandingExists = await db.select({ id: branding.id }).from(branding).limit(1)
  if (brandingExists.length === 0) {
    await db.insert(branding).values({
      shopName: 'InfraShelf',
      shopSubtitle: 'Self-Service Portal',
      // Matches the fallbacks the frontend uses when branding cannot be loaded
      // (see app/(dashboard)/layout.tsx). They disagreed: this seeded #ca8a04 with
      // a near-white #f5f5f4 secondary, so every primary button was painted in a
      // colour indistinguishable from the page and read as disabled — and #ca8a04
      // is the very value e2e/a11y.spec.ts uses as its "hostile" colour.
      primaryColor: '#131921',
      secondaryColor: '#febd69',
    })
    console.warn(`[bootstrap] Default branding created.`)
  }

  const email = process.env.ADMIN_EMAIL
  const password = process.env.ADMIN_PASSWORD

  if (!email || !password) return

  const existing = await db.select({ id: users.id }).from(users).limit(1)
  if (existing.length > 0) return

  const passwordHash = await bcrypt.hash(password, 12)
  await db.insert(users).values({
    email,
    name: 'Root Admin',
    role: 'root',
    passwordHash,
    active: true,
  })

  console.warn(`[bootstrap] Root user created: ${email}`)
}
