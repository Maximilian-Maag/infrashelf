import { describe, it, expect, vi, beforeEach } from 'vitest'
import { eq } from 'drizzle-orm'
import { db } from '@/lib/db/client'
import { webauthnCredentials, webauthnLoginChallenges, sessions, users, auditLog } from '@/lib/db/schema'
import { createUser } from '@/test/helpers'

/**
 * Passwordless sign-in (#241).
 *
 * The ceremony belongs to `@simplewebauthn/server` and is mocked, exactly as
 * `webauthn.test.ts` mocks it and for the same reason. What is worth testing is
 * what this service adds on top, and every item is a way to be signed in as
 * somebody else with no password at all:
 *
 *   * the challenge was one WE issued, and is spent exactly once;
 *   * the account comes from the credential, and the user handle must agree;
 *   * user verification is REQUIRED — it is the second factor, and without a
 *     password in front of it there is no other;
 *   * the signature counter may not go backwards;
 *   * a deactivated account is refused;
 *   * an administrator is not asked for a TOTP code on top.
 */
const verifyAuthentication = vi.fn()
vi.mock('@simplewebauthn/server', () => ({
  generateRegistrationOptions: vi.fn(async () => ({ challenge: 'reg-challenge' })),
  generateAuthenticationOptions: vi.fn(async () => ({ challenge: 'login-challenge' })),
  verifyRegistrationResponse: vi.fn(),
  verifyAuthenticationResponse: (...a: unknown[]) => verifyAuthentication(...a),
}))

const { startPasswordlessAuthentication, verifyPasswordlessAuthentication } = await import('./webauthn')
const { loginWithPasswordlessWebauthn } = await import('./auth')

const SHOP = 'Acme'

/** `clientDataJSON` as the browser sends it: base64url of the signed JSON. */
const clientData = (challenge: string): string =>
  Buffer.from(JSON.stringify({ type: 'webauthn.get', challenge, origin: 'https://example.test' })).toString('base64url')

/** The user handle the authenticator returns — the database id, as registered. */
const handleFor = (userId: number): string => Buffer.from(String(userId)).toString('base64url')

const assertion = (
  credentialId: string,
  over?: { challenge?: string; userHandle?: string | null },
) =>
  ({
    id: credentialId,
    response: {
      clientDataJSON: clientData(over?.challenge ?? 'login-challenge'),
      ...(over?.userHandle === null ? {} : { userHandle: over?.userHandle }),
    },
  }) as never

const storeCredential = async (userId: number, credentialId: string, over?: { counter?: number; discoverable?: boolean }) => {
  const [row] = await db.insert(webauthnCredentials).values({
    userId,
    credentialId,
    publicKey: Buffer.from([1, 2, 3]).toString('base64url'),
    counter: over?.counter ?? 0,
    transports: ['internal'],
    label: 'Phone',
    discoverable: over?.discoverable ?? true,
  }).returning()
  return row
}

/** A challenge in the store, as `startPasswordlessAuthentication` would leave it. */
const issueChallenge = async () => {
  const result = await startPasswordlessAuthentication(SHOP)
  expect(result.ok).toBe(true)
  return result
}

beforeEach(() => {
  verifyAuthentication.mockReset()
  verifyAuthentication.mockResolvedValue({ verified: true, authenticationInfo: { newCounter: 1 } })
})

describe('starting a ceremony that names nobody', () => {
  it('stores the challenge and offers no allowCredentials', async () => {
    const { generateAuthenticationOptions } = await import('@simplewebauthn/server')
    await issueChallenge()

    const [row] = await db.select().from(webauthnLoginChallenges)
      .where(eq(webauthnLoginChallenges.challenge, 'login-challenge'))
    expect(row).toBeDefined()

    // No `allowCredentials` key at all — not an empty array, which some
    // authenticators read as "nothing is acceptable" rather than "anything is".
    const opts = vi.mocked(generateAuthenticationOptions).mock.calls.at(-1)?.[0] as Record<string, unknown>
    expect('allowCredentials' in opts).toBe(false)
    // The decision that makes this two factors rather than one.
    expect(opts.userVerification).toBe('required')
  })
})

