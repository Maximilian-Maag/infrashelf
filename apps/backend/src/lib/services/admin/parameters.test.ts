import { describe, it, expect } from 'vitest'
import { createHash } from 'node:crypto'
import {
  listParameters,
  createParameter,
  updateParameter,
  deleteParameter,
  narrowingFingerprint,
  duplicateIndexError,
} from './parameters'
import { deleteProject } from '@/lib/services/projects'
import { pgErrorCode, pgConstraintName, UNIQUE_VIOLATION } from '@/lib/db/pgError'
import { db } from '@/lib/db/client'
import { parameters, productVersions, projects } from '@/lib/db/schema'
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

/*
 * The database half of the rule (#404).
 *
 * `duplicateParameterError` is a check-then-insert and races with itself, so
 * everything above is about the ordinary case: an admin defining the same thing
 * twice. What follows is about the case the guard cannot reach, and it is
 * asserted against the INDEX rather than the service — a test that only ever
 * calls `createParameter` cannot tell the two apart, which is the point #404
 * makes about step 4.
 */
describe('the narrowing fingerprint', () => {
  const global = (over: Record<string, unknown> = {}) =>
    createParameter({ scope: 'global', name: 'region', type: 'string', ...over } as never)

  /**
   * Insert straight into the table, bypassing every service-level check, and
   * report which constraint refused it.
   *
   * The constraint name rather than the message: drizzle wraps the driver's
   * error and its `message` is "Failed query: insert into …", so asserting on
   * the text would pass for any failure at all.
   */
  const insertRaw = async (values: Record<string, unknown>): Promise<string | null> => {
    try {
      await db.insert(parameters).values({
        scope: 'global',
        scopeId: 0,
        environmentId: null,
        name: 'region',
        type: 'string',
        ...values,
      } as never)
      return null
    } catch (e) {
      expect(pgErrorCode(e)).toBe(UNIQUE_VIOLATION)
      return pgConstraintName(e)
    }
  }

  it('is sha256 of the sorted, de-duplicated ids', async () => {
    const pm = await createUser({ role: 'project_manager' })
    const one = await createProject(pm.id, 'Webshop')
    const two = await createProject(pm.id, 'Billing')

    const created = await global({ projectIds: [two.id, one.id, one.id] })
    if (!created.ok) throw new Error('setup failed')

    const expected = createHash('sha256')
      .update([one.id, two.id].sort((a, b) => a - b).join(','))
      .digest('hex')
    expect(created.data.narrowingKey).toBe(expected)
    expect(narrowingFingerprint([two.id, one.id])).toBe(expected)
  })

  it('is sha256 of the empty string for a parameter narrowed to nothing', async () => {
    // Also the column's DEFAULT, so a row written without narrowing is already
    // right before anything updates it. The two have to agree or the index
    // would let one unnarrowed duplicate through per write path.
    const created = await global()
    if (!created.ok) throw new Error('setup failed')
    expect(created.data.narrowingKey).toBe(createHash('sha256').update('').digest('hex'))
    expect(created.data.narrowingKey).toBe(narrowingFingerprint([]))
  })

  it('follows a narrowing that an update changes', async () => {
    const pm = await createUser({ role: 'project_manager' })
    const one = await createProject(pm.id, 'Webshop')
    const two = await createProject(pm.id, 'Billing')
    const created = await global({ projectIds: [one.id] })
    if (!created.ok) throw new Error('setup failed')

    const widened = await updateParameter(created.data.id, { projectIds: [one.id, two.id] })
    if (!widened.ok) throw new Error(widened.message)
    expect(widened.data.narrowingKey).toBe(narrowingFingerprint([one.id, two.id]))

    const cleared = await updateParameter(created.data.id, { projectIds: [] })
    if (!cleared.ok) throw new Error(cleared.message)
    expect(cleared.data.narrowingKey).toBe(narrowingFingerprint([]))
  })

  it('is refused by the index, not only by the service', async () => {
    // The race the guard cannot close: two simultaneous creates both read no
    // rival. Asserted by writing the second row directly, which is what the
    // losing transaction effectively does.
    expect((await global()).ok).toBe(true)
    expect(await insertRaw({})).toBe('parameters_definition_all_envs_key')
  })

  it('is refused by the index for an environment-specific definition too', async () => {
    // The pair exists because `environment_id` is nullable and NULL is distinct
    // from every other NULL in a unique index. One index over all five columns
    // would catch this case and let every all-environments duplicate through.
    const ci = await createCiSource()
    const env = await createEnvironment(ci.id)
    expect((await global({ environmentId: env.id })).ok).toBe(true)

    expect(await insertRaw({ environmentId: env.id })).toBe('parameters_definition_env_key')
  })

  it('lets the index through for a definition narrowed to something else', async () => {
    // The #275 property, asserted against the constraint this time: the index
    // must not be the thing that forbids a project-narrowed override.
    const pm = await createUser({ role: 'project_manager' })
    const project = await createProject(pm.id, 'Webshop')
    expect((await global()).ok).toBe(true)

    expect(await insertRaw({ narrowingKey: narrowingFingerprint([project.id]) })).toBeNull()
  })

  it('leaves exactly one row when three creates are issued together', async () => {
    /*
     * What this proves and what it does not.
     *
     * It proves the outcome: one definition survives and the losers get a 409
     * they can act on. It does NOT prove WHICH layer refused them — on this
     * machine the guard's SELECT wins the interleave and answers first, and
     * making `duplicateIndexError` rethrow everything does not fail this test.
     * That is why the mapper is also tested directly below, against a real
     * driver error; a test that cannot tell the two layers apart must not be
     * described as covering the one it happens not to reach.
     */
    const results = await Promise.all([global(), global(), global()])

    expect(results.filter((r) => r.ok)).toHaveLength(1)
    for (const failure of results) {
      if (failure.ok) continue
      expect(failure.status).toBe(409)
      expect(failure.message).toContain('region')
    }
    expect(await db.select().from(parameters).where(eq(parameters.name, 'region'))).toHaveLength(1)
  })

  describe('the 409 a lost race gets', () => {
    /**
     * A real 23505 from this index, rather than an object shaped like one.
     *
     * Straight from the driver, so the test cannot drift from what drizzle
     * actually wraps — which is the part `pgErrorCode` exists for and the part
     * that would silently stop working if the wrapper changed shape.
     */
    const realViolation = async (): Promise<unknown> => {
      expect((await global()).ok).toBe(true)
      try {
        await db.insert(parameters).values({
          scope: 'global',
          scopeId: 0,
          environmentId: null,
          name: 'region',
          type: 'string',
        } as never)
      } catch (e) {
        return e
      }
      throw new Error('expected the index to refuse this insert')
    }

    it('turns the index violation into a 409 naming the parameter', async () => {
      // Without this the losing transaction escapes as an unhandled 23505 and
      // the route answers 500 for a request the caller could act on.
      const result = duplicateIndexError(await realViolation(), 'global', 'region')
      expect(result.ok).toBe(false)
      if (result.ok) return
      expect(result.status).toBe(409)
      expect(result.message).toContain('region')
      expect(result.message).toContain('re-read')
    })

    it('rethrows anything that is not this index', async () => {
      // A mapper that answered 409 for every error would turn a genuine failure
      // — a dead connection, a constraint added later — into "already exists",
      // which is the one answer that stops anybody looking.
      const other = new Error('connection terminated')
      expect(() => duplicateIndexError(other, 'global', 'region')).toThrow(other)

      const otherConstraint = { code: '23505', constraint_name: 'users_email_unique' }
      expect(() => duplicateIndexError(otherConstraint, 'global', 'region')).toThrow()
    })
  })
})

