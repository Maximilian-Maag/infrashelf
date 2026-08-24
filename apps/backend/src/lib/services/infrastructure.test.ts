import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { SessionUser } from '@open-hybrid-cloud/types'

vi.mock('@/lib/ci/webhooks', () => ({
  triggerProductWebhooks: vi.fn().mockResolvedValue(['pipe-destroy']),
  triggerPipelineStacks: vi.fn().mockResolvedValue([]),
  // The teardown paths use the *Tracked variants so a trigger that fails to
  // start is reported rather than swallowed.
  triggerProductWebhooksTracked: vi.fn().mockResolvedValue({ pipelineIds: ['pipe-destroy'], failures: [] }),
  triggerPipelineStacksTracked: vi.fn().mockResolvedValue({ pipelineIds: [], failures: [] }),
}))

import {
  listInfrastructure,
  listInfrastructureFacets,
  decommissionInfra,
  retryProvisioning,
  scheduleDecommission,
  sweepDueDecommissions,
} from './infrastructure'
import { triggerProductWebhooksTracked, triggerPipelineStacksTracked } from '@/lib/ci/webhooks'
import { db } from '@/lib/db/client'
import { infrastructureElements, orders, auditLog } from '@/lib/db/schema'
import { eq } from 'drizzle-orm'
import {
  createUser,
  createCategory,
  createProduct,
  createCiSource,
  createEnvironment,
  createProject,
  createOrder as seedOrder,
  createInfraElement,
  linkProductEnvironment,
} from '@/test/helpers'

const makeSession = (u: { id: number; email: string; name: string; role: string }): SessionUser =>
  ({ id: u.id, email: u.email, name: u.name, role: u.role as SessionUser['role'] })

const mockedWebhooks = vi.mocked(triggerProductWebhooksTracked)
const mockedStacks = vi.mocked(triggerPipelineStacksTracked)

beforeEach(() => {
  mockedWebhooks.mockReset().mockResolvedValue({ pipelineIds: ['pipe-destroy'], failures: [] })
  mockedStacks.mockReset().mockResolvedValue({ pipelineIds: [], failures: [] })
})

const setup = async () => {
  const admin = await createUser({ role: 'admin', email: 'admin@test.dev' })
  const pm = await createUser({ role: 'project_manager', email: 'pm@test.dev' })
  const otherPm = await createUser({ role: 'project_manager', email: 'other@test.dev' })
  const cat = await createCategory()
  const product = await createProduct(cat.id, 'P1')
  const product2 = await createProduct(cat.id, 'P2')
  const ci = await createCiSource()
  const env = await createEnvironment(ci.id)
  const project = await createProject(pm.id)
  const otherProject = await createProject(otherPm.id)
  return { admin, pm, otherPm, product, product2, env, project, otherProject }
}

describe('listInfrastructure', () => {
  it('admin sees infra from all projects', async () => {
    const { admin, pm, otherPm, product, env, project, otherProject } = await setup()
    const o1 = await seedOrder(project.id, product.id, env.id, pm.id)
    const o2 = await seedOrder(otherProject.id, product.id, env.id, otherPm.id)
    await createInfraElement(o1.id, project.id, env.id, product.id)
    await createInfraElement(o2.id, otherProject.id, env.id, product.id)

    const result = await listInfrastructure(makeSession(admin), {})
    expect(result.ok).toBe(true)
    if (result.ok) expect(result.data.length).toBe(2)
  })

  it('PM only sees infra from their own projects', async () => {
    const { pm, otherPm, product, env, project, otherProject } = await setup()
    const o1 = await seedOrder(project.id, product.id, env.id, pm.id)
    const o2 = await seedOrder(otherProject.id, product.id, env.id, otherPm.id)
    await createInfraElement(o1.id, project.id, env.id, product.id)
    await createInfraElement(o2.id, otherProject.id, env.id, product.id)

    const result = await listInfrastructure(makeSession(pm), {})
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.data.length).toBe(1)
      expect(result.data[0].projectId).toBe(project.id)
    }
  })

  it('productId filter returns only matching elements', async () => {
    const { admin, pm, product, product2, env, project } = await setup()
    const o1 = await seedOrder(project.id, product.id, env.id, pm.id)
    const o2 = await seedOrder(project.id, product2.id, env.id, pm.id)
    await createInfraElement(o1.id, project.id, env.id, product.id)
    await createInfraElement(o2.id, project.id, env.id, product2.id)

    const result = await listInfrastructure(makeSession(admin), { productId: product.id })
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.data.length).toBe(1)
      expect(result.data[0].productId).toBe(product.id)
    }
  })

  it('projectId filter returns only matching elements', async () => {
    const { admin, pm, otherPm, product, env, project, otherProject } = await setup()
    const o1 = await seedOrder(project.id, product.id, env.id, pm.id)
    const o2 = await seedOrder(otherProject.id, product.id, env.id, otherPm.id)
    await createInfraElement(o1.id, project.id, env.id, product.id)
    await createInfraElement(o2.id, otherProject.id, env.id, product.id)

    const result = await listInfrastructure(makeSession(admin), { projectId: otherProject.id })
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.data.length).toBe(1)
      expect(result.data[0].projectId).toBe(otherProject.id)
    }
  })
})

