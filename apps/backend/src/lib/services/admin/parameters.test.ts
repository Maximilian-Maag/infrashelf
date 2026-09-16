import { describe, it, expect } from 'vitest'
import {
  listParameters,
  createParameter,
  updateParameter,
  deleteParameter,
} from './parameters'
import { db } from '@/lib/db/client'
import { parameters, productVersions } from '@/lib/db/schema'
import { eq } from 'drizzle-orm'
import {
  createUser,
  createCategory,
  createProduct,
  createCiSource,
  createEnvironment,
  createProject,
  linkProductEnvironment,
} from '@/test/helpers'

describe('listParameters', () => {
  it('returns all when no filter', async () => {
    await createParameter({ scope: 'global', name: 'G1', type: 'string' })
    await createParameter({ scope: 'product', scopeId: 1, name: 'P1', type: 'string' })

    const result = await listParameters({})
    expect(result.ok).toBe(true)
    if (result.ok) expect(result.data.length).toBe(2)
  })

  it('filters by scope=product', async () => {
    await createParameter({ scope: 'global', name: 'G1', type: 'string' })
    await createParameter({ scope: 'product', scopeId: 1, name: 'P1', type: 'string' })
    await createParameter({ scope: 'category', scopeId: 1, name: 'C1', type: 'string' })

    const result = await listParameters({ scope: 'product' })
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.data.length).toBe(1)
      expect(result.data[0].scope).toBe('product')
    }
  })

  it('filters by scopeId', async () => {
    await createParameter({ scope: 'product', scopeId: 10, name: 'A', type: 'string' })
    await createParameter({ scope: 'product', scopeId: 20, name: 'B', type: 'string' })

    const result = await listParameters({ scope: 'product', scopeId: 10 })
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.data.length).toBe(1)
      expect(result.data[0].name).toBe('A')
    }
  })
})

describe('createParameter', () => {
  it('inserts a parameter with all defaults', async () => {
    const result = await createParameter({ scope: 'global', name: 'X', type: 'string' })
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.data.scope).toBe('global')
      expect(result.data.scopeId).toBe(0)
      expect(result.data.required).toBe(false)
      expect(result.data.sensitive).toBe(false)
    }
  })

  it('stores label when provided', async () => {
    const result = await createParameter({ scope: 'global', name: 'region', label: 'Region', type: 'string' })
    expect(result.ok).toBe(true)
    if (result.ok) expect(result.data.label).toBe('Region')
  })

  it('stores empty label by default', async () => {
    const result = await createParameter({ scope: 'global', name: 'region', type: 'string' })
    expect(result.ok).toBe(true)
    if (result.ok) expect(result.data.label).toBe('')
  })

  it('refuses a name the server sets as a CI variable (issue #183)', async () => {
    // A parameter's name becomes a trigger variable verbatim, so a definition
    // named REF let whoever ordered the product choose the git ref the pipeline
    // ran, and TF_ACTION turned a provisioning order into a destroy.
    for (const name of ['REF', 'TF_ACTION', 'TF_STATE_NAME']) {
      const result = await createParameter({ scope: 'global', name, type: 'string' })
      expect(result.ok).toBe(false)
      if (!result.ok) expect(result.status).toBe(400)
    }

    const rows = await db.select().from(parameters)
    expect(rows).toEqual([])
  })

  it('refuses the lowercase spelling a template would produce', async () => {
    // `sync-parameters` imports Terraform variables, which are lowercase by
    // convention — the path by which such a definition appears without anyone
    // typing the name.
    const result = await createParameter({ scope: 'global', name: 'tf_action', type: 'string' })
    expect(result.ok).toBe(false)
  })
})

