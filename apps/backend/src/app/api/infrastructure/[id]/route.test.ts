import { describe, it, expect } from 'vitest'
import { NextRequest } from 'next/server'
import { GET } from './route'
import { db } from '@/lib/db/client'
import { orders, parameters, infrastructureElements } from '@/lib/db/schema'
import { eq } from 'drizzle-orm'
import {
  createUser,
  createCategory,
  createProduct,
  createCiSource,
  createEnvironment,
  createProject,
  createOrder,
  createInfraElement,
  createCostCenter,
  makeAuthHeader,
} from '@/test/helpers'
import { createIntegration } from '@/lib/services/admin/integrations'

const makeReq = (id: string, auth?: string) =>
  new NextRequest(`http://localhost/api/infrastructure/${id}`, auth ? { headers: { authorization: auth } } : undefined)

const params = (id: string) => ({ params: Promise.resolve({ id }) })

const scenario = async () => {
  const root = await createUser({ role: 'root', email: `detail-root-${Math.random()}@test.dev` })
  const pm = await createUser({ role: 'project_manager', email: `detail-pm-${Math.random()}@test.dev` })
  const other = await createUser({ role: 'project_manager', email: `detail-other-${Math.random()}@test.dev` })
  const cat = await createCategory()
  const product = await createProduct(cat.id, 'Nginx Gateway')
  const ci = await createCiSource()
  const env = await createEnvironment(ci.id, undefined, 'AWS Frankfurt')
  const cc = await createCostCenter({ code: 'CC-7', name: 'Platform' })
  const project = await createProject(pm.id, 'Webshop Platform')
  const order = await createOrder(project.id, product.id, env.id, pm.id, { status: 'completed' })
  await db.update(orders).set({ costCenterId: cc.id }).where(eq(orders.id, order.id))
  // As provisioning leaves it: the element carries the pipeline IDS, the ORDER
  // carries their status (webhook/handler.ts merges into orders.pipeline_status),
  // and the element's own status map stays empty until a teardown writes it.
  await db.update(orders).set({ pipelineStatus: { 'pipe-1': 'success' } }).where(eq(orders.id, order.id))
  const element = await createInfraElement(order.id, project.id, env.id, product.id, {
    parameters: { hostname: 'web-01', admin_password: 'sup3rs3cret' },
    pipelineId: ['pipe-1'],
    deployedAt: new Date('2026-03-01T10:00:00.000Z'),
  })
  await db
    .update(infrastructureElements)
    .set({ outputs: { ip_address: '203.0.113.10' } })
    .where(eq(infrastructureElements.id, element.id))
  return { root, pm, other, product, env, project, order, element, cc }
}

describe('GET /api/infrastructure/[id]', () => {
  it('returns 401 without a token', async () => {
    expect((await GET(makeReq('1'), params('1'))).status).toBe(401)
  })

  it('returns 400 for a non-numeric id', async () => {
    const { root } = await scenario()
    const res = await GET(makeReq('abc', await makeAuthHeader(root)), params('abc'))
    expect(res.status).toBe(400)
  })

  it('returns 400 for a partially numeric id rather than reading the leading digits', async () => {
    // parseInt('1abc') is 1, so this used to serve element 1 for a URL that asked
    // for something else — a silently different answer, not an error.
    const { root } = await scenario()
    for (const id of ['1abc', '1.5', ' 1', '+1', '0x1', '1e3']) {
      const res = await GET(makeReq(id, await makeAuthHeader(root)), params(id))
      expect(res.status, `id ${id}`).toBe(400)
    }
  })

  it('returns 404 for an element that does not exist', async () => {
    const { root } = await scenario()
    const res = await GET(makeReq('999999', await makeAuthHeader(root)), params('999999'))
    expect(res.status).toBe(404)
  })

  it('returns the element with everything the detail page renders', async () => {
    const { root, element } = await scenario()
    const res = await GET(makeReq(String(element.id), await makeAuthHeader(root)), params(String(element.id)))
    expect(res.status).toBe(200)

    const body = await res.json()
    expect(body).toMatchObject({
      id: element.id,
      productName: 'Nginx Gateway',
      environmentName: 'AWS Frankfurt',
      projectName: 'Webshop Platform',
      status: 'active',
      orderStatus: 'completed',
      costCenter: 'CC-7 — Platform',
    })
    expect(body.outputs).toEqual({ ip_address: '203.0.113.10' })
    expect(body.pipelineId).toEqual(['pipe-1'])
    // Read off the ORDER, not the element. Taking the element's own (empty) map
    // reported a finished deployment's pipelines as pending.
    expect(body.pipelineStatus).toEqual({ 'pipe-1': 'success' })
    expect(body.pipelinePhase).toBe('provisioning')
    expect(body.deployedAt).toBeTruthy()
  })

  it('redacts the values of sensitive parameters, keeping their names', async () => {
    // The same rule the CSV export applies: a value hidden in one place and shown
    // in the other is worse than either choice made consistently.
    const { root, product, element } = await scenario()
    await db.insert(parameters).values({
      scope: 'product',
      scopeId: product.id,
      name: 'admin_password',
      type: 'string',
      sensitive: true,
    })

    const res = await GET(makeReq(String(element.id), await makeAuthHeader(root)), params(String(element.id)))
    const body = await res.json()

    expect(body.parameters.admin_password).toBe('[redacted]')
    expect(body.parameters.hostname).toBe('web-01')
    expect(body.redactedParameters).toEqual(['admin_password'])
  })

  it('lets the owning project manager see their own element', async () => {
    const { pm, element } = await scenario()
    const res = await GET(makeReq(String(element.id), await makeAuthHeader(pm)), params(String(element.id)))
    expect(res.status).toBe(200)
  })

  it("hides another project manager's element behind 404, not 403", async () => {
    // 403 would confirm the id exists, which is information about a project the
    // caller cannot see.
    const { other, element } = await scenario()
    const res = await GET(makeReq(String(element.id), await makeAuthHeader(other)), params(String(element.id)))
    expect(res.status).toBe(404)
  })

  it('takes a teardown run\'s status from the element, not the order', async () => {
    // A teardown REPLACES the element's pipeline ids with the destroy pipelines
    // and records their status on the element (services/teardown). The order's
    // map still describes the provisioning run and must not be shown here.
    const { root, element, order } = await scenario()
    await db
      .update(infrastructureElements)
      .set({
        status: 'decommissioning',
        pipelineId: ['destroy-1'],
        pipelineStatus: { 'destroy-1': 'success', 'trigger-failed:0': 'webhook 500' },
      })
      .where(eq(infrastructureElements.id, element.id))

    const res = await GET(makeReq(String(element.id), await makeAuthHeader(root)), params(String(element.id)))
    const body = await res.json()

    expect(body.pipelinePhase).toBe('teardown')
    expect(body.pipelineStatus).toEqual({ 'destroy-1': 'success', 'trigger-failed:0': 'webhook 500' })
    // The provisioning run's ids are gone from the element, so its status must
    // not leak in from the order.
    expect(Object.keys(body.pipelineStatus)).not.toContain('pipe-1')
    expect(order.id).toBeGreaterThan(0)
  })

  it('reports a failed deployment as active-with-failed-order', async () => {
    // There is no `failed` element status: the element is created when
    // provisioning starts and stays active when the pipeline fails.
    const { root, order, element } = await scenario()
    await db.update(orders).set({ status: 'failed' }).where(eq(orders.id, order.id))

    const body = await (await GET(makeReq(String(element.id), await makeAuthHeader(root)), params(String(element.id)))).json()
    expect(body.status).toBe('active')
    expect(body.orderStatus).toBe('failed')
  })
})