// Issue #31. The list previously accepted only productId/projectId, so anything
// beyond a couple of dozen elements had to be eyeballed.
describe('listInfrastructure — search, filtering and sorting', () => {
  const searchable = async () => {
    const admin = await createUser({ role: 'admin', email: 'search-admin@test.dev' })
    const pm = await createUser({ role: 'project_manager', email: 'search-pm@test.dev' })
    const cat = await createCategory()
    const nginx = await createProduct(cat.id, 'Nginx Gateway')
    const postgres = await createProduct(cat.id, 'Managed Postgres')
    const ci = await createCiSource()
    const frankfurt = await createEnvironment(ci.id, undefined, 'AWS Frankfurt')
    const vienna = await createEnvironment(ci.id, undefined, 'On-Premise Vienna')
    const webshop = await createProject(pm.id, 'Webshop Platform')
    const billing = await createProject(pm.id, 'Billing Service')

    const mk = async (
      product: { id: number },
      env: { id: number },
      project: { id: number },
      over?: Parameters<typeof createInfraElement>[4],
    ) => {
      const order = await seedOrder(project.id, product.id, env.id, pm.id)
      return createInfraElement(order.id, project.id, env.id, product.id, over)
    }

    return { admin, pm, nginx, postgres, frankfurt, vienna, webshop, billing, mk }
  }

  const names = (rows: { productName: string }[]) => rows.map((r) => r.productName).sort()

  it('matches the search term against the product name', async () => {
    const ctx = await searchable()
    await ctx.mk(ctx.nginx, ctx.frankfurt, ctx.webshop)
    await ctx.mk(ctx.postgres, ctx.frankfurt, ctx.webshop)

    const result = await listInfrastructure(makeSession(ctx.admin), { search: 'nginx' })
    expect(result.ok && names(result.data)).toEqual(['Nginx Gateway'])
  })

  it("filters for failed deployments, which are stored 'active'", async () => {
    // The failure lives on the order — the element is inserted 'active' when
    // provisioning starts — so without this the Failed badge on the row could not
    // be filtered for, and 'Active' silently included it.
    const ctx = await searchable()
    const okOrder = await seedOrder(ctx.webshop.id, ctx.nginx.id, ctx.frankfurt.id, ctx.pm.id)
    await createInfraElement(okOrder.id, ctx.webshop.id, ctx.frankfurt.id, ctx.nginx.id)
    const badOrder = await seedOrder(ctx.billing.id, ctx.postgres.id, ctx.frankfurt.id, ctx.pm.id, {
      status: 'failed',
    })
    await createInfraElement(badOrder.id, ctx.billing.id, ctx.frankfurt.id, ctx.postgres.id)

    const failed = await listInfrastructure(makeSession(ctx.admin), { status: 'failed' })
    expect(failed.ok && names(failed.data)).toEqual(['Managed Postgres'])

    // And 'active' means what the badge beside it says.
    const active = await listInfrastructure(makeSession(ctx.admin), { status: 'active' })
    expect(active.ok && names(active.data)).toEqual(['Nginx Gateway'])
  })

  it('matches the search term against the environment and project name too', async () => {
    const ctx = await searchable()
    await ctx.mk(ctx.nginx, ctx.vienna, ctx.webshop)
    await ctx.mk(ctx.postgres, ctx.frankfurt, ctx.billing)

    const byEnv = await listInfrastructure(makeSession(ctx.admin), { search: 'vienna' })
    expect(byEnv.ok && names(byEnv.data)).toEqual(['Nginx Gateway'])

    const byProject = await listInfrastructure(makeSession(ctx.admin), { search: 'billing' })
    expect(byProject.ok && names(byProject.data)).toEqual(['Managed Postgres'])
  })

  it('searches case-insensitively', async () => {
    const ctx = await searchable()
    await ctx.mk(ctx.nginx, ctx.frankfurt, ctx.webshop)

    const result = await listInfrastructure(makeSession(ctx.admin), { search: 'NGINX gateway' })
    expect(result.ok && result.data.length).toBe(1)
  })

  it('treats LIKE metacharacters in the search term literally', async () => {
    // An unescaped '%' would match every row, so a search that should find
    // nothing would instead look like it found everything.
    const ctx = await searchable()
    await ctx.mk(ctx.nginx, ctx.frankfurt, ctx.webshop)
    await ctx.mk(ctx.postgres, ctx.vienna, ctx.billing)

    for (const search of ['%', '_', 'Nginx%Gateway']) {
      const result = await listInfrastructure(makeSession(ctx.admin), { search })
      expect(result.ok && result.data.length, search).toBe(0)
    }
  })

  it('never widens a PM beyond their own projects when searching', async () => {
    const ctx = await searchable()
    const outsider = await createUser({ role: 'project_manager', email: 'outsider@test.dev' })
    const theirs = await createProject(outsider.id, 'Webshop Platform Copy')
    const order = await seedOrder(theirs.id, ctx.nginx.id, ctx.frankfurt.id, outsider.id)
    await createInfraElement(order.id, theirs.id, ctx.frankfurt.id, ctx.nginx.id)
    await ctx.mk(ctx.nginx, ctx.frankfurt, ctx.webshop)

    // 'webshop' matches both projects by name, but scope wins over the filter.
    const result = await listInfrastructure(makeSession(ctx.pm), { search: 'webshop' })
    expect(result.ok && result.data.length).toBe(1)
    if (result.ok) expect(result.data[0].projectId).toBe(ctx.webshop.id)
  })

  it('filters by status', async () => {
    const ctx = await searchable()
    await ctx.mk(ctx.nginx, ctx.frankfurt, ctx.webshop, { status: 'active' })
    await ctx.mk(ctx.postgres, ctx.frankfurt, ctx.webshop, { status: 'decommissioned' })

    const active = await listInfrastructure(makeSession(ctx.admin), { status: 'active' })
    expect(active.ok && names(active.data)).toEqual(['Nginx Gateway'])

    const gone = await listInfrastructure(makeSession(ctx.admin), { status: 'decommissioned' })
    expect(gone.ok && names(gone.data)).toEqual(['Managed Postgres'])
  })

  it('filters by environment', async () => {
    const ctx = await searchable()
    await ctx.mk(ctx.nginx, ctx.frankfurt, ctx.webshop)
    await ctx.mk(ctx.postgres, ctx.vienna, ctx.webshop)

    const result = await listInfrastructure(makeSession(ctx.admin), { environmentId: ctx.vienna.id })
    expect(result.ok && names(result.data)).toEqual(['Managed Postgres'])
  })

  it('filters by deployed-at range, inclusive of both bounds', async () => {
    const ctx = await searchable()
    await ctx.mk(ctx.nginx, ctx.frankfurt, ctx.webshop, { deployedAt: new Date('2026-03-01T00:00:00.000Z') })
    await ctx.mk(ctx.postgres, ctx.frankfurt, ctx.webshop, { deployedAt: new Date('2026-05-15T12:00:00.000Z') })

    const inRange = await listInfrastructure(makeSession(ctx.admin), {
      deployedFrom: new Date('2026-04-01T00:00:00.000Z'),
      deployedTo: new Date('2026-06-01T00:00:00.000Z'),
    })
    expect(inRange.ok && names(inRange.data)).toEqual(['Managed Postgres'])

    // The lower bound matches the row's exact timestamp — it must be included.
    const onBoundary = await listInfrastructure(makeSession(ctx.admin), {
      deployedFrom: new Date('2026-03-01T00:00:00.000Z'),
      deployedTo: new Date('2026-03-01T00:00:00.000Z'),
    })
    expect(onBoundary.ok && names(onBoundary.data)).toEqual(['Nginx Gateway'])
  })

  it('combines filters conjunctively', async () => {
    const ctx = await searchable()
    await ctx.mk(ctx.nginx, ctx.frankfurt, ctx.webshop, { status: 'active' })
    await ctx.mk(ctx.nginx, ctx.vienna, ctx.webshop, { status: 'active' })
    await ctx.mk(ctx.nginx, ctx.frankfurt, ctx.webshop, { status: 'decommissioned' })

    const result = await listInfrastructure(makeSession(ctx.admin), {
      search: 'nginx',
      environmentId: ctx.frankfurt.id,
      status: 'active',
    })
    expect(result.ok && result.data.length).toBe(1)
  })

  it('defaults to newest-deployed first', async () => {
    const ctx = await searchable()
    await ctx.mk(ctx.nginx, ctx.frankfurt, ctx.webshop, { deployedAt: new Date('2026-01-01T00:00:00.000Z') })
    await ctx.mk(ctx.postgres, ctx.frankfurt, ctx.webshop, { deployedAt: new Date('2026-06-01T00:00:00.000Z') })

    const result = await listInfrastructure(makeSession(ctx.admin), {})
    expect(result.ok && result.data.map((r) => r.productName)).toEqual(['Managed Postgres', 'Nginx Gateway'])
  })

  it('sorts by name and by status in both directions', async () => {
    const ctx = await searchable()
    await ctx.mk(ctx.nginx, ctx.frankfurt, ctx.webshop, { status: 'decommissioned' })
    await ctx.mk(ctx.postgres, ctx.frankfurt, ctx.webshop, { status: 'active' })

    const byName = await listInfrastructure(makeSession(ctx.admin), { sort: 'name', direction: 'asc' })
    expect(byName.ok && byName.data.map((r) => r.productName)).toEqual(['Managed Postgres', 'Nginx Gateway'])

    const byNameDesc = await listInfrastructure(makeSession(ctx.admin), { sort: 'name', direction: 'desc' })
    expect(byNameDesc.ok && byNameDesc.data.map((r) => r.productName)).toEqual(['Nginx Gateway', 'Managed Postgres'])

    const byStatus = await listInfrastructure(makeSession(ctx.admin), { sort: 'status', direction: 'asc' })
    expect(byStatus.ok && byStatus.data.map((r) => r.status)).toEqual(['active', 'decommissioned'])
  })

  it('orders rows sharing a sort key deterministically', async () => {
    // An export is expected to match the list it was taken from, so two rows
    // with the same deploy timestamp must not swap places between requests.
    const ctx = await searchable()
    const deployedAt = new Date('2026-04-01T00:00:00.000Z')
    await ctx.mk(ctx.nginx, ctx.frankfurt, ctx.webshop, { deployedAt })
    await ctx.mk(ctx.postgres, ctx.frankfurt, ctx.webshop, { deployedAt })
    await ctx.mk(ctx.nginx, ctx.vienna, ctx.webshop, { deployedAt })

    const first = await listInfrastructure(makeSession(ctx.admin), {})
    const second = await listInfrastructure(makeSession(ctx.admin), {})
    expect(first.ok && second.ok && first.data.map((r) => r.id)).toEqual(
      second.ok ? second.data.map((r) => r.id) : [],
    )
  })

  it('carries the order status so a failed deployment is distinguishable', async () => {
    // The element is 'active' either way — the order is the only thing that knows
    // the deployment failed.
    const ctx = await searchable()
    const el = await ctx.mk(ctx.nginx, ctx.frankfurt, ctx.webshop)
    await db.update(orders).set({ status: 'failed' }).where(eq(orders.id, el.orderId))

    const result = await listInfrastructure(makeSession(ctx.admin), {})
    expect(result.ok).toBe(true)
    if (!result.ok) return
    const row = result.data.find((r) => r.id === el.id)
    expect(row?.status).toBe('active')
    expect(row?.orderStatus).toBe('failed')
  })

  it('returns an empty list rather than an error when nothing matches', async () => {
    const ctx = await searchable()
    await ctx.mk(ctx.nginx, ctx.frankfurt, ctx.webshop)

    const result = await listInfrastructure(makeSession(ctx.admin), { search: 'no-such-thing' })
    expect(result.ok).toBe(true)
    if (result.ok) expect(result.data).toEqual([])
  })
})

