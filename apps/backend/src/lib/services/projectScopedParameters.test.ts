import { describe, it, expect } from 'vitest'
import { loadApplicableParameters, resolveParameterDefs, getProduct } from './catalog'
import { createParameter, updateParameter } from './admin/parameters'
import { db } from '@/lib/db/client'
import { parameters, parameterProjects } from '@/lib/db/schema'
import { eq } from 'drizzle-orm'
import {
  createUser,
  createCategory,
  createProduct,
  createProject,
  createCiSource,
  createEnvironment,
} from '@/test/helpers'

/*
 * #275 part 2. A global parameter can be narrowed to one or several projects.
 *
 * The precedence the owner chose is `product > category > project > global`,
 * which the existing scope rank already delivers — project narrowing is a
 * FILTER on top of a scope, not a fourth scope. What it adds is a tie-break
 * between two rows of the same scope where one names projects.
 */
const setup = async () => {
  const pm = await createUser({ role: 'project_manager' })
  const cat = await createCategory()
  const product = await createProduct(cat.id)
  const ci = await createCiSource()
  const env = await createEnvironment(ci.id)
  const mine = await createProject(pm.id, 'Webshop')
  const other = await createProject(pm.id, 'Billing')
  return { cat, product, env, mine, other }
}

const addParameter = async (over: Record<string, unknown>) => {
  const [row] = await db
    .insert(parameters)
    .values({ scope: 'global', scopeId: 0, name: 'region', type: 'string', ...over })
    .returning()
  return row
}

const narrowTo = async (parameterId: number, projectIds: number[]) => {
  await db.insert(parameterProjects).values(projectIds.map((projectId) => ({ parameterId, projectId })))
}

