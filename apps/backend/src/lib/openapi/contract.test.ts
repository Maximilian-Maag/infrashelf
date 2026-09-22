import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { getTableColumns } from 'drizzle-orm'
import { describe, expect, it } from 'vitest'
import { exchangeRates } from '@/lib/db/schema'
import '@/lib/openapi/paths'
import { generateOpenApiDocument } from '@/lib/openapi/registry'

/**
 * The spec at `/api/docs` is hand-written next to the routes, and until now
 * nothing checked the two against each other: `POST /approvals/{id}/approve`
 * accepted two override flags and could answer a 409 for a release, and the spec
 * described neither (#529).
 *
 * What this checks: for every documented operation whose route declares the shape
 * of its request body, every key of that declaration appears in the spec's body.
 *
 * Why the body half is derived rather than declared: the routes state their body.
 * A zod schema (`RejectSchema`, `CheckoutSchema`) or an inline `as { … }` after
 * `req.json()` is the contract the handler enforces, and reading it out of the
 * source means the check cannot drift into agreeing with a stale list. It is also
 * why a route that reads its body without declaring a shape is skipped: the cart's
 * pass-through endpoints accept whatever the caller sends, and the spec has no
 * business demanding the keys of a body nobody enumerates.
 *
 * What this does NOT check, deliberately: statuses and response shapes. Those are
 * decided in the services (`err(409, …, 'policy_denied')` lives in
 * `commitGates.ts`, five imports away from the route), so deriving them would mean
 * walking the import graph and demanding, on every endpoint that shares a service,
 * the statuses of the others. The four refusals that matter — the two waivers on
 * `POST /orders` and on the approve endpoint — are therefore covered by the second
 * describe block, which is a declaration and catches only the spec losing
 * something it once had.
 */

type Operation = { method: string; path: string; operation: Record<string, unknown> }

/** `/admin/products/{id}` → `src/app/api/admin/products/[id]/route.ts`. */
const routePathOf = (specPath: string): string => {
  const segments = specPath
    .split('/')
    .filter((s) => s !== '')
    .map((s) => s.replace(/^\{(\w+)\}$/, '[$1]'))

  return join(process.cwd(), 'src/app/api', ...segments, 'route.ts')
}

/**
 * The request-body keys the handler parses, or null when it declares none.
 *
 * Two shapes, both of which the codebase uses. A zod schema is declared at module
 * scope and parsed inside the handler:
 *
 *   const CheckoutSchema = z.object({ projectId: z.number(), … })
 *   const parsed = CheckoutSchema.safeParse(await req.json())
 *
 * and a body read without a schema is aliased where it is read:
 *
 *   const body = ((await req.json().catch(() => null)) ?? {}) as { overridePolicy?: unknown }
 *
 * Top level only: a nested key belongs to the spec's nested schema, and this check
 * is about the body a caller sends, not the shape of each field in it.
 */
const declaredBodyKeys = (source: string, handler: string): string[] | null => {
  const keys = new Set<string>()

  // Schemas this file declares, by name, so the handler can be matched to the one
  // it parses — and a file with a schema for another method does not lend it here.
  const schemas = new Map<string, string[]>()
  for (const m of source.matchAll(/const\s+(\w+)\s*=\s*z\.object\(\{([\s\S]*?)\n\}\)/g)) {
    // Top-level keys only: indented at most four spaces, i.e. not inside a nested object.
    schemas.set(
      m[1],
      [...m[2].matchAll(/^ {0,4}(\w+):/gm)].map((k) => k[1]),
    )
  }

  for (const m of handler.matchAll(/(\w+)\.(?:safe)?[Pp]arse\(/g)) {
    for (const key of schemas.get(m[1]) ?? []) keys.add(key)
  }

  // Inline alias after the request body is parsed. The alias closes on its own
  // line or not (`as { order?: unknown } | null`), so it stops at the first brace
  // either way — anything looser reaches into the next object literal in the file
  // and reports its keys as body fields.
  for (const m of handler.matchAll(/req\.json\(\)[\s\S]{0,160}?as\s*\{([^}]*)\}/g)) {
    for (const k of m[1].matchAll(/(\w+)\??\s*:/g)) keys.add(k[1])
  }

  return keys.size ? [...keys].sort() : null
}