describe('listInfrastructureFacets', () => {
  const searchable = async () => {
    const admin = await createUser({ role: 'admin', email: 'facet-admin@test.dev' })
    const pm = await createUser({ role: 'project_manager', email: 'facet-pm@test.dev' })
    const cat = await createCategory()
    const nginx = await createProduct(cat.id, 'Nginx Gateway')
    const postgres = await createProduct(cat.id, 'Managed Postgres')
    const ci = await createCiSource()
    const frankfurt = await createEnvironment(ci.id, undefined, 'AWS Frankfurt')
    const vienna = await createEnvironment(ci.id, undefined, 'On-Premise Vienna')
    const webshop = await createProject(pm.id, 'Webshop Platform')
    const mk = async (product: { id: number }, env: { id: number }, project: { id: number }) => {
      const order = await seedOrder(project.id, product.id, env.id, pm.id)
      return createInfraElement(order.id, project.id, env.id, product.id)
    }
    return { admin, pm, nginx, postgres, frankfurt, vienna, webshop, mk }
  }

  it('lists each distinct value once, sorted by name', async () => {
    const ctx = await searchable()
    await ctx.mk(ctx.nginx, ctx.vienna, ctx.webshop)
    await ctx.mk(ctx.postgres, ctx.frankfurt, ctx.webshop)
    // A second element in an environment already listed must not duplicate it.
    await ctx.mk(ctx.nginx, ctx.vienna, ctx.webshop)

    const result = await listInfrastructureFacets(makeSession(ctx.admin))
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.data.environments.map((e) => e.name)).toEqual(['AWS Frankfurt', 'On-Premise Vienna'])
    expect(result.data.products.map((p) => p.name)).toEqual(['Managed Postgres', 'Nginx Gateway'])
    expect(result.data.projects.map((p) => p.name)).toEqual(['Webshop Platform'])
  })

  it('omits environments with nothing deployed in them', async () => {
    // Offering one would only let the user filter down to an empty list.
    const ctx = await searchable()
    await ctx.mk(ctx.nginx, ctx.frankfurt, ctx.webshop)

    const result = await listInfrastructureFacets(makeSession(ctx.admin))
    expect(result.ok && result.data.environments.map((e) => e.name)).toEqual(['AWS Frankfurt'])
  })

  it('scopes a PM to their own projects', async () => {
    // The facets must not hint at a project the caller cannot otherwise see.
    const ctx = await searchable()
    const outsider = await createUser({ role: 'project_manager', email: 'facet-outsider@test.dev' })
    const hidden = await createProject(outsider.id, 'Hidden Project')
    const order = await seedOrder(hidden.id, ctx.nginx.id, ctx.vienna.id, outsider.id)
    await createInfraElement(order.id, hidden.id, ctx.vienna.id, ctx.nginx.id)
    await ctx.mk(ctx.postgres, ctx.frankfurt, ctx.webshop)

    const result = await listInfrastructureFacets(makeSession(ctx.pm))
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.data.projects.map((p) => p.name)).toEqual(['Webshop Platform'])
    expect(result.data.environments.map((e) => e.name)).toEqual(['AWS Frankfurt'])

    const asAdmin = await listInfrastructureFacets(makeSession(ctx.admin))
    expect(asAdmin.ok && asAdmin.data.projects.map((p) => p.name)).toEqual([
      'Hidden Project', 'Webshop Platform',
    ])
  })

  it('returns empty lists when there is no infrastructure at all', async () => {
    const ctx = await searchable()
    const result = await listInfrastructureFacets(makeSession(ctx.admin))
    expect(result.ok).toBe(true)
    if (result.ok) expect(result.data).toEqual({ environments: [], projects: [], products: [] })
  })
})

