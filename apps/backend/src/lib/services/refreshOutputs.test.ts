import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { eq } from 'drizzle-orm'
import { db } from '@/lib/db/client'
import { infrastructureElements, deploymentEnvironments, integrations } from '@/lib/db/schema'
import type { SessionUser } from '@infrashelf/types'
import {
  createUser, createCategory, createProduct, createCiSource,
  createEnvironment, createProject, createOrder, createInfraElement,
} from '@/test/helpers'

const fetchJobTraces = vi.fn()
vi.mock('@/lib/ci', () => ({
  fetchJobTraces: (...a: unknown[]) => fetchJobTraces(...a),
  parseTofuOutputs: (t: string) =>
    Object.fromEntries(
      t.split('\n').filter((l) => l.includes(' = ')).map((l) => {
        const [k, v] = l.split(' = ')
        return [k.trim(), v.trim().replace(/^"|"$/g, '')]
      }),
    ),
  supportsJobTrace: () => true,
}))

const { refreshElementOutputs, refreshOutputsLimit } = await import('./infrastructure')

const session = (u: { id: number; role: string }): SessionUser =>
  ({ id: u.id, email: 'x@test.dev', name: 'X', role: u.role }) as SessionUser

const scenario = async () => {
  const admin = await createUser({ role: 'admin' })
  const pm = await createUser({ role: 'project_manager' })
  const cat = await createCategory()
  const product = await createProduct(cat.id)
  const ci = await createCiSource()
  const env = await createEnvironment(ci.id)
  const project = await createProject(pm.id)
  const order = await createOrder(project.id, product.id, env.id, pm.id)
  const el = await createInfraElement(order.id, project.id, env.id, product.id, {
    pipelineId: ['777'],
  })
  return { admin, pm, project, env, el }
}

beforeEach(() => {
  fetchJobTraces.mockReset()
  // Element ids repeat across cases in a truncated database, so without this
  // one case's element is still inside the next case's refresh cooldown.
  refreshOutputsLimit.clear()
})

afterEach(() => vi.restoreAllMocks())

/**
 * Issue #218. Outputs are parsed once, at settle. When something was wrong at
 * that instant the element was blank forever, and the only remedies were a
 * database script or redeploying real infrastructure to get a second read of a
 * log that had not changed.
 */
