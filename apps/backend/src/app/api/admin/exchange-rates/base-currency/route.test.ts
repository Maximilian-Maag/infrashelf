import { describe, it, expect } from 'vitest'
import { NextRequest } from 'next/server'
import { GET, PUT } from './route'
import { createUser, makeAuthHeader } from '@/test/helpers'
import { db } from '@/lib/db/client'
import { exchangeRates } from '@/lib/db/schema'

const makeReq = (method: 'GET' | 'PUT', auth?: string, body?: unknown) =>
  new NextRequest('http://localhost/api/admin/exchange-rates/base-currency', {
    method,
    headers: auth ? { authorization: auth, 'content-type': 'application/json' } : {},
    body: body === undefined ? undefined : JSON.stringify(body),
  })

describe('GET /api/admin/exchange-rates/base-currency', () => {
  it('returns 401 without auth', async () => {
    const res = await GET(makeReq('GET'))
    expect(res.status).toBe(401)
  })

  it('returns 403 for admin role (requires root)', async () => {
    const auth = await makeAuthHeader(await createUser({ role: 'admin' }))
    const res = await GET(makeReq('GET', auth))
    expect(res.status).toBe(403)
  })

  it('returns the base currency for root, EUR by default', async () => {
    const auth = await makeAuthHeader(await createUser({ role: 'root' }))
    const res = await GET(makeReq('GET', auth))
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ baseCurrency: 'EUR' })
  })
})

describe('PUT /api/admin/exchange-rates/base-currency', () => {
  it('returns 403 for project_manager', async () => {
    const auth = await makeAuthHeader(await createUser({ role: 'project_manager' }))
    const res = await PUT(makeReq('PUT', auth, { baseCurrency: 'USD' }))
    expect(res.status).toBe(403)
  })

  it('returns 400 for a value that is not a three-letter code', async () => {
    const auth = await makeAuthHeader(await createUser({ role: 'root' }))
    const res = await PUT(makeReq('PUT', auth, { baseCurrency: 'euro' }))
    expect(res.status).toBe(400)
  })

  it('returns 409 when no rate is stored for the requested currency', async () => {
    await db.insert(exchangeRates).values([{ currencyCode: 'EUR', rate: '1' }])
    const auth = await makeAuthHeader(await createUser({ role: 'root' }))
    const res = await PUT(makeReq('PUT', auth, { baseCurrency: 'USD' }))
    expect(res.status).toBe(409)
  })

  it('sets the base currency and re-bases the stored rates for root', async () => {
    await db
      .insert(exchangeRates)
      .values([
        { currencyCode: 'EUR', rate: '1' },
        { currencyCode: 'USD', rate: '1.1' },
      ])
    const auth = await makeAuthHeader(await createUser({ role: 'root' }))

    const res = await PUT(makeReq('PUT', auth, { baseCurrency: 'usd' }))
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ baseCurrency: 'USD' })

    const usd = await db.query.exchangeRates.findFirst({ where: (r, { eq }) => eq(r.currencyCode, 'USD') })
    expect(Number(usd?.rate)).toBeCloseTo(1, 10)
  })
})
