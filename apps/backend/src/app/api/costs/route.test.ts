import { describe, it, expect } from 'vitest'
import { NextRequest } from 'next/server'
import { GET } from './route'
import { GET as EXPORT } from './export/route'
import { db } from '@/lib/db/client'
import { orders } from '@/lib/db/schema'
import { eq } from 'drizzle-orm'
import {
  createUser,
  makeAuthHeader,
  createCategory,
  createProduct,
  createCiSource,
  createEnvironment,
  createProject,
  createOrder as seedOrder,
  linkProductEnvironment,
} from '@/test/helpers'

const req = (query = '', auth?: string) =>
  new NextRequest(`http://localhost/api/costs${query}`, auth ? { headers: { authorization: auth } } : undefined)

const setup = async () => {
  const admin = await createUser({ role: 'admin', email: 'cr-cost-admin@test.dev' })
  const pm = await createUser({ role: 'project_manager', email: 'cr-cost-pm@test.dev' })
  const otherPm = await createUser({ role: 'project_manager', email: 'cr-cost-other@test.dev' })
  const cat = await createCategory()
  const product = await createProduct(cat.id, 'Nginx Gateway')
  const ci = await createCiSource()
  const env = await createEnvironment(ci.id, undefined, 'AWS Frankfurt')
  await linkProductEnvironment(product.id, env.id, { price: '10.00' })
  const mine = await createProject(pm.id, 'Webshop')
  const theirs = await createProject(otherPm.id, 'Hidden')

  const order = await seedOrder(mine.id, product.id, env.id, pm.id, { status: 'completed' })
  await db
    .update(orders)
    .set({
      productSnapshot: {
        version: 1, capturedAt: '2026-06-01T00:00:00.000Z', productName: 'Nginx Gateway',
        productDescription: '', environmentName: 'AWS Frankfurt', price: '10.00', currency: 'EUR',
        costCenterMode: 'project', forcedCostCenter: false, trialEnabled: false,
        trialDurationMinutes: 30, parameters: [],
      },
    })
    .where(eq(orders.id, order.id))

  return {
    mine,
    theirs,
    adminAuth: await makeAuthHeader(admin),
    pmAuth: await makeAuthHeader(pm),
  }
}

describe('GET /api/costs', () => {
  it('returns 401 without a token', async () => {
    await setup()
    expect((await GET(req())).status).toBe(401)
  })

  it('is open to a project manager, scoped to their projects', async () => {
    // Cost visibility is not an admin-only feature; the scoping is the control.
    const { pmAuth } = await setup()
    const res = await GET(req('', pmAuth))
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.totalBase).toBe(10)
    expect(body.global).toBe(false)
  })

  it('shows an admin the global report', async () => {
    const { adminAuth } = await setup()
    const body = await (await GET(req('', adminAuth))).json()
    expect(body.global).toBe(true)
  })

  it('narrows to a project', async () => {
    const { mine, adminAuth } = await setup()
    const body = await (await GET(req(`?projectId=${mine.id}`, adminAuth))).json()
    expect(body.totalBase).toBe(10)
  })

  it('refuses a project the caller may not see, rather than returning zero', async () => {
    // An empty report reads as "no spend" instead of "not yours".
    const { theirs, pmAuth } = await setup()
    const res = await GET(req(`?projectId=${theirs.id}`, pmAuth))
    expect(res.status).toBe(403)
  })

  it('returns 404 for an unknown project', async () => {
    const { pmAuth } = await setup()
    expect((await GET(req('?projectId=999999', pmAuth))).status).toBe(404)
  })

  it.each(['?projectId=0', '?range=lastWeek', '?from=nonsense', '?from=2026-06-01&to=2026-01-01'])(
    'rejects malformed filters (%s)',
    async (query) => {
      const { adminAuth } = await setup()
      expect((await GET(req(query, adminAuth))).status).toBe(400)
    },
  )

  it('accepts every range preset', async () => {
    const { adminAuth } = await setup()
    for (const range of ['currentMonth', 'last3Months', 'last12Months', 'all']) {
      expect((await GET(req(`?range=${range}`, adminAuth))).status, range).toBe(200)
    }
  })

  it('breaks the total down by project, cost centre, product and environment', async () => {
    const { adminAuth } = await setup()
    const body = await (await GET(req('', adminAuth))).json()
    expect(body.byProject).toMatchObject([{ label: 'Webshop', totalBase: 10 }])
    expect(body.byProduct).toMatchObject([{ label: 'Nginx Gateway' }])
    expect(body.byEnvironment).toMatchObject([{ label: 'AWS Frankfurt' }])
    // 'project' cost-centre mode stores none, so the bucket is labelled explicitly.
    expect(body.byCostCenter).toMatchObject([{ label: 'No cost centre' }])
  })

  it('serves the monthly series alongside the totals (issue #106)', async () => {
    // Alongside rather than from its own endpoint: the trend and the total have
    // to be over the same rows, and a second endpoint could disagree.
    const { adminAuth } = await setup()
    const body = await (await GET(req('', adminAuth))).json()
    expect(Array.isArray(body.series)).toBe(true)
    expect(body.series).toHaveLength(1)
    expect(body.series[0]).toMatchObject({
      period: expect.stringMatching(/^\d{4}-\d{2}$/),
      totalBase: 10,
      orderCount: 1,
      estimatedOrders: 0,
      // The seeded order is created now, so its month is the unfinished one.
      partial: true,
    })
    const summed = (body.series as { totalBase: number }[]).reduce((s, p) => s + p.totalBase, 0)
    expect(Math.round(summed * 100) / 100).toBe(body.totalBase)
    // One month in the window, so there is nothing honest to compare against.
    expect(body.comparison).toBeNull()
  })
})

