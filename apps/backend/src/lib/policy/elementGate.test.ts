import { describe, it, expect, vi, afterEach } from 'vitest'
import { db } from '@/lib/db/client'
import { parameters } from '@/lib/db/schema'
import { createUser } from '@/test/helpers'
import { createIntegration } from '@/lib/services/admin/integrations'
import { evaluateElementPolicy } from './elementGate'
import { ELEMENT_DECISION_PATH, ORDER_DECISION_PATH } from './client'
import type { ElementDocumentSource } from './elementDocument'

/**
 * Continuous policy evaluation (issue #110, slice 6), against a real database:
 * the integration is resolved the way production resolves it, the catalogue is
 * read for the sensitive names, and only the engine itself is mocked.
 */

afterEach(() => vi.restoreAllMocks())

const source = (over: Partial<ElementDocumentSource> = {}): ElementDocumentSource => ({
  elementId: 91,
  orderId: 7,
  projectId: 3,
  productId: 42,
  environmentId: 2,
  sizeCode: 'M',
  quantity: 1,
  status: 'active',
  deployedAt: new Date('2026-09-01T10:00:00.000Z'),
  parameters: { instance_type: 't3.large', db_password: 'hunter2' },
  outputs: { public_ip: '203.0.113.9' },
  lastRefreshOutcome: 'clean',
  driftDetectedAt: null,
  driftSummary: null,
  ...over,
})

const jsonRes = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })

const decision = (payload: Record<string, unknown>) => jsonRes({ result: payload })

const root = async () => (await createUser({ role: 'root' })).id

/** An OPA integration pointing at a base URL that the tests intercept. */
const withEngine = async (over: { environmentId?: number; enabled?: boolean } = {}) =>
  createIntegration(await root(), {
    kind: 'opa',
    name: 'Policy engine',
    baseUrl: 'https://opa.example.com',
    authType: 'none',
    failureMode: 'best_effort',
    ...(over.environmentId !== undefined ? { environmentId: over.environmentId } : {}),
    ...(over.enabled !== undefined ? { enabled: over.enabled } : {}),
  })

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

describe('evaluateElementPolicy', () => {
  it('is silent when no engine is configured, rather than reporting an allow', async () => {
    /*
     * `null`, not `{ outcome: 'allow' }`. An estate with no OPA has no policies,
     * and stamping a verdict would claim a rule was applied to it — the caller
     * writes nothing at all, so the element page shows no policy line instead of
     * a green one nobody earned.
     */
    await expect(evaluateElementPolicy(source())).resolves.toBeNull()
  })

  it('asks the ELEMENT decision path, not the order one', async () => {
    /*
     * The two documents answer different questions and a repository may enforce
     * one and not the other, so asking the order rule about a running element
     * would be asking the wrong question and reading the answer as policy's.
     */
    await withEngine()
    const fetchMock = vi.spyOn(globalThis, 'fetch')
    fetchMock.mockResolvedValue(decision({ decision: 'allow' }))

    await evaluateElementPolicy(source())

    expect(fetchMock).toHaveBeenCalledTimes(1)
    const [url] = fetchMock.mock.calls[0] as [URL]
    expect(String(url)).toContain(ELEMENT_DECISION_PATH)
    expect(String(url)).not.toContain(ORDER_DECISION_PATH)
  })

  it('sends the element document as the input, with secrets redacted', async () => {
    await withEngine()
    await sensitiveParameter('db_password')
    const fetchMock = vi.spyOn(globalThis, 'fetch')
    fetchMock.mockResolvedValue(decision({ decision: 'deny', rule: 'exposure/public-ip', message: 'no' }))

    await evaluateElementPolicy(source())

    const body = JSON.parse(String((fetchMock.mock.calls[0] as [unknown, RequestInit])[1].body)) as {
      input: Record<string, unknown>
    }
    expect(body.input.elementId).toBe(91)
    expect(body.input.refresh).toEqual({
      outcome: 'clean',
      driftDetectedAt: null,
      resources: [],
    })
    expect((body.input.parameters as Record<string, string>).db_password).not.toBe('hunter2')
    expect(JSON.stringify(body)).not.toContain('hunter2')
    expect(body.input.sensitiveParameters).toEqual(['db_password'])
  })

  it('reports warn, deny and needs-approval as themselves', async () => {
    await withEngine()

    for (const [word, expected] of [
      ['allow', 'allow'],
      ['warn', 'warn'],
      ['deny', 'deny'],
      ['needs-approval', 'needs-approval'],
    ] as const) {
      vi.spyOn(globalThis, 'fetch').mockResolvedValue(
        decision({ decision: word, rule: 'some/rule', message: 'because' }),
      )
      const verdict = await evaluateElementPolicy(source())
      expect(verdict).toEqual({ outcome: expected, rule: 'some/rule', message: 'because' })
      vi.restoreAllMocks()
    }
  })

  it('stores a failed call as unavailable, with the error, naming the engine', async () => {
    await withEngine()
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('connect ECONNREFUSED'))

    const verdict = await evaluateElementPolicy(source())

    expect(verdict?.outcome).toBe('unavailable')
    // No rule: whatever the last evaluation named does not describe this one.
    expect(verdict?.rule).toBeNull()
    expect(verdict?.message).toContain('Policy engine')
    expect(verdict?.message).toContain('ECONNREFUSED')
  })

  it('treats an undefined rule on the engine as unavailable, not as an allow', async () => {
    // OPA answers 200 with `{}` when the path evaluates to nothing, which means
    // nobody wrote `infrashelf/element/decision` — not that everything is fine.
    await withEngine()
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(jsonRes({}))

    const verdict = await evaluateElementPolicy(source())

    expect(verdict?.outcome).toBe('unavailable')
    expect(verdict?.message).toContain(ELEMENT_DECISION_PATH)
  })

  it('does not ask for an environment the integration is not bound to', async () => {
    // Bound to environment 1; this element is in 2.
    await withEngine({ environmentId: 1 })
    const fetchMock = vi.spyOn(globalThis, 'fetch')
    fetchMock.mockResolvedValue(decision({ decision: 'deny', message: 'no' }))

    await expect(evaluateElementPolicy(source({ environmentId: 2 }))).resolves.toBeNull()
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('reports rather than refusing, whatever the integration\'s failure mode says', async () => {
    /*
     * `failure_mode` decides whether an ORDER proceeds when the engine is down.
     * Nothing proceeds or stops here, so a blocking integration and a best-effort
     * one produce the same stored answer — and the caller (the drift sweep) has no
     * branch to get wrong.
     */
    await createIntegration(await root(), {
      kind: 'opa',
      name: 'Blocking engine',
      baseUrl: 'https://opa.example.com',
      authType: 'none',
      failureMode: 'blocking',
    })
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('nope'))

    const verdict = await evaluateElementPolicy(source())

    expect(verdict?.outcome).toBe('unavailable')
  })
})

describe('the element document never reaches the order endpoint', () => {
  it('has its own path constant', () => {
    expect(ELEMENT_DECISION_PATH).toBe('/v1/data/infrashelf/element/decision')
    expect(ORDER_DECISION_PATH).toBe('/v1/data/infrashelf/order/decision')
    expect(ELEMENT_DECISION_PATH).not.toBe(ORDER_DECISION_PATH)
  })
})
