import { test, expect } from './fixtures'
import type { APIRequestContext } from '@playwright/test'
import { loginAsRoot, requireSeeded } from './helpers'

/**
 * The order-time policy gate, end to end (#110).
 *
 * Nothing here is mocked. A root session creates a real OPA integration through
 * the portal's own admin route, pointing at the WireMock in
 * `infra/wiremock/mappings`; the order really goes out over HTTP to it; the
 * decision really comes back; and the assertion is on the sentence the requester
 * gets. The unit tests prove the client's contract and the integration tests
 * prove the wiring, and neither of them can see the one thing this file exists
 * for: that an engine at the end of a URL changes what happens to an order.
 *
 * The engine URL is `WIREMOCK_URL` because it has to be reachable by the BACKEND,
 * not by this process — in CI both are loopback, the same assumption the demo
 * seed makes when it points the catalogue at `http://localhost:8080`. The portal
 * refuses plaintext http with a stored credential, and these integrations carry
 * none.
 *
 * Every test registers its own refusal for ONE project id and removes it again,
 * so a policy refusal can never leak into another spec's orders in the same
 * shard. The stub's default answer for everything else is `allow`.
 */

const WIREMOCK = process.env.WIREMOCK_URL?.trim() || 'http://localhost:8080'
const DECISION_PATH = '/v1/data/infrashelf/order/decision'

/** The rule and sentence the deny mapping answers with, asserted as written. */
const RULE = 'e2e/project-quota'
const MESSAGE = 'This project has reached the limit the e2e policy sets'

interface Offering {
  productId: number
  environmentId: number
  sizeCode: string | null
}

/**
 * Every (product, environment) the catalogue offers, and how to answer its
 * parameters.
 *
 * The same three helpers as `role-journeys.spec.ts`, which is the only other spec
 * that places orders. They are candidates for `e2e/helpers.ts` when a third spec
 * needs them; two callers with a documented shape is not yet worth moving them.
 */
async function offeringsFor(request: APIRequestContext): Promise<Offering[]> {
  const listRes = await request.get('/api/proxy/api/catalog?lang=en&limit=25')
  if (!listRes.ok()) return []
  const { items = [] } = (await listRes.json()) as { items?: { id: number }[] }

  const offerings: Offering[] = []
  for (const item of items) {
    const detailRes = await request.get(`/api/proxy/api/catalog/${item.id}?lang=en`)
    if (!detailRes.ok()) continue
    const detail = (await detailRes.json()) as {
      environments?: { environmentId: number; sizes?: { code: string }[] }[]
    }
    for (const env of detail.environments ?? []) {
      offerings.push({
        productId: item.id,
        environmentId: env.environmentId,
        sizeCode: env.sizes?.[0]?.code ?? null,
      })
    }
  }
  return offerings
}

interface ParameterDef {
  name: string
  type: string
  required: boolean
  defaultValue: string
}

/** The parameter definitions the order service will validate against. */
async function parametersFor(request: APIRequestContext, offering: Offering): Promise<ParameterDef[]> {
  const res = await request.get(
    `/api/proxy/api/catalog/${offering.productId}?lang=en&environmentId=${offering.environmentId}`,
  )
  if (!res.ok()) return []
  return ((await res.json()) as { parameters?: ParameterDef[] }).parameters ?? []
}

/** Fill in whatever the offering asks for, plausibly enough to pass validation. */
const answerParameters = (defs: ParameterDef[]): Record<string, string> => {
  const values: Record<string, string> = {}
  for (const def of defs) {
    if (!def.required || def.type === 'size') continue
    if (def.defaultValue && def.type !== 'dropdown') {
      values[def.name] = def.defaultValue
      continue
    }
    switch (def.type) {
      case 'dropdown':
        values[def.name] = def.defaultValue.split(',').map((v) => v.trim()).filter(Boolean)[0] ?? ''
        break
      case 'number':
        values[def.name] = '1'
        break
      case 'bool':
        values[def.name] = 'false'
        break
      default:
        values[def.name] = `e2e-policy-${Date.now().toString(36)}`.slice(0, 40)
    }
  }
  return values
}

/** A project of this test's own, so the refusal below can name only its orders. */
async function ownProject(request: APIRequestContext): Promise<number> {
  const res = await request.post('/api/proxy/api/projects', {
    data: { name: `E2E policy ${Date.now()}`, description: 'order-policy.spec.ts' },
  })
  expect(res.ok(), `could not create a project: ${res.status()}`).toBe(true)
  return ((await res.json()) as { id: number }).id
}

/**
 * Register a refusal for exactly this project, and hand back the mapping id.
 *
 * Priority 1 beats the permissive stub shipped in `infra/wiremock/mappings`, so
 * this test's orders are refused while everybody else's are allowed — the reason
 * the mapping is keyed on the project at all.
 */
async function refuseProject(request: APIRequestContext, projectId: number): Promise<string> {
  const res = await request.post(`${WIREMOCK}/__admin/mappings`, {
    data: {
      priority: 1,
      request: {
        method: 'POST',
        urlPath: DECISION_PATH,
        bodyPatterns: [{ matchesJsonPath: { expression: '$.input.projectId', equalTo: String(projectId) } }],
      },
      response: {
        status: 200,
        jsonBody: { result: { decision: 'deny', rule: RULE, message: MESSAGE } },
        headers: { 'Content-Type': 'application/json' },
      },
    },
  })
  const body = await res.text()
  expect(res.ok(), `WireMock refused the mapping: ${res.status()} ${body}`).toBe(true)
  return (JSON.parse(body) as { id: string }).id
}

/**
 * The portal's own OPA integration, created as root through the admin route the
 * UI uses. `failureMode` is the operator's decision (#111) and part of what is
 * under test, so it is never defaulted here.
 */