describe('refreshElementOutputs', () => {
  it('reads the outputs and stores them', async () => {
    const { admin, el } = await scenario()
    fetchJobTraces.mockResolvedValue(['Outputs:\nip_address = "172.105.94.94"'])

    const result = await refreshElementOutputs(session(admin), el.id)
    expect(result.ok).toBe(true)

    const [row] = await db.select().from(infrastructureElements).where(eq(infrastructureElements.id, el.id))
    expect(row.outputs).toEqual({ ip_address: '172.105.94.94' })
    expect(row.outputsError).toBeNull()
  })

  it('records why, when the log cannot be read', async () => {
    // The hcp-dev case: an expired CI token. Blank and "your token died" must not
    // be the same screen.
    const { admin, el } = await scenario()
    fetchJobTraces.mockRejectedValue(new Error('GitLab jobs fetch failed: 401'))

    const result = await refreshElementOutputs(session(admin), el.id)
    expect(result.ok).toBe(true)

    const [row] = await db.select().from(infrastructureElements).where(eq(infrastructureElements.id, el.id))
    expect(row.outputsError).toMatch(/401/)
    expect(row.outputsError).toMatch(/access token/i)
  })

  it('says the deployment declared none, when the log reads fine and has no block', async () => {
    const { admin, el } = await scenario()
    fetchJobTraces.mockResolvedValue(['Apply complete! Resources: 0 added.'])

    await refreshElementOutputs(session(admin), el.id)
    const [row] = await db.select().from(infrastructureElements).where(eq(infrastructureElements.id, el.id))
    expect(row.outputsError).toMatch(/declared none/i)
  })

  it('clears a previous complaint once the read succeeds', async () => {
    // The whole point: fix the token, press the button, and the page stops
    // accusing it.
    const { admin, el } = await scenario()
    fetchJobTraces.mockRejectedValueOnce(new Error('GitLab jobs fetch failed: 401'))
    await refreshElementOutputs(session(admin), el.id)

    // Past the 15s cooldown, which these two calls are not about.
    refreshOutputsLimit.clear()
    fetchJobTraces.mockResolvedValue(['Outputs:\nip_address = "10.0.0.1"'])
    await refreshElementOutputs(session(admin), el.id)

    const [row] = await db.select().from(infrastructureElements).where(eq(infrastructureElements.id, el.id))
    expect(row.outputs).toEqual({ ip_address: '10.0.0.1' })
    expect(row.outputsError).toBeNull()
  })

  it('does not erase outputs it already had when a later read fails', async () => {
    // A transient CI outage must not take the endpoint off the page.
    const { admin, el } = await scenario()
    fetchJobTraces.mockResolvedValueOnce(['Outputs:\nip_address = "10.0.0.1"'])
    await refreshElementOutputs(session(admin), el.id)

    // Past the 15s cooldown, which these two calls are not about.
    refreshOutputsLimit.clear()
    fetchJobTraces.mockRejectedValue(new Error('GitLab jobs fetch failed: 502'))
    await refreshElementOutputs(session(admin), el.id)

    const [row] = await db.select().from(infrastructureElements).where(eq(infrastructureElements.id, el.id))
    expect(row.outputs).toEqual({ ip_address: '10.0.0.1' })
    expect(row.outputsError).toMatch(/502/)
  })

  // Each call makes one outbound CI request per pipeline the element has,
  // against the token the settle path shares. Without a cooldown, holding the
  // button down amplifies one click into an unbounded stream of API calls and
  // can exhaust that token for the whole environment.
  it('refuses a second re-read of the same element inside the cooldown', async () => {
    const { admin, el } = await scenario()
    fetchJobTraces.mockResolvedValue(['Outputs:\nip_address = "10.0.0.1"'])

    const first = await refreshElementOutputs(session(admin), el.id)
    expect(first.ok).toBe(true)

    const second = await refreshElementOutputs(session(admin), el.id)
    expect(second.ok).toBe(false)
    if (!second.ok) expect(second.status).toBe(429)
    // The point of the cooldown: the second click cost no outbound traffic.
    expect(fetchJobTraces).toHaveBeenCalledTimes(1)
  })

  it('throttles per element, so one element does not block another', async () => {
    const { admin, el } = await scenario()
    const other = await scenario()
    fetchJobTraces.mockResolvedValue(['Outputs:\nip_address = "10.0.0.1"'])

    expect((await refreshElementOutputs(session(admin), el.id)).ok).toBe(true)
    expect((await refreshElementOutputs(session(other.admin), other.el.id)).ok).toBe(true)
  })

  // The cooldown sits behind the scoping check on purpose: if it came first, a
  // caller who may not see an element could spend its budget and deny the
  // refresh to the people who own it.
  it('does not let a caller who cannot see the element spend its cooldown', async () => {
    const { el } = await scenario()
    const stranger = await scenario()
    fetchJobTraces.mockResolvedValue(['Outputs:\nip_address = "10.0.0.1"'])

    const denied = await refreshElementOutputs(session(stranger.pm), el.id)
    expect(denied.ok).toBe(false)
    if (!denied.ok) expect(denied.status).toBe(404)

    // The owner's first click still works.
    expect((await refreshElementOutputs(session(stranger.admin), el.id)).ok).toBe(true)
  })

  // Review catch on #219. The response used to say `outputs: {}` on any read
  // that found nothing, while the row kept the outputs an earlier read had
  // recorded — so a POST and the GET right after it disagreed, and a caller who
  // believed the POST would have shown an element as having no outputs.
  it('answers with the outputs that are STORED, not with the failed read', async () => {
    const { admin, el } = await scenario()
    fetchJobTraces.mockResolvedValueOnce(['Outputs:\nip_address = "10.0.0.1"'])
    await refreshElementOutputs(session(admin), el.id)
    refreshOutputsLimit.clear()

    fetchJobTraces.mockRejectedValue(new Error('GitLab jobs fetch failed: 502'))
    const result = await refreshElementOutputs(session(admin), el.id)

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.data.outputs).toEqual({ ip_address: '10.0.0.1' })
    expect(result.data.outputsError).toMatch(/502/)

    // And it matches the row, which is the property that was broken.
    const [row] = await db.select().from(infrastructureElements).where(eq(infrastructureElements.id, el.id))
    expect(result.data.outputs).toEqual(row.outputs)
  })

  // The OTHER early return, which leaves before any trace is fetched: the
  // environment's trigger URL names no project, so there is no job endpoint to
  // ask. It has its own `return ok(...)` and so its own chance to disagree with
  // the row.
  it('answers with the stored outputs when the log cannot be located at all', async () => {
    const { admin, env, el } = await scenario()
    fetchJobTraces.mockResolvedValueOnce(['Outputs:\nip_address = "10.0.0.1"'])
    await refreshElementOutputs(session(admin), el.id)
    refreshOutputsLimit.clear()

    // A trigger URL of another shape: `gitlabProjectRefFromTriggerUrl` finds no
    // /projects/<id>/ segment, so `outputsUnavailableReason` returns early.
    await db
      .update(deploymentEnvironments)
      .set({ webhookUrl: 'https://gitlab.example.com/hooks/generic' })
      .where(eq(deploymentEnvironments.id, env.id))

    const result = await refreshElementOutputs(session(admin), el.id)

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.data.outputsError).toMatch(/projects/)
    expect(result.data.outputs).toEqual({ ip_address: '10.0.0.1' })
    expect(fetchJobTraces).toHaveBeenCalledTimes(1)

    const [row] = await db.select().from(infrastructureElements).where(eq(infrastructureElements.id, el.id))
    expect(result.data.outputs).toEqual(row.outputs)
  })

  it('lets the project manager who owns it refresh their own element', async () => {
    // Reading a log starts nothing and changes no infrastructure, unlike retry.
    const { pm, el } = await scenario()
    fetchJobTraces.mockResolvedValue(['Outputs:\nip_address = "10.0.0.2"'])
    expect((await refreshElementOutputs(session(pm), el.id)).ok).toBe(true)
  })

  it('answers 404 to a project manager who does not own it', async () => {
    // 404 and not 403: that the element exists is itself information.
    const { el } = await scenario()
    const other = await createUser({ role: 'project_manager', email: 'other-pm@test.dev' })
    const result = await refreshElementOutputs(session(other), el.id)
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.status).toBe(404)
    expect(fetchJobTraces).not.toHaveBeenCalled()
  })

  it('answers 404 for an element that does not exist', async () => {
    const { admin } = await scenario()
    const result = await refreshElementOutputs(session(admin), 999_999)
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.status).toBe(404)
  })

  it('explains rather than throwing when the element has no pipeline', async () => {
    const { admin, el } = await scenario()
    await db.update(infrastructureElements).set({ pipelineId: [] }).where(eq(infrastructureElements.id, el.id))

    const result = await refreshElementOutputs(session(admin), el.id)
    expect(result.ok).toBe(true)
    const [row] = await db.select().from(infrastructureElements).where(eq(infrastructureElements.id, el.id))
    expect(row.outputsError).toMatch(/no pipeline/i)
    expect(fetchJobTraces).not.toHaveBeenCalled()
  })
})

