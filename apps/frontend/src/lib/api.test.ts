import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { ApiError, apiRequest, get, post, put, del } from './api'

const signOut = vi.fn()
vi.mock('next-auth/react', () => ({ signOut: (...args: unknown[]) => signOut(...args) }))

const mockFetch = vi.fn()

beforeEach(() => {
  mockFetch.mockClear()
  vi.stubGlobal('fetch', mockFetch)
})

afterEach(() => {
  vi.unstubAllGlobals()
})

const makeResponse = (
  body: unknown,
  status = 200,
  contentType = 'application/json',
): Response => {
  const json = typeof body === 'string' ? body : JSON.stringify(body)
  return new Response(json, {
    status,
    headers: { 'content-type': contentType },
  })
}

describe('ApiError', () => {
  it('extends Error with a status property', () => {
    const err = new ApiError(404, 'Not found')
    expect(err).toBeInstanceOf(Error)
    expect(err.status).toBe(404)
    expect(err.message).toBe('Not found')
  })
})

describe('apiRequest', () => {
  it('returns parsed JSON on success', async () => {
    mockFetch.mockResolvedValueOnce(makeResponse({ id: 1, name: 'test' }))
    const result = await apiRequest<{ id: number; name: string }>('/test')
    expect(result).toEqual({ id: 1, name: 'test' })
  })

  it('throws ApiError with status on 4xx response', async () => {
    mockFetch.mockResolvedValueOnce(makeResponse({ error: 'Not found' }, 404))
    const err = await apiRequest('/missing').catch((e) => e) as ApiError
    expect(err).toBeInstanceOf(ApiError)
    expect(err.status).toBe(404)
    expect(err.message).toBe('Not found')
  })

  it('throws ApiError on 500', async () => {
    mockFetch.mockResolvedValueOnce(makeResponse({ error: 'Server error' }, 500))
    const err = await apiRequest('/fail').catch((e) => e) as ApiError
    expect(err).toBeInstanceOf(ApiError)
    expect(err.status).toBe(500)
    expect(err.message).toBe('Server error')
  })

  it('returns undefined for 204 No Content', async () => {
    mockFetch.mockResolvedValueOnce(new Response(null, { status: 204 }))
    const result = await apiRequest('/empty')
    expect(result).toBeUndefined()
  })

  it('sends no Authorization header from the browser, and goes through the proxy', async () => {
    // Issue #146: the browser must never hold the backend JWT. It sends the
    // HttpOnly session cookie to this origin's own /api/proxy, which attaches
    // the bearer token server-side. These tests run in jsdom, so `window`
    // exists and this is the browser branch.
    mockFetch.mockResolvedValueOnce(makeResponse({}))
    // A token passed here is ignored rather than sent. The browser branch has to
    // be the one that is safe when it is wrong, because client components are
    // server-rendered too — and because the day someone reintroduces a token
    // prop, this is what has to stop it reaching the wire.
    await apiRequest('/api/orders', { token: 'must-not-be-sent' })
    const [url, init] = mockFetch.mock.calls[0]
    expect(url).toBe('/api/proxy/api/orders')
    expect((init as RequestInit).headers).not.toHaveProperty('Authorization')
  })

  it('sets Content-Type for JSON body', async () => {
    mockFetch.mockResolvedValueOnce(makeResponse({}))
    await apiRequest('/submit', { method: 'POST', body: { key: 'val' } })
    const [, init] = mockFetch.mock.calls[0]
    expect((init as RequestInit).headers).toMatchObject({
      'Content-Type': 'application/json',
    })
  })

  it('does not set Content-Type for FormData body', async () => {
    mockFetch.mockResolvedValueOnce(makeResponse({}))
    const form = new FormData()
    form.append('file', 'data')
    await apiRequest('/upload', { method: 'POST', body: form, isFormData: true })
    const [, init] = mockFetch.mock.calls[0]
    expect((init as RequestInit & { headers?: Record<string, string> }).headers?.['Content-Type']).toBeUndefined()
  })

  it('uses fallback error message when response body is not JSON', async () => {
    mockFetch.mockResolvedValueOnce(new Response('Service Unavailable', { status: 503 }))
    const err = await apiRequest('/bad').catch((e) => e) as ApiError
    expect(err).toBeInstanceOf(ApiError)
    expect(err.status).toBe(503)
  })

  /*
   * #509. The backend's refusal code has to survive the trip through the proxy
   * intact, because it is the only part of a 409 a caller can act on: the message
   * beside it is prose written for a person.
   */
  it('carries the refusal code from the body onto the error', async () => {
    mockFetch.mockResolvedValueOnce(
      makeResponse({ error: 'This cost centre is over budget.', code: 'budget_blocked' }, 409),
    )
    const err = await apiRequest('/orders').catch((e) => e) as ApiError
    expect(err.status).toBe(409)
    expect(err.code).toBe('budget_blocked')
    expect(err.message).toBe('This cost centre is over budget.')
  })

  it('leaves the code undefined when the body has none, or has a non-string', async () => {
    mockFetch.mockResolvedValueOnce(makeResponse({ error: 'Nope' }, 409))
    const withoutCode = await apiRequest('/orders').catch((e) => e) as ApiError
    expect(withoutCode.code).toBeUndefined()

    // A caller switching on the code must not have to defend against a number, so
    // anything that is not a string is not a code.
    mockFetch.mockResolvedValueOnce(makeResponse({ error: 'Nope', code: 7 }, 409))
    const numeric = await apiRequest('/orders').catch((e) => e) as ApiError
    expect(numeric.code).toBeUndefined()
  })
})