describe('decommissionInfra', () => {
  it('returns 404 for unknown infra', async () => {
    const { admin } = await setup()
    const result = await decommissionInfra(makeSession(admin), 999_999)
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.status).toBe(404)
  })

  it('PM gets 403 when decommissioning another user\'s project infra', async () => {
    const { otherPm, pm, product, env, project } = await setup()
    const order = await seedOrder(project.id, product.id, env.id, pm.id)
    const infra = await createInfraElement(order.id, project.id, env.id, product.id)

    const result = await decommissionInfra(makeSession(otherPm), infra.id)
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.status).toBe(403)
  })

  it('returns 400 when infra status is not active', async () => {
    const { admin, pm, product, env, project } = await setup()
    const order = await seedOrder(project.id, product.id, env.id, pm.id)
    const infra = await createInfraElement(order.id, project.id, env.id, product.id, {
      status: 'decommissioning',
    })

    const result = await decommissionInfra(makeSession(admin), infra.id)
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.status).toBe(400)
  })

  it('admin can decommission any active infra; updates status, triggers webhook with destroy/INFRA_ID', async () => {
    const { admin, pm, product, env, project } = await setup()
    const order = await seedOrder(project.id, product.id, env.id, pm.id)
    const infra = await createInfraElement(order.id, project.id, env.id, product.id)
    mockedWebhooks.mockResolvedValueOnce({ pipelineIds: ['pipe-dc-1'], failures: [] })

    const result = await decommissionInfra(makeSession(admin), infra.id)
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.data.pipelineIds).toEqual(['pipe-dc-1'])

    const [dbInfra] = await db
      .select()
      .from(infrastructureElements)
      .where(eq(infrastructureElements.id, infra.id))
    expect(dbInfra.status).toBe('decommissioning')
    expect(dbInfra.pipelineId).toEqual(['pipe-dc-1'])

    expect(mockedWebhooks).toHaveBeenCalledTimes(1)
    const [pid, eid, vars] = mockedWebhooks.mock.calls[0]
    expect(pid).toBe(product.id)
    expect(eid).toBe(env.id)
    expect(vars).toMatchObject({ TF_ACTION: 'destroy', INFRA_ID: String(infra.id) })
  })

  it('also triggers pipeline-stack destroy and aggregates the returned pipeline ids', async () => {
    const { admin, pm, product, env, project } = await setup()
    const order = await seedOrder(project.id, product.id, env.id, pm.id)
    const infra = await createInfraElement(order.id, project.id, env.id, product.id)
    mockedWebhooks.mockResolvedValueOnce({ pipelineIds: ['pipe-wh'], failures: [] })
    mockedStacks.mockResolvedValueOnce({ pipelineIds: ['pipe-stack'], failures: [] })

    const result = await decommissionInfra(makeSession(admin), infra.id)
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.data.pipelineIds).toEqual(['pipe-wh', 'pipe-stack'])

    const [dbInfra] = await db
      .select()
      .from(infrastructureElements)
      .where(eq(infrastructureElements.id, infra.id))
    expect(dbInfra.pipelineId).toEqual(['pipe-wh', 'pipe-stack'])

    expect(mockedStacks).toHaveBeenCalledTimes(1)
    const [pid, eid, vars] = mockedStacks.mock.calls[0]
    expect(pid).toBe(product.id)
    expect(eid).toBe(env.id)
    expect(vars).toMatchObject({ TF_ACTION: 'destroy', INFRA_ID: String(infra.id) })
  })

  it('PM can decommission their own project\'s active infra', async () => {
    const { pm, product, env, project } = await setup()
    const order = await seedOrder(project.id, product.id, env.id, pm.id)
    const infra = await createInfraElement(order.id, project.id, env.id, product.id)

    const result = await decommissionInfra(makeSession(pm), infra.id)
    expect(result.ok).toBe(true)

    const [dbInfra] = await db
      .select()
      .from(infrastructureElements)
      .where(eq(infrastructureElements.id, infra.id))
    expect(dbInfra.status).toBe('decommissioning')
  })

  it('hands the element back to active and reports an error when NO destroy pipeline could be started', async () => {
    const { admin, pm, product, env, project } = await setup()
    const order = await seedOrder(project.id, product.id, env.id, pm.id)
    const infra = await createInfraElement(order.id, project.id, env.id, product.id)
    mockedWebhooks.mockResolvedValueOnce({ pipelineIds: [], failures: ['product webhook "wh" (#1): boom'] })
    mockedStacks.mockResolvedValueOnce({ pipelineIds: [], failures: [] })

    const result = await decommissionInfra(makeSession(admin), infra.id)
    // Nothing was destroyed, so this must not read as a started decommission.
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.status).toBe(502)
      expect(result.message).toContain('boom')
    }

    const [dbInfra] = await db
      .select()
      .from(infrastructureElements)
      .where(eq(infrastructureElements.id, infra.id))
    // Back to active so the operator can retry.
    expect(dbInfra.status).toBe('active')
  })

  it('reports a partial destroy and records a sentinel so the teardown cannot self-complete', async () => {
    const { admin, pm, product, env, project } = await setup()
    const order = await seedOrder(project.id, product.id, env.id, pm.id)
    const infra = await createInfraElement(order.id, project.id, env.id, product.id)
    mockedWebhooks.mockResolvedValueOnce({ pipelineIds: ['pipe-wh'], failures: [] })
    mockedStacks.mockResolvedValueOnce({ pipelineIds: [], failures: ['pipeline stack "s" (#7): refused'] })

    const result = await decommissionInfra(makeSession(admin), infra.id)
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.status).toBe(502)
      expect(result.message).toContain('refused')
    }

    const [dbInfra] = await db
      .select()
      .from(infrastructureElements)
      .where(eq(infrastructureElements.id, infra.id))
    // The webhook destroy IS running, so the element cannot go back to active.
    expect(dbInfra.status).toBe('decommissioning')
    expect(dbInfra.pipelineId).toEqual(['pipe-wh'])
    // The sentinel is what stops pipe-wh's success from reporting a complete
    // teardown while the stack was never destroyed.
    expect(dbInfra.pipelineStatus).toEqual({
      'trigger-failed:0': 'pipeline stack "s" (#7): refused',
    })
  })

  it('starts a clean decommission with an empty pipeline-status map', async () => {
    const { admin, pm, product, env, project } = await setup()
    const order = await seedOrder(project.id, product.id, env.id, pm.id)
    const infra = await createInfraElement(order.id, project.id, env.id, product.id)

    const result = await decommissionInfra(makeSession(admin), infra.id)
    expect(result.ok).toBe(true)

    const [dbInfra] = await db
      .select()
      .from(infrastructureElements)
      .where(eq(infrastructureElements.id, infra.id))
    expect(dbInfra.pipelineStatus).toEqual({})
  })
})

