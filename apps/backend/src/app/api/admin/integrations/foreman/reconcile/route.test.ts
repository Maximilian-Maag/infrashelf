import { describe, it, expect, vi, afterEach } from 'vitest'
import { NextRequest } from 'next/server'
import { GET } from './route'
import { createUser, makeAuthHeader, createCiSource, createEnvironment } from '@/test/helpers'
import { createIntegration } from '@/lib/services/admin/integrations'
import * as foreman from '@/lib/integrations/foreman'

afterEach(() => vi.restoreAllMocks())

const makeReq = (query: string, auth?: string) =>
  new NextRequest(`http://localhost/api/admin/integrations/foreman/reconcile${query}`, {
    headers: auth ? { authorization: auth } : {},
  })

const seed = async () => {
  const root = await createUser({ role: 'root' })
  const ci = await createCiSource()
  const env = await createEnvironment(ci.id)
  const created = await createIntegration(root.id, {
    kind: 'foreman',
    name: 'Foreman Prod',
    baseUrl: 'https://foreman.example.com',
    authType: 'bearer',
    credential: 'glpat-super-secret',
    environmentId: env.id,
    failureMode: 'best_effort',
  })
  if (!created.ok) throw new Error('setup failed')
  return { auth: await makeAuthHeader(root), envId: env.id }
}

describe('GET /api/admin/integrations/foreman/reconcile', () => {
  it('returns 401 without an auth token', async () => {
    expect((await GET(makeReq('?environmentId=1'))).status).toBe(401)
  })

  it('returns 403 for a project manager and for an admin', async () => {
    for (const role of ['project_manager', 'admin'] as const) {
      const auth = await makeAuthHeader(await createUser({ role }))
      expect((await GET(makeReq('?environmentId=1', auth))).status).toBe(403)
    }
  })

  it('does not contact Foreman when the caller is not root', async () => {
    // The auth gate has to come before the outbound call, or an unauthorised
    // request still costs a round trip to somebody else's inventory.
    const listed = vi.spyOn(foreman, 'listForemanHosts')
    const auth = await makeAuthHeader(await createUser({ role: 'admin' }))

    await GET(makeReq('?environmentId=1', auth))

    expect(listed).not.toHaveBeenCalled()
  })

  it('refuses a request that names no environment', async () => {
    // Not defaulted to "all": one report built from several Foremans would
    // contain ghosts nobody can read, because which inventory was searched for
    // them would not be in it.
    const { auth } = await seed()

    const res = await GET(makeReq('', auth))

    expect(res.status).toBe(400)
    expect((await res.json()).error).toMatch(/environmentId/)
  })

  it('refuses an environmentId that is not a positive integer', async () => {
    const { auth } = await seed()

    for (const q of ['?environmentId=0', '?environmentId=-3', '?environmentId=abc', '?environmentId=1.5']) {
      expect((await GET(makeReq(q, auth))).status, q).toBe(400)
    }
  })

  it('answers with the four buckets for root', async () => {
    const { auth, envId } = await seed()
    vi.spyOn(foreman, 'listForemanHosts').mockResolvedValue({
      ok: true,
      hosts: [{ id: 5, name: 'legacy-01.dc.example.com', status: 'OK', lastReportAt: null }],
    })

    const res = await GET(makeReq(`?environmentId=${envId}`, auth))

    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.integration.name).toBe('Foreman Prod')
    expect(body.orphans).toHaveLength(1)
    expect(body.matched).toEqual([])
    expect(body.ghosts).toEqual([])
    expect(body.unidentified).toEqual([])
  })

  it('passes the reason through when Foreman could not be read', async () => {
    const { auth, envId } = await seed()
    vi.spyOn(foreman, 'listForemanHosts').mockResolvedValue({
      ok: false,
      error: 'Rejected the stored credential (HTTP 401)',
    })

    const res = await GET(makeReq(`?environmentId=${envId}`, auth))

    // 502, not 500: the portal is fine and the system it asked is not.
    expect(res.status).toBe(502)
    expect((await res.json()).error).toContain('Rejected the stored credential')
  })
})
