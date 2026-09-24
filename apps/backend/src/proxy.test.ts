import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { NextRequest } from 'next/server'
import { proxy, config } from './proxy'

/**
 * The CORS proxy that sits ahead of every API route (#307's tail).
 *
 * The decision worth testing is the one that is easiest to "improve" into a hole:
 * an unrecognised origin is NOT echoed back. The response carries
 * `Access-Control-Allow-Credentials: true`, so echoing whatever Origin arrived
 * would let any site read a signed-in user's API responses — the browser would
 * send the session cookie and hand the body to the page that asked. The fallback
 * is the first allowed origin instead, which a browser refuses to match.
 */
const request = (over: { origin?: string | null; method?: string } = {}) => {
  const headers = new Headers()
  if (over.origin !== undefined && over.origin !== null) headers.set('origin', over.origin)
  return new NextRequest('http://api.example.com/api/products', {
    method: over.method ?? 'GET',
    headers,
  })
}

/** Read a response's headers without caring which kind of Response it is. */
const headersOf = (res: Response) => ({
  origin: res.headers.get('access-control-allow-origin'),
  credentials: res.headers.get('access-control-allow-credentials'),
  methods: res.headers.get('access-control-allow-methods'),
  allowedHeaders: res.headers.get('access-control-allow-headers'),
})

beforeEach(() => {
  vi.unstubAllEnvs()
})

afterEach(() => vi.unstubAllEnvs())

describe('proxy', () => {
  it('answers a preflight without reaching a route', () => {
    const res = proxy(request({ origin: 'http://localhost:3001', method: 'OPTIONS' }))

    expect(res.status).toBe(204)
    // A 204 has no body, and a preflight must not run the handler it is asking
    // permission for — an OPTIONS that fell through would delete on a CORS probe.
    expect(headersOf(res).origin).toBe('http://localhost:3001')
    expect(headersOf(res).methods).toContain('DELETE')
  })

  it('lets a request through with the CORS headers attached', () => {
    const res = proxy(request({ origin: 'http://localhost:3001' }))

    // `NextResponse.next()` marks the response for the next handler rather than
    // ending the chain — the route still runs, which is the point of a proxy.
    expect(res.headers.get('x-middleware-next')).toBe('1')
    expect(headersOf(res).origin).toBe('http://localhost:3001')
    expect(headersOf(res).credentials).toBe('true')
  })

  it('allows the two local development origins', () => {
    for (const origin of ['http://localhost:3000', 'http://localhost:3001']) {
      expect(headersOf(proxy(request({ origin }))).origin).toBe(origin)
    }
  })

  it('never echoes an origin it does not know', () => {
    // The hole this guards: with credentials allowed, an echoed origin is a
    // cross-site read of everything the signed-in user can see.
    const res = proxy(request({ origin: 'https://evil.example.com' }))

    expect(headersOf(res).origin).not.toBe('https://evil.example.com')
    expect(headersOf(res).origin).toBe('http://localhost:3000')
  })

  it('answers the same fallback for a caller with no Origin at all', () => {
    // curl and server-to-server callers send no Origin; the header still has to
    // be something a browser can match, rather than a wildcard — `*` is not
    // allowed alongside credentials at all.
    const res = proxy(request({ origin: null }))

    expect(headersOf(res).origin).toBe('http://localhost:3000')
    expect(headersOf(res).origin).not.toBe('*')
  })

  it('allows exactly the headers the API uses', () => {
    const res = proxy(request({ origin: 'http://localhost:3000' }))

    expect(headersOf(res).allowedHeaders).toBe('Content-Type,Authorization')
    expect(headersOf(res).methods).toBe('GET,POST,PUT,PATCH,DELETE,OPTIONS')
  })

  it('matches the API only', () => {
    // Scoped to `/api/`: a matcher of `/:path*` would run CORS on the pages too,
    // and an allow-origin header on a page is a cache-poisoning surface.
    expect(config.matcher).toBe('/api/:path*')
  })

  it('adds the deployment frontend to the allowed origins', async () => {
    // Read once at module load, so the import is re-run under a stubbed env: an
    // FRONTEND_URL the operator set is the one origin a browser will actually be
    // sending, and leaving it out breaks every real deployment.
    vi.stubEnv('FRONTEND_URL', 'https://portal.example.com')
    vi.resetModules()
    const fresh = await import('./proxy')

    expect(headersOf(fresh.proxy(request({ origin: 'https://portal.example.com' }))).origin).toBe(
      'https://portal.example.com',
    )
  })
})
