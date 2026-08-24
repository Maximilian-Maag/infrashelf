import { test, expect, request, type APIRequestContext } from '@playwright/test'
import { loginAs } from './helpers'
import {
  apiAsRoot,
  apiBaseURL,
  ensureUser,
  expectOk,
  tryDelete,
  wiremockURL,
  type FixtureUser,
} from './api'

/**
 * Issue #157. The one seam nothing covered end to end.
 *
 * A pipeline callback is how a CI provider tells the portal that an order became
 * infrastructure. Everything downstream of it — the order reaching `completed`,
 * the element getting its Terraform outputs, the customer being notified — hangs
 * off a single POST that no test had ever sent. It is covered by route tests and
 * by lib/webhook/handler.test.ts, but those mock `@/lib/ci` wholesale, which is
 * exactly how #121 (no order ever recorded outputs) survived for months: every
 * unit was right about a seam none of them actually crossed.
 *
 * So this spec crosses it for real, against the WireMock GitLab in
 * infra/docker-compose.dev.yml:
 *
 *   project manager places an order   → pending   (in the browser)
 *   root approves it                  → provisioning + a real trigger POST
 *   GitLab reports the pipeline done  → completed  (the callback)
 *   the element shows its outputs     → parsed out of the stubbed apply log
 *
 * Root's own order would prove none of this: an admin's order is written straight
 * to `provisioning` (services/orders.ts createPreparedOrder), so the approval step
 * — and therefore the trigger that produces a pipeline id to call back about —
 * only exists for a project manager.
 */

/** The pipeline id infra/wiremock/mappings/gitlab-pipeline-trigger.json answers with. */
const STUB_PIPELINE_ID = 42
/**
 * What the stubbed apply log declares (gitlab-job-trace.json). Reaching this
 * value means the whole read-back path ran: entry pipeline 42 → its bridge →
 * child pipeline 43 → the `apply` job → parseTofuOutputs. Issue #121's bug lived
 * in exactly that walk.
 */
const STUB_OUTPUT_KEY = 'vm_ip'
const STUB_OUTPUT_VALUE = '10.0.0.100'

/**
 * Stable names, not `${Date.now()}` ones.
 *
 * A fixture named after the clock is a new row on every run and nothing ever
 * removes the old ones — that is issue #156. These are torn down in afterAll, and
 * the fixed names mean a run that died before its teardown is cleaned up by the
 * next one rather than adding to the pile. (They are also why an assertion like
 * `not.toContainText('500')` could never be tripped by a fixture name here.)
 */
const FIXTURE = {
  ciSource: 'E2E Webhook GitLab',
  environment: 'E2E Webhook Environment',
  category: 'E2E Webhook Category',
  product: 'E2E Webhook Product',
  project: 'E2E Webhook Project',
}

interface Fixtures {
  ciSourceId: number
  environmentId: number
  categoryId: number
  productId: number
  projectId: number
  callbackSecret: string
  pm: FixtureUser
}

let root: APIRequestContext
let fixtures: Fixtures | null = null
let wiremockReady = false

const SKIP_REASON =
  'The stub GitLab is not running. Start it with the dev compose file ' +
  '(infra/docker-compose.dev.yml, service `wiremock`) — this spec drives a real ' +
  'pipeline trigger and a real callback, so there is nothing to assert without it.'

/** Delete anything a previous run left behind, so the fixed names are always free. */
const removeByName = async (
  api: APIRequestContext,
  collection: string,
  name: string,
): Promise<void> => {
  const res = await api.get(collection)
  if (!res.ok()) return
  const rows = (await res.json()) as { id: number; name: string }[]
  for (const row of rows.filter((r) => r.name === name)) {
    await tryDelete(api, `${collection}/${row.id}`)
  }
}