/**
 * Issue #111's Loki item: the pipeline log read from Loki rather than from the
 * provider's job API.
 *
 * The wiring is what these cases are for — the environment's integration is what
 * decides which source a read uses, and the window starts at the run that printed
 * the outputs. The HTTP response is faked rather than the Loki client, so the
 * selector and the parameters an operator's Loki would actually receive are part
 * of what is asserted.
 */
describe('refreshElementOutputs — with a Loki bound to the environment (#111)', () => {
  /** A Loki answer for `elementId`, from the real API's shape. */
  const lokiStream = (elementId: number, lines: string[]): Response =>
    new Response(
      JSON.stringify({
        status: 'success',
        data: {
          resultType: 'streams',
          result: lines.length
            ? [
                {
                  stream: { element_id: String(elementId) },
                  values: lines.map((line, i) => [`175870800${String(i).padStart(9, '0')}`, line]),
                },
              ]
            : [],
        },
      }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    )

  const addLoki = (environmentId: number) =>
    db.insert(integrations).values({
      kind: 'loki',
      name: 'loki',
      baseUrl: 'https://loki.example.com',
      // `none` on purpose: this case is about which source a read uses, not about
      // decrypting a credential, and it keeps the test out of the secret store.
      authType: 'none',
      failureMode: 'best_effort',
      environmentId,
    })

  it('reads the element’s log from Loki and stores its outputs', async () => {
    const { admin, env, el } = await scenario()
    await addLoki(env.id)
    const deployedAt = new Date('2026-09-01T00:00:00Z')
    await db
      .update(infrastructureElements)
      .set({ deployedAt })
      .where(eq(infrastructureElements.id, el.id))

    const fetchMock = vi
      .spyOn(global, 'fetch')
      .mockResolvedValue(lokiStream(el.id, ['apply chatter', 'Outputs:', 'ip_address = "10.0.0.7"']))

    const result = await refreshElementOutputs(session(admin), el.id)
    expect(result.ok).toBe(true)

    const [row] = await db.select().from(infrastructureElements).where(eq(infrastructureElements.id, el.id))
    expect(row.outputs).toEqual({ ip_address: '10.0.0.7' })
    expect(row.outputsError).toBeNull()

    // The provider's job API was never asked: this deployment reads from Loki.
    expect(fetchJobTraces).not.toHaveBeenCalled()

    const url = new URL(String((fetchMock.mock.calls[0] as [unknown])[0]))
    expect(url.pathname).toBe('/loki/api/v1/query_range')
    expect(url.searchParams.get('query')).toBe(`{element_id="${el.id}"}`)
    // The window opens at the run that printed these outputs rather than at the
    // default week-back, which is why the column is selected at all.
    expect(url.searchParams.get('start')).toBe(`${BigInt(deployedAt.getTime()) * 1_000_000n}`)
  })

  it('leaves a deployment without one reading through the CI provider, as before', async () => {
    const { admin, el } = await scenario()
    fetchJobTraces.mockResolvedValue(['Outputs:\nip_address = "10.0.0.8"'])
    const fetchMock = vi.spyOn(global, 'fetch')

    await refreshElementOutputs(session(admin), el.id)

    const [row] = await db.select().from(infrastructureElements).where(eq(infrastructureElements.id, el.id))
    expect(row.outputs).toEqual({ ip_address: '10.0.0.8' })
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('records what Loki said when the read fails, and keeps the outputs it had', async () => {
    const { admin, env, el } = await scenario()
    await addLoki(env.id)
    vi.spyOn(global, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ status: 'error', error: 'Unauthorized' }), {
        status: 401,
        headers: { 'content-type': 'application/json' },
      }),
    )
    // Both sources are asked — the CI one is the second source rather than a
    // dead end — and both are named in what the element records.
    fetchJobTraces.mockRejectedValue(new Error('GitLab job trace fetch failed: 410'))
    await db
      .update(infrastructureElements)
      .set({ outputs: { ip_address: '10.0.0.1' } })
      .where(eq(infrastructureElements.id, el.id))

    const result = await refreshElementOutputs(session(admin), el.id)
    expect(result.ok).toBe(true)

    const [row] = await db.select().from(infrastructureElements).where(eq(infrastructureElements.id, el.id))
    expect(row.outputs).toEqual({ ip_address: '10.0.0.1' })
    // The message has to send the operator to the integration, not to the CI
    // token: the token is not what failed.
    expect(row.outputsError).toMatch(/Loki: Rejected the stored credential \(HTTP 401\)/)
    expect(row.outputsError).toMatch(/Admin → Integrations/)
    expect(row.outputsError).toMatch(/410/)
  })
})