describe('an assertion that names nobody signs its owner in', () => {
  it('resolves the account from the credential and mints a session', async () => {
    const user = await createUser({ email: 'passkey@test.dev' })
    await storeCredential(user.id, 'cred-a')
    await issueChallenge()

    const result = await loginWithPasswordlessWebauthn(
      assertion('cred-a', { userHandle: handleFor(user.id) }),
      SHOP,
      { ip: '10.0.0.1', userAgent: 'test' },
    )

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.data.mfaRequired).toBe(false)
    if (result.data.mfaRequired) return
    expect(result.data.user.id).toBe(user.id)
    expect(result.data.token).toBeTruthy()

    // A real, revocable session row — not just a signed token.
    const rows = await db.select().from(sessions).where(eq(sessions.userId, user.id))
    expect(rows.length).toBe(1)
  })

  it('requires user verification, because there is no password in front of it', async () => {
    const user = await createUser()
    await storeCredential(user.id, 'cred-uv')
    await issueChallenge()

    await verifyPasswordlessAuthentication(assertion('cred-uv', { userHandle: handleFor(user.id) }), SHOP)

    const args = verifyAuthentication.mock.calls.at(-1)?.[0] as Record<string, unknown>
    expect(args.requireUserVerification).toBe(true)
  })

  it('does not ask an administrator for a second factor on top', async () => {
    // The owner's decision on #241: a discoverable credential asserted with user
    // verification IS two factors, so `requiresSecondFactor` must not run here —
    // it would demand a TOTP code after a ceremony that is already stronger than
    // password-plus-code, and refuse the flow to the accounts it most suits.
    const admin = await createUser({ role: 'admin', email: 'admin-passkey@test.dev' })
    await storeCredential(admin.id, 'cred-admin')
    await issueChallenge()

    const result = await loginWithPasswordlessWebauthn(
      assertion('cred-admin', { userHandle: handleFor(admin.id) }),
      SHOP,
    )

    expect(result.ok).toBe(true)
    if (!result.ok || result.data.mfaRequired) return
    expect(result.data.token).toBeTruthy()
    // And the account owes no enrolment — it demonstrably holds a factor.
    expect(result.data.mustEnrollSecondFactor).toBeUndefined()
  })

  it('marks a credential discoverable once it has answered such a ceremony', async () => {
    // Proof rather than inference, and how a key registered before #241 — which
    // was never asked for `credProps` — earns its flag.
    const user = await createUser()
    await storeCredential(user.id, 'cred-earns', { discoverable: false })
    await issueChallenge()

    await loginWithPasswordlessWebauthn(assertion('cred-earns', { userHandle: handleFor(user.id) }), SHOP)

    const [row] = await db.select().from(webauthnCredentials)
      .where(eq(webauthnCredentials.credentialId, 'cred-earns'))
    expect(row.discoverable).toBe(true)
    expect(row.lastUsedAt).not.toBeNull()
  })
})