// Issue #29. Note the failure model the issue describes does not exist here:
// there is no `failed` infrastructure status. The element is inserted `active`
// when provisioning STARTS, and a failed pipeline sets orders.status = 'failed'
// while leaving the element `active`. The retryable condition is on the order.
describe('retryProvisioning', () => {
  const failedDeployment = async (orderStatus = 'failed') => {
    const admin = await createUser({ role: 'admin', email: 'retry-admin@test.dev' })
    const pm = await createUser({ role: 'project_manager', email: 'retry-pm@test.dev' })
    const cat = await createCategory()
    const product = await createProduct(cat.id, 'Nginx Gateway')
    const ci = await createCiSource()
    const env = await createEnvironment(ci.id)
    const project = await createProject(pm.id)
    const order = await seedOrder(project.id, product.id, env.id, pm.id, {
      status: orderStatus,
      pipelineId: ['old-pipe'],
    })
    await db
      .update(orders)
      .set({ parameters: { hostname: 'web-01' }, pipelineStatus: { 'old-pipe': 'failed' } })
      .where(eq(orders.id, order.id))
    const el = await createInfraElement(order.id, project.id, env.id, product.id, {
      parameters: { hostname: 'web-01' },
      pipelineId: ['old-pipe'],
    })
    return { admin, pm, product, env, project, order, el }
  }

  const orderRow = async (id: number) =>
    (await db.select().from(orders).where(eq(orders.id, id)))[0]
  const infraRow = async (id: number) =>
    (await db.select().from(infrastructureElements).where(eq(infrastructureElements.id, id)))[0]

  it('returns 404 for an unknown element', async () => {
    const { admin } = await failedDeployment()
    const result = await retryProvisioning(makeSession(admin), 999_999)
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.status).toBe(404)
  })

  it.each(['completed', 'provisioning', 'pending', 'rejected'])(
    'refuses to retry an order that is %s',
    async (status) => {
      const { admin, el } = await failedDeployment(status)
      const result = await retryProvisioning(makeSession(admin), el.id)
      expect(result.ok).toBe(false)
      if (!result.ok) {
        expect(result.status).toBe(400)
        expect(result.message).toMatch(new RegExp(status))
      }
    },
  )

  it('re-fires both trigger kinds with the ORIGINAL parameters', async () => {
    // A retry must not quietly provision something different from what was
    // approved, so the parameters come from the stored element.
    const { admin, product, env, el } = await failedDeployment()
    mockedWebhooks.mockResolvedValue({ pipelineIds: ['new-webhook'], failures: [] })
    mockedStacks.mockResolvedValue({ pipelineIds: ['new-stack'], failures: [] })

    const result = await retryProvisioning(makeSession(admin), el.id)
    expect(result.ok).toBe(true)
    if (result.ok) expect(result.data.pipelineIds).toEqual(['new-webhook', 'new-stack'])

    for (const mock of [mockedWebhooks, mockedStacks]) {
      expect(mock).toHaveBeenCalledWith(
        product.id,
        env.id,
        expect.objectContaining({ hostname: 'web-01' }),
        expect.any(Function),
      )
    }
  })

  it('reuses the original ORDER_ID so the retry targets the same Terraform state', async () => {
    const { admin, el, order } = await failedDeployment()
    mockedWebhooks.mockResolvedValue({ pipelineIds: ['new-pipe'], failures: [] })
    mockedStacks.mockResolvedValue({ pipelineIds: [], failures: [] })

    await retryProvisioning(makeSession(admin), el.id)
    expect(mockedWebhooks).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      expect.objectContaining({ ORDER_ID: String(order.id) }),
      // The recorder that stores each pipeline id as it starts (issue #132).
      expect.any(Function),
    )
  })

  it('retries an element provisioned before #183 against the state key it already has', async () => {
    // `failedDeployment` leaves state_key_namespace NULL, as every row written
    // before the column existed is. Sending a namespace now would make the retry
    // apply into a fresh state and leave the half-built infrastructure of the
    // failed attempt orphaned.
    const { admin, el } = await failedDeployment()
    mockedWebhooks.mockResolvedValue({ pipelineIds: ['new-pipe'], failures: [] })

    await retryProvisioning(makeSession(admin), el.id)

    const vars = mockedWebhooks.mock.calls[0][2] as Record<string, string>
    expect(vars).not.toHaveProperty('TF_STATE_NAMESPACE')
  })

  it("carries a namespaced element's own namespace into the retry (issue #183)", async () => {
    const { admin, el } = await failedDeployment()
    await db
      .update(infrastructureElements)
      .set({ stateKeyNamespace: '99', parameters: { hostname: 'web-01', REF: 'attacker/branch' } })
      .where(eq(infrastructureElements.id, el.id))
    mockedWebhooks.mockResolvedValue({ pipelineIds: ['new-pipe'], failures: [] })

    await retryProvisioning(makeSession(admin), el.id)

    const vars = mockedWebhooks.mock.calls[0][2] as Record<string, string>
    expect(vars.TF_STATE_NAMESPACE).toBe('99')
    // And a stored parameter still cannot choose which git ref the rerun uses.
    expect(vars).not.toHaveProperty('REF')
  })

  it('resets the order to provisioning and clears the previous attempt tracking', async () => {
    const { admin, el, order } = await failedDeployment()
    mockedWebhooks.mockResolvedValue({ pipelineIds: ['new-pipe'], failures: [] })
    mockedStacks.mockResolvedValue({ pipelineIds: [], failures: [] })

    await retryProvisioning(makeSession(admin), el.id)

    const updated = await orderRow(order.id)
    expect(updated.status).toBe('provisioning')
    // The failed attempt's ids and statuses must be gone, or the callback
    // handler would still be reconciling against them.
    expect(updated.pipelineId).toEqual(['new-pipe'])
    expect(updated.pipelineStatus).toEqual({})
  })

  it('repoints the element at the new pipelines and clears stale outputs', async () => {
    const { admin, el } = await failedDeployment()
    await db.update(infrastructureElements).set({ outputs: { ip: '10.0.0.1' } }).where(eq(infrastructureElements.id, el.id))
    mockedWebhooks.mockResolvedValue({ pipelineIds: ['new-pipe'], failures: [] })
    mockedStacks.mockResolvedValue({ pipelineIds: [], failures: [] })

    await retryProvisioning(makeSession(admin), el.id)

    const updated = await infraRow(el.id)
    expect(updated.pipelineId).toEqual(['new-pipe'])
    expect(updated.pipelineStatus).toEqual({})
    // Outputs described infrastructure this retry is about to replace.
    expect(updated.outputs).toEqual({})
    expect(updated.status).toBe('active')
  })

  it('records an infra.retried audit entry', async () => {
    const { admin, el } = await failedDeployment()
    mockedWebhooks.mockResolvedValue({ pipelineIds: ['new-pipe'], failures: [] })
    mockedStacks.mockResolvedValue({ pipelineIds: [], failures: [] })

    await retryProvisioning(makeSession(admin), el.id)

    const entries = await db.select().from(auditLog).where(eq(auditLog.action, 'infra.retried'))
    expect(entries).toHaveLength(1)
    expect(entries[0].entityId).toBe(el.id)
    expect(entries[0].userId).toBe(admin.id)
  })

  it('hands the order back to failed when nothing could be started', async () => {
    // Otherwise it would sit in 'provisioning' forever, waiting for a callback
    // that no pipeline will ever send — and the Retry button would be gone.
    const { admin, el, order } = await failedDeployment()
    mockedWebhooks.mockResolvedValue({ pipelineIds: [], failures: ['webhook "a" (#1): boom'] })
    mockedStacks.mockResolvedValue({ pipelineIds: [], failures: [] })

    const result = await retryProvisioning(makeSession(admin), el.id)
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.status).toBe(502)
      expect(result.message).toMatch(/could not start/i)
    }

    expect((await orderRow(order.id)).status).toBe('failed')
    const entries = await db.select().from(auditLog).where(eq(auditLog.action, 'infra.retry_failed'))
    expect(entries).toHaveLength(1)
  })

  it('hands the order back to failed when a trigger throws outright', async () => {
    const { admin, el, order } = await failedDeployment()
    mockedWebhooks.mockRejectedValue(new Error('CI unreachable'))

    await expect(retryProvisioning(makeSession(admin), el.id)).rejects.toThrow('CI unreachable')
    expect((await orderRow(order.id)).status).toBe('failed')
  })

  it('reports a partial retry and records a sentinel so it cannot complete silently', async () => {
    // Started pipelines cannot be recalled, so the order stays 'provisioning' —
    // but a trigger that never fired contributes no pipeline id, so without the
    // sentinel the order would complete as soon as the others succeed.
    const { admin, el, order } = await failedDeployment()
    mockedWebhooks.mockResolvedValue({ pipelineIds: ['started'], failures: [] })
    mockedStacks.mockResolvedValue({ pipelineIds: [], failures: ['stack "b" (#2): boom'] })

    const result = await retryProvisioning(makeSession(admin), el.id)
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.status).toBe(502)
      expect(result.message).toMatch(/could not be started/i)
    }

    const updated = await orderRow(order.id)
    expect(updated.status).toBe('provisioning')
    expect(updated.pipelineId).toEqual(['started'])
    expect(updated.pipelineStatus).toMatchObject({ 'trigger-failed:0': 'stack "b" (#2): boom' })
    // The attempt still happened, so it is still audited as a retry.
    const entries = await db.select().from(auditLog).where(eq(auditLog.action, 'infra.retried'))
    expect(entries).toHaveLength(1)
  })

  it('lets only one of two concurrent retries fire pipelines', async () => {
    const { admin, el } = await failedDeployment()
    mockedWebhooks.mockResolvedValue({ pipelineIds: ['new-pipe'], failures: [] })
    mockedStacks.mockResolvedValue({ pipelineIds: [], failures: [] })

    const [first, second] = await Promise.all([
      retryProvisioning(makeSession(admin), el.id),
      retryProvisioning(makeSession(admin), el.id),
    ])

    // Exactly one wins the failed → provisioning claim; a double-clicked Retry
    // must not fire two sets of pipelines at the same infrastructure.
    const outcomes = [first.ok, second.ok].filter(Boolean)
    expect(outcomes).toHaveLength(1)
    const loser = first.ok ? second : first
    if (!loser.ok) expect([400, 409]).toContain(loser.status)
    expect(mockedWebhooks).toHaveBeenCalledTimes(1)
  })
})

