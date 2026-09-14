import { describe, it, expect } from 'vitest'
import {
  createCategory,
  createProduct,
  createCiSource,
  createEnvironment,
  createUser,
  createProject,
  createOrder,
  createInfraElement,
} from '@/test/helpers'
import { db } from '@/lib/db/client'
import { pipelineStacks, auditLog } from '@/lib/db/schema'
import { eq } from 'drizzle-orm'
import {
  listPipelineStacks,
  createPipelineStack,
  updatePipelineStack,
  deletePipelineStack,
} from './pipeline-stacks'

const STEPS = [
  { template: 'linode/virtual-machine', stateSuffix: '-vm', execOrder: 0 },
  {
    template: 'linode/firewall',
    stateSuffix: '-fw',
    execOrder: 1,
    upstreamRefs: [{ varName: 'VM_STATE_NAME', suffix: '-vm' }],
  },
]

const seedStack = async () => {
  const cat = await createCategory()
  const p = await createProduct(cat.id)
  const ci = await createCiSource()
  const env = await createEnvironment(ci.id)
  const [stack] = await db.insert(pipelineStacks).values({
    productId: p.id,
    environmentId: env.id,
    name: 'Seed Stack',
    stateKeyParam: 'hostname',
    steps: STEPS,
  }).returning()
  return { p, env, stack }
}

describe('listPipelineStacks', () => {
  it('returns empty array for product with no stacks', async () => {
    const cat = await createCategory()
    const p = await createProduct(cat.id)
    const result = await listPipelineStacks(p.id)
    expect(result.ok).toBe(true)
    if (result.ok) expect(result.data).toEqual([])
  })

  it('returns stacks belonging to the given product', async () => {
    const { p } = await seedStack()
    const result = await listPipelineStacks(p.id)
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.data.length).toBeGreaterThanOrEqual(1)
      expect(result.data[0].name).toBe('Seed Stack')
      expect(result.data[0].steps).toHaveLength(2)
    }
  })

  it('lists the stacks in a defined order (#402)', async () => {
    // Without an ORDER BY the list an administrator reads reshuffles between two
    // page loads for no reason they can see. Names chosen so a plan that
    // happened to sort by name would fail this — they come back in the order
    // they were added, not alphabetically.
    const { p, env } = await seedStack()
    for (const name of ['Zulu Stack', 'Alpha Stack']) {
      await db.insert(pipelineStacks).values({
        productId: p.id, environmentId: env.id, name, stateKeyParam: 'hostname', steps: STEPS,
      })
    }

    const result = await listPipelineStacks(p.id)
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.data.map((s) => s.name)).toEqual(['Seed Stack', 'Zulu Stack', 'Alpha Stack'])
  })

  it('does not return stacks belonging to a different product', async () => {
    const { stack } = await seedStack()
    const cat2 = await createCategory()
    const p2 = await createProduct(cat2.id)
    const result = await listPipelineStacks(p2.id)
    expect(result.ok).toBe(true)
    if (result.ok) expect(result.data.map((s) => s.id)).not.toContain(stack.id)
  })
})