describe('what it refuses', () => {
  it('spends the challenge exactly once', async () => {
    const user = await createUser()
    await storeCredential(user.id, 'cred-replay')
    await issueChallenge()
    const replayed = assertion('cred-replay', { userHandle: handleFor(user.id) })

    /*
     * An ALWAYS-ADVANCING counter, so this test can only be passed by the
     * challenge being spent.
     *
     * Written with the default fixed counter it passed even with challenge
     * consumption removed — the first sign-in advanced the stored counter to 1,
     * and the replay was refused by the clone check instead. Green, and guarding
     * nothing it claimed to.
     */
    let counter = 0
    verifyAuthentication.mockImplementation(async () => ({
      verified: true,
      authenticationInfo: { newCounter: ++counter },
    }))

    expect((await loginWithPasswordlessWebauthn(replayed, SHOP)).ok).toBe(true)

    // The identical assertion again. Without single-use this is a recorded
    // ceremony replayed into a fresh session.
    const second = await loginWithPasswordlessWebauthn(replayed, SHOP)
    expect(second.ok).toBe(false)
    if (!second.ok) expect(second.status).toBe(401)
  })

  it('refuses a challenge it never issued', async () => {
    const user = await createUser()
    await storeCredential(user.id, 'cred-forged')
    await issueChallenge()

    const result = await loginWithPasswordlessWebauthn(
      assertion('cred-forged', { challenge: 'not-one-of-ours', userHandle: handleFor(user.id) }),
      SHOP,
    )

    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.status).toBe(401)
    // And the real challenge is still unspent, so a forged attempt cannot be
    // used to burn somebody else's ceremony.
    const rows = await db.select().from(webauthnLoginChallenges)
      .where(eq(webauthnLoginChallenges.challenge, 'login-challenge'))
    expect(rows).toHaveLength(1)
  })

  it('refuses a user handle that disagrees with the credential', async () => {
    const owner = await createUser({ email: 'owner@test.dev' })
    const other = await createUser({ email: 'other@test.dev' })
    await storeCredential(owner.id, 'cred-handle')
    await issueChallenge()

    const result = await loginWithPasswordlessWebauthn(
      assertion('cred-handle', { userHandle: handleFor(other.id) }),
      SHOP,
    )

    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.status).toBe(401)
    expect(await db.select().from(sessions).where(eq(sessions.userId, other.id))).toHaveLength(0)
    expect(await db.select().from(sessions).where(eq(sessions.userId, owner.id))).toHaveLength(0)
  })

  it('refuses an unknown credential', async () => {
    await issueChallenge()
    const result = await loginWithPasswordlessWebauthn(assertion('cred-nobody'), SHOP)
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.status).toBe(401)
  })

  it('refuses a signature counter that did not advance', async () => {
    const user = await createUser()
    await storeCredential(user.id, 'cred-clone', { counter: 9 })
    await issueChallenge()
    verifyAuthentication.mockResolvedValue({ verified: true, authenticationInfo: { newCounter: 9 } })

    const result = await loginWithPasswordlessWebauthn(
      assertion('cred-clone', { userHandle: handleFor(user.id) }),
      SHOP,
    )

    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.status).toBe(401)
  })

  it('refuses a deactivated account, and says so', async () => {
    // 403 and a plain message, like the password path: whoever produced this
    // assertion physically holds the key, so naming the reason discloses nothing
    // — and the alternative is the afternoon #196 cost.
    const user = await createUser({ email: 'off@test.dev' })
    await db.update(users).set({ active: false }).where(eq(users.id, user.id))
    await storeCredential(user.id, 'cred-off')
    await issueChallenge()

    const result = await loginWithPasswordlessWebauthn(
      assertion('cred-off', { userHandle: handleFor(user.id) }),
      SHOP,
    )

    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.status).toBe(403)
      expect(result.message).toMatch(/deactivated/i)
    }
    expect(await db.select().from(sessions).where(eq(sessions.userId, user.id))).toHaveLength(0)
  })

  it('refuses an assertion the library rejects', async () => {
    const user = await createUser()
    await storeCredential(user.id, 'cred-bad')
    await issueChallenge()
    verifyAuthentication.mockResolvedValue({ verified: false, authenticationInfo: { newCounter: 1 } })

    const result = await loginWithPasswordlessWebauthn(
      assertion('cred-bad', { userHandle: handleFor(user.id) }),
      SHOP,
    )
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.status).toBe(401)
  })
})

describe('what it records', () => {
  it('logs the sign-in against the account and names the key', async () => {
    const user = await createUser({ email: 'audited@test.dev' })
    await storeCredential(user.id, 'cred-audit')
    await issueChallenge()

    await loginWithPasswordlessWebauthn(assertion('cred-audit', { userHandle: handleFor(user.id) }), SHOP)

    const entries = await db.select().from(auditLog).where(eq(auditLog.action, 'auth.webauthn.login'))
    expect(entries).toHaveLength(1)
    expect(entries[0].userId).toBe(user.id)
    expect(entries[0].details).toContain('without a password')
    expect(entries[0].details).toContain('Phone')
  })
})