// Issue #30. The issue asks for the polling worker to be extended; there is no
// polling worker (status arrives by webhook) and the backend is horizontally
// scaled, so the sweep is an explicit call an external scheduler drives. What
// makes that safe is the atomic claim inside claimAndDestroy, which these tests
// lean on directly.
describe('retryProvisioning — trials (issue #1 × #29)', () => {
  const failedTrial = async (trialDurationMinutes = 45) => {
    const admin = await createUser({ role: 'admin', email: 'retry-trial-admin@test.dev' })
    const pm = await createUser({ role: 'project_manager', email: 'retry-trial-pm@test.dev' })
    const cat = await createCategory()
    const product = await createProduct(cat.id, 'Trial Product')
    const ci = await createCiSource()
    const env = await createEnvironment(ci.id)
    await linkProductEnvironment(product.id, env.id, { trialEnabled: true, trialDurationMinutes })
    const project = await createProject(pm.id)
    const order = await seedOrder(project.id, product.id, env.id, pm.id, {
      status: 'failed',
      isTrial: true,
    })
    const el = await createInfraElement(order.id, project.id, env.id, product.id, {
      parameters: { hostname: 'trial-01' },
    })
    return { admin, el, order }
  }

  it('re-sends the trial variables the stored parameters cannot carry', async () => {
    // TRIAL and TRIAL_DURATION_MINUTES are server-generated at provisioning, so a
    // retry that only replayed the element's parameters silently turned a trial
    // into an ordinary deployment.
    const { admin, el } = await failedTrial(45)
    mockedWebhooks.mockResolvedValue({ pipelineIds: ['trial-pipe'], failures: [] })

    const result = await retryProvisioning(makeSession(admin), el.id)
    expect(result.ok).toBe(true)

    const vars = mockedWebhooks.mock.calls[0][2] as Record<string, string>
    expect(vars.TRIAL).toBe('true')
    expect(vars.TRIAL_DURATION_MINUTES).toBe('45')
    expect(vars.hostname).toBe('trial-01')
  })

  it('restarts the trial clock, so the sweep does not tear the retry down at once', async () => {
    const { admin, el } = await failedTrial(45)
    // The first attempt's window has already run out.
    await db
      .update(infrastructureElements)
      .set({ scheduledDecommissionAt: new Date('2020-01-01T00:00:00.000Z') })
      .where(eq(infrastructureElements.id, el.id))
    mockedWebhooks.mockResolvedValue({ pipelineIds: ['trial-pipe'], failures: [] })

    await retryProvisioning(makeSession(admin), el.id)

    const [row] = await db
      .select()
      .from(infrastructureElements)
      .where(eq(infrastructureElements.id, el.id))
    expect(row.scheduledDecommissionAt?.getTime() ?? 0).toBeGreaterThan(Date.now())
  })

  it('leaves a hand-scheduled decommission alone on a non-trial retry', async () => {
    // Issue #30's schedule is an operator's decision and must survive a retry.
    const admin = await createUser({ role: 'admin', email: 'retry-sched-admin@test.dev' })
    const pm = await createUser({ role: 'project_manager', email: 'retry-sched-pm@test.dev' })
    const cat = await createCategory()
    const product = await createProduct(cat.id, 'Plain Product')
    const ci = await createCiSource()
    const env = await createEnvironment(ci.id)
    const project = await createProject(pm.id)
    const order = await seedOrder(project.id, product.id, env.id, pm.id, { status: 'failed' })
    const el = await createInfraElement(order.id, project.id, env.id, product.id)
    const scheduled = new Date('2099-06-01T14:30:00.000Z')
    await db
      .update(infrastructureElements)
      .set({ scheduledDecommissionAt: scheduled })
      .where(eq(infrastructureElements.id, el.id))
    mockedWebhooks.mockResolvedValue({ pipelineIds: ['pipe'], failures: [] })

    await retryProvisioning(makeSession(admin), el.id)

    const [row] = await db
      .select()
      .from(infrastructureElements)
      .where(eq(infrastructureElements.id, el.id))
    expect(row.scheduledDecommissionAt?.toISOString()).toBe(scheduled.toISOString())
    const vars = mockedWebhooks.mock.calls[0][2] as Record<string, string>
    expect(vars.TRIAL).toBeUndefined()
  })
})