describe('createPipelineStack', () => {
  it('creates a stack with all fields and returns it', async () => {
    const cat = await createCategory()
    const p = await createProduct(cat.id)
    const ci = await createCiSource()
    const env = await createEnvironment(ci.id)
    const result = await createPipelineStack(p.id, {
      environmentId: env.id,
      name: 'VM Stack',
      stateKeyParam: 'hostname',
      steps: STEPS,
    })
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.data.name).toBe('VM Stack')
      expect(result.data.productId).toBe(p.id)
      expect(result.data.environmentId).toBe(env.id)
      expect(result.data.stateKeyParam).toBe('hostname')
      expect(result.data.steps).toHaveLength(2)
      expect(result.data.steps[0].template).toBe('linode/virtual-machine')
      expect(result.data.steps[1].upstreamRefs?.[0]?.varName).toBe('VM_STATE_NAME')
      expect(result.data.steps[1].upstreamRefs?.[0]?.suffix).toBe('-vm')
      expect(result.data.steps[1].execOrder).toBe(1)
    }
  })

  it('accepts multiple upstreamRefs per step', async () => {
    const cat = await createCategory()
    const p = await createProduct(cat.id)
    const ci = await createCiSource()
    const env = await createEnvironment(ci.id)
    const steps = [
      { template: 'linode/virtual-machine', stateSuffix: '-vm', execOrder: 0 },
      { template: 'linode/dns-record', stateSuffix: '-dns', execOrder: 0 },
      {
        template: 'linode/firewall',
        stateSuffix: '-fw',
        execOrder: 1,
        upstreamRefs: [
          { varName: 'VM_STATE_NAME', suffix: '-vm' },
          { varName: 'DNS_STATE_NAME', suffix: '-dns' },
        ],
      },
    ]
    const result = await createPipelineStack(p.id, {
      environmentId: env.id,
      name: 'Multi-upstream',
      steps,
    })
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.data.steps[2].upstreamRefs).toHaveLength(2)
      expect(result.data.steps[2].upstreamRefs?.map((r) => r.varName).sort())
        .toEqual(['DNS_STATE_NAME', 'VM_STATE_NAME'])
    }
  })

  it('persists execOrder for parallel and sequential steps', async () => {
    const cat = await createCategory()
    const p = await createProduct(cat.id)
    const ci = await createCiSource()
    const env = await createEnvironment(ci.id)
    const result = await createPipelineStack(p.id, {
      environmentId: env.id,
      name: 'Parallel',
      steps: [
        { template: 'linode/virtual-machine', stateSuffix: '-a', execOrder: 0 },
        { template: 'linode/virtual-machine', stateSuffix: '-b', execOrder: 0 },
        { template: 'linode/firewall', stateSuffix: '-fw', execOrder: 5 },
      ],
    })
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.data.steps.map((s) => s.execOrder)).toEqual([0, 0, 5])
    }
  })

  it('defaults stateKeyParam to "hostname" when omitted', async () => {
    const cat = await createCategory()
    const p = await createProduct(cat.id)
    const ci = await createCiSource()
    const env = await createEnvironment(ci.id)
    const result = await createPipelineStack(p.id, {
      environmentId: env.id,
      name: 'Stack',
      steps: STEPS,
    })
    expect(result.ok).toBe(true)
    if (result.ok) expect(result.data.stateKeyParam).toBe('hostname')
  })

  it('persists fixedParams inside steps', async () => {
    const cat = await createCategory()
    const p = await createProduct(cat.id)
    const ci = await createCiSource()
    const env = await createEnvironment(ci.id)
    const stepsWithFixed = [
      { template: 'linode/virtual-machine', stateSuffix: '-vm', fixedParams: { LINODE_REGION: 'eu-central' } },
    ]
    const result = await createPipelineStack(p.id, {
      environmentId: env.id,
      name: 'Stack with fixed params',
      steps: stepsWithFixed,
    })
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.data.steps[0].fixedParams?.LINODE_REGION).toBe('eu-central')
    }
  })
})

describe('updatePipelineStack', () => {
  it('updates name only, leaving other fields unchanged', async () => {
    const { p, stack } = await seedStack()
    const result = await updatePipelineStack(p.id, stack.id, { name: 'Renamed Stack' })
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.data.name).toBe('Renamed Stack')
      expect(result.data.stateKeyParam).toBe('hostname')
      expect(result.data.steps).toHaveLength(2)
    }
  })

  it('updates stateKeyParam', async () => {
    const { p, stack } = await seedStack()
    const result = await updatePipelineStack(p.id, stack.id, { stateKeyParam: 'vm_name' })
    expect(result.ok).toBe(true)
    if (result.ok) expect(result.data.stateKeyParam).toBe('vm_name')
  })

  it('replaces steps entirely', async () => {
    const { p, stack } = await seedStack()
    const newSteps = [{ template: 'vsphere/virtual-machine', stateSuffix: '-vsvm' }]
    const result = await updatePipelineStack(p.id, stack.id, { steps: newSteps })
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.data.steps).toHaveLength(1)
      expect(result.data.steps[0].template).toBe('vsphere/virtual-machine')
    }
  })

  it('returns 404 for non-existent stack ID', async () => {
    const { p } = await seedStack()
    const result = await updatePipelineStack(p.id, 999999, { name: 'ghost' })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.status).toBe(404)
  })

  it('returns 404 when stackId belongs to a different product', async () => {
    const { stack } = await seedStack()
    const cat2 = await createCategory()
    const p2 = await createProduct(cat2.id)
    const result = await updatePipelineStack(p2.id, stack.id, { name: 'hijack' })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.status).toBe(404)
  })
})