const buildFixtures = async (): Promise<Fixtures> => {
  // Projects first: deleting one cascades to its orders and infrastructure
  // elements (both foreign keys are ON DELETE CASCADE), which is the only way to
  // remove an order — the API deliberately offers no DELETE for one.
  const projects = (await (
    await expectOk(await root.get('/api/projects'), 'list projects')
  ).json()) as { id: number; name: string }[]
  for (const p of projects.filter((p) => p.name === FIXTURE.project)) {
    await tryDelete(root, `/api/projects/${p.id}`)
  }
  await removeByName(root, '/api/admin/products', FIXTURE.product)
  await removeByName(root, '/api/admin/environments', FIXTURE.environment)
  await removeByName(root, '/api/admin/ci-sources', FIXTURE.ciSource)
  await removeByName(root, '/api/admin/categories', FIXTURE.category)

  const ciSource = (await (
    await expectOk(
      await root.post('/api/admin/ci-sources', {
        data: {
          name: FIXTURE.ciSource,
          // WireMock, not gitlab.example.invalid: this source is read back from
          // for the job log, so it has to answer.
          url: wiremockURL,
          accessToken: 'e2e-stub-token',
          provider: 'gitlab',
        },
      }),
      'create CI source',
    )
  ).json()) as { id: number }

  const environment = (await (
    await expectOk(
      await root.post('/api/admin/environments', {
        data: {
          name: FIXTURE.environment,
          description: 'Points at the WireMock GitLab',
          ciSourceId: ciSource.id,
          // The `/projects/1/` segment is the only place the GitLab project is
          // named — `gitlabProjectRefFromTriggerUrl` reads it back out to locate
          // the job log. A URL of another shape means no outputs at all.
          webhookUrl: `${wiremockURL}/api/v4/projects/1/trigger/pipeline`,
          webhookToken: 'e2e-trigger-token',
        },
      }),
      'create environment',
    )
  ).json()) as { id: number }

  const category = (await (
    await expectOk(
      await root.post('/api/admin/categories', { data: { name: FIXTURE.category } }),
      'create category',
    )
  ).json()) as { id: number }

  const product = (await (
    await expectOk(
      await root.post('/api/admin/products', {
        data: {
          categoryId: category.id,
          baseLanguage: 'en',
          name: FIXTURE.product,
          description: 'Ordered by the pipeline-callback journey.',
        },
      }),
      'create product',
    )
  ).json()) as { id: number }

  await expectOk(
    await root.post(`/api/admin/products/${product.id}/environments`, {
      data: { environmentId: environment.id, price: '10.00', currency: 'EUR' },
    }),
    'offer the product in the environment',
  )

  // Without this the order provisions nothing: `provisionOrderElements` fans out
  // over the product's webhooks and pipeline stacks, and a product with neither
  // produces an element with no pipeline id — nothing for a callback to match.
  await expectOk(
    await root.post(`/api/admin/products/${product.id}/webhooks`, {
      data: {
        environmentId: environment.id,
        name: 'apply',
        webhookUrl: `${wiremockURL}/api/v4/projects/1/trigger/pipeline`,
        webhookToken: 'e2e-trigger-token',
      },
    }),
    'attach the provisioning webhook',
  )

  const secret = (await (
    await expectOk(
      await root.get(`/api/admin/environments/${environment.id}/callback-secret`),
      'read the callback secret',
    )
  ).json()) as { callbackSecret: string }

  const pm = await ensureUser(root, 'project_manager', 'webhook-pm')

  // Owned by the project manager: `prepareOrder` refuses an order into a project
  // a project_manager does not own, so a root-owned project would 403 here.
  const pmApi = await request.newContext({
    baseURL: apiBaseURL,
    extraHTTPHeaders: { Authorization: `Bearer ${await tokenOf(pm)}` },
  })
  const project = (await (
    await expectOk(
      await pmApi.post('/api/projects', {
        data: { name: FIXTURE.project, description: 'Pipeline-callback journey' },
      }),
      'create the project managers project',
    )
  ).json()) as { id: number }
  await pmApi.dispose()

  return {
    ciSourceId: ciSource.id,
    environmentId: environment.id,
    categoryId: category.id,
    productId: product.id,
    projectId: project.id,
    callbackSecret: secret.callbackSecret,
    pm,
  }
}

