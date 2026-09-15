// @vitest-environment node
//
// Node, not jsdom: `serverApi` refuses to run where a `window` exists — that
// guard is the backstop on the #146 boundary, and a jsdom test would trip it
// before reaching anything this file is about.
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { ApiError } from '@/lib/api'
import type * as Api from '@/lib/api'

const apiRequest = vi.fn()
vi.mock('@/lib/api', async (importOriginal) => {
  const actual = await importOriginal<typeof Api>()
  return { ...actual, apiRequest: (...args: unknown[]) => apiRequest(...args) }
})
vi.mock('@/lib/auth', () => ({ auth: async () => ({ apiToken: 'token-abc' }) }))

const redirect = vi.fn((url: string) => { throw new Error(`NEXT_REDIRECT:${url}`) })
vi.mock('next/navigation', () => ({ redirect: (url: string) => redirect(url) }))

import { get, post, put, del } from './serverApi'

beforeEach(() => {
  apiRequest.mockReset()
  redirect.mockClear()
})

/**
 * A 401 on the SERVER means the session is over (#427).
 *
 * `lib/api.ts` only ends the session in the browser, on the grounds that the
 * middleware and the dashboard layout have already decided on the server. For a
 * revoked session they have not: the cookie is valid and the token's `exp` has
 * not passed, so both wave it through and the page fetches a 401 it then throws
 * at the error boundary — HTTP 500 instead of the login screen.
 */
describe('serverApi', () => {
  it('sends the caller’s token and returns the body', async () => {
    apiRequest.mockResolvedValue([{ id: 1 }])
    await expect(get('/api/orders')).resolves.toEqual([{ id: 1 }])
    expect(apiRequest).toHaveBeenCalledWith('/api/orders', { token: 'token-abc' })
    expect(redirect).not.toHaveBeenCalled()
  })

  it('ends the session when the backend says 401', async () => {
    apiRequest.mockRejectedValue(new ApiError(401, 'Unauthorized'))

    await expect(get('/api/orders')).rejects.toThrow('NEXT_REDIRECT')
    // Same URL the dashboard layout uses for an expired token, callback and all.
    expect(redirect).toHaveBeenCalledWith('/login?expired=1&callbackUrl=%2F')
  })

  it('does the same for every verb, not only reads', async () => {
    // A revoked session hits a POST just as readily, and a 500 on a submit is
    // worse than one on a page: the user believes their change was lost.
    for (const call of [
      () => post('/api/cart', {}),
      () => put('/api/projects/1', {}),
      () => del('/api/cart/1'),
    ]) {
      apiRequest.mockRejectedValue(new ApiError(401, 'Unauthorized'))
      await expect(call()).rejects.toThrow('NEXT_REDIRECT')
    }
    expect(redirect).toHaveBeenCalledTimes(3)
  })

  it('leaves every other failure alone', async () => {
    // 403 is "not for you", not "you are not signed in" — redirecting on it would
    // sign people out of pages they are merely not allowed to see, and a 500 is
    // the backend's problem, not the session's.
    for (const status of [400, 403, 404, 500, 502]) {
      apiRequest.mockRejectedValue(new ApiError(status, 'nope'))
      await expect(get('/api/orders')).rejects.toThrow('nope')
    }
    expect(redirect).not.toHaveBeenCalled()
  })

  it('leaves a non-ApiError alone', async () => {
    apiRequest.mockRejectedValue(new TypeError('fetch failed'))
    await expect(get('/api/orders')).rejects.toThrow('fetch failed')
    expect(redirect).not.toHaveBeenCalled()
  })
})