describe('parameters narrowed to projects (#275)', () => {
  it('applies to a project it names', async () => {
    const { cat, product, env, mine } = await setup()
    const param = await addParameter({ name: 'region' })
    await narrowTo(param.id, [mine.id])

    const rows = await loadApplicableParameters(product.id, cat.id, env.id, mine.id)

    expect(rows.map((r) => r.name)).toContain('region')
  })

  /*
   * The half that makes narrowing mean anything. Without it the table would be
   * decoration: every parameter would still apply everywhere.
   */
  it('does not apply to a project it does not name', async () => {
    const { cat, product, env, other, mine } = await setup()
    const param = await addParameter({ name: 'region' })
    await narrowTo(param.id, [mine.id])

    const rows = await loadApplicableParameters(product.id, cat.id, env.id, other.id)

    expect(rows.map((r) => r.name)).not.toContain('region')
  })

  it('applies everywhere when it names no projects at all', async () => {
    const { cat, product, env, other } = await setup()
    await addParameter({ name: 'region' })

    const rows = await loadApplicableParameters(product.id, cat.id, env.id, other.id)

    expect(rows.map((r) => r.name)).toContain('region')
  })

  /*
   * The catalogue renders the order form before a project is chosen. Filtering
   * to "unnarrowed only" there would hide a control the order will still
   * validate — and may require — once the project is picked.
   */
  it('hides nothing while the project is still unknown', async () => {
    const { cat, product, env, mine } = await setup()
    const param = await addParameter({ name: 'region' })
    await narrowTo(param.id, [mine.id])

    const rows = await loadApplicableParameters(product.id, cat.id, env.id)

    expect(rows.map((r) => r.name)).toContain('region')
  })

  it('applies to every project it names, not just the first', async () => {
    const { cat, product, env, mine, other } = await setup()
    const param = await addParameter({ name: 'region' })
    await narrowTo(param.id, [mine.id, other.id])

    for (const project of [mine, other]) {
      const rows = await loadApplicableParameters(product.id, cat.id, env.id, project.id)
      expect(rows.map((r) => r.name), `project ${project.id}`).toContain('region')
    }
  })

  describe('precedence', () => {
    /*
     * The tie-break narrowing adds: two global rows of the same name, one
     * narrowed to this project. The narrowed one is the more specific
     * statement, exactly as an environment-specific row is.
     */
    it('prefers the narrowed row over the one that applies everywhere', async () => {
      const { cat, product, env, mine } = await setup()
      await addParameter({ name: 'region', defaultValue: 'everywhere' })
      const narrow = await addParameter({ name: 'region', defaultValue: 'for-this-project' })
      await narrowTo(narrow.id, [mine.id])

      const defs = resolveParameterDefs(
        await loadApplicableParameters(product.id, cat.id, env.id, mine.id),
      )

      expect(defs.find((d) => d.name === 'region')?.defaultValue).toBe('for-this-project')
    })

    /*
     * The owner's decision, and the reason project is a filter rather than a
     * fourth scope: a product-scoped row beats a project-narrowed global one.
     * The product knows most precisely what it needs to provision.
     */
    it('lets the product win over a project-narrowed global', async () => {
      const { cat, product, env, mine } = await setup()
      const narrow = await addParameter({ name: 'region', defaultValue: 'from-project' })
      await narrowTo(narrow.id, [mine.id])
      await addParameter({
        scope: 'product', scopeId: product.id, name: 'region', defaultValue: 'from-product',
      })

      const defs = resolveParameterDefs(
        await loadApplicableParameters(product.id, cat.id, env.id, mine.id),
      )

      expect(defs.find((d) => d.name === 'region')?.defaultValue).toBe('from-product')
    })

    it('lets the category win over a project-narrowed global too', async () => {
      const { cat, product, env, mine } = await setup()
      const narrow = await addParameter({ name: 'region', defaultValue: 'from-project' })
      await narrowTo(narrow.id, [mine.id])
      await addParameter({
        scope: 'category', scopeId: cat.id, name: 'region', defaultValue: 'from-category',
      })

      const defs = resolveParameterDefs(
        await loadApplicableParameters(product.id, cat.id, env.id, mine.id),
      )

      expect(defs.find((d) => d.name === 'region')?.defaultValue).toBe('from-category')
    })
  })

  describe('a narrowing that names a project which does not exist', () => {
    /*
     * From review. Without the check the foreign key rejects the insert, the
     * transaction throws, and the route answers 500 — for an ordinary stale
     * selection: an admin with the form open while somebody else deletes the
     * project sends an id that was valid when the page loaded.
     */
    it('is refused with 400, naming the id, rather than a 500 from the foreign key', async () => {
      const { cat } = await setup()
      const result = await createParameter({
        scope: 'global', scopeId: 0, name: 'region', type: 'string',
        projectIds: [999_999],
      })

      expect(result.ok).toBe(false)
      if (!result.ok) {
        expect(result.status).toBe(400)
        expect(result.message).toContain('999999')
      }
      expect(cat).toBeDefined()
    })

    it('is refused on update too', async () => {
      const param = await addParameter({ name: 'region' })

      const result = await updateParameter(param.id, { projectIds: [999_999] })

      expect(result.ok).toBe(false)
      if (!result.ok) expect(result.status).toBe(400)
    })
  })

  /*
   * From review. An update carrying ONLY `projectIds` leaves the column set
   * empty, and drizzle throws "No values to set" on `.set({})` — so the one
   * edit this feature exists for answered 500.
   */
  it('accepts an update that changes nothing but the projects', async () => {
    const { mine } = await setup()
    const param = await addParameter({ name: 'region' })

    const result = await updateParameter(param.id, { projectIds: [mine.id] })

    expect(result.ok).toBe(true)
    const links = await db
      .select()
      .from(parameterProjects)
      .where(eq(parameterProjects.parameterId, param.id))
    expect(links.map((l) => l.projectId)).toEqual([mine.id])
  })

  /*
   * `onDelete: 'cascade'` on both sides. A parameter narrowed to a project that
   * no longer exists would apply NOWHERE — silently, and the worst of the
   * available failures, because the parameter still looks configured.
   */
  it('stops being narrowed when the project it named is deleted', async () => {
    const { cat, product, env, mine, other } = await setup()
    const param = await addParameter({ name: 'region' })
    await narrowTo(param.id, [mine.id])

    await db.execute(`DELETE FROM projects WHERE id = ${mine.id}`)

    const rows = await loadApplicableParameters(product.id, cat.id, env.id, other.id)
    expect(rows.map((r) => r.name)).toContain('region')
  })
})

