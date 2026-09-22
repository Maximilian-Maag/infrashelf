import { describe, it, expect } from 'vitest'
import { NextRequest } from 'next/server'
import { eq } from 'drizzle-orm'
import { GET, POST } from './route'
import { db } from '@/lib/db/client'
import { costCenters } from '@/lib/db/schema'
import { createUser, makeAuthHeader, createCostCenter } from '@/test/helpers'

const makeReq = (url: string, method = 'GET', body?: unknown, auth?: string) =>
  new NextRequest(url, {
    method,
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    headers: {
      'content-type': 'application/json',
      ...(auth ? { authorization: auth } : {}),
    },
  })

describe('GET /api/admin/cost-centers', () => {
  it('returns 401 without auth token', async () => {
    const res = await GET(makeReq('http://localhost/api/admin/cost-centers'))
    expect(res.status).toBe(401)
  })

  it('returns cost-centers list for project_manager', async () => {
    const pm = await createUser({ role: 'project_manager' })
    const auth = await makeAuthHeader(pm)
    const res = await GET(makeReq('http://localhost/api/admin/cost-centers', 'GET', undefined, auth))
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(Array.isArray(body)).toBe(true)
  })

  it('returns cost-centers list for admin', async () => {
    const admin = await createUser({ role: 'admin' })
    const auth = await makeAuthHeader(admin)
    const res = await GET(makeReq('http://localhost/api/admin/cost-centers', 'GET', undefined, auth))
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(Array.isArray(body)).toBe(true)
  })
})

describe('POST /api/admin/cost-centers', () => {
  it('returns 401 without auth token', async () => {
    const res = await POST(
      makeReq('http://localhost/api/admin/cost-centers', 'POST', {
        code: 'CC001',
        name: 'Engineering',
      }),
    )
    expect(res.status).toBe(401)
  })

  it('returns 403 for project_manager', async () => {
    const pm = await createUser({ role: 'project_manager' })
    const auth = await makeAuthHeader(pm)
    const res = await POST(
      makeReq(
        'http://localhost/api/admin/cost-centers',
        'POST',
        { code: 'CC001', name: 'Engineering' },
        auth,
      ),
    )
    expect(res.status).toBe(403)
  })

  it('returns 400 for missing code', async () => {
    const admin = await createUser({ role: 'admin' })
    const auth = await makeAuthHeader(admin)
    const res = await POST(
      makeReq('http://localhost/api/admin/cost-centers', 'POST', { name: 'Engineering' }, auth),
    )
    expect(res.status).toBe(400)
  })

  it('returns 400 for missing name', async () => {
    const admin = await createUser({ role: 'admin' })
    const auth = await makeAuthHeader(admin)
    const res = await POST(
      makeReq('http://localhost/api/admin/cost-centers', 'POST', { code: 'CC001' }, auth),
    )
    expect(res.status).toBe(400)
  })

  it('creates cost center for admin', async () => {
    const admin = await createUser({ role: 'admin' })
    const auth = await makeAuthHeader(admin)
    const res = await POST(
      makeReq(
        'http://localhost/api/admin/cost-centers',
        'POST',
        { code: 'CC-ENG', name: 'Engineering', active: true },
        auth,
      ),
    )
    expect(res.status).toBe(201)
    const body = await res.json()
    expect(body.code).toBe('CC-ENG')
    expect(body.name).toBe('Engineering')
    expect(body.active).toBe(true)
    expect(body.id).toBeDefined()
  })

  it('root user can also create cost centers', async () => {
    const root = await createUser({ role: 'root' })
    const auth = await makeAuthHeader(root)
    const res = await POST(
      makeReq(
        'http://localhost/api/admin/cost-centers',
        'POST',
        { code: 'CC-ROOT', name: 'Root Center' },
        auth,
      ),
    )
    expect(res.status).toBe(201)
  })
})

/*
 * The budget landed on the `cost_centers` row in #325, and the budget verbs are
 * `requireRole('root')` on purpose — "who may see one is the same question as who
 * may set it". This list is not root's: it needs only a session, so a bare
 * `select()` here handed a spending limit to a project manager (#539).
 *
 * Asserted as the exact key set rather than the absence of four names, so a column
 * added to the table is caught the same way: nothing reaches a response unless
 * somebody selected it.
 */
describe('a cost centre\'s budget does not ride along (#539)', () => {
  const withBudget = async () => {
    const cc = await createCostCenter()
    await db
      .update(costCenters)
      .set({
        budgetAmount: '100.00',
        budgetCurrency: 'EUR',
        budgetPeriod: 'total',
        budgetBehaviour: 'block',
      })
      .where(eq(costCenters.id, cc.id))
    return cc
  }

  it('is not handed to a project manager with the list', async () => {
    const cc = await withBudget()

    const pm = await createUser({ role: 'project_manager' })
    const res = await GET(
      makeReq('http://localhost/api/admin/cost-centers', 'GET', undefined, await makeAuthHeader(pm)),
    )
    expect(res.status).toBe(200)

    const body = (await res.json()) as Array<Record<string, unknown>>
    const row = body.find((r) => r.id === cc.id)
    expect(Object.keys(row ?? {}).sort()).toEqual(['active', 'code', 'id', 'name'])
  })

  it('is not echoed back by the create', async () => {
    const admin = await createUser({ role: 'admin' })
    const res = await POST(
      makeReq(
        'http://localhost/api/admin/cost-centers',
        'POST',
        { code: 'CC-NOBUDGET', name: 'No Budget' },
        await makeAuthHeader(admin),
      ),
    )
    expect(res.status).toBe(201)

    const body = (await res.json()) as Record<string, unknown>
    expect(Object.keys(body).sort()).toEqual(['active', 'code', 'id', 'name'])
  })
})
