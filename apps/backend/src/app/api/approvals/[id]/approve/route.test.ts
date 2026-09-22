import { vi, describe, it, expect, afterEach } from 'vitest'

vi.mock('@/lib/ci', () => ({ triggerPipeline: vi.fn().mockResolvedValue('pipeline-1') }))
vi.mock('@/lib/notification', () => ({
  sendOrderCreated: vi.fn(),
  sendApprovalRequest: vi.fn(),
  sendOrderApproved: vi.fn(),
  sendOrderRejected: vi.fn(),
  sendProvisioningCompleted: vi.fn(),
  sendProvisioningFailed: vi.fn(),
  sendDecommissioned: vi.fn(),
}))

import { NextRequest } from 'next/server'
import { POST } from './route'
import {
  createUser,
  createCategory,
  createProduct,
  createCiSource,
  createEnvironment,
  createProject,
  createOrder,
  makeAuthHeader,
  createProductWebhook,
} from '@/test/helpers'
import { sendOrderApproved } from '@/lib/notification'
import { createIntegration } from '@/lib/services/admin/integrations'
import { db } from '@/lib/db/client'
import { infrastructureElements, orders } from '@/lib/db/schema'
import { eq } from 'drizzle-orm'

const makeReq = (url: string, auth?: string, body?: unknown) =>
  new NextRequest(url, {
    method: 'POST',
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    headers: {
      'content-type': 'application/json',
      ...(auth ? { authorization: auth } : {}),
    },
  })

/*
 * Root's escape at the moment of approval (#511).
 *
 * The gates are re-asked when an approval commits an order, so a policy that
 * refuses it has to be waivable from the same click that approves it — and the
 * body flag must reach the service without becoming the authority for the
 * privilege itself (`recheckOrderGates` checks the session's role).
 */
