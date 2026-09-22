import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest'
import type { Role } from '@infrashelf/types'
import { db } from '@/lib/db/client'
import { auditLog, parameters } from '@/lib/db/schema'
import { createUser, createCiSource, createEnvironment } from '@/test/helpers'
import { createIntegration } from '@/lib/services/admin/integrations'
import { evaluateOrderPolicy, denyMessage, warnMessage } from './gate'
import { ORDER_DECISION_PATH } from './client'
import type { OrderDocumentSource } from './orderDocument'

/**
 * The order-time policy gate (issue #110), against a real database: the
 * integration is resolved the way production resolves it, the catalogue is read
 * for the sensitive names, and only the engine itself is mocked.
 */

afterEach(() => vi.restoreAllMocks())

const source = (over: Partial<OrderDocumentSource> = {}): OrderDocumentSource => ({
  projectId: 7,
  productId: 42,
  environmentId: 3,
  sizeCode: 'M',
  quantity: 2,
  isTrial: false,
  costCenterId: 11,
  parameters: { instance_type: 't3.large', db_password: 'hunter2' },
  ...over,
})

const sessionRef = { current: { id: 0, email: '', role: 'project_manager' as Role } }

/**
 * A real user, because `audit_log.user_id` is a foreign key: the gate's failed-call
 * path writes an audit entry, so a fixture id that exists nowhere would fail the
 * very assertions about that entry.
 */
beforeEach(async () => {
  const u = await createUser({ role: 'project_manager' })
  sessionRef.current = { id: u.id, email: u.email, role: 'project_manager' }
})

const session = () => sessionRef.current

const root = async () => (await createUser({ role: 'root' })).id

const jsonRes = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })

const decision = (payload: Record<string, unknown>) => jsonRes({ result: payload })

/** An OPA integration pointing at a base URL that will not be reached. */
const withEngine = async (over: { failureMode?: 'blocking' | 'best_effort'; environmentId?: number; enabled?: boolean } = {}) =>
  createIntegration(await root(), {
    kind: 'opa',
    name: 'Policy engine',
    baseUrl: 'https://opa.example.com',
    authType: 'none',
    failureMode: over.failureMode ?? 'blocking',
    ...(over.environmentId !== undefined ? { environmentId: over.environmentId } : {}),
    ...(over.enabled !== undefined ? { enabled: over.enabled } : {}),
  })

/** Mark a parameter sensitive in the catalogue, which is what the gate reads. */
const sensitiveParameter = async (name: string) => {
  await db.insert(parameters).values({
    scope: 'global',
    scopeId: 0,
    name,
    label: name,
    type: 'string',
    sensitive: true,
  })
}

/**
 * The actions the GATE wrote, in order. Filtered to its own prefix because
 * setting up a test's engine writes `integration.created` of its own — an
 * assertion listing every audit row would be about the fixture rather than about
 * the gate.
 */
const auditActions = async (): Promise<string[]> => {
  const rows = await db.select({ action: auditLog.action }).from(auditLog).orderBy(auditLog.id)
  return rows.map((r) => r.action).filter((a) => a.startsWith('order.'))
}

/** The body of the one request the engine received. */
const sentDocument = (mock: ReturnType<typeof vi.spyOn>): Record<string, unknown> => {
  const [, init] = mock.mock.calls[0] as [URL, RequestInit]
  return (JSON.parse(String(init.body)) as { input: Record<string, unknown> }).input
}

