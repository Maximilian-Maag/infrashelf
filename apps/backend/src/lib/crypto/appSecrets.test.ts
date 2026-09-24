import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { sql, eq } from 'drizzle-orm'
import { db } from '@/lib/db/client'
import { appConfig } from '@/lib/db/schema'
import { encryptLegacyAppSecrets, prepareAppSecret, readAppSecret, swapLegacySecret } from './appSecrets'
import {
  SECRET_KEY_ENV,
  SECRET_KEY_HEX_LENGTH,
  decryptSecret,
  encryptSecret,
  isEncryptedEnvelope,
} from './secrets'

/**
 * #556. The two secrets of `app_config` are stored as envelopes now, and the
 * column can still hold plaintext from before that — so the interesting
 * behaviour is the transition, not the happy path.
 */

// Two syntactically valid keys. The point is that they are different, not that
// either is secret: the suite's own key comes from vitest.config.ts.
const OTHER_KEY = 'b'.repeat(SECRET_KEY_HEX_LENGTH)

/** vitest.config.ts sets a key for the whole suite; restore it after meddling. */
const configuredKey = process.env[SECRET_KEY_ENV]

const rowOf = async () => {
  const rows = await db.select().from(appConfig).where(eq(appConfig.id, 1)).limit(1)
  return rows[0]
}

/** The legacy state: a plaintext secret in the column, as written before #556. */
const seedPlaintext = async (values: { smtpPass?: string; aiApiKey?: string }) => {
  await db.execute(sql`
    UPDATE app_config SET smtp_pass = NULL, ai_api_key = NULL WHERE id = 1
  `)
  // `set({})` is an error in drizzle rather than a no-op, and "both columns
  // empty" is a state worth having.
  if (Object.keys(values).length === 0) return
  await db.update(appConfig).set(values).where(eq(appConfig.id, 1))
}

beforeEach(async () => {
  process.env[SECRET_KEY_ENV] = configuredKey
  await db.execute(sql`
    UPDATE app_config SET smtp_pass = NULL, ai_api_key = NULL WHERE id = 1
  `)
})

afterEach(() => {
  if (configuredKey === undefined) delete process.env[SECRET_KEY_ENV]
  else process.env[SECRET_KEY_ENV] = configuredKey
})

describe('prepareAppSecret', () => {
  it('returns an envelope, not the plaintext, for a value being stored', () => {
    const prepared = prepareAppSecret('smtpPass', 'hunter2')
    expect(prepared.ok).toBe(true)
    if (!prepared.ok) return
    expect(prepared.data).not.toBe('hunter2')
    expect(isEncryptedEnvelope(prepared.data as string)).toBe(true)
    expect(decryptSecret(prepared.data as string)).toBe('hunter2')
  })

  it('treats a blank value as a clear, not as a secret to encrypt', () => {
    // '' and '   ' are "not configured" to every reader, and `orNull` in the
    // config service says the same thing about the neighbouring columns.
    for (const blank of ['', '   ']) {
      const prepared = prepareAppSecret('aiApiKey', blank)
      expect(prepared.ok).toBe(true)
      if (prepared.ok) expect(prepared.data).toBeNull()
    }
  })

  it('refuses to store a secret when there is no key, and says which one', () => {
    delete process.env[SECRET_KEY_ENV]

    const prepared = prepareAppSecret('smtpPass', 'hunter2')
    expect(prepared.ok).toBe(false)
    if (prepared.ok) return
    expect(prepared.status).toBe(503)
    expect(prepared.message).toContain(SECRET_KEY_ENV)
    expect(prepared.message).toContain('SMTP password')
  })

  it('refuses a malformed key rather than storing plaintext under it', () => {
    process.env[SECRET_KEY_ENV] = 'not-a-key'

    const prepared = prepareAppSecret('aiApiKey', 'sk-live')
    expect(prepared.ok).toBe(false)
    if (prepared.ok) return
    expect(prepared.message).toContain(String(SECRET_KEY_HEX_LENGTH))
  })

  it('names the field it refused, so one form says which secret failed', () => {
    delete process.env[SECRET_KEY_ENV]
    const prepared = prepareAppSecret('aiApiKey', 'sk-live')
    expect(prepared.ok).toBe(false)
    if (!prepared.ok) expect(prepared.message).toContain('AI API key')
  })
})

