import { describe, it, expect } from 'vitest'
import { NextRequest } from 'next/server'
import { eq } from 'drizzle-orm'
import { DELETE } from './route'
import { GET } from '../route'
import { getSession } from '@/lib/auth/middleware'
import { db } from '@/lib/db/client'
import { sessions } from '@/lib/db/schema'
import { createUser, makeSession } from '@/test/helpers'

const authed = (auth?: string) =>
  new NextRequest('http://localhost/api/sessions/current', auth ? { headers: { authorization: auth } } : undefined)

/**
 * "End the session I am in", in one round trip (#425).
 *
 * The sign-out button had to ask which session was current before it could end
 * it, and both calls shared one 3s deadline. This route is the same revocation
 * with the id taken from the verified token instead of from a list.
 */
describe('DELETE /api/sessions/current', () => {
  it('requires authentication', async () => {
    expect((await DELETE(authed())).status).toBe(401)
  })

  it('ends the session the request was made with', async () => {
    const user = await createUser({ email: 'sc-self@test.dev' })
    const phone = await makeSession(user)

    const res = await DELETE(authed(phone.auth))
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ revoked: 1 })

    // The claim that matters: the token stops working, not merely that a row
    // changed. This is what the sign-out is buying.
    expect(await getSession(authed(phone.auth))).toBeNull()
  })

  it('leaves the caller’s other sessions alone', async () => {
    // "Sign out" means this device, not every device — that is the separate
    // "sign out everywhere else" action on DELETE /api/sessions.
    const user = await createUser({ email: 'sc-others@test.dev' })
    const laptop = await makeSession(user)
    const phone = await makeSession(user)

    await DELETE(authed(phone.auth))

    const res = await GET(new NextRequest('http://localhost/api/sessions', { headers: { authorization: laptop.auth } }))
    const body: { id: number }[] = await res.json()
    expect(body.map((s) => s.id)).toEqual([laptop.sessionId])
  })

  it('touches nobody else’s session', async () => {
    const mine = await makeSession(await createUser({ email: 'sc-mine@test.dev' }))
    const theirs = await makeSession(await createUser({ email: 'sc-theirs@test.dev' }))

    await DELETE(authed(mine.auth))

    const [row] = await db
      .select({ revokedAt: sessions.revokedAt })
      .from(sessions)
      .where(eq(sessions.id, theirs.sessionId))
    expect(row.revokedAt).toBeNull()
  })

  it('revokes the session on the TOKEN, whatever the request asks for', async () => {
    // The route's whole contract is that the id is not in the request. A root
    // caller may legitimately revoke someone else's session — through
    // `/api/sessions/:id`, which is the route that takes an id. This one must
    // ignore anything that looks like one, or "sign me out" becomes a way to
    // sign someone else out.
    const root = await createUser({ email: 'sc-root@test.dev', role: 'root' })
    const rootSession = await makeSession(root)
    const victim = await makeSession(await createUser({ email: 'sc-victim@test.dev' }))

    const res = await DELETE(
      new NextRequest(`http://localhost/api/sessions/current?id=${victim.sessionId}&sessionId=${victim.sessionId}`, {
        headers: { authorization: rootSession.auth },
      }),
    )
    expect(res.status).toBe(200)

    const [theirs] = await db
      .select({ revokedAt: sessions.revokedAt })
      .from(sessions)
      .where(eq(sessions.id, victim.sessionId))
    expect(theirs.revokedAt, 'a query parameter chose whose session ended').toBeNull()

    const [mine] = await db
      .select({ revokedAt: sessions.revokedAt })
      .from(sessions)
      .where(eq(sessions.id, rootSession.sessionId))
    expect(mine.revokedAt).not.toBeNull()
  })

  it('is idempotent — a second sign-out is not an error', async () => {
    // The button can be pressed twice, and the first revoke makes the second
    // request's token invalid, so the honest answer is 401 rather than a 500.
    const phone = await makeSession(await createUser({ email: 'sc-twice@test.dev' }))

    expect((await DELETE(authed(phone.auth))).status).toBe(200)
    expect((await DELETE(authed(phone.auth))).status).toBe(401)
  })
})