describe('evaluateOrderPolicy — no engine, or a permissive one', () => {
  it('plans nothing and asks nobody when no OPA is configured', async () => {
    /*
     * The state every installation starts in. It must not refuse orders (that
     * would make installing OPA mandatory), and it must not write an audit entry
     * per order either — "you have not installed a policy engine" would bury the
     * log it is written to.
     */
    const fetchMock = vi.spyOn(global, 'fetch')

    expect(await evaluateOrderPolicy(source(), session())).toEqual({ outcome: 'ok', rule: null, message: null })
    expect(fetchMock).not.toHaveBeenCalled()
    expect(await auditActions()).toEqual([])
  })

  it('ignores a disabled engine', async () => {
    await withEngine({ enabled: false })
    const fetchMock = vi.spyOn(global, 'fetch')

    expect((await evaluateOrderPolicy(source(), session())).outcome).toBe('ok')
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('allows when the policy allows, saying nothing', async () => {
    await withEngine({ failureMode: 'best_effort' })
    vi.spyOn(global, 'fetch').mockResolvedValue(decision({ decision: 'allow', rule: 'baseline' }))

    expect(await evaluateOrderPolicy(source(), session())).toEqual({ outcome: 'ok', rule: 'baseline', message: null })
    expect(await auditActions()).toEqual([])
  })

  it('carries a warning through in the policy’s own words', async () => {
    await withEngine({ failureMode: 'best_effort' })
    vi.spyOn(global, 'fetch').mockResolvedValue(
      decision({ decision: 'warn', rule: 'quota/near-limit', message: 'This project is near its VM limit.' }),
    )

    const verdict = await evaluateOrderPolicy(source(), session())
    expect(verdict).toEqual({
      outcome: 'warn',
      rule: 'quota/near-limit',
      message: 'This project is near its VM limit.',
    })
  })
})

describe('evaluateOrderPolicy — a policy that asks for a person', () => {
  it('carries a needs-approval verdict through, naming the rule that asked', async () => {
    /*
     * #110's third answer. It is not a refusal and not a warning: the order is
     * permitted, but not to whoever asked for it — somebody else has to say yes.
     * The verdict has to be its own outcome rather than a `deny` the portal
     * chooses to treat gently, because the two travel to different places: a
     * denial is shown as a refusal, this one becomes a row in the approvals
     * queue.
     */
    await withEngine({ failureMode: 'best_effort' })
    vi.spyOn(global, 'fetch').mockResolvedValue(
      decision({ decision: 'needs-approval', rule: 'sod/production', message: 'Production needs a second pair of eyes.' }),
    )

    const verdict = await evaluateOrderPolicy(source(), session())

    expect(verdict.outcome).toBe('needs-approval')
    expect(verdict.rule).toBe('sod/production')
    expect(verdict.message).toContain('Production needs a second pair of eyes.')
    expect(verdict.message).toContain('sod/production')
    // Nothing was refused, so nothing is written as a refusal.
    expect(await auditActions()).toEqual([])
  })

  it('has a sentence of its own for a rule that asked without words', async () => {
    await withEngine({ failureMode: 'best_effort' })
    vi.spyOn(global, 'fetch').mockResolvedValue(decision({ decision: 'needs-approval', rule: 'sod/production' }))

    const verdict = await evaluateOrderPolicy(source(), session())

    expect(verdict.message).toContain('sod/production')
    expect(verdict.message).not.toContain('undefined')
  })
})

describe('evaluateOrderPolicy — a refusal that teaches something', () => {
  it('names the rule that refused the order', async () => {
    await withEngine()
    vi.spyOn(global, 'fetch').mockResolvedValue(
      decision({ decision: 'deny', rule: 'quota/vm-count', message: 'This project already holds 20 VMs.' }),
    )

    const verdict = await evaluateOrderPolicy(source(), session())
    expect(verdict.outcome).toBe('deny')
    expect(verdict.rule).toBe('quota/vm-count')
    // #110: a denial that does not say which rule refused it teaches the
    // requester nothing.
    expect(verdict.message).toBe('This project already holds 20 VMs. (rule: quota/vm-count).')
  })

  it('refuses without a rule rather than inventing a name for it', async () => {
    await withEngine()
    vi.spyOn(global, 'fetch').mockResolvedValue(decision({ decision: 'deny', message: 'Not on this environment.' }))

    const verdict = await evaluateOrderPolicy(source(), session())
    expect(verdict.message).toBe('Not on this environment.')
    expect(verdict.message).not.toContain('rule:')
    expect(verdict.rule).toBeNull()
  })
})

describe('evaluateOrderPolicy — when the engine cannot be asked', () => {
  it('refuses the order under a blocking engine, and says how to fix it', async () => {
    await withEngine({ failureMode: 'blocking' })
    vi.spyOn(global, 'fetch').mockRejectedValue(new Error('getaddrinfo ENOTFOUND opa'))

    const verdict = await evaluateOrderPolicy(source(), session())
    expect(verdict.outcome).toBe('deny')
    // The reader is a requester who has been told no by a system they cannot
    // see, so the sentence has to say what happened and who can change it.
    expect(verdict.message).toContain('Policy engine')
    expect(verdict.message).toContain('ENOTFOUND')
    expect(verdict.message).toContain('best-effort')
  })

  it('lets the order through under a best-effort engine, and still says so', async () => {
    await withEngine({ failureMode: 'best_effort' })
    vi.spyOn(global, 'fetch').mockRejectedValue(new Error('connect ECONNREFUSED'))

    const verdict = await evaluateOrderPolicy(source(), session())
    expect(verdict.outcome).toBe('warn')
    expect(verdict.message).toContain('could not be asked')
  })

  it('audits the unevaluated order either way, which is the outcome nobody would see', async () => {
    await withEngine({ failureMode: 'best_effort' })
    vi.spyOn(global, 'fetch').mockRejectedValue(new Error('connect ECONNREFUSED'))
    await evaluateOrderPolicy(source(), session())

    expect(await auditActions()).toEqual(['order.policy_unavailable'])
  })

  it('treats an engine that answers nothing usable as a failure, not as permission', async () => {
    // OPA answers 200 with `{}` when the decision path is not loaded — the policy
    // repository has no gate at that path. Reading that as "allow" would make an
    // empty policy directory the most permissive configuration there is.
    await withEngine({ failureMode: 'blocking' })
    vi.spyOn(global, 'fetch').mockResolvedValue(jsonRes({}))

    const verdict = await evaluateOrderPolicy(source(), session())
    expect(verdict.outcome).toBe('deny')
    expect(verdict.message).toContain(ORDER_DECISION_PATH)
  })
})

describe('evaluateOrderPolicy — what leaves the portal', () => {
  it('sends the versioned document', async () => {
    await withEngine({ failureMode: 'best_effort' })
    const fetchMock = vi.spyOn(global, 'fetch').mockResolvedValue(decision({ decision: 'allow' }))
    await evaluateOrderPolicy(source(), session())

    const sent = sentDocument(fetchMock)
    expect(sent.version).toBe(1)
    expect(sent).toMatchObject({ projectId: 7, productId: 42, environmentId: 3, size: 'M', quantity: 2 })
    expect(sent.requester).toEqual({
      id: session().id,
      email: session().email,
      role: 'project_manager',
    })
  })

  it('never puts a sensitive parameter value on the wire', async () => {
    /*
     * The assertion this whole redaction exists for (#131's rule, applied to the
     * one hop that leaves the portal): the catalogue says `db_password` is
     * sensitive, so the value must not appear in the request at all — not in
     * `parameters`, not anywhere else in the body.
     */
    await sensitiveParameter('db_password')
    await withEngine({ failureMode: 'best_effort' })
    const fetchMock = vi.spyOn(global, 'fetch').mockResolvedValue(decision({ decision: 'allow' }))

    await evaluateOrderPolicy(source(), session())
    const [, init] = fetchMock.mock.calls[0] as [URL, RequestInit]

    expect(String(init.body)).not.toContain('hunter2')
    expect(sentDocument(fetchMock)).toMatchObject({
      parameters: { instance_type: 't3.large', db_password: '[redacted]' },
      sensitiveParameters: ['db_password'],
    })
  })

  it('asks the engine bound to the environment, and the portal-wide one otherwise', async () => {
    const ci = await createCiSource()
    const env = await createEnvironment(ci.id)
    await createIntegration(await root(), {
      kind: 'opa',
      name: 'Environment engine',
      baseUrl: 'https://env-opa.example.com',
      authType: 'none',
      failureMode: 'best_effort',
      environmentId: env.id,
    })
    const fetchMock = vi.spyOn(global, 'fetch').mockResolvedValue(decision({ decision: 'allow' }))

    await evaluateOrderPolicy(source({ environmentId: env.id }), session())
    expect(String((fetchMock.mock.calls[0] as [URL, RequestInit])[0])).toContain('env-opa')

    // A different environment has no engine of its own and nothing portal-wide,
    // so it is not policed at all rather than policed by the wrong instance.
    vi.restoreAllMocks()
    const second = vi.spyOn(global, 'fetch')
    expect((await evaluateOrderPolicy(source({ environmentId: 999 }), session())).outcome).toBe('ok')
    expect(second).not.toHaveBeenCalled()
  })

  it('falls back to a portal-wide engine when the environment has none', async () => {
    const ci = await createCiSource()
    const env = await createEnvironment(ci.id)
    await withEngine({ failureMode: 'best_effort' })
    const fetchMock = vi.spyOn(global, 'fetch').mockResolvedValue(decision({ decision: 'allow' }))

    await evaluateOrderPolicy(source({ environmentId: env.id }), session())
    expect(String((fetchMock.mock.calls[0] as [URL, RequestInit])[0])).toContain('opa.example.com')
  })
})

/**
 * The two sentences the portal wraps a policy's words in.
 *
 * Pure, and worth testing on their own, because this is where the doubled full
 * stop lived: a policy that writes `"Not on this environment."` — the obvious
 * way to write it — reached the requester as `"Not on this environment.."`, which
 * reads as a fault in the policy rather than in the portal.
 */
describe('the sentences around a policy’s own words', () => {
  it('does not add a second full stop to a policy that wrote one', () => {
    expect(denyMessage(null, 'Not on this environment.')).toBe('Not on this environment.')
    expect(denyMessage(null, 'Not on this environment!')).toBe('Not on this environment!')
    expect(denyMessage(null, 'Is this on an approved list?')).toBe('Is this on an approved list?')
  })

  it('adds one to a policy that did not', () => {
    expect(denyMessage(null, 'Not on this environment')).toBe('Not on this environment.')
  })

  it('names the rule alongside, and only when there is one', () => {
    expect(denyMessage('quota/vm-count', 'At the limit')).toBe('At the limit. (rule: quota/vm-count).')
    expect(denyMessage(null, 'At the limit')).not.toContain('rule:')
  })

  it('has a sentence of its own for a policy that said nothing', () => {
    // Not an empty string, and not a rule name standing where a reason should be.
    expect(denyMessage(null, null)).toBe('This order is not permitted by policy.')
    expect(denyMessage('quota/vm-count', null)).toContain('quota/vm-count')
  })

  it('still produces a warning sentence when a rule warned without words', () => {
    expect(warnMessage('quota/near-limit')).toContain('quota/near-limit')
    expect(warnMessage(null)).toMatch(/warning/i)
  })
})