describe('deleting a project that a parameter is narrowed to', () => {
  const global = (over: Record<string, unknown> = {}) =>
    createParameter({ scope: 'global', name: 'region', type: 'string', ...over } as never)

  it('re-fingerprints the parameters it leaves behind', async () => {
    // `parameter_projects.project_id` cascades, so the delete changes what the
    // parameter is narrowed to. A fingerprint left describing the old narrowing
    // is a column the index is enforcing against a value nothing reproduces.
    const pm = await createUser({ role: 'project_manager' })
    const doomed = await createProject(pm.id, 'Doomed')
    const kept = await createProject(pm.id, 'Kept')
    const param = await global({ projectIds: [doomed.id, kept.id] })
    if (!param.ok) throw new Error('setup failed')

    const deleted = await deleteProject({ id: pm.id, email: pm.email, name: pm.name, role: 'project_manager' }, doomed.id)
    expect(deleted.ok).toBe(true)

    const [row] = await db.select().from(parameters).where(eq(parameters.id, param.data.id))
    expect(row.narrowingKey).toBe(narrowingFingerprint([kept.id]))
  })

  it('leaves every fingerprint alone when any one of them would collide', async () => {
    /*
     * CodeRabbit on PR #495, and it was right.
     *
     * The first implementation updated each fingerprint as it went and stopped
     * at the first collision. `deleteProject` then RETURNS an error from inside
     * `db.transaction`, and drizzle commits a callback that returns — it rolls
     * back only when the callback throws. So the parameters checked before the
     * colliding one were left holding a `narrowing_key` describing a narrowing
     * they still had, which is the exact inconsistency this column exists to
     * prevent.
     *
     * Two parameters narrowed to the doomed project: one that would be fine
     * afterwards and one that collides. The refused delete must move neither.
     */
    const pm = await createUser({ role: 'project_manager' })
    const doomed = await createProject(pm.id, 'Doomed')
    const kept = await createProject(pm.id, 'Kept')

    const survivor = await createParameter({
      scope: 'global',
      name: 'zone',
      type: 'string',
      projectIds: [doomed.id, kept.id],
    } as never)
    expect((await global()).ok).toBe(true)
    const willCollide = await global({ projectIds: [doomed.id] })
    if (!survivor.ok || !willCollide.ok) throw new Error('setup failed')

    const before = survivor.data.narrowingKey
    const result = await deleteProject(
      { id: pm.id, email: pm.email, name: pm.name, role: 'project_manager' },
      doomed.id,
    )
    expect(result.ok).toBe(false)

    const [after] = await db.select().from(parameters).where(eq(parameters.id, survivor.data.id))
    expect(after.narrowingKey).toBe(before)
    expect(after.narrowingKey).toBe(narrowingFingerprint([doomed.id, kept.id]))
  })

  it('refuses the delete when losing the narrowing would create a duplicate', async () => {
    // A definition narrowed to this project and an identical one narrowed to
    // nothing are two definitions today and one of them tomorrow. Resolving that
    // by deleting one of them is not something deleting a PROJECT should do.
    const pm = await createUser({ role: 'project_manager' })
    const doomed = await createProject(pm.id, 'Doomed')
    expect((await global()).ok).toBe(true)
    const narrowed = await global({ projectIds: [doomed.id] })
    if (!narrowed.ok) throw new Error('setup failed')

    const result = await deleteProject(
      { id: pm.id, email: pm.email, name: pm.name, role: 'project_manager' },
      doomed.id,
    )
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.status).toBe(409)
    expect(result.message).toContain('region')

    // And the project is still there: the refusal rolled the whole thing back.
    const [stillThere] = await db.select().from(projects).where(eq(projects.id, doomed.id))
    expect(stillThere).toBeDefined()
  })
})