/**
 * The tie-break that was missing, and what it was costing (#402).
 *
 * `parameters` has no uniqueness constraint and `createParameter` has no
 * duplicate guard, so two rows can share a name at the same scope, the same
 * environment and the same project narrowing. Every precedence rule then says
 * "neither", and the resolver kept whichever arrived FIRST — which is plan
 * order, not a decision anybody made.
 */
describe('two definitions that tie resolve the same way every time', () => {
  const tying = (
    over: Partial<{
      id: number
      scope: string
      scopeId: number
      environmentId: number | null
      projectScoped: boolean
      sensitive: boolean
      defaultValue: string
    }>,
  ) =>
    ({
      id: 1,
      scope: 'product',
      scopeId: 7,
      environmentId: null,
      name: 'API_TOKEN',
      label: '',
      type: 'string',
      description: '',
      defaultValue: '',
      required: false,
      sensitive: false,
      sizeValues: {},
      projectScoped: false,
      ...over,
    }) as unknown as Parameters<typeof resolveParameterDefs>[0][number]

  it('does not depend on the order the rows arrived in', () => {
    // This is the whole bug, as a pure function: the same two rows, two orders,
    // and before the tie-break they produced two different answers.
    const older = tying({ id: 10, defaultValue: 'first' })
    const newer = tying({ id: 11, defaultValue: 'second' })

    const forward = resolveParameterDefs([older, newer])
    const backward = resolveParameterDefs([newer, older])

    expect(forward).toHaveLength(1)
    expect(backward).toHaveLength(1)
    expect(forward[0].defaultValue).toBe(backward[0].defaultValue)
  })

  it('resolves to the most recently created definition', () => {
    // Highest id: the rule a person would guess, and the only one the data can
    // answer. It does not make duplicates a good idea — it makes them repeatable.
    const older = tying({ id: 10, defaultValue: 'first' })
    const newer = tying({ id: 11, defaultValue: 'second' })
    expect(resolveParameterDefs([older, newer])[0].defaultValue).toBe('second')
    expect(resolveParameterDefs([newer, older])[0].defaultValue).toBe('second')
  })

  it('decides `sensitive` the same way every time, whichever order they arrive in', () => {
    /*
     * The sharp edge. `sensitive` decides whether the value is redacted
     * everywhere downstream (#131), so two tying rows that disagreed about it
     * made "is this secret redacted?" a question about row order.
     */
    const secret = tying({ id: 20, sensitive: true })
    const plain = tying({ id: 21, sensitive: false })

    expect(resolveParameterDefs([secret, plain])[0].sensitive).toBe(
      resolveParameterDefs([plain, secret])[0].sensitive,
    )
  })

  it('still lets a more specific scope win over a newer row', () => {
    // The tie-break is the LAST rule, not a replacement for the others: an older
    // product-scoped row must still beat a newer global one.
    const globalNewer = tying({ id: 99, scope: 'global', scopeId: 0, defaultValue: 'global' })
    const productOlder = tying({ id: 1, scope: 'product', scopeId: 7, defaultValue: 'product' })

    expect(resolveParameterDefs([globalNewer, productOlder])[0].defaultValue).toBe('product')
    expect(resolveParameterDefs([productOlder, globalNewer])[0].defaultValue).toBe('product')
  })

  it('still lets a project-narrowed row win over a newer unnarrowed one', () => {
    // #275's rule is not subordinate to "newest wins": a global `region` narrowed
    // to one project is the more specific statement, and adding an unnarrowed one
    // afterwards must not silently take it over for that project.
    const narrowedOlder = tying({ id: 1, projectScoped: true, defaultValue: 'narrowed' })
    const broadNewer = tying({ id: 99, projectScoped: false, defaultValue: 'broad' })

    expect(resolveParameterDefs([narrowedOlder, broadNewer])[0].defaultValue).toBe('narrowed')
    expect(resolveParameterDefs([broadNewer, narrowedOlder])[0].defaultValue).toBe('narrowed')
  })

  it('still lets an environment-specific row win over a newer all-environments one', () => {
    const anyEnvNewer = tying({ id: 99, environmentId: null, defaultValue: 'any' })
    const envSpecificOlder = tying({ id: 1, environmentId: 3, defaultValue: 'specific' })

    expect(resolveParameterDefs([anyEnvNewer, envSpecificOlder])[0].defaultValue).toBe('specific')
    expect(resolveParameterDefs([envSpecificOlder, anyEnvNewer])[0].defaultValue).toBe('specific')
  })
})