describe('updateParameter', () => {
  it('returns 404 for unknown id', async () => {
    const result = await updateParameter(999_999, { name: 'X' })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.status).toBe(404)
  })

  it('updates fields', async () => {
    const created = await createParameter({ scope: 'global', name: 'old', type: 'string' })
    if (!created.ok) throw new Error('seed failed')
    const result = await updateParameter(created.data.id, { name: 'new', required: true })
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.data.name).toBe('new')
      expect(result.data.required).toBe(true)
    }
  })

  it('refuses a rename onto a reserved name (issue #183)', async () => {
    // Or the create-time check would cost an attacker one extra request.
    const created = await createParameter({ scope: 'global', name: 'hostname', type: 'string' })
    if (!created.ok) throw new Error('seed failed')

    const result = await updateParameter(created.data.id, { name: 'REF' })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.status).toBe(400)

    const [row] = await db.select().from(parameters).where(eq(parameters.id, created.data.id))
    expect(row.name).toBe('hostname')
  })

  it('updates label field', async () => {
    const created = await createParameter({ scope: 'global', name: 'x', type: 'string', label: 'Old Label' })
    if (!created.ok) throw new Error('seed failed')
    const result = await updateParameter(created.data.id, { label: 'New Label' })
    expect(result.ok).toBe(true)
    if (result.ok) expect(result.data.label).toBe('New Label')
  })
})

/**
 * A T-shirt size is a variable TYPE. `instance_type` is one of these: the
 * customer never types it, the size they picked decides it, and the map from
 * size code to value lives on the variable — because one size can drive several
 * of them (vSphere moves num_cpus, memory_mb and disk_size_gb together).
 */
describe('a size parameter', () => {
  it('stores the value for each size', async () => {
    const result = await createParameter({
      scope: 'global', name: 'instance_type', type: 'size',
      sizeValues: { S: 't3.micro', XL: 'm6i.2xlarge' },
    })
    expect(result.ok).toBe(true)
    if (result.ok) expect(result.data.sizeValues).toEqual({ S: 't3.micro', XL: 'm6i.2xlarge' })
  })

  it('defaults to an empty map', async () => {
    const result = await createParameter({ scope: 'global', name: 'hostname', type: 'string' })
    expect(result.ok).toBe(true)
    if (result.ok) expect(result.data.sizeValues).toEqual({})
  })

  // A map on a string parameter is a mistake with consequences: nothing would
  // ever read it, so it would sit there looking like configuration.
  it('refuses per-size values on a parameter that is not a size', async () => {
    const result = await createParameter({
      scope: 'global', name: 'hostname', type: 'string', sizeValues: { S: 'x' },
    })
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.status).toBe(400)
      expect(result.message).toMatch(/Only a size parameter/)
    }
  })

  it('refuses a value keyed by nothing', async () => {
    const result = await createParameter({
      scope: 'global', name: 'instance_type', type: 'size', sizeValues: { '  ': 'x' },
    })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.message).toMatch(/needs a size code/)
  })

  it('refuses a size code longer than a size code can be', async () => {
    const result = await createParameter({
      scope: 'global', name: 'instance_type', type: 'size', sizeValues: { ['x'.repeat(40)]: 'v' },
    })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.message).toMatch(/longer than/)
  })

  // It becomes a CI trigger variable, so an unbounded value is an unbounded
  // request body — the same reason a parameter value is bounded.
  it('refuses a value that is too long', async () => {
    const result = await createParameter({
      scope: 'global', name: 'instance_type', type: 'size', sizeValues: { S: 'x'.repeat(5000) },
    })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.message).toMatch(/too long/)
  })

  it('updates the map', async () => {
    const created = await createParameter({
      scope: 'global', name: 'instance_type', type: 'size', sizeValues: { S: 't3.micro' },
    })
    if (!created.ok) throw new Error('seed failed')

    const updated = await updateParameter(created.data.id, { sizeValues: { S: 't3.small', XL: 'm6i.large' } })
    expect(updated.ok).toBe(true)
    if (updated.ok) expect(updated.data.sizeValues).toEqual({ S: 't3.small', XL: 'm6i.large' })
  })
})

describe('deleteParameter', () => {
  it('returns 404 for unknown id', async () => {
    const result = await deleteParameter(999_999)
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.status).toBe(404)
  })

  it('removes from DB', async () => {
    const created = await createParameter({ scope: 'global', name: 'del', type: 'string' })
    if (!created.ok) throw new Error('seed failed')
    const result = await deleteParameter(created.data.id)
    expect(result.ok).toBe(true)

    const rows = await db.select().from(parameters).where(eq(parameters.id, created.data.id))
    expect(rows.length).toBe(0)
  })
})


