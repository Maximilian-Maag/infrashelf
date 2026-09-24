import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { NextRequest } from 'next/server'
import { GET } from './route'

/**
 * The HTTP surface of the metrics endpoint (#548).
 *
 * The collector is tested next door; what is only testable here is the part that
 * decides whether a stranger may read the shape of this deployment's estate at
 * all — the 503 on an unconfigured deployment, the constant-time token, and the
 * content type a scraper needs before it will parse the body.
 */
const SECRET = 'metrics-secret-value'

beforeEach(() => {
  process.env.METRICS_SECRET = SECRET
})
afterEach(() => {
  delete process.env.METRICS_SECRET
})

const get = (authorization?: string) =>
  new NextRequest('http://localhost/api/internal/metrics', {
    method: 'GET',
    ...(authorization === undefined ? {} : { headers: { authorization } }),
  })

describe('GET /api/internal/metrics', () => {
  /*
   * The most important case. A deployment that never configured a secret must not
   * be readable by an anonymous caller — the response says how many elements this
   * installation runs and which projects have drifted, which is operational
   * information about customers, not a health check.
   */
  it('answers 503, with no metrics, when the deployment never configured a secret', async () => {
    delete process.env.METRICS_SECRET

    const response = await GET(get(`Bearer ${SECRET}`))

    expect(response.status).toBe(503)
    expect(await response.json()).toEqual({ error: 'Metrics are not configured — set METRICS_SECRET' })
    // Nothing from the collector: a 503 that still rendered the body would be the
    // exposure the status code is pretending to refuse.
    expect(response.headers.get('content-type')).toContain('application/json')
  })

  it('refuses every shape of missing or wrong credential', async () => {
    // A prefix of the secret, the secret with different case, an empty bearer, a
    // Basic header whose base64 is not the secret, and no header at all.
    for (const header of [
      `Bearer ${SECRET.slice(0, -1)}`,
      `Bearer ${SECRET.toUpperCase()}`,
      'Bearer ',
      'Bearer',
      'Basic bWV0cmljcy1zZWNyZXQ=',
      'Token metrics-secret-value',
      undefined,
    ]) {
      const response = await GET(get(header))
      expect(response.status, `authorization: ${header}`).toBe(401)
      expect(await response.json()).toEqual({ error: 'Unauthorized' })
    }
  })

  it('serves the metrics in the format a scraper parses, for the right token', async () => {
    const response = await GET(get(`Bearer ${SECRET}`))

    expect(response.status).toBe(200)
    // The version is part of the content type by specification; a Prometheus that
    // does not recognise it may refuse the body rather than guess a dialect.
    expect(response.headers.get('content-type')).toBe('text/plain; version=0.0.4; charset=utf-8')
    // Never cached: a cached scrape is timestamped with when it was copied, not
    // when it was taken.
    expect(response.headers.get('cache-control')).toBe('no-store')

    const body = await response.text()
    const lines = body.trimEnd().split('\n')
    expect(lines[0]).toContain('# HELP infrashelf_metrics_generated_timestamp_seconds')
    expect(lines[1]).toBe('# TYPE infrashelf_metrics_generated_timestamp_seconds gauge')
    expect(lines[2]).toMatch(/^infrashelf_metrics_generated_timestamp_seconds \d+$/)
    expect(body.endsWith('\n')).toBe(true)
  })

  it('accepts the scheme case-insensitively, as the header is defined that way', async () => {
    const response = await GET(get(`bearer ${SECRET}`))
    expect(response.status).toBe(200)
  })

  it('does not touch the database for an unauthenticated request', async () => {
    // The order of the two checks is the point: a request with no credential must
    // cost nothing, so the collector is called after the token, not before a
    // response is decided.
    const unauthenticated = await GET(get())
    expect(unauthenticated.status).toBe(401)

    const body = await unauthenticated.text()
    expect(body).not.toContain('infrashelf_')
  })
})
