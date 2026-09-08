import { describe, expect, it, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import path from 'node:path'

/**
 * The PWA's own files cannot sit behind the session (#374).
 *
 * Every one of them was, until the middleware matcher named them. It went
 * unnoticed for as long as it did because none of the three failures looks like
 * an auth problem from the outside: an install prompt that never offers, a
 * service worker that is simply absent, and an offline page that turns out to be
 * a login form. `curl` shows all three at once — a 307 to /login — and nothing
 * else does.
 *
 * The paths are DERIVED here rather than listed. A list would be a second copy
 * of the same fact, and the copy is what goes stale: the next icon added to the
 * manifest would be redirected exactly like these were, and a test carrying its
 * own list would still be green. So the manifest, the worker and the
 * registration are read for the URLs they actually use, and each one is required
 * to be reachable.
 */

// `auth()` wraps the handler and is irrelevant to the matcher; importing the
// real one drags NextAuth's whole server config into a unit test.
vi.mock('@/lib/auth', () => ({ auth: (handler: unknown) => handler }))

const SRC = path.resolve(__dirname)
const read = (p: string) => readFileSync(path.join(SRC, p), 'utf8')

/** Where `registerServiceWorker` points the browser. */
function serviceWorkerUrl(): string {
  const m = /const SW_URL = '([^']+)'/.exec(read('lib/serviceWorker.ts'))
  if (!m) throw new Error('SW_URL not found in lib/serviceWorker.ts')
  return m[1]
}

/** The page the worker precaches and serves when the network is gone. */
function offlineUrl(): string {
  const m = /const OFFLINE_URL = '([^']+)'/.exec(
    readFileSync(path.resolve(SRC, '../public/sw.js'), 'utf8'),
  )
  if (!m) throw new Error('OFFLINE_URL not found in public/sw.js')
  return m[1]
}

/** Every `src` the generated manifest hands to the browser. */
function manifestIconUrls(): string[] {
  const src = read('app/manifest.ts')
  const urls = [...src.matchAll(/src: '([^']+)'/g)].map((m) => m[1])
  if (urls.length === 0) throw new Error('no icon srcs found in app/manifest.ts')
  return urls
}

/**
 * Next serves `app/manifest.ts` at this path, and the `<link rel="manifest">`
 * in the root layout's metadata is generated to point at it.
 */
const MANIFEST_URL = '/manifest.webmanifest'

describe('middleware matcher', () => {
  const matches = async (pathname: string): Promise<boolean> => {
    const { config } = await import('./middleware')
    return config.matcher.some((pattern: string) => new RegExp(`^${pattern}$`).test(pathname))
  }

  it('serves the manifest without a session', async () => {
    // Fetched with credentials OMITTED per spec unless the link says otherwise,
    // and Next's generated one does not — so a redirect here is unrecoverable
    // for every visitor, signed in or not.
    expect(await matches(MANIFEST_URL)).toBe(false)
  })

  it('serves the service worker script without a session', async () => {
    // A worker script behind a redirect is refused outright, and registration
    // runs from the root layout — which renders on /login, where nobody has a
    // session yet.
    expect(await matches(serviceWorkerUrl())).toBe(false)
  })

  it('serves the offline page without a session', async () => {
    expect(await matches(offlineUrl())).toBe(false)
  })

  it.each(manifestIconUrls())('serves the manifest icon %s without a session', async (url) => {
    expect(await matches(url)).toBe(false)
  })

  /*
   * The other half of the assertion, and the half that makes the rest mean
   * something: a matcher broken open — `[]`, or a lookahead that swallowed
   * everything — would pass every test above. These are the paths that MUST
   * still reach the middleware.
   */
  it.each(['/', '/orders', '/settings', '/admin', '/catalog', '/orders/42'])(
    'still protects %s',
    async (pathname) => {
      expect(await matches(pathname)).toBe(true)
    },
  )

  it('still exempts the routes that signing in depends on', async () => {
    // Regression cover for #36 and #146, which the same matcher owns.
    for (const pathname of ['/login', '/api/auth/session', '/api/login-challenge', '/api/proxy/cart']) {
      expect(await matches(pathname), pathname).toBe(false)
    }
  })
})
