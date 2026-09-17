import { describe, it, expect, vi, afterEach } from 'vitest'
import { readAccessToken, readAccessTokenResult } from './token'
import { encryptSecret, isEncryptedEnvelope } from '@/lib/crypto/secrets'

/**
 * The module that decides whether a stored CI credential can be read back.
 *
 * Its whole job is to survive a half-finished backfill: `ci_sources.access_token`
 * was plain text until #111, so both forms are in the database at once and will
 * be until every deployment has booted with a key. Everything asserted here is a
 * property the comments in `token.ts` state and nothing checked.
 */

// The key vitest.config.ts configures for the suite, so a test can put it back
// after taking it away.
const SUITE_KEY = process.env.SECRET_ENCRYPTION_KEY ?? ''

afterEach(() => {
  vi.unstubAllEnvs()
  process.env.SECRET_ENCRYPTION_KEY = SUITE_KEY
})

describe('readAccessToken', () => {
  it('returns an encrypted token decrypted', () => {
    expect(readAccessToken(encryptSecret('glpat-secret'))).toBe('glpat-secret')
  })

  it('returns a pre-#111 plaintext token unchanged', () => {
    // The rows the backfill has not reached yet. Treating one as an envelope
    // would throw, and every CI trigger on that source would fail.
    expect(readAccessToken('glpat-plaintext')).toBe('glpat-plaintext')
  })

  it('treats a token that merely starts with the version prefix as plaintext', () => {
    // `isEncryptedEnvelope` is structural rather than a prefix match, and this is
    // why: a real token beginning "v1:" is not a ciphertext, and misjudging it
    // throws on decrypt instead of degrading quietly.
    const lookalike = 'v1:not-base64-at-all!!'
    expect(isEncryptedEnvelope(lookalike)).toBe(false)
    expect(readAccessToken(lookalike)).toBe(lookalike)
  })

  it('throws rather than handing back the ciphertext when the key is gone', () => {
    // The defect this catches: a `catch` that fell back to returning `stored`.
    // The ciphertext would then be sent to GitLab as a token and reported as an
    // authentication failure against the CI system, which is the wrong component.
    const envelope = encryptSecret('glpat-secret')
    vi.stubEnv('SECRET_ENCRYPTION_KEY', '')
    expect(() => readAccessToken(envelope)).toThrow()
  })
})

describe('readAccessTokenResult', () => {
  it('carries the plaintext through as ok', () => {
    const result = readAccessTokenResult(encryptSecret('glpat-secret'))
    expect(result).toEqual({ ok: true, data: 'glpat-secret' })
  })

  it('answers 503, not 422, when there is no key to read the token with', () => {
    // 422 is what the CI routes answer when the CI system did not give us a
    // file. "This server cannot read its own credential" is a different problem
    // and sends an operator somewhere else — before this module existed one
    // route answered 422 for it and the other let it escape as a 500.
    const envelope = encryptSecret('glpat-secret')
    vi.stubEnv('SECRET_ENCRYPTION_KEY', '')

    const result = readAccessTokenResult(envelope)
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.status).toBe(503)
    // The message has to say WHICH failure this is. Both mention the variable
    // by name, so asserting on the name alone passes against a module that
    // reports every failure as a replaced key.
    expect(result.message).toContain('is not set')
    expect(result.message).not.toContain('not rotatable in place')
  })

  it('tells a replaced key apart from a missing one', () => {
    // Both are 503 and both are configuration facts, but the fix differs: set a
    // key, versus re-enter every credential the old key wrote. A single message
    // for both branches would pass a test that only checked the status.
    const envelope = encryptSecret('glpat-secret')
    vi.stubEnv('SECRET_ENCRYPTION_KEY', 'b'.repeat(64))

    const result = readAccessTokenResult(envelope)
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.status).toBe(503)
    expect(result.message).toContain('not rotatable in place')
    expect(result.message).not.toContain('is not set')
  })

  it('never puts the stored value in the message it returns', () => {
    // The message reaches an admin-facing error surface. A failure that quoted
    // the envelope back would publish the ciphertext, and a failure that quoted
    // a plaintext token would publish the token.
    const envelope = encryptSecret('glpat-supersecret')
    vi.stubEnv('SECRET_ENCRYPTION_KEY', 'b'.repeat(64))

    const result = readAccessTokenResult(envelope)
    if (result.ok) throw new Error('expected a failure')
    expect(result.message).not.toContain(envelope)
    expect(result.message).not.toContain('glpat-supersecret')
  })
})
