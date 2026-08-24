import { readFileSync } from 'node:fs'
import { request, type APIRequestContext, type APIResponse } from '@playwright/test'
import { rootEmail, rootPassword } from './helpers'

/**
 * The backend, talked to directly.
 *
 * Why a spec would want this at all: a browser-driven test can only build a
 * fixture out of the screens that happen to offer one, and can only remove it
 * again if some screen offers a Delete. That is how issue #156 happened — the
 * environments spec creates a CI source and an environment through the admin UI,
 * the callback-secret test has no path back out, and every run left two more
 * global rows behind for the next run's list assertions to trip over.
 *
 * So setup and teardown go through the API and the *behaviour under test* goes
 * through the browser. The API is not a shortcut around the thing being tested;
 * it is the way a test can promise the database looks the same afterwards.
 */

const fromEnvFile = (file: string, key: string): string | undefined => {
  try {
    return readFileSync(file, 'utf-8').match(new RegExp(`^${key}=(.+)$`, 'm'))?.[1]?.trim()
  } catch {
    return undefined
  }
}

/**
 * Where the backend is.
 *
 * CI sets E2E_API_URL explicitly. Locally it is whatever the frontend is pointed
 * at, which is the only value that can be right — the token minted here has to be
 * accepted by the same server the browser session talks to.
 */
export const apiBaseURL =
  process.env.E2E_API_URL ??
  process.env.NEXT_PUBLIC_API_URL ??
  fromEnvFile('./apps/frontend/.env', 'API_URL') ??
  'http://localhost:3001'

/** The stub GitLab (infra/wiremock). Absent locally unless the dev compose file is up. */
export const wiremockURL = process.env.E2E_WIREMOCK_URL ?? 'http://localhost:8080'

/** Throw with the server's own words rather than a bare status number. */
export const expectOk = async (res: APIResponse, what: string): Promise<APIResponse> => {
  if (res.ok()) return res
  throw new Error(`${what} failed: ${res.status()} ${res.statusText()} — ${await res.text()}`)
}

const contextFor = async (token: string): Promise<APIRequestContext> =>
  request.newContext({
    baseURL: apiBaseURL,
    extraHTTPHeaders: { Authorization: `Bearer ${token}` },
  })

const tokenFor = async (email: string, password: string): Promise<string> => {
  const anon = await request.newContext({ baseURL: apiBaseURL })
  try {
    const res = await expectOk(
      await anon.post('/api/auth/login', { data: { email, password } }),
      `API login as ${email}`,
    )
    const body = (await res.json()) as { token?: string; mfaRequired?: boolean }
    if (!body.token) {
      throw new Error(
        `API login as ${email} returned no token` +
          (body.mfaRequired ? ' — the account has a second factor enabled' : ''),
      )
    }
    return body.token
  } finally {
    await anon.dispose()
  }
}

/**
 * Cached per worker, deliberately.
 *
 * `POST /api/auth/login` is rate limited to 10 attempts per account per 15
 * minutes, and it opens a `sessions` row each time. One token per account per
 * worker keeps both facts harmless; a login per test would eventually spend the
 * budget and start failing tests for a reason that has nothing to do with what
 * they assert — and the 429 would arrive mid-suite, so it would read as a flake.
 */
const tokens = new Map<string, Promise<string>>()
const cachedToken = (email: string, password: string): Promise<string> => {
  const existing = tokens.get(email)
  if (existing) return existing
  const minted = tokenFor(email, password)
  tokens.set(email, minted)
  return minted
}

export const rootApiToken = (): Promise<string> => cachedToken(rootEmail, rootPassword)

/** A root-authenticated request context. Callers dispose it. */
export const apiAsRoot = async (): Promise<APIRequestContext> => contextFor(await rootApiToken())

/** A request context for any other account — used for the roles a fixture needs. */
export const apiAs = async (email: string, password: string): Promise<APIRequestContext> =>
  contextFor(await cachedToken(email, password))

export interface FixtureUser {
  id: number
  email: string
  password: string
  /** The display name the portal shows for this account. */
  name: string
}

/**
 * A user of the given role, created if it is not there already.
 *
 * Stable email rather than `${Date.now()}@example.com`: a fixture named after the
 * clock is a new row on every run, and nothing ever deletes the old ones (#156).
 * The same address every time means the second run reuses the first run's user.
 *
 * `.invalid` is reserved by RFC 2606, so these can never collide with a real
 * address or accidentally receive mail from the SMTP configuration.
 */
export const ensureUser = async (
  api: APIRequestContext,
  role: 'project_manager' | 'admin',
  handle: string,
): Promise<FixtureUser> => {
  const email = `e2e-${handle}@e2e.invalid`
  const password = 'E2eFixture123!'
  const name = `E2E ${handle}`

  const existing = (await (
    await expectOk(await api.get('/api/admin/users'), 'list users')
  ).json()) as { id: number; email: string; role: string }[]

  const found = existing.find((u) => u.email === email)
  if (found) {
    // The role is part of what the caller asked for, so a user left over from a
    // spec that wanted a different one must not be handed back as-is.
    if (found.role !== role) {
      await expectOk(await api.put(`/api/admin/users/${found.id}`, { data: { role } }), 'set role')
    }
    // Reset the password too: this user survives across runs, and a spec that
    // changed it would otherwise break every later run's login.
    await expectOk(
      await api.put(`/api/admin/users/${found.id}`, { data: { password, active: true } }),
      'reset fixture password',
    )
    return { id: found.id, email, password, name }
  }

  const created = (await (
    await expectOk(
      await api.post('/api/admin/users', { data: { email, name, password, role } }),
      'create fixture user',
    )
  ).json()) as { id: number }

  return { id: created.id, email, password, name }
}

export interface Offering {
  productId: number
  environmentId: number
  productName: string
}

/**
 * A seeded product that can be ordered by filling in nothing.
 *
 * The demo catalogue gives its first product two required parameters (one of them
 * sensitive, so the export and detail-page redaction have something to redact) and
 * the other two none. A spec that only needs "an order exists" wants one of the
 * latter, and wants to say so rather than hard-coding "the third product" — which
 * is the kind of positional assumption that turns a catalogue edit into a puzzle.
 */
export const plainOffering = async (api: APIRequestContext): Promise<Offering> => {
  const page = (await (
    await expectOk(await api.get('/api/catalog?limit=50'), 'list the catalogue')
  ).json()) as { items: { id: number; name: string }[] }

  for (const product of page.items) {
    const detail = (await (
      await expectOk(await api.get(`/api/catalog/${product.id}`), `read product ${product.id}`)
    ).json()) as {
      environments: { environmentId: number }[]
      parameters: { required?: boolean }[]
    }
    if (detail.environments.length === 0) continue
    if (detail.parameters.some((p) => p.required)) continue
    return {
      productId: product.id,
      environmentId: detail.environments[0].environmentId,
      productName: product.name,
    }
  }

  throw new Error(
    'No seeded product is offered in an environment with no required parameters. ' +
      'The demo catalogue (apps/backend/src/lib/bootstrap/demo.ts) is supposed to ' +
      'provide two; check that the database was seeded — see e2e/global-setup.ts.',
  )
}

/** Delete quietly — teardown must not turn a passing test red over a 404. */
export const tryDelete = async (api: APIRequestContext, path: string): Promise<void> => {
  try {
    await api.delete(path)
  } catch {
    /* the point of teardown is that it never decides the verdict */
  }
}
