import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { eq } from 'drizzle-orm'
import { db } from '@/lib/db/client'
import { infrastructureElements } from '@/lib/db/schema'
import {
  createUser, createCategory, createProduct, createCiSource,
  createEnvironment, createProject, createOrder, createInfraElement,
} from '@/test/helpers'
import { createIntegration } from '@/lib/services/admin/integrations'
import { evaluateElementPolicies, POLICY_EVALUATION_CONCURRENCY } from './elementPolicy'

/**
 * Storing continuous policy verdicts (#110, slice 6).
 *
 * What matters here is not the verdict itself — `elementGate.test.ts` has that —
 * but what the sweep does with it: which elements it writes to, which it leaves
 * alone, and that a dead engine cannot stop a drift report from being recorded.
 */

const AT = new Date('2026-09-22T06:00:00.000Z')

afterEach(() => vi.restoreAllMocks())
beforeEach(() => {
  vi.spyOn(console, 'error').mockImplementation(() => {})
})

const scenario = async (over: { status?: string; sizeCode?: string | null; quantity?: number } = {}) => {
  const user = await createUser({ email: `policy-${Math.random()}@test.dev` })
  const category = await createCategory()
  const product = await createProduct(category.id)
  const ci = await createCiSource()
  const environment = await createEnvironment(ci.id)
  const project = await createProject(user.id)
  const order = await createOrder(project.id, product.id, environment.id, user.id, {
    status: 'completed',
    ...(over.quantity !== undefined ? { quantity: over.quantity } : {}),
  })
  const element = await createInfraElement(order.id, project.id, environment.id, product.id, {
    status: over.status ?? 'active',
    ...(over.sizeCode !== undefined ? { sizeCode: over.sizeCode } : {}),
    parameters: { hostname: 'web-01' },
    outputs: { public_ip: '203.0.113.9' },
  })
  return { element, environment, order }
}

const root = async () => (await createUser({ role: 'root' })).id

const withEngine = async (environmentId?: number) =>
  createIntegration(await root(), {
    kind: 'opa',
    name: 'Policy engine',
    baseUrl: 'https://opa.example.com',
    authType: 'none',
    failureMode: 'best_effort',
    ...(environmentId !== undefined ? { environmentId } : {}),
  })

const decision = (payload: Record<string, unknown>) =>
  new Response(JSON.stringify({ result: payload }), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  })

const reload = async (id: number) => {
  const [row] = await db.select().from(infrastructureElements).where(eq(infrastructureElements.id, id))
  return row
}

