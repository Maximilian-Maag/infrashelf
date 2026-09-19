import { describe, it, expect } from 'vitest'
import { eq } from 'drizzle-orm'
import { logAudit, logAuditWith, changedFields } from './index'
import { db } from '@/lib/db/client'
import { auditLog } from '@/lib/db/schema'
import { createUser } from '@/test/helpers'

/**
 * The audit log is append-only by NFA-04.3 and readable by an admin, which makes
 * `changedFields` a security boundary rather than a formatting helper: the admin
 * updates it summarises carry a CI access token, an SMTP password, an AI API key
 * and a webhook callback secret, and a value written here can never be redacted
 * afterwards (#137).
 */

const entriesFor = (action: string) =>
  db.select().from(auditLog).where(eq(auditLog.action, action))

describe('changedFields', () => {
  it('names the fields that changed', () => {
    expect(changedFields({ name: 'new', url: 'https://ci.example' })).toBe('Changed: name, url')
  })

  it('does not put the values in the log', () => {
    // The assertion that matters is the ABSENCE. One that only checked the
    // string contained "accessToken" would still pass if the token itself were
    // appended to it, which is the exact defect this exists to prevent.
    const details = changedFields({ accessToken: 'glpat-supersecret', password: 'hunter2' })
    expect(details).not.toContain('glpat-supersecret')
    expect(details).not.toContain('hunter2')
    expect(details).toBe('Changed: accessToken, password')
  })

  it('keeps a field whose value is null or empty, because clearing one is a change', () => {
    // Only `undefined` means "not named by this update". Filtering on
    // truthiness instead would silently stop recording the update that BLANKS
    // an SMTP password — which is a change somebody may need to account for.
    expect(changedFields({ smtpPass: '', smtpUser: null, smtpPort: 0 })).toBe(
      'Changed: smtpPass, smtpPort, smtpUser',
    )
  })

  it('drops fields the update did not name', () => {
    expect(changedFields({ name: 'new', url: undefined })).toBe('Changed: name')
  })

  it('sorts the names, so two updates of the same fields read the same', () => {
    expect(changedFields({ url: 'u', name: 'n' })).toBe(changedFields({ name: 'n', url: 'u' }))
  })

  it('says so when an update named nothing, rather than logging an empty list', () => {
    // "Changed: " with nothing after it reads as a truncated entry. This is the
    // difference between an audit trail and a puzzle.
    expect(changedFields({})).toBe('No fields changed')
    expect(changedFields({ name: undefined })).toBe('No fields changed')
  })
})

describe('logAudit', () => {
  it('writes the actor, action, entity and details', async () => {
    const user = await createUser({ role: 'admin' })
    await logAudit(user.id, 'test.written', 99, 'Changed: name')

    const [entry] = await entriesFor('test.written')
    expect(entry).toMatchObject({
      userId: user.id,
      action: 'test.written',
      entityId: 99,
      details: 'Changed: name',
    })
  })

  it('accepts a null actor, for something the system did rather than a person', async () => {
    // The decommission sweep and the bootstrap have no user behind them, and an
    // entry that had to invent one would name somebody who did not act.
    await logAudit(null, 'test.system', undefined, undefined)

    const [entry] = await entriesFor('test.system')
    expect(entry.userId).toBeNull()
    expect(entry.entityId).toBeNull()
    expect(entry.details).toBe('')
  })
})

describe('logAuditWith', () => {
  it('writes on the executor it was handed, so a rollback takes the entry with it', async () => {
    // The property the transactional deletes rest on. An entry written through
    // the pool instead survives the rollback and claims a delete that never
    // happened — a log that is wrong in the direction nobody checks.
    const user = await createUser({ role: 'admin' })

    await expect(
      db.transaction(async (tx) => {
        await logAuditWith(tx, user.id, 'test.rolled_back', 1, 'Changed: name')
        throw new Error('deliberate')
      }),
    ).rejects.toThrow('deliberate')

    expect(await entriesFor('test.rolled_back')).toHaveLength(0)
  })

  it('leaves the entry behind when the transaction commits', async () => {
    // The other half: without it, the test above would also pass against a
    // `logAuditWith` that wrote nothing at all.
    const user = await createUser({ role: 'admin' })

    await db.transaction(async (tx) => {
      await logAuditWith(tx, user.id, 'test.committed', 1, 'Changed: name')
    })

    expect(await entriesFor('test.committed')).toHaveLength(1)
  })
})
