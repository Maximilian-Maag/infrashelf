import { describe, expect, it } from 'vitest'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import path from 'node:path'

/**
 * The reverse proxy has to know which /api paths are NOT the backend's.
 *
 * Both apps are Next.js and both serve routes under /api. The proxy splits them
 * by path, which means the split is a hand-maintained copy of a fact that lives
 * in the frontend's file tree — and #196 is what happens when the copy falls
 * behind: #36 added `/api/login-challenge` to the frontend, neither proxy config
 * learned about it, and every sign-in on the deployed instance got a 404 from
 * the backend. It carried the backend's CORS headers, which is how it was
 * finally attributed.
 *
 * So: derive the list from the frontend build, and fail if either config is
 * missing one. This is the gate that #196 did not have.
 *
 * It was also, until 2026-08-27, a gate over a file nobody deployed. The Docker
 * host kept a hand-made `nginx.conf` beside the `.example` this test reads, and
 * that copy predated `/api/proxy/` — the only route by which the browser reaches
 * the backend since #146. So this test was green while every dashboard action on
 * the deployed instance answered 404. The example is now a TEMPLATE that
 * docker-compose mounts directly, which is what makes this assertion worth
 * anything: the file it checks is the file that runs.
 *
 * Both configs are checked, because they are deployed independently and were
 * wrong in DIFFERENT ways — the Helm ingress sent all of /api to the backend
 * including NextAuth, while nginx.conf.template had already special-cased
 * /api/auth/ and only missed the two routes added after it was written.
 */

const REPO_ROOT = path.resolve(__dirname, '../../../..')
const API_DIR = path.join(REPO_ROOT, 'apps/frontend/src/app/api')
const INGRESS = path.join(REPO_ROOT, 'infra/helm/infrashelf/templates/ingress.yaml')
const NGINX = path.join(REPO_ROOT, 'infra/docker-host/nginx.conf.template')

/**
 * Every /api path the frontend actually serves, as the proxy sees it.
 *
 * A dynamic segment (`[...nextauth]`) is not a path the proxy can match, so the
 * route contributes its parent prefix instead: `/api/auth/[...nextauth]` is
 * `/api/auth`, which is what has to be routed.
 */
function frontendApiPaths(dir = API_DIR, prefix = '/api'): string[] {
  const found: string[] = []
  for (const entry of readdirSync(dir)) {
    const full = path.join(dir, entry)
    if (statSync(full).isDirectory()) {
      // A dynamic segment stops the walk: everything below it is served by the
      // same prefix, and the proxy cannot match on it anyway.
      if (entry.startsWith('[')) {
        found.push(prefix)
        continue
      }
      found.push(...frontendApiPaths(full, `${prefix}/${entry}`))
    } else if (entry === 'route.ts' || entry === 'route.tsx') {
      found.push(prefix)
    }
  }
  return [...new Set(found)]
}

/** Paths the Helm ingress sends to the FRONTEND service. */
function ingressFrontendPaths(): string[] {
  const src = readFileSync(INGRESS, 'utf8')
  const list = /range \$path := list ([^}]*)}}/.exec(src)
  if (!list) return []
  return [...list[1].matchAll(/"([^"]+)"/g)].map((m) => m[1])
}

/**
 * Entra ID's OAuth callback used to live here.
 *
 * It was the BACKEND's, and it sits inside the frontend's NextAuth prefix, so it
 * survived only as an exact match outranking `/api/auth`. #139 removed the flow:
 * nothing on the frontend ever consumed its result, and it handed the session
 * JWT back in a query string. The backend no longer serves the path, so a proxy
 * rule pointing at it now sends the browser to a 404 — and, worse, would be read
 * by the next person as evidence that SSO exists.
 *
 * Asserted as an absence rather than deleted, so re-adding the routing without
 * re-adding the route fails here instead of in production. #250 has to invert
 * this assertion back when SSO is built for real — it is the only check that
 * would notice the callback landing on the wrong service.
 */
const REMOVED_BACKEND_PATH = '/api/auth/callback'