describe('GET /api/costs/export', () => {
  it('returns 401 without a token', async () => {
    await setup()
    expect((await EXPORT(req())).status).toBe(401)
  })

  it('serves CSV with reconcilable per-order rows', async () => {
    // A total nobody can break down is a total nobody trusts.
    const { adminAuth } = await setup()
    const res = await EXPORT(req('', adminAuth))
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toMatch(/text\/csv/)
    expect(res.headers.get('content-disposition')).toContain('costs.csv')

    const text = await res.text()
    // `price` stays the UNIT price and `lineTotalBase` is what reconciles with the
    // report total, now that one order can be twenty elements (issues #98/#104).
    expect(text.split('\n')[0]).toBe(
      'orderId,createdAt,project,costCenter,product,environment,size,quantity,status,' +
        'price,currency,priceBase,lineTotalBase,estimated',
    )
    expect(text).toContain('Webshop')
    expect(text).toContain('Nginx Gateway')
  })

  it('applies the same filters as the report', async () => {
    const { theirs, adminAuth } = await setup()
    const res = await EXPORT(req(`?projectId=${theirs.id}`, adminAuth))
    const lines = (await res.text()).split('\n').filter(Boolean)
    // Only the header: the other project has no spend.
    expect(lines).toHaveLength(1)
  })

  it('enforces the same project scoping as the report', async () => {
    const { theirs, pmAuth } = await setup()
    expect((await EXPORT(req(`?projectId=${theirs.id}`, pmAuth))).status).toBe(403)
  })

  it('serves a PDF when asked', async () => {
    const { adminAuth } = await setup()
    const res = await EXPORT(req('?format=pdf', adminAuth))
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toBe('application/pdf')

    const bytes = new Uint8Array(await res.arrayBuffer())
    expect(String.fromCharCode(...bytes.slice(0, 4))).toBe('%PDF')
  })

  it('rejects an unknown format', async () => {
    const { adminAuth } = await setup()
    expect((await EXPORT(req('?format=xlsx', adminAuth))).status).toBe(400)
  })

  it('rejects a malformed filter rather than exporting everything', async () => {
    const { adminAuth } = await setup()
    expect((await EXPORT(req('?range=lastWeek', adminAuth))).status).toBe(400)
  })
})