/**
 * Issue #200. An element's Terraform state key is not recorded anywhere — it is
 * re-derived at trigger time from `variables[stack.stateKeyParam]`. So changing
 * that field under a running element changes where its NEXT pipeline looks for
 * state, and the next pipeline is usually its destroy.
 *
 * The destroy then addresses a state that was never created, reports success,
 * and leaves the real state in the bucket with the infrastructure it describes
 * still running — while `claimAndDestroy` has already flipped the row to
 * `decommissioning`, so the portal shows it as torn down.
 */
describe('stateKeyParam is frozen while elements depend on it (#200)', () => {
  const seedStackWithElement = async (status = 'active') => {
    const seeded = await seedStack()
    const pm = await createUser({ role: 'project_manager', email: `pm-${Date.now()}-${Math.round(performance.now() * 1000)}@test.dev` })
    const project = await createProject(pm.id)
    const order = await createOrder(project.id, seeded.p.id, seeded.env.id, pm.id, { status: 'completed' })
    const el = await createInfraElement(order.id, project.id, seeded.env.id, seeded.p.id, { status })
    return { ...seeded, el }
  }

  it('refuses the change while a deployed element still derives its key from it', async () => {
    const { p, stack } = await seedStackWithElement()

    const result = await updatePipelineStack(p.id, stack.id, { stateKeyParam: 'vm_name' })

    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.status).toBe(409)
      // The message has to name the field, or an admin cannot tell which of the
      // three things they just edited was refused.
      expect(result.message).toContain('hostname')
    }

    const [row] = await db.select().from(pipelineStacks).where(eq(pipelineStacks.id, stack.id))
    expect(row.stateKeyParam).toBe('hostname')
  })

  // A claimed teardown that has not run yet is exactly the window this guard is
  // about — the destroy pipeline has not read the key.
  it('counts an element that is mid-decommission', async () => {
    const { p, stack } = await seedStackWithElement('decommissioning')

    const result = await updatePipelineStack(p.id, stack.id, { stateKeyParam: 'vm_name' })

    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.status).toBe(409)
  })

  it('allows the change once every element is decommissioned', async () => {
    const { p, stack } = await seedStackWithElement('decommissioned')

    const result = await updatePipelineStack(p.id, stack.id, { stateKeyParam: 'vm_name' })

    expect(result.ok).toBe(true)
    if (result.ok) expect(result.data.stateKeyParam).toBe('vm_name')
  })

  // The admin form PATCHes the whole record, so it re-sends `stateKeyParam`
  // unchanged on every save. Refusing that would make the stack uneditable for
  // any product that has ever been deployed.
  it('allows an unrelated edit that re-sends the same stateKeyParam', async () => {
    const { p, stack } = await seedStackWithElement()

    const result = await updatePipelineStack(p.id, stack.id, {
      name: 'Renamed',
      stateKeyParam: 'hostname',
    })

    expect(result.ok).toBe(true)
    if (result.ok) expect(result.data.name).toBe('Renamed')
  })

  // Scoped to the product AND the environment the stack belongs to: an element
  // of another product, or of the same product in another environment, derives
  // its key from a different stack and is none of this stack's business.
  it('ignores elements of another product', async () => {
    const { stack } = await seedStackWithElement()
    const other = await seedStack()

    const result = await updatePipelineStack(other.p.id, other.stack.id, { stateKeyParam: 'vm_name' })

    expect(result.ok).toBe(true)
    // And the first stack is still guarded.
    const stillRefused = await updatePipelineStack(
      (await db.select().from(pipelineStacks).where(eq(pipelineStacks.id, stack.id)))[0].productId,
      stack.id,
      { stateKeyParam: 'vm_name' },
    )
    expect(stillRefused.ok).toBe(false)
  })
})

describe('deletePipelineStack', () => {
  it('deletes an existing stack successfully', async () => {
    const { p, stack } = await seedStack()
    const result = await deletePipelineStack(p.id, stack.id)
    expect(result.ok).toBe(true)
  })

  it('stack no longer appears in list after deletion', async () => {
    const { p, stack } = await seedStack()
    await deletePipelineStack(p.id, stack.id)
    const listed = await listPipelineStacks(p.id)
    if (listed.ok) expect(listed.data.map((s) => s.id)).not.toContain(stack.id)
  })

  it('returns 404 for non-existent stack ID', async () => {
    const { p } = await seedStack()
    const result = await deletePipelineStack(p.id, 999999)
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.status).toBe(404)
  })

  it('returns 404 when stackId belongs to a different product', async () => {
    const { stack } = await seedStack()
    const cat2 = await createCategory()
    const p2 = await createProduct(cat2.id)
    const result = await deletePipelineStack(p2.id, stack.id)
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.status).toBe(404)
  })
})