describe('scheduleDecommission', () => {
  const build = async () => {
    const admin = await createUser({ role: 'admin', email: 'sched-admin@test.dev' })
    const pm = await createUser({ role: 'project_manager', email: 'sched-pm@test.dev' })
    const outsider = await createUser({ role: 'project_manager', email: 'sched-outsider@test.dev' })
    const cat = await createCategory()
    const product = await createProduct(cat.id, 'P')
    const ci = await createCiSource()
    const env = await createEnvironment(ci.id)
    const project = await createProject(pm.id)
    const order = await seedOrder(project.id, product.id, env.id, pm.id)
    const el = await createInfraElement(order.id, project.id, env.id, product.id)
    return { admin, pm, outsider, product, env, project, el }
  }

  const row = async (id: number) =>
    (await db.select().from(infrastructureElements).where(eq(infrastructureElements.id, id)))[0]

  const future = () => new Date(Date.now() + 60 * 60 * 1000)

  it('returns 404 for an unknown element', async () => {
    const { admin } = await build()
    const result = await scheduleDecommission(makeSession(admin), 999_999, future())
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.status).toBe(404)
  })

  it('stores a future time', async () => {
    const { admin, el } = await build()
    const at = future()
    const result = await scheduleDecommission(makeSession(admin), el.id, at)
    expect(result.ok).toBe(true)
    expect((await row(el.id)).scheduledDecommissionAt?.getTime()).toBe(at.getTime())
  })

  it('clears the schedule when passed null', async () => {
    const { admin, el } = await build()
    await scheduleDecommission(makeSession(admin), el.id, future())
    const result = await scheduleDecommission(makeSession(admin), el.id, null)
    expect(result.ok).toBe(true)
    expect((await row(el.id)).scheduledDecommissionAt).toBeNull()
  })

  it('refuses a time in the past', async () => {
    // It would be swept on the very next run — that is a decommission, not a
    // schedule, so say so rather than silently tearing something down.
    const { admin, el } = await build()
    const result = await scheduleDecommission(makeSession(admin), el.id, new Date(Date.now() - 1000))
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.message).toMatch(/must be in the future/i)
    expect((await row(el.id)).scheduledDecommissionAt).toBeNull()
  })

  it.each(['decommissioning', 'decommissioned'])('refuses to schedule a %s element', async (status) => {
    const { admin, el } = await build()
    await db.update(infrastructureElements).set({ status: status as 'decommissioning' }).where(eq(infrastructureElements.id, el.id))

    const result = await scheduleDecommission(makeSession(admin), el.id, future())
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.status).toBe(400)
  })

  it('lets the owning PM schedule their own element', async () => {
    const { pm, el } = await build()
    const result = await scheduleDecommission(makeSession(pm), el.id, future())
    expect(result.ok).toBe(true)
  })

  it('forbids a PM from scheduling somebody else\'s element', async () => {
    // Scheduling is a deferred teardown, so it cannot be a lower bar than doing
    // it now.
    const { outsider, el } = await build()
    const result = await scheduleDecommission(makeSession(outsider), el.id, future())
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.status).toBe(403)
    expect((await row(el.id)).scheduledDecommissionAt).toBeNull()
  })

  it('audits both setting and clearing', async () => {
    const { admin, el } = await build()
    await scheduleDecommission(makeSession(admin), el.id, future())
    await scheduleDecommission(makeSession(admin), el.id, null)

    const actions = (await db.select().from(auditLog).where(eq(auditLog.entityId, el.id))).map((a) => a.action)
    expect(actions).toContain('infra.decommission_scheduled')
    expect(actions).toContain('infra.decommission_schedule_cleared')
  })
})