describe('POST /api/approvals/[id]/approve — the policy override', () => {
  afterEach(() => vi.restoreAllMocks())

  const ready = async () => {
    const root = await createUser({ role: 'root' })
    const pm = await createUser({ role: 'project_manager' })
    const admin = await createUser({ role: 'admin' })
    const cat = await createCategory()
    const product = await createProduct(cat.id)
    const ci = await createCiSource()
    const env = await createEnvironment(ci.id)
    await createProductWebhook(product.id, env.id)
    const project = await createProject(pm.id)
    await createIntegration(root.id, {
      kind: 'opa',
      name: 'Policy engine',
      baseUrl: 'https://opa.example.com',
      authType: 'none',
      failureMode: 'blocking',
    })
    const order = await createOrder(project.id, product.id, env.id, pm.id, { status: 'pending' })
    vi.spyOn(global, 'fetch').mockResolvedValue(
      new Response(
        JSON.stringify({ result: { decision: 'deny', rule: 'quota/vm-count', message: 'At the limit' } }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      ),
    )
    return { root, pm, admin, order }
  }

  it('refuses the approval when the policy denies the order by then', async () => {
    const base = await ready()
    const res = await POST(makeReq('http://localhost/api/approvals/1/approve', await makeAuthHeader(base.admin)), {
      params: Promise.resolve({ id: String(base.order.id) }),
    })

    expect(res.status).toBe(409)
    const { error } = (await res.json()) as { error: string }
    expect(error).toContain('quota/vm-count')
  })

  it('lets root approve it anyway with overridePolicy in the body', async () => {
    const base = await ready()
    const auth = await makeAuthHeader(base.root)

    const refused = await POST(makeReq('http://localhost/api/approvals/1/approve', auth), {
      params: Promise.resolve({ id: String(base.order.id) }),
    })
    expect(refused.status).toBe(409)

    const waived = await POST(
      makeReq('http://localhost/api/approvals/1/approve', auth, { overridePolicy: true }),
      { params: Promise.resolve({ id: String(base.order.id) }) },
    )
    expect(waived.status).toBe(200)
  })

  it('does not let the flag stand in for the role', async () => {
    // An admin sending the flag is refused, because the privilege is checked
    // against the session and never against the request body (#195's rule).
    const base = await ready()
    const res = await POST(
      makeReq('http://localhost/api/approvals/1/approve', await makeAuthHeader(base.admin), {
        overridePolicy: true,
      }),
      { params: Promise.resolve({ id: String(base.order.id) }) },
    )

    expect(res.status).toBe(409)
  })

  it('approves as before when the body is absent or nonsense', async () => {
    // Every existing caller posts no body; a strict parse would turn each of
    // them into a 500. The engine is pointed at `allow` so the only thing that
    // can refuse these is the body itself.
    const base = await ready()
    vi.restoreAllMocks()
    // A FRESH Response per call: a body can only be read once, so a
    // `mockResolvedValue` of a single Response answers the first request and
    // then looks like an engine that sent no decision at all.
    vi.spyOn(global, 'fetch').mockImplementation(async () =>
      new Response(JSON.stringify({ result: { decision: 'allow', rule: 'baseline' } }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    )
    const auth = await makeAuthHeader(base.root)

    for (const body of [undefined, null, 'not an object', { overridePolicy: 'yes' }]) {
      const res = await POST(makeReq('http://localhost/api/approvals/1/approve', auth, body), {
        params: Promise.resolve({ id: String(base.order.id) }),
      })
      const text = await res.text()
      expect(res.status, `body ${JSON.stringify(body)} was not handled leniently: ${text}`).toBe(200)
      await db.update(orders).set({ status: 'pending' }).where(eq(orders.id, base.order.id))
    }
  })
})

describe('POST /api/approvals/[id]/approve', () => {
  it('returns 401 without auth token', async () => {
    const res = await POST(makeReq('http://localhost/api/approvals/1/approve'), {
      params: Promise.resolve({ id: '1' }),
    })
    expect(res.status).toBe(401)
  })

  it('returns 403 for project_manager role', async () => {
    const pm = await createUser({ role: 'project_manager' })
    const auth = await makeAuthHeader(pm)
    const res = await POST(makeReq('http://localhost/api/approvals/1/approve', auth), {
      params: Promise.resolve({ id: '1' }),
    })
    expect(res.status).toBe(403)
  })

  it('returns 404 for non-existent order', async () => {
    const admin = await createUser({ role: 'admin' })
    const auth = await makeAuthHeader(admin)
    const res = await POST(makeReq('http://localhost/api/approvals/999999/approve', auth), {
      params: Promise.resolve({ id: '999999' }),
    })
    expect(res.status).toBe(404)
  })

  it('approves pending order: transitions to provisioning, creates infra element, calls sendOrderApproved', async () => {
    const admin = await createUser({ role: 'admin' })
    const pm = await createUser({ role: 'project_manager' })
    const cat = await createCategory()
    const product = await createProduct(cat.id)
    const ci = await createCiSource()
    const env = await createEnvironment(ci.id)
    // Something to deploy it with: since #206 an order whose product has no
    // webhook and no pipeline stack is refused rather than left in a provisioning
    // state nothing can complete.
    await createProductWebhook(product.id, env.id)
    const proj = await createProject(pm.id)

    const order = await createOrder(proj.id, product.id, env.id, pm.id, { status: 'pending' })

    const auth = await makeAuthHeader(admin)
    const res = await POST(
      makeReq(`http://localhost/api/approvals/${order.id}/approve`, auth),
      { params: Promise.resolve({ id: String(order.id) }) },
    )
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.success).toBe(true)
    expect(body.infraId).toBeDefined()

    // Order status updated to provisioning
    const updatedOrders = await db
      .select({ status: orders.status })
      .from(orders)
      .where(eq(orders.id, order.id))
    expect(updatedOrders[0]?.status).toBe('provisioning')

    // Infra element created
    const infra = await db
      .select()
      .from(infrastructureElements)
      .where(eq(infrastructureElements.id, body.infraId))
    expect(infra.length).toBe(1)
    expect(infra[0].orderId).toBe(order.id)

    // sendOrderApproved called with orderer's email
    expect(sendOrderApproved).toHaveBeenCalledWith(pm.email, expect.any(String), order.id)
  })

  it('returns 400 if order is not pending', async () => {
    const admin = await createUser({ role: 'admin' })
    const pm = await createUser({ role: 'project_manager' })
    const cat = await createCategory()
    const product = await createProduct(cat.id)
    const ci = await createCiSource()
    const env = await createEnvironment(ci.id)
    const proj = await createProject(pm.id)

    const order = await createOrder(proj.id, product.id, env.id, pm.id, { status: 'provisioning' })

    const auth = await makeAuthHeader(admin)
    const res = await POST(
      makeReq(`http://localhost/api/approvals/${order.id}/approve`, auth),
      { params: Promise.resolve({ id: String(order.id) }) },
    )
    expect(res.status).toBe(400)
    const body = await res.json()
    expect(body.error).toBe('Order is not pending')
  })
})