/** Paths the Helm ingress sends to the BACKEND by an exact match. */
function ingressExactBackendPaths(): string[] {
  const src = readFileSync(INGRESS, 'utf8')
  const found: string[] = []
  // `- path: X` … `pathType: Exact` … `backend.fullname`
  for (const m of src.matchAll(/- path: (\S+)\n\s*pathType: Exact\n[\s\S]{0,200}?fullname" \$ \}\}/g)) {
    if (m[0].includes('backend.fullname')) found.push(m[1])
  }
  return found
}

/** Paths nginx.conf.template proxies to the backend by an exact match. */
function nginxExactBackendPaths(): string[] {
  const src = readFileSync(NGINX, 'utf8')
  const found: string[] = []
  for (const m of src.matchAll(/location\s+=\s+(\/\S*)\s*\{([\s\S]*?)\n {8}\}/g)) {
    if (m[2].includes('$backend_upstream')) found.push(m[1])
  }
  return found
}

/** Paths nginx.conf.template proxies to the frontend upstream. */
function nginxFrontendPaths(): string[] {
  const src = readFileSync(NGINX, 'utf8')
  const paths: string[] = []
  // `location [=] /some/path {` … `}` — keep the ones whose body goes to the
  // frontend. Non-greedy to the first closing brace at column 8, which is how
  // every block in this file is indented.
  for (const m of src.matchAll(/location\s+(=\s+)?(\/[^\s{]*)\s*\{([\s\S]*?)\n {8}\}/g)) {
    if (m[3].includes('$frontend_upstream')) paths.push(m[2].replace(/\/$/, '') || '/')
  }
  return paths
}

describe('the proxy configs know which /api routes are the frontend’s', () => {
  const served = frontendApiPaths()

  it('finds the frontend’s own /api routes', () => {
    // Guards the walk itself: a change that made this return nothing would make
    // every assertion below vacuously pass.
    expect(served).toContain('/api/login-challenge')
    expect(served).toContain('/api/auth')
    expect(served.length).toBeGreaterThanOrEqual(3)
  })

  it.each(frontendApiPaths())('the Helm ingress routes %s to the frontend', (p) => {
    expect(ingressFrontendPaths()).toContain(p)
  })

  it.each(frontendApiPaths())('nginx.conf.template proxies %s to the frontend', (p) => {
    // An exact-match block for the path itself, or a prefix block that covers
    // it — `/api/auth` is served as `location /api/auth/`.
    const covered = nginxFrontendPaths().some((f) => f === p || p.startsWith(`${f}/`))
    expect(covered).toBe(true)
  })

  it.each([
    ['the Helm ingress', ingressExactBackendPaths],
    ['nginx.conf.template', nginxExactBackendPaths],
  ])('%s no longer sends /api/auth/callback to the backend (#139)', (_name, exactBackendPaths) => {
    // The backend does not serve that path any more. A rule still pointing at it
    // is a 404 waiting for whoever reinstates the Entra app registration, and it
    // reads as evidence that SSO works — which is what #139 was about.
    expect(exactBackendPaths()).not.toContain(REMOVED_BACKEND_PATH)
  })

  it('the frontend’s middleware exempts exactly these paths from auth', () => {
    // Runs the real matcher rather than searching the source for a substring:
    // these paths appear in that file's comments too, so a `toContain` check
    // passes even if the matcher itself stops exempting them.
    const mw = readFileSync(path.join(REPO_ROOT, 'apps/frontend/src/middleware.ts'), 'utf8')
    const matcher = /matcher: \[[\s\S]*?'(\/\(\(\?![\s\S]*?)',/.exec(mw)
    if (!matcher) throw new Error('could not find the middleware matcher in middleware.ts')
    // The matcher is a string literal in source, so its escapes are doubled.
    const guard = new RegExp(`^${matcher[1].replace(/\\\\/g, '\\')}$`)

    // Exempt: the middleware must NOT claim these, or an unauthenticated caller
    // is redirected to /login and sign-in dies before it reaches the backend.
    for (const p of served) {
      expect(guard.test(p), `${p} is not exempt from the middleware`).toBe(false)
    }

    // Not exempt: a path the frontend does not serve must still be protected,
    // so the assertion above cannot pass by the matcher exempting everything.
    for (const p of ['/api/not-a-frontend-route', '/costs', '/admin/users']) {
      expect(guard.test(p), `${p} should be protected`).toBe(true)
    }
  })
})

/**
 * The gate above is only worth something if the file it reads is the file that
 * runs. It was not, for months.
 *
 * `nginx.conf.template` used to be `nginx.conf.example`, and each host kept a
 * hand-made copy beside it. The copy on hcp-dev predated the `/api/proxy/`
 * block, so every browser-initiated call — catalogue, cart, order, decommission,
 * write-off, project delete — got a 404 from the backend, while this suite was
 * green and the repository was correct.
 *
 * The copy is gone: docker-compose mounts the template and the nginx image
 * renders it. These assertions are what keeps it that way.
 */
describe('the deployed proxy config is the one this suite checks', () => {
  const compose = readFileSync(path.join(REPO_ROOT, 'infra/docker-host/docker-compose.yml'), 'utf8')

  it('mounts the template the tests above read', () => {
    expect(compose).toContain('./nginx.conf.template:/etc/nginx/templates/nginx.conf.template')
  })

  it('mounts no hand-copied nginx.conf beside it', () => {
    // `./nginx.conf:` — the old mount. Anchored on the `./` and the colon so the
    // template mount and the prose in the comments do not match it.
    expect(compose).not.toMatch(/\.\/nginx\.conf:/)
  })

  it('renders the template with SERVER_NAME and nothing else', () => {
    // Without the filter, envsubst also replaces $host, $scheme and the upstream
    // variables, and nginx cannot parse the result — a config that fails to
    // start is at least loud, but this is the line that keeps it from happening.
    expect(compose).toContain('NGINX_ENVSUBST_FILTER')
    expect(compose).toContain('NGINX_ENVSUBST_OUTPUT_DIR: /etc/nginx')
    expect(readFileSync(NGINX, 'utf8')).toContain('server_name ${SERVER_NAME}')
  })
})
