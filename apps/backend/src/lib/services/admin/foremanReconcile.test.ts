import { describe, it, expect, vi, afterEach } from 'vitest'
import { db } from '@/lib/db/client'
import { pipelineStacks, infrastructureElements } from '@/lib/db/schema'
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
} from '@/test/helpers'
import { createIntegration } from './integrations'
import { reconcileForemanHosts, hostKey } from './foremanReconcile'
import * as foreman from '@/lib/integrations/foreman'

afterEach(() => vi.restoreAllMocks())

/** Foreman's answer, as the client hands it over. */
const hosts = (...names: string[]) =>
  names.map((name, i) => ({ id: i + 1, name, status: 'OK', lastReportAt: null }))

const answerWith = (...names: string[]) =>
  vi.spyOn(foreman, 'listForemanHosts').mockResolvedValue({ ok: true, hosts: hosts(...names) })

/**
 * An environment with one product, one Foreman, and elements to compare.
 *
 * `hostnames` become one active element each, carrying the value in the
 * parameter the stack names.
 */
const scaffold = async (opts: {
  hostnames: string[]
  stateKeyParam?: string
  withForeman?: boolean
  paramName?: string
  /** Bind the Foreman to the environment, or leave it portal-wide. */
  portalWide?: boolean
  /** Host names ordered in a SECOND environment the same Foreman serves. */
  otherEnvironmentHostnames?: string[]
}) => {
  const pm = await createUser({ role: 'project_manager' })
  const root = await createUser({ role: 'root' })
  const cat = await createCategory()
  const product = await createProduct(cat.id)
  const ci = await createCiSource()
  const env = await createEnvironment(ci.id)
  const project = await createProject(pm.id)

  if (opts.stateKeyParam !== undefined) {
    await db.insert(pipelineStacks).values({
      productId: product.id,
      environmentId: env.id,
      name: 'stack',
      stateKeyParam: opts.stateKeyParam,
    })
  }

  const elements: number[] = []
  for (const hostname of opts.hostnames) {
    const order = await createOrder(project.id, product.id, env.id, pm.id)
    const element = await createInfraElement(order.id, project.id, env.id, product.id, {
      parameters: { [opts.paramName ?? opts.stateKeyParam ?? 'hostname']: hostname },
    })
    elements.push(element.id)
  }

  let otherEnv: { id: number } | null = null
  if (opts.otherEnvironmentHostnames?.length) {
    otherEnv = await createEnvironment(ci.id, undefined, `other-${Date.now()}`)
    for (const hostname of opts.otherEnvironmentHostnames) {
      const order = await createOrder(project.id, product.id, otherEnv.id, pm.id)
      await createInfraElement(order.id, project.id, otherEnv.id, product.id, {
        parameters: { [opts.paramName ?? opts.stateKeyParam ?? 'hostname']: hostname },
      })
    }
  }

  if (opts.withForeman !== false) {
    const created = await createIntegration(root.id, {
      kind: 'foreman',
      name: 'House Foreman',
      baseUrl: 'https://foreman.example.com',
      authType: 'bearer',
      credential: 'a-token',
      environmentId: opts.portalWide ? null : env.id,
      failureMode: 'best_effort',
    })
    if (!created.ok) throw new Error('setup failed')
  }

  return { env, otherEnv, product, project, pm, root, elements }
}

/**
 * The Foreman half of #111: what Foreman has, against what the portal ordered.
 *
 * The four buckets are the whole point, and three of them are easy to collapse
 * into each other by accident — which is what these tests are for.
 */