describe('the applicable rows come back in a defined order', () => {
  it('orders by id, so the form and the resolver both see the same sequence', async () => {
    const s = await setup()
    // Created deliberately out of alphabetical order, so a plan that happened to
    // return them sorted by name would fail this.
    const zeta = await createParameter({ scope: 'product', scopeId: s.product.id, name: 'ZETA', type: 'string' })
    const alpha = await createParameter({ scope: 'product', scopeId: s.product.id, name: 'ALPHA', type: 'string' })
    const mid = await createParameter({ scope: 'product', scopeId: s.product.id, name: 'MID', type: 'string' })
    expect(zeta.ok && alpha.ok && mid.ok).toBe(true)

    const rows = await loadApplicableParameters(s.product.id, s.cat.id)
    const ours = rows.filter((r) => ['ZETA', 'ALPHA', 'MID'].includes(r.name))
    expect(ours.map((r) => r.name)).toEqual(['ZETA', 'ALPHA', 'MID'])
  })
})


/*
 * #406. Resolving parameters before a project is chosen, and never again after.
 *
 * `projectScoped` is a precedence rule (#275), and it only means "narrowed to
 * the project we are ordering for" when the loader was GIVEN a project. Given
 * none, it means "narrowed to some project" — and preferring that row handed
 * one project's definition to every project, including the `sensitive` flag
 * that decides whether the value is redacted downstream (#131).
 */
