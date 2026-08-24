import { describe, it, expect } from 'vitest'
import { existsSync, readFileSync } from 'fs'
import { createRequire } from 'module'
import { dirname, join } from 'path'
import { NextRequest } from 'next/server'
import { GET } from './route'
import { createUser, makeAuthHeader } from '@/test/helpers'

const makeReq = (auth?: string) =>
  new NextRequest('http://localhost/api/docs', {
    headers: auth ? { authorization: auth } : {},
  })

const authenticatedPage = async () => {
  const pm = await createUser({ role: 'project_manager' })
  const res = await GET(makeReq(await makeAuthHeader(pm)))
  expect(res.status).toBe(200)
  return { res, html: await res.text() }
}

/** Every `src="…"` and `href="…"` in the document. */
const assetRefs = (html: string) =>
  [...html.matchAll(/(?:src|href)="([^"]+)"/g)].map((m) => m[1])

describe('GET /api/docs', () => {
  it('returns 401 without auth', async () => {
    const res = await GET(makeReq())
    expect(res.status).toBe(401)
  })

  it('returns Swagger UI for any authenticated user', async () => {
    const { html } = await authenticatedPage()
    expect(html).toContain('swagger-ui')
  })

  // Issue #146. This page is behind requireAuth, so a script it loads runs as the
  // signed-in user against this API. It used to pull three files from unpkg.com
  // at a floating `@5` with no integrity hash — a CDN compromise, or a hostile
  // publish of any 5.x, was a full API takeover of every reader.
  it('loads every asset from this origin', async () => {
    const { html } = await authenticatedPage()
    const refs = assetRefs(html)

    expect(refs.length).toBeGreaterThan(0)
    for (const ref of refs) {
      expect(ref.startsWith('/')).toBe(true)
    }
  })

  // Same-origin paths are only an improvement if the files are there, and a
  // committed copy is only trustworthy if it is the release the lockfile pins.
  // Bumping swagger-ui-dist without re-running the vendoring script fails here.
  it('serves the byte-for-byte contents of the pinned swagger-ui-dist release', async () => {
    const { html } = await authenticatedPage()
    const vendored = assetRefs(html).filter((ref) => ref.startsWith('/swagger-ui/'))
    expect(vendored.length).toBe(2)

    const distDir = dirname(createRequire(import.meta.url).resolve('swagger-ui-dist/package.json'))
    for (const ref of vendored) {
      const committed = new URL(`../../../../public${ref}`, import.meta.url)
      expect(existsSync(committed)).toBe(true)
      expect(readFileSync(committed).equals(readFileSync(join(distDir, ref.slice('/swagger-ui/'.length))))).toBe(true)
    }
  })

  // `persistAuthorization` wrote the bearer token the reader pasted into the
  // Authorize box to localStorage, where any script on this origin could read it
  // back long after the tab was closed.
  it('does not persist the reader’s bearer token to localStorage', async () => {
    const { html } = await authenticatedPage()
    expect(html).not.toContain('persistAuthorization')
  })

  it('sends a CSP that pins scripts to this origin and a per-request nonce', async () => {
    const { res, html } = await authenticatedPage()
    const policy = res.headers.get('content-security-policy') ?? ''

    expect(policy).toContain("default-src 'self'")
    expect(policy).not.toMatch(/https?:/)
    expect(policy).not.toContain("script-src 'self' 'unsafe-inline'")

    // The inline initialiser is allowed by its nonce, not by 'unsafe-inline' —
    // otherwise the header would permit an injected inline script too.
    const nonce = policy.match(/'nonce-([^']+)'/)?.[1]
    expect(nonce).toBeTruthy()
    expect(html).toContain(`nonce="${nonce}"`)

    const second = await authenticatedPage()
    const secondNonce = (second.res.headers.get('content-security-policy') ?? '').match(/'nonce-([^']+)'/)?.[1]
    expect(secondNonce).not.toBe(nonce)
  })
})