describe('pipeline stack lifecycle progression', () => {
  it('create → list → update steps → update name → delete → list empty', async () => {
    const cat = await createCategory()
    const p = await createProduct(cat.id)
    const ci = await createCiSource()
    const env = await createEnvironment(ci.id)

    // 1. Create
    const created = await createPipelineStack(p.id, {
      environmentId: env.id,
      name: 'Lifecycle Stack',
      stateKeyParam: 'hostname',
      steps: [{ template: 'linode/virtual-machine', stateSuffix: '-vm' }],
    })
    expect(created.ok).toBe(true)
    if (!created.ok) return
    const id = created.data.id

    // 2. List — appears
    const listed = await listPipelineStacks(p.id)
    expect(listed.ok).toBe(true)
    if (listed.ok) expect(listed.data.map((s) => s.id)).toContain(id)

    // 3. Update steps — three-step chain
    const withThreeSteps = await updatePipelineStack(p.id, id, {
      steps: [
        { template: 'linode/virtual-machine', stateSuffix: '-vm', execOrder: 0 },
        {
          template: 'linode/firewall',
          stateSuffix: '-fw',
          execOrder: 1,
          upstreamRefs: [{ varName: 'VM_STATE_NAME', suffix: '-vm' }],
        },
        {
          template: 'linode/dns-record',
          stateSuffix: '-dns',
          execOrder: 1,
          upstreamRefs: [{ varName: 'VM_STATE_NAME', suffix: '-vm' }],
        },
      ],
    })
    expect(withThreeSteps.ok).toBe(true)
    if (withThreeSteps.ok) expect(withThreeSteps.data.steps).toHaveLength(3)

    // 4. Update name and stateKeyParam
    const renamed = await updatePipelineStack(p.id, id, { name: 'Full VM Stack', stateKeyParam: 'vm_name' })
    expect(renamed.ok).toBe(true)
    if (renamed.ok) {
      expect(renamed.data.name).toBe('Full VM Stack')
      expect(renamed.data.stateKeyParam).toBe('vm_name')
      expect(renamed.data.steps).toHaveLength(3)
    }

    // 5. Delete
    const del = await deletePipelineStack(p.id, id)
    expect(del.ok).toBe(true)

    // 6. List — gone
    const final = await listPipelineStacks(p.id)
    if (final.ok) expect(final.data.map((s) => s.id)).not.toContain(id)
  })
})

/*
 * `entityId` under a `pipeline_stack.` action has to be the STACK. It was the
 * PRODUCT for all three verbs, so filtering the log by the prefix and reading the
 * id gave the wrong entity every time — and NFA-04.3 makes the table append-only,
 * so the entries already written can never be corrected. The product is still in
 * `details`, where nothing is lost.
 */
describe('pipeline stack audit entries name the stack (#137)', () => {
  const actionsFor = async (userId: number) =>
    db.select().from(auditLog).where(eq(auditLog.userId, userId))

  it('logs the stack id, not the product id, for create/update/delete', async () => {
    const actor = await createUser({ role: 'admin' })
    const cat = await createCategory()
    // Both sequences restart at 1 between tests, so the first product would share
    // its id with the first stack and the old behaviour would pass unnoticed. One
    // throwaway product pushes them apart.
    await createProduct(cat.id)
    const p = await createProduct(cat.id)
    const ci = await createCiSource()
    const env = await createEnvironment(ci.id)

    const created = await createPipelineStack(
      p.id,
      { environmentId: env.id, name: 'Audited Stack', steps: STEPS },
      actor.id,
    )
    expect(created.ok).toBe(true)
    if (!created.ok) return
    const stackId = created.data.id
    expect(stackId).not.toBe(p.id)

    await updatePipelineStack(p.id, stackId, { name: 'Renamed' }, actor.id)
    await deletePipelineStack(p.id, stackId, actor.id)

    const rows = await actionsFor(actor.id)
    expect(rows.map((r) => r.action).sort()).toEqual([
      'pipeline_stack.created',
      'pipeline_stack.deleted',
      'pipeline_stack.updated',
    ])
    expect(rows.every((r) => r.entityId === stackId)).toBe(true)
    // Nothing was lost by moving it: every entry still names the product.
    expect(rows.every((r) => r.details?.includes(`#${p.id}`))).toBe(true)
  })
})
