import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { NextRequest } from 'next/server'
import { eq } from 'drizzle-orm'
import { POST } from './route'
import { db } from '@/lib/db/client'
import { infrastructureElements, unclaimedStates } from '@/lib/db/schema'
import {
  createUser, createCategory, createProduct, createCiSource,
  createEnvironment, createProject, createOrder, createInfraElement,
} from '@/test/helpers'

/**
 * The HTTP surface of drift reporting (#108).
 *
 * The service is tested next door; what is only testable here is the part that
 * decides whether a stranger may write to this deployment's infrastructure
 * records at all — the 503 when unconfigured, the constant-time secret, and the
 * schema that stands between CI's JSON and a jsonb column.
 */
const SECRET = 'drift-secret-value'

beforeEach(() => {
  process.env.DRIFT_REPORT_SECRET = SECRET
})
afterEach(() => {
  delete process.env.DRIFT_REPORT_SECRET
})

const post = (body: unknown, secret?: string) =>
  new NextRequest('http://localhost/api/internal/drift-report', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(secret === undefined ? {} : { 'x-drift-secret': secret }),
    },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  })

const validReport = { checkedAt: '2026-09-10T06:00:00.000Z', results: [{ stateKey: 'web-01-o42', outcome: 'clean' }] }

describe('POST /api/internal/drift-report', () => {
  /*
   * The most important case. A deployment that never configured the secret must
   * not be writable by an anonymous caller — so the check comes BEFORE the
   * header is even read, and there is no value of the header that gets in.
   */
  it('is disabled with a 503 when the secret is unset', async () => {
    delete process.env.DRIFT_REPORT_SECRET

    const res = await POST(post(validReport, 'anything'))

    expect(res.status).toBe(503)
    expect((await res.json()).error).toMatch(/DRIFT_REPORT_SECRET/)
  })

  it.each([
    ['no secret at all', undefined],
    ['the wrong secret', 'not-the-secret'],
    ['a prefix of the secret', SECRET.slice(0, 8)],
    ['the secret plus a suffix', `${SECRET}x`],
  ])('refuses %s with a 401', async (_name, secret) => {
    const res = await POST(post(validReport, secret))
    expect(res.status).toBe(401)
  })

  it('accepts a well-formed report and says what it did with it', async () => {
    const user = await createUser({ email: 'route-drift@test.dev' })
    const category = await createCategory()
    const product = await createProduct(category.id)
    const ci = await createCiSource()
    const environment = await createEnvironment(ci.id)
    const project = await createProject(user.id)
    const order = await createOrder(project.id, product.id, environment.id, user.id, { status: 'completed' })
    const element = await createInfraElement(order.id, project.id, environment.id, product.id, {
      status: 'active',
      stateKeys: { '1': 'web-01-o42' },
    })

    const res = await POST(post(validReport, SECRET))

    expect(res.status).toBe(200)
    // The counts go back so the pipeline's own log says what the portal made of
    // its report — a run that matched nothing is a state-key convention that has
    // drifted apart, and it should be visible from either end.
    expect(await res.json()).toEqual({ matched: 1, unclaimed: 0, ignored: 0, stale: 0, policyEvaluated: 0, policyUnavailable: 0 })
    const [row] = await db.select().from(infrastructureElements).where(eq(infrastructureElements.id, element.id))
    expect(row.lastRefreshOutcome).toBe('clean')
  })

  /*
   * `complete` decides whether the report's silence about a state key may be
   * read as "nothing checks that any more". A run that does not say so must not
   * have observations reconciled away underneath it, so the flag has to survive
   * the route rather than being defaulted on.
   */
  it('carries the completeness flag through to the recorder', async () => {
    await db.insert(unclaimedStates).values({ stateKey: 'left-behind-o7', outcome: 'drifted' })

    const res = await POST(post({ ...validReport, results: [], complete: true }, SECRET))

    expect(res.status).toBe(200)
    expect(await db.select().from(unclaimedStates)).toHaveLength(0)
  })

  it('leaves observations alone when the run does not claim completeness', async () => {
    await db.insert(unclaimedStates).values({ stateKey: 'left-behind-o7', outcome: 'drifted' })

    const res = await POST(post({ ...validReport, results: [] }, SECRET))

    expect(res.status).toBe(200)
    expect(await db.select().from(unclaimedStates)).toHaveLength(1)
  })

  it('refuses a body that is not JSON', async () => {
    const res = await POST(post('not json at all', SECRET))
    expect(res.status).toBe(400)
  })

  it.each([
    ['an unknown outcome word', { checkedAt: '2026-09-10T06:00:00.000Z', results: [{ stateKey: 'k', outcome: 'maybe' }] }],
    ['a missing state key', { checkedAt: '2026-09-10T06:00:00.000Z', results: [{ outcome: 'clean' }] }],
    ['a checkedAt that is not a timestamp', { checkedAt: 'tuesday', results: [] }],
    ['no results array', { checkedAt: '2026-09-10T06:00:00.000Z' }],
  ])('refuses %s with a 400', async (_name, body) => {
    const res = await POST(post(body, SECRET))
    expect(res.status).toBe(400)
  })

  /*
   * The caps are not politeness. This body is parsed into memory and lands in a
   * jsonb column, and a plan against a badly drifted state can list thousands of
   * resources — the portal shows a summary, not a plan.
   */
  it('refuses a report with more results than the cap', async () => {
    const results = Array.from({ length: 5001 }, (_, i) => ({ stateKey: `k${i}`, outcome: 'clean' }))
    const res = await POST(post({ checkedAt: '2026-09-10T06:00:00.000Z', results }, SECRET))
    expect(res.status).toBe(400)
  })

  it('refuses a summary with more resources than the cap', async () => {
    const resources = Array.from({ length: 201 }, (_, i) => ({ address: `a${i}`, action: 'update' }))
    const res = await POST(post({
      checkedAt: '2026-09-10T06:00:00.000Z',
      results: [{ stateKey: 'k', outcome: 'drifted', summary: { resources } }],
    }, SECRET))
    expect(res.status).toBe(400)
  })
})