const tokenOf = async (user: FixtureUser): Promise<string> => {
  const anon = await request.newContext({ baseURL: apiBaseURL })
  try {
    const res = await expectOk(
      await anon.post('/api/auth/login', { data: { email: user.email, password: user.password } }),
      `log in as ${user.email}`,
    )
    return ((await res.json()) as { token: string }).token
  } finally {
    await anon.dispose()
  }
}

test.beforeAll(async () => {
  root = await apiAsRoot()

  const probe = await request.newContext()
  try {
    const res = await probe.get(`${wiremockURL}/__admin/mappings`, { timeout: 5000 })
    wiremockReady = res.ok()
  } catch {
    wiremockReady = false
  } finally {
    await probe.dispose()
  }

  // CI declares WireMock as a step of the e2e job, so its absence there is a
  // broken pipeline, not a reason to quietly assert nothing — which is precisely
  // the failure mode issue #154 catalogued.
  if (!wiremockReady) {
    if (process.env.CI) throw new Error(`WireMock is required in CI. ${SKIP_REASON}`)
    return
  }

  fixtures = await buildFixtures()
})

test.afterAll(async () => {
  if (fixtures) {
    // Project first — the cascade takes the order and the infrastructure element
    // with it, and the environment cannot be deleted while they still refer to it.
    await tryDelete(root, `/api/projects/${fixtures.projectId}`)
    await tryDelete(root, `/api/admin/products/${fixtures.productId}`)
    await tryDelete(root, `/api/admin/environments/${fixtures.environmentId}`)
    await tryDelete(root, `/api/admin/ci-sources/${fixtures.ciSourceId}`)
    await tryDelete(root, `/api/admin/categories/${fixtures.categoryId}`)
  }
  await root.dispose()
})

