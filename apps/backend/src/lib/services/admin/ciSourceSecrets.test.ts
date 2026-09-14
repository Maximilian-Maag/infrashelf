import { describe, it, expect } from 'vitest'
import { eq } from 'drizzle-orm'
import { db } from '@/lib/db/client'
import { ciSources, auditLog } from '@/lib/db/schema'
import {
  createCiSource,
  updateCiSource,
  listCiSources,
  getCiSourceById,
} from './ciSources'
import { readAccessToken } from '@/lib/ci/token'
import { findCiSourceForEnv } from '@/lib/db/queries'
import { isEncryptedEnvelope, encryptSecret } from '@/lib/crypto/secrets'
import { createCiSource as seedCiSource, createEnvironment } from '@/test/helpers'
import { encryptLegacyCiTokens } from '@/lib/bootstrap'

/**
 * CI source access tokens are encrypted at rest (#111).
 *
 * `integrations.credential` has been AES-256-GCM encrypted since the registry
 * landed; `ci_sources.access_token` was still plain text, and it is the column
 * #111 names — *"four more systems with tokens is the moment to fix that rather
 * than the moment to repeat it"*. This is that column being brought in line.
 *
 * What is worth testing is not the cryptography, which `secrets.ts` owns and
 * tests. It is the seam: that nothing writes plaintext, that everything which
 * needs the real token still gets it, and that a database written before this
 * change keeps working.
 */
const TOKEN = 'glpat-SuperSecretValue123'

describe('a token is encrypted before it reaches the database', () => {
  it('stores an envelope, not the token', async () => {
    const created = await createCiSource({
      name: 'GitLab', url: 'https://gitlab.example.com', accessToken: TOKEN, provider: 'gitlab',
    })
    expect(created.ok).toBe(true)
    if (!created.ok) return

    const [row] = await db.select().from(ciSources).where(eq(ciSources.id, created.data.id))
    expect(row.accessToken).not.toBe(TOKEN)
    expect(row.accessToken).not.toContain('SuperSecret')
    expect(isEncryptedEnvelope(row.accessToken)).toBe(true)
    // And it still decrypts back to what was handed in — an envelope of the
    // wrong value would satisfy every assertion above.
    expect(readAccessToken(row.accessToken)).toBe(TOKEN)
  })

  it('re-encrypts when the token is rotated', async () => {
    const created = await createCiSource({
      name: 'GitLab', url: 'https://gitlab.example.com', accessToken: TOKEN, provider: 'gitlab',
    })
    if (!created.ok) return
    const [before] = await db.select().from(ciSources).where(eq(ciSources.id, created.data.id))

    await updateCiSource(created.data.id, { accessToken: 'glpat-RotatedValue456' })

    const [after] = await db.select().from(ciSources).where(eq(ciSources.id, created.data.id))
    expect(isEncryptedEnvelope(after.accessToken)).toBe(true)
    expect(readAccessToken(after.accessToken)).toBe('glpat-RotatedValue456')
    // A fresh IV per write, so the same value would not even produce the same
    // ciphertext — but this is a different value, so the envelopes must differ.
    expect(after.accessToken).not.toBe(before.accessToken)
  })

  it('leaves the token alone when the update does not mention it', async () => {
    const created = await createCiSource({
      name: 'GitLab', url: 'https://gitlab.example.com', accessToken: TOKEN, provider: 'gitlab',
    })
    if (!created.ok) return
    const [before] = await db.select().from(ciSources).where(eq(ciSources.id, created.data.id))

    await updateCiSource(created.data.id, { name: 'Renamed' })

    const [after] = await db.select().from(ciSources).where(eq(ciSources.id, created.data.id))
    expect(after.accessToken).toBe(before.accessToken)
    expect(after.name).toBe('Renamed')
  })
})

