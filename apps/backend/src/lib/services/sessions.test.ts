import { describe, it, expect } from 'vitest'
import { eq } from 'drizzle-orm'
import {
  listSessions,
  revokeAllSessionsOf,
  revokeSession,
  revokeOtherSessions,
} from './sessions'
import { db } from '@/lib/db/client'
import { auditLog, sessions, type User } from '@/lib/db/schema'
import { createUser, makeSession } from '@/test/helpers'
import type { AuthenticatedUser } from '@/lib/auth/middleware'
import type { Role } from '@infrashelf/types'

/**
 * Who may see and end whose sessions (#37).
 *
 * Two rules run through the module, both stated in its comments and neither
 * asserted anywhere until now: the target's owner is read from the row and never
 * from the request, and every list and every revocation is written to the audit
 * log — "who looked at whose sessions" being the question asked after an incident.
 */

/** A caller as `requireAuth` would have built it, sitting in a real session. */
const callerFor = async (user: User): Promise<AuthenticatedUser> => {
  const { sessionId } = await makeSession(user)
  return {
    id: user.id,
    email: user.email,
    name: user.name,
    role: user.role as Role,
    sessionId,
  }
}

/** A session row in a state `createSession` will not produce. */
const seedSession = async (
  userId: number,
  overrides: { expiresAt?: Date; revokedAt?: Date | null } = {},
) => {
  const [row] = await db
    .insert(sessions)
    .values({
      userId,
      tokenHash: `hash-${Math.random().toString(36).slice(2)}`,
      expiresAt: overrides.expiresAt ?? new Date(Date.now() + 3_600_000),
      revokedAt: overrides.revokedAt ?? null,
    })
    .returning()
  return row
}

const auditEntries = (action: string) =>
  db.select().from(auditLog).where(eq(auditLog.action, action))

const revokedAtOf = async (sessionId: number) => {
  const [row] = await db
    .select({ revokedAt: sessions.revokedAt })
    .from(sessions)
    .where(eq(sessions.id, sessionId))
  return row.revokedAt
}

describe('listSessions', () => {
  it('lists the caller’s own live sessions, marking the one they are in', async () => {
    const user = await createUser()
    const caller = await callerFor(user)
    const other = await makeSession(user)

    const result = await listSessions(caller)
    expect(result.ok).toBe(true)
    if (!result.ok) return

    const byId = Object.fromEntries(result.data.map((s) => [s.id, s.current]))
    expect(byId[caller.sessionId]).toBe(true)
    expect(byId[other.sessionId]).toBe(false)
  })

  it('leaves out revoked and expired sessions', async () => {
    // `liveSessionsOf` is three predicates in one `and`, and it is reused by
    // every revocation in this module. Dropping either of these two makes the
    // list longer AND every revocation broader than what it claims to do.
    const user = await createUser()
    const caller = await callerFor(user)
    const revoked = await seedSession(user.id, { revokedAt: new Date() })
    const expired = await seedSession(user.id, { expiresAt: new Date(Date.now() - 1_000) })

    const result = await listSessions(caller)
    if (!result.ok) throw new Error(result.message)

    const ids = result.data.map((s) => s.id)
    expect(ids).toContain(caller.sessionId)
    expect(ids).not.toContain(revoked.id)
    expect(ids).not.toContain(expired.id)
  })

  it('refuses one user the sessions of another with 403', async () => {
    const [caller, target] = await Promise.all([
      createUser({ role: 'admin' }).then(callerFor),
      createUser(),
    ])
    await makeSession(target)

    const result = await listSessions(caller, target.id)
    expect(result).toMatchObject({ ok: false, status: 403 })
  })

  it('lets root list another user’s sessions', async () => {
    // Admin is refused above and root is allowed here: the check is on the role
    // being root, not on outranking the target.
    const root = await createUser({ role: 'root' }).then(callerFor)
    const target = await createUser()
    const theirs = await makeSession(target)

    const result = await listSessions(root, target.id)
    if (!result.ok) throw new Error(result.message)
    expect(result.data.map((s) => s.id)).toEqual([theirs.sessionId])
  })

  it('marks nothing as current when root is looking at somebody else’s list', async () => {
    // `current` compares against the CALLER's session id. Root's own session id
    // could collide with nothing here, but the property is worth pinning: a list
    // of another user's sessions has no "this is you" row in it.
    const root = await createUser({ role: 'root' }).then(callerFor)
    const target = await createUser()
    await makeSession(target)

    const result = await listSessions(root, target.id)
    if (!result.ok) throw new Error(result.message)
    expect(result.data.every((s) => s.current === false)).toBe(true)
  })

  it('audits a list of somebody else’s sessions differently from a list of your own', async () => {
    // Listing is audited because root can look at anyone. An entry that did not
    // say WHOSE list was read would answer the wrong half of the question.
    const root = await createUser({ role: 'root' }).then(callerFor)
    const target = await createUser()
    await makeSession(target)

    await listSessions(root)
    await listSessions(root, target.id)

    const details = (await auditEntries('session.list')).map((e) => e.details)
    expect(details).toContain('Listed own sessions (1 active)')
    expect(details).toContain(`Listed sessions of user ${target.id} (1 active)`)
  })
})