describe('convenience helpers', () => {
  it('get() calls apiRequest with GET method', async () => {
    mockFetch.mockResolvedValueOnce(makeResponse({ ok: true }))
    const result = await get<{ ok: boolean }>('/items')
    expect(result.ok).toBe(true)
    expect(mockFetch.mock.calls[0][1]).toMatchObject({ method: 'GET' })
  })

  it('post() sends body as JSON', async () => {
    mockFetch.mockResolvedValueOnce(makeResponse({ created: true }))
    await post('/items', { name: 'new' })
    const [, init] = mockFetch.mock.calls[0]
    expect((init as RequestInit).method).toBe('POST')
    expect((init as RequestInit).body).toBe(JSON.stringify({ name: 'new' }))
  })

  it('put() sends body with PUT method', async () => {
    mockFetch.mockResolvedValueOnce(makeResponse({}))
    await put('/items/1', { name: 'updated' })
    expect(mockFetch.mock.calls[0][1]).toMatchObject({ method: 'PUT' })
  })

  it('del() sends DELETE request', async () => {
    mockFetch.mockResolvedValueOnce(new Response(null, { status: 204 }))
    await del('/items/1')
    expect(mockFetch.mock.calls[0][1]).toMatchObject({ method: 'DELETE' })
  })
})

// Issue #103. A 401 means the session is over, not that this one call was
// unlucky; the caller-by-caller handling left people on a page that looked
// logged in with no data on it.
describe('apiRequest on 401', () => {
  beforeEach(() => {
    signOut.mockClear()
    // The module keeps a "sign-out already under way" flag, so each test needs
    // its own instance of it.
    vi.resetModules()
    window.history.pushState({}, '', '/orders/7')
  })

  afterEach(() => {
    window.history.pushState({}, '', '/')
  })

  it('signs out and comes back to the page you were on', async () => {
    // Destructured from the same fresh module: `vi.resetModules()` gives the
    // re-import its own ApiError class, so the statically imported one would not
    // match it.
    const { apiRequest: request, ApiError: FreshApiError } = await import('./api')
    mockFetch.mockResolvedValueOnce(makeResponse({ error: 'Unauthorized' }, 401))

    await expect(request('/orders')).rejects.toThrow(FreshApiError)

    expect(signOut).toHaveBeenCalledWith({
      redirectTo: '/login?expired=1&callbackUrl=%2Forders%2F7',
    })
  })

  it('still throws, so a caller mid-render is not left waiting', async () => {
    const { apiRequest: request, ApiError: FreshApiError } = await import('./api')
    mockFetch.mockResolvedValueOnce(makeResponse({ error: 'Unauthorized' }, 401))

    // `request` is generic with no argument here, so its rejection widens to
    // unknown: assert the shape after narrowing, not through it.
    const err = (await request('/orders').catch((e: unknown) => e)) as ApiError
    expect(err).toBeInstanceOf(FreshApiError)
    expect(err.status).toBe(401)
  })

  it('signs out once when a page full of parallel requests all fail', async () => {
    // A dead token fails everything in flight at once, and one redirect is the
    // only sensible outcome.
    const { apiRequest: request } = await import('./api')
    mockFetch.mockResolvedValue(makeResponse({ error: 'Unauthorized' }, 401))

    await Promise.allSettled([request('/a'), request('/b'), request('/c')])

    expect(signOut).toHaveBeenCalledTimes(1)
  })

  it('does not sign out on the login page itself', async () => {
    window.history.pushState({}, '', '/login')
    const { apiRequest: request, ApiError: FreshApiError } = await import('./api')
    mockFetch.mockResolvedValueOnce(makeResponse({ error: 'Unauthorized' }, 401))

    await expect(request('/api/auth/whatever')).rejects.toThrow(FreshApiError)

    expect(signOut).not.toHaveBeenCalled()
  })

  it('leaves other error statuses to the caller', async () => {
    const { apiRequest: request, ApiError: FreshApiError } = await import('./api')
    mockFetch.mockResolvedValueOnce(makeResponse({ error: 'Forbidden' }, 403))

    await expect(request('/orders')).rejects.toThrow(FreshApiError)

    expect(signOut).not.toHaveBeenCalled()
  })
})

/**
 * The server half of the same rule (issue #146).
 *
 * The token is attached only on the server, and only by `lib/serverApi.ts` — the
 * `get`/`post`/`put`/`del` exported here do not take one, so client code has no
 * way to send one and nothing to send. These tests make `typeof window`
 * undefined so the module takes its server branch.
 */
describe('apiRequest on the server', () => {
  beforeEach(() => {
    vi.resetModules()
    vi.stubGlobal('window', undefined)
  })

  it('calls the API host directly and attaches the token it was given', async () => {
    const { apiRequest: request } = await import('./api')
    mockFetch.mockResolvedValueOnce(makeResponse({ ok: true }))

    await request('/api/orders', { token: 'server-side-jwt' })

    const [url, init] = mockFetch.mock.calls[0]
    // No NEXT_PUBLIC_API_URL in the test env, so the base is '' — what matters
    // is that it is NOT the proxy prefix, which only the browser uses.
    expect(url).toBe('/api/orders')
    expect((init as RequestInit).headers).toMatchObject({
      Authorization: 'Bearer server-side-jwt',
    })
  })

  it('sends no Authorization header when there is no token', async () => {
    const { apiRequest: request } = await import('./api')
    mockFetch.mockResolvedValueOnce(makeResponse({ ok: true }))

    await request('/api/public/branding')

    expect((mockFetch.mock.calls[0][1] as RequestInit).headers).not.toHaveProperty('Authorization')
  })
})