describe('the token never leaves the module', () => {
  it('is absent from the list and the single-source responses', async () => {
    const created = await createCiSource({
      name: 'GitLab', url: 'https://gitlab.example.com', accessToken: TOKEN, provider: 'gitlab',
    })
    if (!created.ok) return

    const list = await listCiSources()
    const one = await getCiSourceById(created.data.id)
    expect(JSON.stringify(list)).not.toContain('SuperSecret')
    expect(JSON.stringify(one)).not.toContain('SuperSecret')
    // Nor the ciphertext, which is not a secret but is not the API's business.
    expect(JSON.stringify(one)).not.toContain('v1:')
  })

  it('is absent from the audit log, on create and on rotation', async () => {
    // An audit log an admin can read must not become the place to find a token.
    const created = await createCiSource({
      name: 'GitLab', url: 'https://gitlab.example.com', accessToken: TOKEN, provider: 'gitlab',
    })
    if (!created.ok) return
    await updateCiSource(created.data.id, { accessToken: 'glpat-RotatedValue456' })

    const entries = await db.select().from(auditLog)
    const text = JSON.stringify(entries)
    expect(text).not.toContain('SuperSecret')
    expect(text).not.toContain('RotatedValue456')
    // The ROTATION is still recorded — the event matters even though the value
    // does not.
    expect(text).toContain('accessToken')
  })
})

describe('the consumers still get a usable token', () => {
  it('hands the CI caller the decrypted value', async () => {
    const created = await createCiSource({
      name: 'GitLab', url: 'https://gitlab.example.com', accessToken: TOKEN, provider: 'gitlab',
    })
    if (!created.ok) return
    const env = await createEnvironment(created.data.id)

    const source = await findCiSourceForEnv(env.id)
    // Without decryption here, every pipeline trigger would send a `v1:` envelope
    // as its token and GitLab would report an authentication failure against the
    // wrong component.
    expect(source?.accessToken).toBe(TOKEN)
  })
})

describe('a database written before encryption keeps working', () => {
  it('reads a legacy plaintext token unchanged', async () => {
    // `createCiSource` in the test helpers writes the column directly, which is
    // exactly the pre-#111 shape.
    const legacy = await seedCiSource()
    const [row] = await db.select().from(ciSources).where(eq(ciSources.id, legacy.id))
    expect(isEncryptedEnvelope(row.accessToken)).toBe(false)

    const env = await createEnvironment(legacy.id)
    const source = await findCiSourceForEnv(env.id)
    expect(source?.accessToken).toBe('test-token')
  })

  it('tells an envelope from a plaintext token that merely looks like one', async () => {
    // The shape check is not "starts with v1:". A value that does would still
    // have to be valid base64 of the right length and authenticate under GCM.
    expect(isEncryptedEnvelope('v1:not-really-base64!!')).toBe(false)
    expect(readAccessToken('v1:not-really-base64!!')).toBe('v1:not-really-base64!!')
    expect(isEncryptedEnvelope(encryptSecret('x'))).toBe(true)
  })
})

describe('the boot backfill converts what is already stored', () => {
  it('encrypts legacy plaintext rows and leaves encrypted ones alone', async () => {
    // Two rows in the two states a real database is in mid-migration.
    const legacy = await seedCiSource({ name: 'Legacy' })
    const modern = await createCiSource({
      name: 'Modern', url: 'https://gitlab.example.com', accessToken: TOKEN, provider: 'gitlab',
    })
    if (!modern.ok) return
    const [modernBefore] = await db.select().from(ciSources).where(eq(ciSources.id, modern.data.id))

    await encryptLegacyCiTokens()

    const [legacyAfter] = await db.select().from(ciSources).where(eq(ciSources.id, legacy.id))
    expect(isEncryptedEnvelope(legacyAfter.accessToken)).toBe(true)
    // The VALUE has to survive the conversion — an envelope of the wrong thing
    // would pass the check above and break every pipeline this source triggers.
    expect(readAccessToken(legacyAfter.accessToken)).toBe('test-token')

    // The already-encrypted row is untouched, byte for byte: re-encrypting would
    // be harmless but pointless, and a changed ciphertext here would mean the
    // backfill cannot tell the two states apart.
    const [modernAfter] = await db.select().from(ciSources).where(eq(ciSources.id, modern.data.id))
    expect(modernAfter.accessToken).toBe(modernBefore.accessToken)
  })

  it('is idempotent across boots', async () => {
    const legacy = await seedCiSource({ name: 'Legacy' })
    await encryptLegacyCiTokens()
    const [first] = await db.select().from(ciSources).where(eq(ciSources.id, legacy.id))

    // A second boot must not encrypt the ciphertext again — that would produce
    // an envelope around an envelope, and the token would be unrecoverable.
    await encryptLegacyCiTokens()
    const [second] = await db.select().from(ciSources).where(eq(ciSources.id, legacy.id))

    expect(second.accessToken).toBe(first.accessToken)
    expect(readAccessToken(second.accessToken)).toBe('test-token')
  })
})