describe('revokeSession', () => {
  it('ends one session and audits it', async () => {
    const user = await createUser()
    const caller = await callerFor(user)
    const victim = await makeSession(user)

    expect(await revokeSession(caller, victim.sessionId)).toEqual({
      ok: true,
      data: { revoked: 1 },
    })
    expect(await revokedAtOf(victim.sessionId)).not.toBeNull()
    expect(await auditEntries('session.revoked')).toHaveLength(1)
  })

  it('answers 404, not 403, for a session belonging to somebody else', async () => {
    // Whether session 812 exists is not something one user should learn about
    // another. A test that accepted "403 or 404" would not pin this at all.
    const caller = await createUser({ role: 'admin' }).then(callerFor)
    const stranger = await createUser()
    const theirs = await makeSession(stranger)

    const result = await revokeSession(caller, theirs.sessionId)
    expect(result).toMatchObject({ ok: false, status: 404 })
    expect(await revokedAtOf(theirs.sessionId)).toBeNull()
  })

  it('answers 404 for a session that does not exist, in the same words', async () => {
    const caller = await createUser().then(callerFor)
    const missing = await revokeSession(caller, 2_147_483_000)
    const notMine = await revokeSession(
      caller,
      (await makeSession(await createUser())).sessionId,
    )

    expect(missing).toMatchObject({ ok: false, status: 404 })
    if (missing.ok || notMine.ok) return
    // Identical, or the difference tells a caller which of the two it was.
    expect(missing.message).toBe(notMine.message)
  })

  it('lets root end a session that is not theirs', async () => {
    const root = await createUser({ role: 'root' }).then(callerFor)
    const target = await createUser()
    const theirs = await makeSession(target)

    expect(await revokeSession(root, theirs.sessionId)).toEqual({
      ok: true,
      data: { revoked: 1 },
    })
    const [entry] = await auditEntries('session.revoked')
    expect(entry.details).toBe(`Revoked session ${theirs.sessionId} of user ${target.id}`)
  })

  it('reports a second revocation as 0 and writes no second audit entry', async () => {
    // Revoking twice is not an error — the outcome asked for is the outcome the
    // caller has — but only the revocation that actually changed the row is the
    // event. A second entry would put two "ended this session" lines in an
    // append-only log for one ending.
    const user = await createUser()
    const caller = await callerFor(user)
    const victim = await makeSession(user)

    await revokeSession(caller, victim.sessionId)
    const again = await revokeSession(caller, victim.sessionId)

    expect(again).toEqual({ ok: true, data: { revoked: 0 } })
    expect(await auditEntries('session.revoked')).toHaveLength(1)
  })

  it('lets exactly one of two simultaneous revokers claim the revocation', async () => {
    // The compare-and-swap (#195). Both callers pass the read having both seen
    // `revokedAt: null`, so it is the `revokedAt IS NULL` predicate on the
    // UPDATE — not the read — that decides. Drop it and both are told they ended
    // the session, and the log carries two entries for one event.
    const user = await createUser()
    const caller = await callerFor(user)
    const victim = await makeSession(user)

    const results = await Promise.all([
      revokeSession(caller, victim.sessionId),
      revokeSession(caller, victim.sessionId),
    ])

    const claimed = results.filter((r) => r.ok && r.data.revoked === 1)
    expect(claimed).toHaveLength(1)
    expect(await auditEntries('session.revoked')).toHaveLength(1)
  })

  it('does not revoke an expired session twice over', async () => {
    // An expired row is not live, but it is also not revoked, so `revokeSession`
    // reaches it by id. Ending it is harmless and the caller gets the outcome
    // they asked for — the point is that it is recorded once.
    const user = await createUser()
    const caller = await callerFor(user)
    const expired = await seedSession(user.id, { expiresAt: new Date(Date.now() - 1_000) })

    expect(await revokeSession(caller, expired.id)).toEqual({ ok: true, data: { revoked: 1 } })
    expect(await revokeSession(caller, expired.id)).toEqual({ ok: true, data: { revoked: 0 } })
  })
})