describe('GET /api/infrastructure/[id] — where it can be watched (#546)', () => {
  /*
   * The deep link into Grafana. What matters beyond the URL's shape (asserted in
   * lib/integrations/grafana.test.ts) is that it is built here, from the resolved
   * integration, and that neither the credential nor the username of an admin-only
   * row escapes into a response any signed-in caller can read.
   */
  const grafana = { kind: 'grafana' as const, name: 'Grafana', baseUrl: 'https://grafana.example.com', authType: 'bearer' as const, credential: 'grafana-token', failureMode: 'best_effort' as const }

  it('carries a deep link for this element, filtered by its identifiers', async () => {
    const { root, element, project } = await scenario()
    await createIntegration(root.id, grafana)

    const body = await (await GET(makeReq(String(element.id), await makeAuthHeader(root)), params(String(element.id)))).json()

    expect(body.observability.grafana.url).toContain('https://grafana.example.com/d/infrashelf-element/element?')
    expect(body.observability.grafana.url).toContain(`var-element_id=${element.id}`)
    expect(body.observability.grafana.url).toContain(`var-project_id=${project.id}`)
    expect(body.observability.grafana.dashboardUid).toBe('infrashelf-element')
  })

  it('is null when no Grafana is configured, rather than a link to nowhere', async () => {
    const { root, element } = await scenario()

    const body = await (await GET(makeReq(String(element.id), await makeAuthHeader(root)), params(String(element.id)))).json()

    expect(body.observability).toEqual({ grafana: null })
  })

  it('is null when the only Grafana is disabled', async () => {
    const { root, element } = await scenario()
    await createIntegration(root.id, { ...grafana, enabled: false })

    const body = await (await GET(makeReq(String(element.id), await makeAuthHeader(root)), params(String(element.id)))).json()

    expect(body.observability.grafana).toBeNull()
  })

  it("prefers the environment's own Grafana to the portal-wide one", async () => {
    const { root, element, env } = await scenario()
    await createIntegration(root.id, grafana)
    await createIntegration(root.id, { ...grafana, name: 'Grafana env', environmentId: env.id, baseUrl: 'https://env-grafana.example.com' })

    const body = await (await GET(makeReq(String(element.id), await makeAuthHeader(root)), params(String(element.id)))).json()

    expect(body.observability.grafana.url).toContain('https://env-grafana.example.com/d/')
  })

  it('hands a project manager the link too, and only the link', async () => {
    // The element page is the one place a project manager sees their own machines,
    // and a URL is not a credential — Grafana enforces its own access. What must not
    // travel is everything else the registry row holds.
    const { pm, element } = await scenario()
    await createIntegration(await createUser({ role: 'root' }).then((u) => u.id), grafana)

    const body = await (await GET(makeReq(String(element.id), await makeAuthHeader(pm)), params(String(element.id)))).json()

    expect(body.observability.grafana.url).toContain('/d/infrashelf-element/element?')
    expect(Object.keys(body.observability.grafana).sort()).toEqual(['dashboardUid', 'url'])
    expect(JSON.stringify(body.observability)).not.toContain('grafana-token')
    expect(JSON.stringify(body.observability)).not.toContain('Grafana')
  })
})