const document = generateOpenApiDocument()

const operations: Operation[] = Object.entries(document.paths).flatMap(([path, methods]) =>
  Object.entries(methods as Record<string, Record<string, unknown>>)
    .filter(([method]) => ['get', 'post', 'put', 'patch', 'delete'].includes(method))
    .map(([method, operation]) => ({ method, path, operation })),
)

describe('the OpenAPI spec agrees with the routes about request bodies', () => {
  it('covers every operation it registers', () => {
    // The table below is only as good as this list: a path the spec does not
    // register is a path this test never looks at. 37 routes have no entry at
    // all — `/orders/{id}/deploy-now` among them — which is #534's problem, not
    // this file's; what matters here is that nothing silently disappears.
    expect(operations.length).toBeGreaterThan(100)
  })

  it('documents every key of every request body a route declares', () => {
    const failures: string[] = []
    let checked = 0

    for (const { method, path, operation } of operations) {
      let source: string
      try {
        source = readFileSync(routePathOf(path), 'utf8')
      } catch {
        // Documented but not implemented here (or a differently-shaped path):
        // the spec's own test covers those.
        continue
      }

      // The handler for THIS method, so a file with several does not lend its
      // body to its neighbours.
      const handler = source.split(new RegExp(`export async function ${method.toUpperCase()}\\b`))[1]
      if (!handler) continue

      const declared = declaredBodyKeys(source, handler.split(/export async function /)[0])
      if (!declared) continue

      checked += 1
      // The request body as the document renders it, not the object the registry
      // was handed: `parameters`/`requestBody` is the generated shape a client reads.
      const documented = JSON.stringify(operation.requestBody ?? {})
      const missing = declared.filter((key) => !documented.includes(`"${key}"`))
      if (missing.length) failures.push(`${method.toUpperCase()} ${path}: ${missing.join(', ')}`)
    }

    // A guard on the guard: if the extraction stops matching (a refactor, a new
    // parsing style), the test would pass by checking nothing at all.
    expect(checked).toBeGreaterThanOrEqual(20)
    expect(failures).toEqual([])
  })
})

/**
 * Declared, for the endpoints that commit money and infrastructure.
 *
 * These are the two the issue is about, and the keys and statuses below are what
 * the routes and their services actually do — read them from the source when
 * changing one, and change this table too. It fails only in the direction that
 * matters: the spec losing something a caller depends on.
 */
const REFUSALS: Array<{ method: string; path: string; body: string[]; statuses: string[] }> = [
  {
    method: 'post',
    path: '/orders',
    body: ['overrideBudget', 'overridePolicy'],
    statuses: ['201', '400', '401', '409'],
  },
  {
    method: 'post',
    path: '/approvals/{id}/approve',
    body: ['overrideBudget', 'overridePolicy'],
    statuses: ['200', '400', '401', '403', '404', '409'],
  },
]

