import { describe, it, expect } from 'vitest'
import { NextRequest } from 'next/server'
import { GET, POST } from './route'
import { createUser, createCategory, makeAuthHeader } from '@/test/helpers'

const makeReq = (method = 'GET', body?: unknown, auth?: string) =>
  new NextRequest('http://localhost/api/admin/products', {
    method,
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    headers: {
      'content-type': 'application/json',
      ...(auth ? { authorization: auth } : {}),
    },
  })

describe('GET /api/admin/products', () => {
  it('returns 401 without auth', async () => {
    const res = await GET(makeReq())
    expect(res.status).toBe(401)
  })

  it('returns 403 for admin role (requires root)', async () => {
    const admin = await createUser({ role: 'admin' })
    const auth = await makeAuthHeader(admin)
    const res = await GET(makeReq('GET', undefined, auth))
    expect(res.status).toBe(403)
  })

  it('returns a page of products for root', async () => {
    const root = await createUser({ role: 'root' })
    const auth = await makeAuthHeader(root)
    const res = await GET(makeReq('GET', undefined, auth))
    expect(res.status).toBe(200)
    // A page envelope, not a bare array (#158): the response is bounded, and the
    // caller reads `items`.
    const body = await res.json()
    expect(body).toMatchObject({ items: expect.any(Array), total: expect.any(Number) })
    expect(body.limit).toBeGreaterThan(0)
  })

  it('returns 400 for a malformed limit rather than page one under a new size', async () => {
    const root = await createUser({ role: 'root' })
    const auth = await makeAuthHeader(root)
    const res = await GET(
      new NextRequest('http://localhost/api/admin/products?limit=fifty', {
        headers: { authorization: auth },
      }),
    )
    expect(res.status).toBe(400)
  })
})

describe('POST /api/admin/products', () => {
  it('returns 401 without auth', async () => {
    const cat = await createCategory()
    const res = await POST(makeReq('POST', { categoryId: cat.id, name: 'P', baseLanguage: 'en' }))
    expect(res.status).toBe(401)
  })

  it('returns 403 for admin role', async () => {
    const cat = await createCategory()
    const admin = await createUser({ role: 'admin' })
    const auth = await makeAuthHeader(admin)
    const res = await POST(makeReq('POST', { categoryId: cat.id, name: 'P', baseLanguage: 'en' }, auth))
    expect(res.status).toBe(403)
  })

  it('creates product for root', async () => {
    const cat = await createCategory()
    const root = await createUser({ role: 'root' })
    const auth = await makeAuthHeader(root)
    const res = await POST(makeReq('POST', { categoryId: cat.id, name: 'My Product', baseLanguage: 'en' }, auth))
    expect(res.status).toBe(201)
    const body = await res.json()
    expect(body.name).toBe('My Product')
  })

  it('returns 400 for missing categoryId', async () => {
    const root = await createUser({ role: 'root' })
    const auth = await makeAuthHeader(root)
    const res = await POST(makeReq('POST', { name: 'P', baseLanguage: 'en' }, auth))
    expect(res.status).toBe(400)
  })
})
