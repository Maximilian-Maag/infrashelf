import { describe, it, expect } from 'vitest'
import { toResponse } from './http'
import { ok, err } from '@/lib/services/result'

describe('toResponse', () => {
  it('wraps an Ok result as a 200 JSON response', async () => {
    const res = toResponse(ok({ hello: 'world' }))
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body).toEqual({ hello: 'world' })
  })

  it('uses a custom success status when provided', async () => {
    const res = toResponse(ok({ id: 1 }), 201)
    expect(res.status).toBe(201)
    const body = await res.json()
    expect(body).toEqual({ id: 1 })
  })

  it('returns the err status and { error } body for an Err result', async () => {
    const res = toResponse(err(404, 'Not found'))
    expect(res.status).toBe(404)
    const body = await res.json()
    expect(body).toEqual({ error: 'Not found' })
  })

  it('preserves other error status codes', async () => {
    const res = toResponse(err(403, 'Forbidden'))
    expect(res.status).toBe(403)
    const body = await res.json()
    expect(body).toEqual({ error: 'Forbidden' })
  })

  /*
   * #509. A refusal that a client can DO something about says so in the body,
   * beside the sentence written for a person. Without it, two refusals that need
   * different handling are the same 409 and the only way to tell them apart is to
   * match on the prose — which is not a contract.
   */
  it('carries a refusal code beside the message when the result has one', async () => {
    const res = toResponse(err(409, 'Over budget', 'budget_blocked'))
    expect(res.status).toBe(409)
    expect(await res.json()).toEqual({ error: 'Over budget', code: 'budget_blocked' })
  })

  it('omits the code key entirely when there is none', async () => {
    // Absent, not `undefined`: a client switching on the key must not have to
    // distinguish "no code" from "a code that failed to serialise".
    const res = toResponse(err(403, 'Forbidden'))
    expect(await res.json()).toEqual({ error: 'Forbidden' })
  })

  it('returns a generic success body when ok data is undefined', async () => {
    const res = toResponse(ok(undefined))
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body).toEqual({ success: true })
  })

  it('returns array data correctly', async () => {
    const res = toResponse(ok([1, 2, 3]))
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body).toEqual([1, 2, 3])
  })
})