// Issue #38. Parameter definitions are part of the offering snapshot, so a change
// to one has to leave a version behind — otherwise it silently folds itself into
// whatever unrelated edit happens to be recorded next, and the parameter history
// the diff advertises is unreachable.
describe('parameter changes record a product version', () => {
  const offering = async () => {
    const admin = await createUser({ role: 'admin', email: `param-ver-${Math.random()}@test.dev` })
    const cat = await createCategory()
    const product = await createProduct(cat.id, 'Nginx Gateway')
    const ci = await createCiSource()
    const env = await createEnvironment(ci.id)
    await linkProductEnvironment(product.id, env.id)
    return { admin, cat, product, env }
  }

  /*
   * Ordered explicitly, because the assertions below are about sequence.
   *
   * Without an ORDER BY, Postgres returns plan order — which held until it did
   * not, and the three summaries came back exactly reversed on a loaded run.
   * `id` is the insertion order these tests actually mean; `created_at` ties
   * when several versions are written inside one call.
   */
  const versionsFor = async (productId: number) =>
    db
      .select()
      .from(productVersions)
      .where(eq(productVersions.productId, productId))
      .orderBy(productVersions.id)

  it('records one for a product-scoped parameter, with a snapshot to diff against', async () => {
    const { admin, product, env } = await offering()

    const created = await createParameter(
      { scope: 'product', scopeId: product.id, name: 'REGION', type: 'string' },
      admin.id,
    )
    expect(created.ok).toBe(true)

    const rows = await versionsFor(product.id)
    expect(rows).toHaveLength(1)
    expect(rows[0].summary).toBe('Parameter REGION added')
    expect(rows[0].environmentId).toBe(env.id)
    expect(rows[0].createdBy).toBe(admin.id)
    // The snapshot is what makes the change diffable rather than merely logged.
    expect(rows[0].snapshot).not.toBeNull()
  })

  it('records one on update and on delete', async () => {
    const { admin, product } = await offering()
    const created = await createParameter(
      { scope: 'product', scopeId: product.id, name: 'REGION', type: 'string' },
      admin.id,
    )
    if (!created.ok) throw new Error('setup failed')

    await updateParameter(created.data.id, { sensitive: true }, admin.id)
    await deleteParameter(created.data.id, admin.id)

    const summaries = (await versionsFor(product.id)).map((r) => r.summary)
    expect(summaries).toEqual([
      'Parameter REGION added',
      'Parameter REGION updated',
      'Parameter REGION removed',
    ])
  })

  it('records a category-scoped change against every product in the category', async () => {
    const { admin, cat, product, env } = await offering()
    const sibling = await createProduct(cat.id, 'Managed Postgres')
    await linkProductEnvironment(sibling.id, env.id)

    await createParameter({ scope: 'category', scopeId: cat.id, name: 'TIER', type: 'string' }, admin.id)

    expect(await versionsFor(product.id)).toHaveLength(1)
    expect(await versionsFor(sibling.id)).toHaveLength(1)
  })

  it('records only the named environment when the parameter pins one', async () => {
    const { admin, product, env } = await offering()
    const ci = await createCiSource()
    const other = await createEnvironment(ci.id)
    await linkProductEnvironment(product.id, other.id)

    await createParameter(
      { scope: 'product', scopeId: product.id, environmentId: env.id, name: 'REGION', type: 'string' },
      admin.id,
    )

    const rows = await versionsFor(product.id)
    expect(rows.map((r) => r.environmentId)).toEqual([env.id])
  })
})

/**
 * One definition per name, per place (#477, part of #404).
 *
 * `resolveParameterDefs` collapses the applicable rows to one definition per
 * name, and two rows alike on scope, environment AND narrowing hit none of its
 * precedence rules — so #402's tie-break decides, most recently created wins.
 * That is repeatable but nobody chose it, and `sensitive` disagreeing between
 * the two makes "is this secret redacted?" a question about write order (#131).
 */