describe('the OpenAPI spec covers the routes', () => {
  /**
   * Deliberately undocumented, and named here so the exclusion is a decision
   * rather than an omission.
   *
   * These are called by the scheduler and by pipelines, not by clients: they
   * authenticate with an internal token rather than a session, and their bodies
   * are machine-written reports (a drift report, a sweep result). Publishing them
   * in a contract meant for clients would document an interface nobody should
   * call, and the spec has one security scheme — `BearerAuth`, a session JWT —
   * that would be wrong for them. `GET /internal/drift-targets`,
   * `POST /internal/drift-report`, `POST /internal/holiday-refresh` and
   * `POST /internal/deployment-window-sweep` are the whole set; a new one has to
   * be added here on purpose.
   */
  const INTERNAL = ['/internal/']

  const routeFilesOf = (dir: string): string[] => {
    const found: string[] = []
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name)
      if (entry.isDirectory()) found.push(...routeFilesOf(full))
      else if (entry.name === 'route.ts') found.push(full)
    }
    return found
  }

  it('has an entry for every handler in the app', () => {
    const documented = new Set(
      Object.entries(document.paths).flatMap(([path, methods]) =>
        Object.keys(methods as Record<string, unknown>)
          .filter((method) => ['get', 'post', 'put', 'patch', 'delete'].includes(method))
          .map((method) => `${method} ${path}`),
      ),
    )

    const undocumented: string[] = []
    for (const file of routeFilesOf(join(process.cwd(), 'src/app/api'))) {
      const segments = file
        .slice(join(process.cwd(), 'src/app/api').length + 1)
        .split('/')
        .slice(0, -1)
        // Route groups are not part of the URL.
        .filter((s) => !(s.startsWith('(') && s.endsWith(')')))
        .map((s) => s.replace(/^\[(?:\.\.\.)?(\w+)\]$/, '{$1}'))
      const path = `/${segments.join('/')}`

      for (const [, method] of readFileSync(file, 'utf8').matchAll(
        /export async function (GET|POST|PUT|PATCH|DELETE)/g,
      )) {
        const operation = `${method.toLowerCase()} ${path}`
        if (documented.has(operation)) continue
        if (INTERNAL.some((prefix) => path.startsWith(prefix))) continue
        undocumented.push(operation)
      }
    }

    expect(undocumented).toEqual([])
  })
})

describe('the spec documents the waivers and the refusals', () => {
  it.each(REFUSALS)('$method $path', ({ method, path, body, statuses }) => {
    const operation = (document.paths[path] as Record<string, unknown>)[method] as {
      requestBody?: unknown
      responses: Record<string, unknown>
    }

    const request = JSON.stringify(operation.requestBody ?? {})
    for (const key of body) expect(request, `request body documents ${key}`).toContain(key)

    for (const status of statuses) {
      expect(Object.keys(operation.responses), `documents ${status}`).toContain(status)
    }

    // The refusal a client has to be able to tell apart, and the two answers it
    // can be given: this is what a UI switches on to offer the matching waiver.
    const refused = JSON.stringify(operation.responses['409'])
    expect(refused).toContain('budget_blocked')
    expect(refused).toContain('policy_denied')
  })
})

/**
 * The half of the contract a client reads to know what it will RECEIVE, which is
 * the half nothing checked: the exchange-rate row was documented as
 * `{ id, currencyCode, rateToEur, updatedAt }` while the service returns the row
 * as stored — `{ currencyCode, rate, updatedAt }` (#537). `id` and `rateToEur` are
 * both invented, and the spec said nothing about `rate` being a string that must
 * not be parsed into a float, on a field that is money.
 *
 * Bound to the table rather than to a second list: these three operations select
 * from `exchange_rates` and return the rows unchanged, so the table's columns ARE
 * the response — a column renamed in the database then fails this test instead of
 * silently leaving the contract lying about it.
 *
 * Narrow on purpose: most other row schemas back services that select and rename
 * their fields deliberately, where demanding a table's columns would be wrong.
 */
describe('the exchange-rate schema names the columns the endpoint returns (#537)', () => {
  const columns = Object.keys(getTableColumns(exchangeRates)).sort()

  const documentedColumns = (method: string, path: string): string[] => {
    const operation = (document.paths[path] as Record<string, Record<string, unknown>>)[method]
    const responses = operation.responses as Record<
      string,
      { content: Record<string, { schema: { items?: { properties?: object }; properties?: object } }> }
    >
    const schema = responses['200'].content['application/json'].schema

    return Object.keys(schema.items?.properties ?? schema.properties ?? {}).sort()
  }

  it.each([
    ['get', '/admin/exchange-rates'],
    ['post', '/admin/exchange-rates/refresh'],
    ['get', '/public/exchange-rates'],
  ])('%s %s documents exactly the columns of exchange_rates', (method, path) => {
    expect(documentedColumns(method, path)).toEqual(columns)
  })
})