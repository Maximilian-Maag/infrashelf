import { describe, it, expect } from 'vitest'
import {
  listCostCenters,
  createCostCenter,
  getCostCenterById,
  updateCostCenter,
  deleteCostCenter,
} from './costCenters'
import { db } from '@/lib/db/client'
import { costCenters, projects, orders, auditLog } from '@/lib/db/schema'
import { eq } from 'drizzle-orm'
import {
  createUser,
  createProject,
  createCategory,
  createProduct,
  createCiSource,
  createEnvironment,
  createOrder,
} from '@/test/helpers'

describe('listCostCenters', () => {
  it('returns empty when none', async () => {
    const result = await listCostCenters()
    expect(result.ok).toBe(true)
    if (result.ok) expect(result.data).toEqual([])
  })

  it('returns cost centers ordered by code', async () => {
    await createCostCenter({ code: 'B', name: 'Beta' })
    await createCostCenter({ code: 'A', name: 'Alpha' })

    const result = await listCostCenters()
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.data.map((c) => c.code)).toEqual(['A', 'B'])
    }
  })
})

describe('createCostCenter', () => {
  it('inserts with active=true default', async () => {
    const result = await createCostCenter({ code: 'CC1', name: 'CC One' })
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.data.code).toBe('CC1')
      expect(result.data.active).toBe(true)
    }
  })
})

describe('getCostCenterById', () => {
  it('returns 404 for unknown id', async () => {
    const result = await getCostCenterById(999_999)
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.status).toBe(404)
  })

  it('returns the cost center when found', async () => {
    const created = await createCostCenter({ code: 'X', name: 'X-Name' })
    if (!created.ok) throw new Error('seed failed')

    const result = await getCostCenterById(created.data.id)
    expect(result.ok).toBe(true)
    if (result.ok) expect(result.data.name).toBe('X-Name')
  })
})

describe('updateCostCenter', () => {
  it('returns 404 for unknown id', async () => {
    const result = await updateCostCenter(999_999, { name: 'X' })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.status).toBe(404)
  })

  it('updates fields', async () => {
    const created = await createCostCenter({ code: 'X', name: 'Old' })
    if (!created.ok) throw new Error('seed failed')

    const result = await updateCostCenter(created.data.id, { name: 'New', active: false })
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.data.name).toBe('New')
      expect(result.data.active).toBe(false)
    }
  })
})

describe('deleteCostCenter', () => {
  it('returns 404 for unknown id', async () => {
    const result = await deleteCostCenter(999_999)
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.status).toBe(404)
  })

  it('deletes from DB', async () => {
    const created = await createCostCenter({ code: 'D', name: 'Del' })
    if (!created.ok) throw new Error('seed failed')

    const result = await deleteCostCenter(created.data.id)
    expect(result.ok).toBe(true)

    const rows = await db.select().from(costCenters).where(eq(costCenters.id, created.data.id))
    expect(rows.length).toBe(0)
  })

  // projects.cost_center_id and orders.cost_center_id are NO ACTION, so the bare
  // delete raised 23503 and escaped as an unhandled 500 (issue #142).
  it('returns 409, not a 500, when a project references it', async () => {
    const created = await createCostCenter({ code: 'REF', name: 'Referenced' })
    if (!created.ok) throw new Error('seed failed')
    const owner = await createUser()
    const project = await createProject(owner.id)
    await db.update(projects).set({ costCenterId: created.data.id }).where(eq(projects.id, project.id))

    const result = await deleteCostCenter(created.data.id)
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.status).toBe(409)
      expect(result.message).toContain('project(s)')
      expect(result.message).toContain('Deactivate')
    }

    expect((await db.select().from(costCenters).where(eq(costCenters.id, created.data.id))).length).toBe(1)
  })

  it('returns 409 when an order references it', async () => {
    const created = await createCostCenter({ code: 'ORD', name: 'Ordered' })
    if (!created.ok) throw new Error('seed failed')
    const user = await createUser()
    const category = await createCategory()
    const product = await createProduct(category.id)
    const source = await createCiSource()
    const env = await createEnvironment(source.id)
    const project = await createProject(user.id)
    const order = await createOrder(project.id, product.id, env.id, user.id)
    await db.update(orders).set({ costCenterId: created.data.id }).where(eq(orders.id, order.id))

    const result = await deleteCostCenter(created.data.id)
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.status).toBe(409)
      expect(result.message).toContain('order(s)')
    }
  })
})

describe('cost center audit trail (issue #137)', () => {
  it('records create, update and delete against the acting admin', async () => {
    const actor = await createUser({ role: 'admin' })

    const created = await createCostCenter({ code: 'AUD', name: 'Audited' }, actor.id)
    if (!created.ok) throw new Error('seed failed')
    await updateCostCenter(created.data.id, { name: 'Renamed' }, actor.id)
    await deleteCostCenter(created.data.id, actor.id)

    const rows = await db.select().from(auditLog)
    const actions = rows.map((r) => r.action).sort()
    expect(actions).toEqual(['cost_center.created', 'cost_center.deleted', 'cost_center.updated'])
    for (const row of rows) expect(row.userId).toBe(actor.id)

    const updateRow = rows.find((r) => r.action === 'cost_center.updated')
    // Field names, not values.
    expect(updateRow?.details).toBe('Changed: name')
  })

  it('rejects an empty update with a 400 instead of a 500', async () => {
    const created = await createCostCenter({ code: 'EMPTY', name: 'Empty' })
    if (!created.ok) throw new Error('seed failed')

    const result = await updateCostCenter(created.data.id, {})
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.status).toBe(400)
  })
})

/*
 * #325 put the budget on the `cost_centers` row and made every verb that touches
 * it `root`, deliberately — the route says so: "who may see one is the same
 * question as who may set it". A `select()` or `returning()` here returns the row,
 * budget columns and all, to callers who are not root (#539).
 */
describe('a cost centre comes back as the four fields it is (#539)', () => {
  const FOUR_FIELDS = ['active', 'code', 'id', 'name']

  it('on the list, the read and the write echoes', async () => {
    const created = await createCostCenter({ code: 'LEAK', name: 'Leaky' })
    if (!created.ok) throw new Error('seed failed')

    await db
      .update(costCenters)
      .set({
        budgetAmount: '100.00',
        budgetCurrency: 'EUR',
        budgetPeriod: 'total',
        budgetBehaviour: 'block',
      })
      .where(eq(costCenters.id, created.data.id))

    const list = await listCostCenters()
    const read = await getCostCenterById(created.data.id)
    const renamed = await updateCostCenter(created.data.id, { name: 'Renamed' })

    if (!list.ok || !read.ok || !renamed.ok) throw new Error('unexpected refusal')
    expect(Object.keys(list.data[0]).sort()).toEqual(FOUR_FIELDS)
    expect(Object.keys(read.data).sort()).toEqual(FOUR_FIELDS)
    expect(Object.keys(renamed.data).sort()).toEqual(FOUR_FIELDS)
  })
})