describe('readAppSecret', () => {
  it('returns null when the column is empty, rather than an empty secret', async () => {
    expect(await readAppSecret('smtpPass')).toBeNull()
    expect(await readAppSecret('aiApiKey')).toBeNull()
  })

  it('reads an envelope back as the plaintext', async () => {
    await db.update(appConfig).set({ smtpPass: encryptSecret('hunter2') }).where(eq(appConfig.id, 1))
    expect(await readAppSecret('smtpPass')).toBe('hunter2')
  })

  it('returns a legacy plaintext secret as it is, without writing', async () => {
    await seedPlaintext({ smtpPass: 'hunter2' })

    // A read is a read. The conversion belongs to the boot backfill below, where
    // it can be done once with a compare-and-swap rather than by whichever request
    // happens to touch the value first — and where an admin saving a new password
    // at the same moment cannot have it overwritten by a stale one.
    expect(await readAppSecret('smtpPass')).toBe('hunter2')
    expect((await rowOf())?.smtpPass).toBe('hunter2')
  })

  it('throws when the envelope does not authenticate under the current key', async () => {
    process.env[SECRET_KEY_ENV] = OTHER_KEY
    const foreign = encryptSecret('hunter2')
    process.env[SECRET_KEY_ENV] = configuredKey
    await db.update(appConfig).set({ smtpPass: foreign }).where(eq(appConfig.id, 1))

    // Not swallowed into "treat it as plaintext": a replaced key is an operator
    // problem with its own fix, and a ciphertext handed to a mail server as a
    // password is a login failure against the wrong component (#111's reasoning).
    await expect(readAppSecret('smtpPass')).rejects.toThrow()
  })

  it('reads a `v1:`-prefixed value that is not a well-formed envelope as plaintext', async () => {
    // `isEncryptedEnvelope` is a structural check, not a prefix match, so a secret
    // that merely begins with `v1:` is read as the plaintext it is. Throwing on it
    // instead would lock an operator out of a value that works (#111's reasoning in
    // `isEncryptedEnvelope`).
    await seedPlaintext({ smtpPass: 'v1:AAAA' })
    expect(await readAppSecret('smtpPass')).toBe('v1:AAAA')
  })
})

describe('encryptLegacyAppSecrets', () => {
  it('converts both plaintext secrets, and they still read back as themselves', async () => {
    await seedPlaintext({ smtpPass: 'hunter2', aiApiKey: 'sk-live' })

    expect(await encryptLegacyAppSecrets()).toBe(2)

    const row = await rowOf()
    expect(isEncryptedEnvelope(row?.smtpPass as string)).toBe(true)
    expect(isEncryptedEnvelope(row?.aiApiKey as string)).toBe(true)
    expect(decryptSecret(row?.smtpPass as string)).toBe('hunter2')
    expect(decryptSecret(row?.aiApiKey as string)).toBe('sk-live')
    expect(await readAppSecret('smtpPass')).toBe('hunter2')
    expect(await readAppSecret('aiApiKey')).toBe('sk-live')
  })

  it('counts only what it converted, so a second boot reports nothing', async () => {
    await seedPlaintext({ smtpPass: 'hunter2', aiApiKey: 'sk-live' })

    expect(await encryptLegacyAppSecrets()).toBe(2)
    // Idempotent: the second run finds nothing to do and says so. A count of rows
    // considered rather than of rows written would make every boot look like work.
    expect(await encryptLegacyAppSecrets()).toBe(0)
  })

  it('converts a racing pair of boots once between them', async () => {
    await seedPlaintext({ smtpPass: 'hunter2' })

    // Two instances of the same deploy booting at once. Whether they interleave or
    // one finishes first, ONE write happened: the compare-and-swap on the value that
    // was read is what makes the second a no-op rather than a second conversion —
    // and, in the case that actually matters, rather than writing a stale plaintext
    // over a password an administrator has just saved.
    const [a, b] = await Promise.all([encryptLegacyAppSecrets(), encryptLegacyAppSecrets()])
    expect(a + b).toBe(1)
  })

  it('does not write a stale plaintext over a secret that was replaced', async () => {
    await seedPlaintext({ smtpPass: 'hunter2' })

    // An administrator saves a new password between the backfill's read and its
    // write, or a second instance of the rolling deploy gets there first. The update
    // is guarded on the value that was READ, so it matches nothing here and the new
    // secret survives; without that guard, the stale plaintext would be written back
    // over it and the change would be silently lost.
    await db.update(appConfig).set({ smtpPass: encryptSecret('newer') }).where(eq(appConfig.id, 1))

    expect(await swapLegacySecret('smtpPass', 'hunter2')).toBe(0)
    expect(decryptSecret((await rowOf())?.smtpPass as string)).toBe('newer')
  })

  it('leaves a value that is already an envelope byte for byte', async () => {
    const envelope = encryptSecret('hunter2')
    await db.update(appConfig).set({ smtpPass: envelope }).where(eq(appConfig.id, 1))

    expect(await encryptLegacyAppSecrets()).toBe(0)
    // Re-encrypting would be harmless to read but changes the ciphertext, and the
    // point of the compare-and-swap is that a value someone else has already fixed
    // is left exactly as they left it.
    expect((await rowOf())?.smtpPass).toBe(envelope)
  })

  it('skips a blank column rather than storing an envelope of nothing', async () => {
    await seedPlaintext({ smtpPass: '   ', aiApiKey: 'sk-live' })

    expect(await encryptLegacyAppSecrets()).toBe(1)
    const row = await rowOf()
    expect(row?.smtpPass).toBe('   ')
    expect(isEncryptedEnvelope(row?.aiApiKey as string)).toBe(true)
  })

  it('does nothing, and writes nothing, when there is no key', async () => {
    await seedPlaintext({ smtpPass: 'hunter2', aiApiKey: 'sk-live' })
    delete process.env[SECRET_KEY_ENV]

    // The CI token backfill returns the same way. The columns stay plaintext, which
    // is why `prepareAppSecret` refuses new writes without a key instead of falling
    // back to one.
    expect(await encryptLegacyAppSecrets()).toBe(0)
    const row = await rowOf()
    expect(row?.smtpPass).toBe('hunter2')
    expect(row?.aiApiKey).toBe('sk-live')
  })

  it('does nothing when both columns are empty', async () => {
    await seedPlaintext({})
    expect(await encryptLegacyAppSecrets()).toBe(0)
  })
})