describe('sweepDueDecommissions', () => {
  const build = async () => {
    const pm = await createUser({ role: 'project_manager', email: 'sweep-pm@test.dev' })
    const cat = await createCategory()
    const product = await createProduct(cat.id, 'P')
    const ci = await createCiSource()
    const env = await createEnvironment(ci.id)
    const project = await createProject(pm.id)
    const mk = async (scheduledDecommissionAt: Date | null, status = 'active') => {
      const order = await seedOrder(project.id, product.id, env.id, pm.id)
      const el = await createInfraElement(order.id, project.id, env.id, product.id, { status })
      if (scheduledDecommissionAt) {
        await db
          .update(infrastructureElements)
          .set({ scheduledDecommissionAt })
          .where(eq(infrastructureElements.id, el.id))
      }
      return el
    }
    return { pm, mk }
  }

  const status = async (id: number) =>
    (await db.select().from(infrastructureElements).where(eq(infrastructureElements.id, id)))[0].status

  const past = new Date('2026-01-01T00:00:00.000Z')
  const later = new Date('2099-01-01T00:00:00.000Z')

  it('tears down an element whose time has arrived', async () => {
    const { mk } = await build()
    const due = await mk(past)

    const result = await sweepDueDecommissions()
    expect(result.decommissioned).toEqual([due.id])
    expect(result.failed).toEqual([])
    expect(await status(due.id)).toBe('decommissioning')
    expect(mockedWebhooks).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      expect.objectContaining({ TF_ACTION: 'destroy' }),
      expect.any(Function),
    )
  })

  it('leaves an element whose time has not arrived alone', async () => {
    const { mk } = await build()
    const notDue = await mk(later)

    const result = await sweepDueDecommissions()
    expect(result.decommissioned).toEqual([])
    expect(await status(notDue.id)).toBe('active')
    expect(mockedWebhooks).not.toHaveBeenCalled()
  })

  it('ignores elements with no schedule', async () => {
    const { mk } = await build()
    const unscheduled = await mk(null)

    const result = await sweepDueDecommissions()
    expect(result.decommissioned).toEqual([])
    expect(await status(unscheduled.id)).toBe('active')
  })

  it('ignores an element that is already tearing down', async () => {
    // Its schedule is moot; re-firing would double-destroy.
    const { mk } = await build()
    await mk(past, 'decommissioning')

    const result = await sweepDueDecommissions()
    expect(result.decommissioned).toEqual([])
    expect(mockedWebhooks).not.toHaveBeenCalled()
  })

  it('treats the exact scheduled instant as due', async () => {
    const { mk } = await build()
    const at = new Date('2026-06-01T12:00:00.000Z')
    const el = await mk(at)

    const result = await sweepDueDecommissions(at)
    expect(result.decommissioned).toEqual([el.id])
  })

  it('handles each element independently when one product is broken', async () => {
    // One broken product's triggers must not stop the rest of the sweep.
    const { mk } = await build()
    const first = await mk(new Date('2026-01-01T00:00:00.000Z'))
    const second = await mk(new Date('2026-02-01T00:00:00.000Z'))

    mockedWebhooks
      .mockResolvedValueOnce({ pipelineIds: [], failures: ['webhook "a" (#1): boom'] })
      .mockResolvedValueOnce({ pipelineIds: ['pipe-ok'], failures: [] })

    const result = await sweepDueDecommissions()
    expect(result.failed.map((f) => f.infraId)).toEqual([first.id])
    expect(result.decommissioned).toEqual([second.id])
    // Nothing started for the first, so it is back to active and the next sweep
    // will try again.
    expect(await status(first.id)).toBe('active')
    expect(await status(second.id)).toBe('decommissioning')
  })

  it('keeps a thrown trigger from aborting the sweep', async () => {
    const { mk } = await build()
    const first = await mk(new Date('2026-01-01T00:00:00.000Z'))
    const second = await mk(new Date('2026-02-01T00:00:00.000Z'))

    mockedWebhooks
      .mockRejectedValueOnce(new Error('CI unreachable'))
      .mockResolvedValueOnce({ pipelineIds: ['pipe-ok'], failures: [] })

    const result = await sweepDueDecommissions()
    expect(result.failed.map((f) => f.infraId)).toEqual([first.id])
    expect(result.decommissioned).toEqual([second.id])
    expect(await status(first.id)).toBe('active')
  })

  it('is idempotent — a second sweep finds nothing left to do', async () => {
    const { mk } = await build()
    await mk(past)

    const first = await sweepDueDecommissions()
    const second = await sweepDueDecommissions()
    expect(first.decommissioned).toHaveLength(1)
    // The claim moved it out of 'active', so a replayed or overlapping sweep is
    // a no-op rather than a second destroy.
    expect(second.decommissioned).toEqual([])
    expect(mockedWebhooks).toHaveBeenCalledTimes(1)
  })

  it('fires nothing twice when two sweeps run concurrently', async () => {
    const { mk } = await build()
    await mk(past)

    const [a, b] = await Promise.all([sweepDueDecommissions(), sweepDueDecommissions()])
    expect([...a.decommissioned, ...b.decommissioned]).toHaveLength(1)
    expect(mockedWebhooks).toHaveBeenCalledTimes(1)
  })

  it('audits the teardown as system-initiated', async () => {
    const { mk } = await build()
    const el = await mk(past)

    await sweepDueDecommissions()
    const entries = await db.select().from(auditLog).where(eq(auditLog.entityId, el.id))
    const scheduled = entries.find((e) => e.action === 'infra.decommissioning')
    // No user asked for it interactively, matching how the webhook handler
    // audits callback-driven transitions.
    expect(scheduled?.userId).toBeNull()
    expect(scheduled?.details).toMatch(/by schedule/i)
  })

  it('processes the earliest-due element first', async () => {
    const { mk } = await build()
    const later = await mk(new Date('2026-05-01T00:00:00.000Z'))
    const earlier = await mk(new Date('2026-01-01T00:00:00.000Z'))

    const result = await sweepDueDecommissions()
    expect(result.decommissioned).toEqual([earlier.id, later.id])
  })

  it('returns empty lists when nothing is due', async () => {
    await build()
    const result = await sweepDueDecommissions()
    expect(result).toEqual({ decommissioned: [], failed: [] })
  })
})
