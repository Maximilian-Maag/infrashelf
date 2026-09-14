import { describe, it, expect, vi, beforeEach } from 'vitest'
import { NextRequest } from 'next/server'
import { eq } from 'drizzle-orm'
import { db } from '@/lib/db/client'
import { webauthnCredentials, webauthnLoginChallenges, sessions } from '@/lib/db/schema'
import { createUser } from '@/test/helpers'

/**
 * The HTTP surface of passwordless sign-in (#241).
 *
 * These two endpoints are unauthenticated and one of them MINTS A SESSION, which
 * no other WebAuthn route does — `/api/auth/login/mfa` has a password behind it
 * and every `/api/users/me/webauthn/*` route needs a session. So what is worth
 * testing here is the surface itself: what an unauthenticated stranger can send,
 * what they learn from the answer, and how often they may ask.
 */
/*
 * `vi.hoisted`, and the routes imported STATICALLY below.
 *
 * `vi.mock` factories run before the module graph is imported, so a plain
 * `const` above them is still in its temporal dead zone when the factory fires —
 * which is why the sibling service tests reach for `await import(...)` instead.
 * That works, but a dynamic import is not an import EDGE, and the
 * `route_has_a_test` policy rule reads edges: written that way, these routes
 * counted as untested and the gate denied them.
 */
const mocks = vi.hoisted(() => ({ verifyAuthentication: vi.fn(), challengeSeq: 0 }))

vi.mock('@simplewebauthn/server', () => ({
  generateRegistrationOptions: vi.fn(async () => ({ challenge: 'reg' })),
  // A DISTINCT challenge per call, like the real one: it is the primary key of
  // the store, and a constant made a second ceremony in one test collide.
  generateAuthenticationOptions: vi.fn(async () => ({
    challenge: `login-${++mocks.challengeSeq}`,
    rpId: 'localhost',
  })),
  verifyRegistrationResponse: vi.fn(),
  verifyAuthenticationResponse: (...a: unknown[]) => mocks.verifyAuthentication(...a),
}))

import { POST as optionsPost } from './options/route'
import { POST as verifyPost } from './verify/route'

const req = (path: string, body?: unknown) =>
  new NextRequest(`http://localhost/api/auth/webauthn/${path}`, {
    method: 'POST',
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    headers: { 'content-type': 'application/json' },
  })

const clientData = (challenge: string) =>
  Buffer.from(JSON.stringify({ type: 'webauthn.get', challenge, origin: 'http://localhost' })).toString('base64url')

/** Start a ceremony and hand back the challenge it issued. */
const issued = async (): Promise<string> => {
  const res = await optionsPost(req('options'))
  return (await res.json()).challenge as string
}

beforeEach(() => {
  mocks.challengeSeq = 0
  mocks.verifyAuthentication.mockReset()
  mocks.verifyAuthentication.mockResolvedValue({ verified: true, authenticationInfo: { newCounter: 1 } })
})

describe('POST /api/auth/webauthn/options', () => {
  it('issues a challenge to a caller who names nobody', async () => {
    const res = await optionsPost(req('options'))
    expect(res.status).toBe(200)

    const body = await res.json()
    expect(typeof body.challenge).toBe('string')
    expect(body.challenge.length).toBeGreaterThan(0)
    // Stored, or the assertion could never be matched to a ceremony we started.
    const rows = await db.select().from(webauthnLoginChallenges)
    expect(rows).toHaveLength(1)
  })

  it('answers the same whether or not any key is registered', async () => {
    // The important non-disclosure. If this endpoint were quieter on an empty
    // deployment it would be an oracle for whether anybody has enrolled a key.
    const empty = await optionsPost(req('options'))
    const emptyBody = await empty.json()

    const user = await createUser()
    await db.insert(webauthnCredentials).values({
      userId: user.id,
      credentialId: 'cred-x',
      publicKey: Buffer.from([1]).toString('base64url'),
      counter: 0,
      transports: [],
      label: 'Key',
      discoverable: true,
    })

    const populated = await optionsPost(req('options'))
    const populatedBody = await populated.json()

    expect(empty.status).toBe(populated.status)
    expect(Object.keys(emptyBody).sort()).toEqual(Object.keys(populatedBody).sort())
  })
})

describe('POST /api/auth/webauthn/verify', () => {
  it.each([
    ['no body at all', undefined],
    ['no response', {}],
    ['a response with no id', { response: {} }],
    ['an empty id', { response: { id: '' } }],
  ])('rejects %s with 400', async (_name, body) => {
    expect((await verifyPost(req('verify', body))).status).toBe(400)
  })

  it('mints a session for a valid assertion', async () => {
    const user = await createUser({ email: 'route@test.dev' })
    await db.insert(webauthnCredentials).values({
      userId: user.id,
      credentialId: 'cred-route',
      publicKey: Buffer.from([1, 2, 3]).toString('base64url'),
      counter: 0,
      transports: [],
      label: 'Phone',
      discoverable: true,
    })
    const challenge = await issued()

    const res = await verifyPost(req('verify', {
      response: {
        id: 'cred-route',
        response: {
          clientDataJSON: clientData(challenge),
          userHandle: Buffer.from(String(user.id)).toString('base64url'),
        },
      },
    }))

    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.token).toBeTruthy()
    expect(body.user.email).toBe('route@test.dev')
    expect(await db.select().from(sessions).where(eq(sessions.userId, user.id))).toHaveLength(1)
  })

  it('answers 401 for an unknown credential, and mints nothing', async () => {
    const challenge = await issued()
    const res = await verifyPost(req('verify', {
      response: { id: 'cred-nobody', response: { clientDataJSON: clientData(challenge) } },
    }))

    expect(res.status).toBe(401)
    expect(await db.select().from(sessions)).toHaveLength(0)
  })
})