describe('resolving parameters for the project that is actually asking (#406)', () => {
  const params = (result: Awaited<ReturnType<typeof getProduct>>) => {
    if (!result.ok) throw new Error('getProduct failed')
    return result.data.parameters as { name: string; defaultValue: string; sensitive: boolean }[]
  }
  const region = (result: Awaited<ReturnType<typeof getProduct>>) =>
    params(result).find((p) => p.name === 'region')

  it('gives each project the definition narrowed to it, not the other one', async () => {
    const { product, env, mine, other } = await setup()
    const forMine = await addParameter({ name: 'region', defaultValue: 'westeurope' })
    await narrowTo(forMine.id, [mine.id])
    const forOther = await addParameter({ name: 'region', defaultValue: 'northeurope' })
    await narrowTo(forOther.id, [other.id])

    // Both rows are `projectScoped`, so before the fix nothing separated them
    // and #402's tie-break — highest id — handed `northeurope` to both projects.
    expect(region(await getProduct(product.id, 'en', env.id, mine.id))?.defaultValue).toBe('westeurope')
    expect(region(await getProduct(product.id, 'en', env.id, other.id))?.defaultValue).toBe('northeurope')
  })

  /*
   * The sharp edge, and the reason this is more than a rendering ticket. A
   * definition that is `sensitive` for the chosen project, resolved from a row
   * where it is not, is an input the form does not mask.
   */
  it('does not let another project decide whether a value is secret', async () => {
    const { product, env, mine, other } = await setup()
    const secretForMine = await addParameter({ name: 'region', sensitive: true })
    await narrowTo(secretForMine.id, [mine.id])
    const plainForOther = await addParameter({ name: 'region', sensitive: false })
    await narrowTo(plainForOther.id, [other.id])

    expect(region(await getProduct(product.id, 'en', env.id, mine.id))?.sensitive).toBe(true)
    expect(region(await getProduct(product.id, 'en', env.id, other.id))?.sensitive).toBe(false)
  })

  /*
   * The pre-selection state. There is no correct answer before a project is
   * chosen, only a less wrong one: the unnarrowed row is the definition that
   * applies to every project, so it is the one to show while we do not know
   * which project is asking. Picking one refetches and narrowing takes over.
   */
  it('shows the definition that applies to everybody while no project is chosen', async () => {
    const { product, env, mine } = await setup()
    /*
     * The NARROWED row is created first, so it has the lower id and
     * `loadApplicableParameters` (ordered by id, #402) hands it to the resolver
     * as the incumbent. Created the other way round the unnarrowed row wins by
     * arriving first and this asserts nothing — which is the order-dependence
     * #402 was about, so the guard has to be the awkward order.
     */
    const narrow = await addParameter({ name: 'region', defaultValue: 'for-one-project' })
    await narrowTo(narrow.id, [mine.id])
    await addParameter({ name: 'region', defaultValue: 'everywhere' })

    expect(region(await getProduct(product.id, 'en', env.id))?.defaultValue).toBe('everywhere')
    // ...and choosing that project still gets its own definition.
    expect(region(await getProduct(product.id, 'en', env.id, mine.id))?.defaultValue).toBe('for-one-project')
  })

  it('still hides a parameter narrowed away from the project that is asking', async () => {
    const { product, env, mine, other } = await setup()
    const param = await addParameter({ name: 'region' })
    await narrowTo(param.id, [mine.id])

    expect(region(await getProduct(product.id, 'en', env.id, other.id))).toBeUndefined()
  })

  it('resolves per project before an environment is chosen too', async () => {
    // The catalogue page loads with no environment and resolves per environment
    // instead; that path has to carry the project as well.
    const { product, mine, other } = await setup()
    const forMine = await addParameter({ name: 'region', defaultValue: 'westeurope' })
    await narrowTo(forMine.id, [mine.id])
    const forOther = await addParameter({ name: 'region', defaultValue: 'northeurope' })
    await narrowTo(forOther.id, [other.id])

    expect(region(await getProduct(product.id, 'en', undefined, mine.id))?.defaultValue).toBe('westeurope')
    expect(region(await getProduct(product.id, 'en', undefined, other.id))?.defaultValue).toBe('northeurope')
  })

  it('prefers the unnarrowed row whichever order the rows arrive in', async () => {
    // The pure-function half: order independence is the property that made the
    // old behaviour a query-plan question rather than a decision (#402).
    const narrowed = { id: 1, projectScoped: true, defaultValue: 'narrowed' }
    const broad = { id: 99, projectScoped: false, defaultValue: 'broad' }
    const row = (over: object) =>
      ({
        scope: 'global', scopeId: 0, environmentId: null, name: 'region', label: '',
        type: 'string', description: '', required: false, sensitive: false, sizeValues: {},
        ...over,
      }) as unknown as Parameters<typeof resolveParameterDefs>[0][number]

    const opts = { projectKnown: false }
    expect(resolveParameterDefs([row(narrowed), row(broad)], opts)[0].defaultValue).toBe('broad')
    expect(resolveParameterDefs([row(broad), row(narrowed)], opts)[0].defaultValue).toBe('broad')

    // And with a project known, #275's rule is untouched.
    expect(resolveParameterDefs([row(narrowed), row(broad)])[0].defaultValue).toBe('narrowed')
    expect(resolveParameterDefs([row(broad), row(narrowed)])[0].defaultValue).toBe('narrowed')
  })
})