describe('evaluateElementPolicies', () => {
  it('stores the verdict, the rule and the policy\'s own words', async () => {
    const { element, environment } = await scenario({ sizeCode: 'M' })
    await withEngine(environment.id)
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      decision({ decision: 'deny', rule: 'exposure/public-ip', message: 'A public IP is not permitted here.' }),
    )

    const summary = await evaluateElementPolicies([element.id], AT)

    expect(summary).toEqual({ evaluated: 1, unavailable: 0, unconfigured: 0 })
    const row = await reload(element.id)
    expect(row.policyOutcome).toBe('deny')
    expect(row.policyRule).toBe('exposure/public-ip')
    expect(row.policyMessage).toBe('A public IP is not permitted here.')
    expect(row.policyCheckedAt?.toISOString()).toBe(AT.toISOString())
  })

  it('sends the size from the element and the quantity from its order', async () => {
    // The two live on different rows, and a policy about "more than one of these"
    // can only be answered if the document carries both.
    const { element, environment } = await scenario({ sizeCode: 'L', quantity: 4 })
    await withEngine(environment.id)
    const fetchMock = vi.spyOn(globalThis, 'fetch')
    fetchMock.mockResolvedValue(decision({ decision: 'allow' }))

    await evaluateElementPolicies([element.id], AT)

    const body = JSON.parse(String((fetchMock.mock.calls[0] as [unknown, RequestInit])[1].body)) as {
      input: Record<string, unknown>
    }
    expect(body.input.size).toBe('L')
    expect(body.input.quantity).toBe(4)
    expect(body.input.elementId).toBe(element.id)
    expect(body.input.outputs).toEqual({ public_ip: '203.0.113.9' })
  })

  it('stores a failed call as unavailable, with the error, and counts it', async () => {
    const { element, environment } = await scenario()
    await withEngine(environment.id)
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('ECONNREFUSED'))

    const summary = await evaluateElementPolicies([element.id], AT)

    expect(summary).toEqual({ evaluated: 1, unavailable: 1, unconfigured: 0 })
    const row = await reload(element.id)
    expect(row.policyOutcome).toBe('unavailable')
    expect(row.policyRule).toBeNull()
    expect(row.policyMessage).toContain('ECONNREFUSED')
    // A failed check still stamps the time: "asked at 06:00 and could not be
    // answered" is what the page has to be able to say.
    expect(row.policyCheckedAt?.toISOString()).toBe(AT.toISOString())
  })

  it('writes nothing and asks nothing when no engine is configured', async () => {
    const { element } = await scenario()
    const fetchMock = vi.spyOn(globalThis, 'fetch')

    const summary = await evaluateElementPolicies([element.id], AT)

    expect(summary).toEqual({ evaluated: 0, unavailable: 0, unconfigured: 1 })
    expect(fetchMock).not.toHaveBeenCalled()
    const row = await reload(element.id)
    // No verdict at all, rather than a green one nobody earned.
    expect(row.policyOutcome).toBeNull()
    expect(row.policyCheckedAt).toBeNull()
  })

  it('leaves a newer verdict alone when an older run is replayed', async () => {
    const NEWER = new Date('2026-09-22T12:00:00.000Z')
    const { element } = await scenario()
    await db
      .update(infrastructureElements)
      .set({ policyCheckedAt: NEWER, policyOutcome: 'allow', policyRule: null, policyMessage: null })
      .where(eq(infrastructureElements.id, element.id))

    const summary = await evaluateElementPolicies([element.id], AT)

    expect(summary.evaluated).toBe(0)
    const row = await reload(element.id)
    expect(row.policyOutcome).toBe('allow')
    expect(row.policyCheckedAt?.toISOString()).toBe(NEWER.toISOString())
  })

  it('does not evaluate an element that is on its way out', async () => {
    // A teardown may start while the engine is being asked; an element being
    // decommissioned is not a subject a policy report is about.
    const { element, environment } = await scenario({ status: 'decommissioning' })
    await withEngine(environment.id)
    const fetchMock = vi.spyOn(globalThis, 'fetch')
    fetchMock.mockResolvedValue(decision({ decision: 'deny', message: 'no' }))

    const summary = await evaluateElementPolicies([element.id], AT)

    expect(summary.evaluated).toBe(0)
    expect((await reload(element.id)).policyOutcome).toBeNull()
  })

  it('evaluates every element, not just the first chunk', async () => {
    // One environment and one engine, so a shortfall here is the chunking and not
    // an integration that only resolves for some of the estate.
    const count = POLICY_EVALUATION_CONCURRENCY + 3
    const user = await createUser({ email: `chunk-${Math.random()}@test.dev` })
    const category = await createCategory()
    const product = await createProduct(category.id)
    const ci = await createCiSource()
    const environment = await createEnvironment(ci.id)
    const project = await createProject(user.id)

    const elements: number[] = []
    for (let i = 0; i < count; i += 1) {
      const order = await createOrder(project.id, product.id, environment.id, user.id, { status: 'completed' })
      const element = await createInfraElement(order.id, project.id, environment.id, product.id, {
        parameters: { hostname: `web-${i}` },
      })
      elements.push(element.id)
    }
    await withEngine(environment.id)
    // A fresh Response per call: a Response body can be read once, so a single
    // mockResolvedValue would answer the first element and fail the rest with
    // "Body is unusable" — which the gate stores as `unavailable`.
    vi.spyOn(globalThis, 'fetch').mockImplementation(async () =>
      decision({ decision: 'warn', rule: 'tagging/missing' }),
    )

    const summary = await evaluateElementPolicies(elements, AT)

    expect(summary.evaluated).toBe(count)
    for (const id of elements) expect((await reload(id)).policyOutcome).toBe('warn')
  })

  it('is a no-op for an empty list', async () => {
    await expect(evaluateElementPolicies([], AT)).resolves.toEqual({
      evaluated: 0,
      unavailable: 0,
      unconfigured: 0,
    })
  })
})