test.describe('Pipeline callback (FA-6, issue #157)', () => {
  test('an approved order becomes infrastructure when the pipeline reports success', async ({
    page,
    browser,
  }) => {
    test.skip(!wiremockReady, SKIP_REASON)
    const fx = fixtures!
    // Four cold `next dev` compiles (catalog detail, orders, approvals, infra
    // detail) plus two sign-ins, in series. auth.setup.ts measures a single cold
    // sign-in at ~32s on a loaded machine; this is that bill several times over.
    test.setTimeout(240_000)

    // ── The project manager places the order, in the browser ──────────────────
    // A separate context because the shared storageState is root's, and the whole
    // point is that this order is placed by someone who cannot approve it.
    const pmContext = await browser.newContext()
    const pmPage = await pmContext.newPage()
    try {
      await loginAs(pmPage, fx.pm.email, fx.pm.password)
      await pmPage.goto(`/catalog/${fx.productId}`)

      const form = pmPage.locator('#order')
      // Scoped to the order form: the buy box carries an Environment select too.
      await form.getByLabel(/environment/i).selectOption(String(fx.environmentId))
      await form.getByLabel(/project/i).selectOption(String(fx.projectId))
      await form.getByRole('button', { name: /place order/i }).click()
      await pmPage.waitForURL(/\/orders/, { timeout: 60_000 })
    } finally {
      await pmContext.close()
    }

    // The order the browser just created. Read back rather than scraped, because
    // the id is what every later assertion is scoped to.
    const orders = (await (
      await expectOk(await root.get('/api/orders'), 'list orders')
    ).json()) as { id: number; status: string; projectId: number }[]
    const order = orders.find((o) => o.projectId === fx.projectId)
    expect(order, 'the project manager’s order was not created').toBeTruthy()
    // A project manager's order waits for a human. This is the branch root never
    // takes, and the reason the callback has something to call back about.
    expect(order!.status).toBe('pending')

    // ── Root approves it, in the browser ──────────────────────────────────────
    await page.goto('/approvals')
    const card = page
      .locator('div')
      .filter({ has: page.getByText(FIXTURE.product) })
      .filter({ has: page.getByRole('button', { name: /^approve$/i }) })
      .last()
    await expect(card).toBeVisible({ timeout: 30_000 })
    await card.getByRole('button', { name: /^approve$/i }).click()

    // Approval is what fires the trigger, so the pipeline id only exists after it.
    await expect
      .poll(
        async () => {
          const res = await root.get(`/api/orders/${order!.id}`)
          if (!res.ok()) return null
          return (await res.json()) as { status: string; pipelineId: string[] }
        },
        { timeout: 30_000, message: 'the approved order never reached provisioning' },
      )
      .toMatchObject({ status: 'provisioning', pipelineId: [String(STUB_PIPELINE_ID)] })

    // ── GitLab reports the pipeline finished ──────────────────────────────────
    // Unauthenticated on purpose: the callback carries no session, only the
    // environment's callback secret. That is the entire authentication story of
    // this endpoint, and it is what the next test probes.
    const gitlab = await request.newContext({ baseURL: apiBaseURL })
    try {
      const callback = await gitlab.post('/api/webhooks/gitlab/pipeline', {
        headers: { 'x-gitlab-token': fx.callbackSecret },
        data: {
          object_kind: 'pipeline',
          object_attributes: { id: STUB_PIPELINE_ID, status: 'success' },
        },
      })
      expect(callback.status(), await callback.text()).toBe(200)
    } finally {
      await gitlab.dispose()
    }

    // ── What the callback was supposed to achieve ─────────────────────────────
    const completed = (await (
      await expectOk(await root.get(`/api/orders/${order!.id}`), 'read the order back')
    ).json()) as { status: string }
    expect(completed.status).toBe('completed')

    const elements = (await (
      await expectOk(await root.get('/api/infrastructure'), 'list infrastructure')
    ).json()) as { id: number; orderId: number }[]
    const element = elements.find((e) => e.orderId === order!.id)
    expect(element, 'the completed order produced no infrastructure element').toBeTruthy()

    // The outputs are the payload of the whole journey: they exist only because
    // the handler followed the pipeline down to its apply job and parsed the log.
    // Asserted in the browser, because an output nobody can read is not delivered.
    await page.goto(`/infrastructure/${element!.id}`)
    await expect(page.getByRole('heading', { name: /^outputs$/i })).toBeVisible({ timeout: 60_000 })
    await expect(page.getByText(STUB_OUTPUT_KEY)).toBeVisible()
    await expect(page.getByText(STUB_OUTPUT_VALUE)).toBeVisible()

    // And the order it came from stays reachable from the element.
    await expect(page.getByRole('link', { name: `#${order!.id}` })).toBeVisible()
  })

  test('a callback with the wrong secret is refused', async () => {
    test.skip(!wiremockReady, SKIP_REASON)

    const gitlab = await request.newContext({ baseURL: apiBaseURL })
    try {
      // No secret at all.
      const anonymous = await gitlab.post('/api/webhooks/gitlab/pipeline', {
        data: { object_kind: 'pipeline', object_attributes: { id: 1, status: 'success' } },
      })
      expect(anonymous.status()).toBe(401)

      // A secret, but not one this portal ever issued. The endpoint is
      // unauthenticated by design, so this header is the only thing standing
      // between the public internet and "mark that order completed".
      const forged = await gitlab.post('/api/webhooks/gitlab/pipeline', {
        headers: { 'x-gitlab-token': 'ohc-cb-not-a-real-secret' },
        data: { object_kind: 'pipeline', object_attributes: { id: 1, status: 'success' } },
      })
      expect(forged.status()).toBe(401)

      // The right secret with a payload that is not a pipeline event is a 400,
      // not a silent 200 — a provider misconfigured to send push events would
      // otherwise look like it was working.
      const wrongKind = await gitlab.post('/api/webhooks/gitlab/pipeline', {
        headers: { 'x-gitlab-token': fixtures!.callbackSecret },
        data: { object_kind: 'push' },
      })
      expect(wrongKind.status()).toBe(400)
    } finally {
      await gitlab.dispose()
    }
  })
})