describe('reconcileForemanHosts', () => {
  it('matches an ordered host that Foreman knows about', async () => {
    const { env, elements } = await scaffold({ hostnames: ['web-01'] })
    answerWith('web-01.dc.example.com')

    const result = await reconcileForemanHosts(env.id)

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.data.matched).toEqual([
      { elementId: elements[0], hostName: 'web-01', foremanHostId: 1, status: 'OK' },
    ])
    expect(result.data.ghosts).toEqual([])
    expect(result.data.orphans).toEqual([])
  })

  it('matches a short name against an FQDN, case-insensitively', async () => {
    // Otherwise the same machine is reported as one ghost AND one orphan, which
    // is the single most likely way this report becomes noise nobody reads.
    const { env } = await scaffold({ hostnames: ['Web-02'] })
    answerWith('web-02.dc.example.com')

    const result = await reconcileForemanHosts(env.id)

    expect(result.ok && result.data.matched).toHaveLength(1)
    expect(result.ok && result.data.orphans).toHaveLength(0)
  })

  it('reports an ordered element Foreman has never heard of as a ghost', async () => {
    const { env, elements } = await scaffold({ hostnames: ['web-01'] })
    answerWith('unrelated-01')

    const result = await reconcileForemanHosts(env.id)

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.data.ghosts.map((g) => g.elementId)).toEqual([elements[0]])
    // And the host nobody ordered is the other half of the same comparison.
    expect(result.data.orphans.map((o) => o.name)).toEqual(['unrelated-01'])
  })

  it('reports a host nobody ordered as unmanaged rather than as a fault', async () => {
    const { env } = await scaffold({ hostnames: [] })
    answerWith('legacy-01.dc.example.com', 'legacy-02.dc.example.com')

    const result = await reconcileForemanHosts(env.id)

    expect(result.ok && result.data.orphans.map((o) => o.name)).toEqual([
      'legacy-01.dc.example.com',
      'legacy-02.dc.example.com',
    ])
    expect(result.ok && result.data.ghosts).toEqual([])
  })

  it('keeps an element with no host name out of the ghosts', async () => {
    /*
     * "Foreman does not have this host" and "the portal never recorded which
     * host this is" are different problems with different fixes. Collapsing them
     * puts every element of a product whose stack names no host parameter onto a
     * list of machines to go and look for.
     */
    const { env, elements } = await scaffold({ hostnames: ['web-01'], paramName: 'unrelated_param' })
    answerWith('web-01')

    const result = await reconcileForemanHosts(env.id)

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.data.unidentified.map((u) => u.elementId)).toEqual([elements[0]])
    expect(result.data.ghosts).toEqual([])
    // The Foreman host is still unmatched, and still says so.
    expect(result.data.orphans.map((o) => o.name)).toEqual(['web-01'])
  })

  it('reads the host name from the parameter the stack names', async () => {
    // `stateKeyParam` is what the Terraform state key is derived from, which
    // makes it the one value the portal and the machine are known to agree on.
    const { env } = await scaffold({ hostnames: ['db-07'], stateKeyParam: 'vm_name' })
    answerWith('db-07.dc.example.com')

    const result = await reconcileForemanHosts(env.id)

    expect(result.ok && result.data.matched).toHaveLength(1)
    expect(result.ok && result.data.unidentified).toHaveLength(0)
  })

  it('ignores elements that are not active', async () => {
    // An element mid-teardown SHOULD be leaving Foreman, and a decommissioned one
    // is supposed to be gone. Both would report as ghosts for ever.
    const { env, elements } = await scaffold({ hostnames: ['web-01', 'web-02'] })
    await db
      .update(infrastructureElements)
      .set({ status: 'decommissioned' })
      .where(eq(infrastructureElements.id, elements[1]))
    answerWith('web-01')

    const result = await reconcileForemanHosts(env.id)

    expect(result.ok && result.data.matched).toHaveLength(1)
    expect(result.ok && result.data.ghosts).toEqual([])
  })

  it('matches both elements when two orders name the same host', async () => {
    /*
     * Named for what it asserts (CodeRabbit, PR #499): `matched` is "ordered and
     * present", not a one-to-one pairing, so two elements naming one hostname
     * both match the one host. The title used to claim the opposite rule.
     *
     * What `claimed` is for is the orphan list — the host must not also be
     * reported as unmanaged — and the duplicate stays visible as two matched
     * rows carrying the same `foremanHostId`, which is how somebody notices it.
     */
    const { env } = await scaffold({ hostnames: ['web-01', 'web-01'] })
    answerWith('web-01')

    const result = await reconcileForemanHosts(env.id)

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.data.matched).toHaveLength(2)
    expect(new Set(result.data.matched.map((m) => m.foremanHostId)).size).toBe(1)
    expect(result.data.orphans).toEqual([])
  })

  describe('a portal-wide Foreman serving several environments', () => {
    /*
     * CodeRabbit on PR #499, and it was right.
     *
     * `resolveIntegration` falls back to a portal-wide row, so one Foreman can
     * answer for every environment. Its host list therefore covers all of them,
     * while the elements being compared came from the one environment asked
     * about — and every host another environment had ordered fell out as an
     * orphan. "Unmanaged" was the one thing those hosts were not.
     */
    it('does not call another environment’s host unmanaged', async () => {
      const { env } = await scaffold({
        hostnames: ['web-01'],
        otherEnvironmentHostnames: ['staging-01'],
        portalWide: true,
      })
      answerWith('web-01', 'staging-01')

      const result = await reconcileForemanHosts(env.id)

      expect(result.ok).toBe(true)
      if (!result.ok) return
      expect(result.data.matched.map((m) => m.hostName)).toEqual(['web-01'])
      // Claimed by the other environment, so it is neither an orphan here...
      expect(result.data.orphans).toEqual([])
      // ...nor a ghost: this environment never ordered it.
      expect(result.data.ghosts).toEqual([])
    })

    it('still reports a host nobody ordered anywhere', async () => {
      // The scoping must not turn the orphan list off; it only removes hosts
      // that some environment this Foreman serves does account for.
      const { env } = await scaffold({
        hostnames: ['web-01'],
        otherEnvironmentHostnames: ['staging-01'],
        portalWide: true,
      })
      answerWith('web-01', 'staging-01', 'legacy-01')

      const result = await reconcileForemanHosts(env.id)

      expect(result.ok && result.data.orphans.map((o) => o.name)).toEqual(['legacy-01'])
    })
  })

  it('answers 409 when no Foreman is configured for the environment', async () => {
    const { env } = await scaffold({ hostnames: ['web-01'], withForeman: false })
    const listed = vi.spyOn(foreman, 'listForemanHosts')

    const result = await reconcileForemanHosts(env.id)

    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.status).toBe(409)
    expect(result.message).toMatch(/Configure one, enable it/)
    // And nothing was asked of a system that was never configured.
    expect(listed).not.toHaveBeenCalled()
  })

  it('answers 404 for an environment that does not exist', async () => {
    const result = await reconcileForemanHosts(999_999)

    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.status).toBe(404)
  })

  it('answers 502 with the reason when Foreman could not be read', async () => {
    // The portal is fine and Foreman is not, and the distinction matters to
    // whoever is paged.
    const { env } = await scaffold({ hostnames: ['web-01'] })
    vi.spyOn(foreman, 'listForemanHosts').mockResolvedValue({
      ok: false,
      error: 'Rejected the stored credential (HTTP 401)',
    })

    const result = await reconcileForemanHosts(env.id)

    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.status).toBe(502)
    expect(result.message).toContain('House Foreman')
    expect(result.message).toContain('Rejected the stored credential (HTTP 401)')
  })

  it('writes nothing', async () => {
    // Read-only, and the elements are the thing it would be tempting to
    // annotate. A reconciliation that quietly decommissioned a ghost would be
    // the worst possible reading of an inventory nobody has verified.
    const { env, elements } = await scaffold({ hostnames: ['web-01'] })
    answerWith('unrelated-01')

    await reconcileForemanHosts(env.id)

    const [row] = await db
      .select()
      .from(infrastructureElements)
      .where(eq(infrastructureElements.id, elements[0]))
    expect(row.status).toBe('active')
  })
})

describe('hostKey', () => {
  it('reduces a name to the label a comparison can use', () => {
    expect(hostKey('WEB-01.dc.example.com')).toBe('web-01')
    expect(hostKey('  web-01  ')).toBe('web-01')
    expect(hostKey('web-01')).toBe('web-01')
  })
})