describe('a duplicate parameter definition', () => {
  const global = (over: Record<string, unknown> = {}) =>
    createParameter({ scope: 'global', name: 'region', type: 'string', ...over } as never)

  it('is refused, naming the definition that already exists', async () => {
    const first = await global()
    expect(first.ok).toBe(true)

    const second = await global()
    expect(second.ok).toBe(false)
    if (!second.ok) {
      expect(second.status).toBe(409)
      expect(second.message).toContain('region')
      if (first.ok) expect(second.message).toContain(`#${first.data.id}`)
    }
    // And nothing was written: a refused create must not leave half a parameter.
    const rows = await db.select().from(parameters).where(eq(parameters.name, 'region'))
    expect(rows.length).toBe(1)
  })

  it('does not count a different scope, scopeId or environment as the same place', async () => {
    const ci = await createCiSource()
    const env = await createEnvironment(ci.id)
    await global()

    for (const over of [
      { scope: 'product', scopeId: 1 },
      { scope: 'category', scopeId: 1 },
      { environmentId: env.id },
    ]) {
      const result = await createParameter({ scope: 'global', name: 'region', type: 'string', ...over } as never)
      expect(result.ok, JSON.stringify(over)).toBe(true)
    }
  })

  /*
   * The #275 property, and the reason the key cannot be a plain unique index:
   * narrowing lives in `parameter_projects`, and narrowing one definition to a
   * project while another applies everywhere is the whole feature.
   */
  it('is not what a project-narrowed definition beside an unnarrowed one is', async () => {
    const pm = await createUser({ role: 'project_manager' })
    const project = await createProject(pm.id, 'Webshop')

    expect((await global()).ok).toBe(true)
    expect((await global({ projectIds: [project.id] })).ok).toBe(true)
  })

  it('compares the whole set of projects, not merely whether there is one', async () => {
    const pm = await createUser({ role: 'project_manager' })
    const one = await createProject(pm.id, 'Webshop')
    const two = await createProject(pm.id, 'Billing')

    expect((await global({ projectIds: [one.id] })).ok).toBe(true)
    expect((await global({ projectIds: [one.id, two.id] })).ok).toBe(true)
    // Same set, written in the other order — which is the order a form
    // serialised it in, not something anybody meant.
    const same = await global({ projectIds: [two.id, one.id] })
    expect(same.ok).toBe(false)
    if (!same.ok) expect(same.status).toBe(409)
  })

  it('refuses a rename onto a definition that already exists', async () => {
    const taken = await global({ name: 'region' })
    const moving = await global({ name: 'zone' })
    expect(taken.ok && moving.ok).toBe(true)
    if (!moving.ok) return

    const result = await updateParameter(moving.data.id, { name: 'region' })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.status).toBe(409)
  })

  it('refuses a move into an environment where the name is taken', async () => {
    const ci = await createCiSource()
    const env = await createEnvironment(ci.id)
    const there = await global({ environmentId: env.id })
    const here = await global()
    expect(there.ok && here.ok).toBe(true)
    if (!here.ok) return

    const result = await updateParameter(here.data.id, { environmentId: env.id })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.status).toBe(409)
  })

  it('lets a parameter keep its own name', async () => {
    // A row is not its own duplicate — otherwise every edit that touches nothing
    // in the key would refuse itself.
    const only = await global()
    if (!only.ok) throw new Error('setup failed')

    expect((await updateParameter(only.data.id, { name: 'region', defaultValue: 'eu' })).ok).toBe(true)
    expect((await updateParameter(only.data.id, { defaultValue: 'us' })).ok).toBe(true)
  })

  it('lets an update narrow a parameter that is otherwise a twin', async () => {
    // Narrowing is what MAKES it a different definition, so the edit that
    // introduces the difference has to be allowed.
    const pm = await createUser({ role: 'project_manager' })
    const project = await createProject(pm.id, 'Webshop')
    const unnarrowed = await global()
    const other = await global({ projectIds: [project.id] })
    expect(unnarrowed.ok && other.ok).toBe(true)
    if (!other.ok) return

    // Clearing the narrowing WOULD make it a twin of the first, so that is refused.
    const cleared = await updateParameter(other.data.id, { projectIds: [] })
    expect(cleared.ok).toBe(false)
    if (!cleared.ok) expect(cleared.status).toBe(409)
  })
})