async function configureEngine(
  request: APIRequestContext,
  over: { baseUrl?: string; failureMode?: 'blocking' | 'best_effort' } = {},
): Promise<number> {
  const res = await request.post('/api/proxy/api/admin/integrations', {
    data: {
      kind: 'opa',
      name: 'E2E policy engine',
      baseUrl: over.baseUrl ?? WIREMOCK,
      authType: 'none',
      failureMode: over.failureMode ?? 'blocking',
    },
  })
  expect(res.ok(), `could not create the OPA integration: ${res.status()} ${await res.text()}`).toBe(true)
  return ((await res.json()) as { id: number }).id
}

/** Remove this test's traces: the engine first, then the refusal it answered with. */
async function cleanUp(
  request: APIRequestContext,
  integrationId: number | null,
  mappingId: string | null,
): Promise<void> {
  if (integrationId !== null) {
    await request.delete(`/api/proxy/api/admin/integrations/${integrationId}`, { failOnStatusCode: false })
  }
  if (mappingId !== null) {
    await request.delete(`${WIREMOCK}/__admin/mappings/${mappingId}`, { failOnStatusCode: false })
  }
}

/** Place an order for this offering and project, returning the response. */
async function placeOrder(
  request: APIRequestContext,
  offering: Offering,
  projectId: number,
  over?: Record<string, unknown>,
) {
  const parameters = answerParameters(await parametersFor(request, offering))
  return request.post('/api/proxy/api/orders', {
    failOnStatusCode: false,
    data: {
      projectId,
      productId: offering.productId,
      environmentId: offering.environmentId,
      ...(offering.sizeCode !== null ? { sizeCode: offering.sizeCode } : {}),
      parameters,
      ...(over ?? {}),
    },
  })
}

test.describe('Policy as code (OPA)', () => {
  test('refuses an order the configured engine denies, and names the rule', async ({ page }) => {
    await loginAsRoot(page)
    const { request } = page

    const offerings = await offeringsFor(request)
    requireSeeded(offerings.length > 0, 'the catalogue offers no (product, environment) to order')

    const project = await ownProject(request)
    const mapping = await refuseProject(request, project)
    let integration: number | null = null

    try {
      integration = await configureEngine(request)

      const res = await placeOrder(request, offerings[0], project)
      // Read once: a Playwright response body is buffered, but asserting on a
      // string that consumed it would make the failure message the reason the
      // next line throws.
      const bodyText = await res.text()
      expect(res.status(), `the order was not refused: ${bodyText}`).toBe(409)

      const { error } = JSON.parse(bodyText) as { error: string }
      // The rule and the policy's own sentence, not a generic denial: a refusal a
      // requester cannot act on is the thing #110 asks to avoid.
      expect(error).toContain(RULE)
      expect(error).toContain(MESSAGE)
    } finally {
      await cleanUp(request, integration, mapping)
    }
  })

  test('lets root waive it, and the same order is no longer refused by policy', async ({ page }) => {
    await loginAsRoot(page)
    const { request } = page

    const offerings = await offeringsFor(request)
    requireSeeded(offerings.length > 0, 'the catalogue offers no (product, environment) to order')

    const project = await ownProject(request)
    const mapping = await refuseProject(request, project)
    let integration: number | null = null

    try {
      integration = await configureEngine(request)

      const waived = await placeOrder(request, offerings[0], project, { overridePolicy: true })
      if (waived.status() !== 201) {
        // Without a pipeline stack the order is still refused — for want of
        // something to provision with, which is the ordinary refusal and not this
        // one. What must NOT happen is the policy refusal arriving for root.
        const { error } = (await waived.json()) as { error?: string }
        expect(error ?? '', 'root was still refused by the policy it waived').not.toContain(RULE)
      }
    } finally {
      await cleanUp(request, integration, mapping)
    }
  })

  test('refuses under a blocking engine that cannot be answered, and says so', async ({ page }) => {
    await loginAsRoot(page)
    const { request } = page

    const offerings = await offeringsFor(request)
    requireSeeded(offerings.length > 0, 'the catalogue offers no (product, environment) to order')

    const project = await ownProject(request)
    // Port 9 (discard) is closed: the call fails rather than being answered, which
    // is the outage the failure mode exists to decide about.
    let integration: number | null = null
    try {
      integration = await configureEngine(request, { baseUrl: 'http://127.0.0.1:9' })

      const res = await placeOrder(request, offerings[0], project)
      const bodyText = await res.text()
      expect(res.status(), `expected a refusal, got ${bodyText}`).toBe(409)
      const { error } = JSON.parse(bodyText) as { error: string }
      // The sentence has to say what could not be reached and who can change the
      // setting, because the reader is a requester who cannot see the engine.
      expect(error).toContain('E2E policy engine')
      expect(error).toContain('best-effort')
    } finally {
      await cleanUp(request, integration, null)
    }
  })

  test('orderers are not policed by an engine nobody configured', async ({ page }) => {
    /*
     * The seeded state, and the state every installation starts in. A portal with
     * no OPA integration has nothing to enforce, so an order must reach exactly
     * the outcome it would have reached before #110 — here, the ordinary refusal
     * for want of a pipeline stack, which is not a policy one.
     */
    await loginAsRoot(page)
    const { request } = page

    const offerings = await offeringsFor(request)
    requireSeeded(offerings.length > 0, 'the catalogue offers no (product, environment) to order')

    const project = await ownProject(request)
    const res = await placeOrder(request, offerings[0], project)
    const body = (await res.json()) as { error?: string }
    expect(body.error ?? '', 'an unconfigured portal refused an order by policy').not.toMatch(
      /policy/i,
    )
  })
})