describe('revokeOtherSessions', () => {
  it('ends every other session of the caller and keeps the one they are in', async () => {
    const user = await createUser()
    const caller = await callerFor(user)
    const a = await makeSession(user)
    const b = await makeSession(user)

    expect(await revokeOtherSessions(caller)).toEqual({ ok: true, data: { revoked: 2 } })
    expect(await revokedAtOf(caller.sessionId)).toBeNull()
    expect(await revokedAtOf(a.sessionId)).not.toBeNull()
    expect(await revokedAtOf(b.sessionId)).not.toBeNull()
  })

  it('leaves another user’s sessions alone', async () => {
    // The `userId` predicate inside `liveSessionsOf`. Without it "sign out
    // everywhere else" signs out the whole installation.
    const user = await createUser()
    const caller = await callerFor(user)
    await makeSession(user)
    const bystander = await makeSession(await createUser())

    await revokeOtherSessions(caller)
    expect(await revokedAtOf(bystander.sessionId)).toBeNull()
  })

  it('spares nothing when root does it to another user', async () => {
    // Root's own session is not one of the target's, so there is nothing to
    // keep — and keeping one by mistake would leave the account signed in
    // somewhere after an operator said it should not be.
    const root = await createUser({ role: 'root' }).then(callerFor)
    const target = await createUser()
    const a = await makeSession(target)
    const b = await makeSession(target)

    expect(await revokeOtherSessions(root, target.id)).toEqual({ ok: true, data: { revoked: 2 } })
    expect(await revokedAtOf(a.sessionId)).not.toBeNull()
    expect(await revokedAtOf(b.sessionId)).not.toBeNull()
    expect(await revokedAtOf(root.sessionId)).toBeNull()
  })

  it('refuses a non-root caller another user’s sessions with 403', async () => {
    const caller = await createUser({ role: 'admin' }).then(callerFor)
    const target = await createUser()
    const theirs = await makeSession(target)

    expect(await revokeOtherSessions(caller, target.id)).toMatchObject({
      ok: false,
      status: 403,
    })
    expect(await revokedAtOf(theirs.sessionId)).toBeNull()
  })

  it('audits your own sign-out-elsewhere and root’s differently', async () => {
    // One entry says which session survived, the other says there was none to
    // keep. A single message for both would lose the distinction that matters
    // when the log is read back: whether the user did this or it was done to
    // them.
    const user = await createUser()
    const caller = await callerFor(user)
    await makeSession(user)

    const root = await createUser({ role: 'root' }).then(callerFor)
    const target = await createUser()
    await makeSession(target)

    await revokeOtherSessions(caller)
    await revokeOtherSessions(root, target.id)

    const details = (await auditEntries('session.revoked_others')).map((e) => e.details)
    expect(details).toContain(`Signed out 1 other session(s), kept ${caller.sessionId}`)
    expect(details).toContain(`Signed out all 1 session(s) of user ${target.id}`)
  })
})

