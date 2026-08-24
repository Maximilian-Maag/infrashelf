import { describe, it, expect } from 'vitest'
import { NextRequest } from 'next/server'
import { GET, PUT } from './route'
import { createUser, makeAuthHeader } from '@/test/helpers'

const makeReq = (method = 'GET', body?: unknown, auth?: string) =>
  new NextRequest('http://localhost/api/admin/branding', {
    method,
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    headers: {
      'content-type': 'application/json',
      ...(auth ? { authorization: auth } : {}),
    },
  })

const validPayload = { shopName: 'Test Shop', primaryColor: '#ff0000' }

// The OpenAPI entry for this path has said `[root]` with bearerAuth and 401/403
// responses since it was written; the handler took no request at all (issue
// #140). Anonymous callers now use /api/public/branding, which serves the same
// six fields on purpose.
describe('GET /api/admin/branding', () => {
  it('returns 401 without auth', async () => {
    const res = await GET(makeReq())
    expect(res.status).toBe(401)
  })

  it('returns 403 for admin role (requires root)', async () => {
    const admin = await createUser({ role: 'admin' })
    const res = await GET(makeReq('GET', undefined, await makeAuthHeader(admin)))
    expect(res.status).toBe(403)
  })

  it('returns the settings for root', async () => {
    const root = await createUser({ role: 'root' })
    const res = await GET(makeReq('GET', undefined, await makeAuthHeader(root)))
    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({ shopName: expect.any(String) })
  })
})

describe('PUT /api/admin/branding', () => {
  it('returns 401 without auth', async () => {
    const res = await PUT(makeReq('PUT', validPayload))
    expect(res.status).toBe(401)
  })

  it('returns 403 for admin role (requires root)', async () => {
    const admin = await createUser({ role: 'admin' })
    const auth = await makeAuthHeader(admin)
    const res = await PUT(makeReq('PUT', validPayload, auth))
    expect(res.status).toBe(403)
  })

  it('returns 403 for project_manager', async () => {
    const pm = await createUser({ role: 'project_manager' })
    const auth = await makeAuthHeader(pm)
    const res = await PUT(makeReq('PUT', validPayload, auth))
    expect(res.status).toBe(403)
  })

  it('updates branding for root', async () => {
    const root = await createUser({ role: 'root' })
    const auth = await makeAuthHeader(root)
    const res = await PUT(makeReq('PUT', validPayload, auth))
    expect(res.status).toBe(200)
  })

  it('returns 400 for invalid payload', async () => {
    const root = await createUser({ role: 'root' })
    const auth = await makeAuthHeader(root)
    const res = await PUT(makeReq('PUT', { primaryColor: 123 }, auth))
    expect(res.status).toBe(400)
  })
})