describe('revokeAllSessionsOf', () => {
  it('ends every live session of a user and returns how many', async () => {
    // Deactivation: something that happened TO the account. Before #37 a
    // deactivated user stayed signed in until their token expired.
    const user = await createUser()
    const a = await makeSession(user)
    const b = await makeSession(user)

    expect(await revokeAllSessionsOf(null, user.id, 'Account deactivated')).toBe(2)
    expect(await revokedAtOf(a.sessionId)).not.toBeNull()
    expect(await revokedAtOf(b.sessionId)).not.toBeNull()
  })

  it('spares exactly the session it was told to keep', async () => {
    // A password change ends every OTHER session (#184) — it must not sign the
    // person out of the tab they just re-authenticated in. Swapping `ne` for
    // `eq` inverts this and revokes only the one that should have survived.
    const user = await createUser()
    const kept = await makeSession(user)
    const other = await makeSession(user)

    expect(await revokeAllSessionsOf(user.id, user.id, 'Password changed', db, kept.sessionId)).toBe(1)
    expect(await revokedAtOf(kept.sessionId)).toBeNull()
    expect(await revokedAtOf(other.sessionId)).not.toBeNull()
  })

  it('writes no audit entry when there was nothing live to end', async () => {
    // "Signed out 0 session(s)" is not an event. A deactivation of an account
    // nobody was signed in to should not read like one in the log.
    const user = await createUser()

    expect(await revokeAllSessionsOf(null, user.id, 'Account deactivated')).toBe(0)
    expect(await auditEntries('session.revoked_others')).toHaveLength(0)
  })

  it('records the reason, the count and the session it kept', async () => {
    const user = await createUser()
    const kept = await makeSession(user)
    await makeSession(user)

    await revokeAllSessionsOf(user.id, user.id, 'Password changed', db, kept.sessionId)

    const [entry] = await auditEntries('session.revoked_others')
    expect(entry.details).toBe(
      `Password changed: signed out 1 session(s) of user ${user.id}, kept ${kept.sessionId}`,
    )
  })

  it('takes the audit entry down with the transaction that failed', async () => {
    // The `executor` argument exists so a revoke stands or falls with whatever
    // caused it. A deactivation that commits while the revoke rolls back leaves
    // an account disabled and still signed in — and a log that says otherwise.
    const user = await createUser()
    const session = await makeSession(user)

    await expect(
      db.transaction(async (tx) => {
        await revokeAllSessionsOf(null, user.id, 'Account deactivated', tx)
        throw new Error('deliberate')
      }),
    ).rejects.toThrow('deliberate')

    expect(await revokedAtOf(session.sessionId)).toBeNull()
    expect(await auditEntries('session.revoked_others')).toHaveLength(0)
  })

  it('does not touch a session that is already revoked or expired', async () => {
    const user = await createUser()
    const revokedAt = new Date('2020-01-01T00:00:00.000Z')
    const alreadyRevoked = await seedSession(user.id, { revokedAt })
    const expired = await seedSession(user.id, { expiresAt: new Date(Date.now() - 1_000) })

    expect(await revokeAllSessionsOf(null, user.id, 'Account deactivated')).toBe(0)
    // Unchanged, rather than re-stamped with a later time: the row is evidence,
    // and the moment a session ended is part of it.
    expect(await revokedAtOf(alreadyRevoked.id)).toEqual(revokedAt)
    expect(await revokedAtOf(expired.id)).toBeNull()
  })
})
