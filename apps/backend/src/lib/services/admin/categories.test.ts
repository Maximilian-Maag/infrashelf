import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('@/lib/ci/webhooks', () => ({
  triggerProductWebhooks: vi.fn().mockResolvedValue(['pipe-destroy']),
}))

import {
  listCategories,
  createCategory,
  getCategoryById,
  updateCategory,
  deleteCategory,
} from './categories'
import { triggerProductWebhooks } from '@/lib/ci/webhooks'
import { db } from '@/lib/db/client'
import {
  categories,
  products,
  productEnvironments,
  orders,
  auditLog,
  infrastructureElements,
} from '@/lib/db/schema'
import { eq } from 'drizzle-orm'
import {
  createUser,
  createCategory as seedCategory,
  createProduct as seedProduct,
  createCiSource,
  createEnvironment,
  createProject,
  createOrder as seedOrder,
  createInfraElement,
  linkProductEnvironment,
  waitUntilBlocked,
  warmPool,
  latch,
} from '@/test/helpers'

const mockedWebhooks = vi.mocked(triggerProductWebhooks)

beforeEach(() => {
  mockedWebhooks.mockReset().mockResolvedValue(['pipe-destroy'])
})

describe('listCategories', () => {
  it('returns empty when none exist', async () => {
    const result = await listCategories()
    expect(result.ok).toBe(true)
    if (result.ok) expect(result.data).toEqual([])
  })

  it('returns categories ordered by displayOrder then name', async () => {
    await createCategory({ name: 'B', displayOrder: 1 })
    await createCategory({ name: 'A', displayOrder: 1 })
    await createCategory({ name: 'C', displayOrder: 0 })

    const result = await listCategories()
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.data.map((c) => c.name)).toEqual(['C', 'A', 'B'])
    }
  })
})

describe('createCategory', () => {
  it('inserts a category', async () => {
    const result = await createCategory({ name: 'New', displayOrder: 5 })
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.data.name).toBe('New')
      expect(result.data.displayOrder).toBe(5)
    }
  })
})

describe('getCategoryById', () => {
  it('returns 404 for unknown id', async () => {
    const result = await getCategoryById(999_999)
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.status).toBe(404)
  })

  it('returns the category when found', async () => {
    const created = await createCategory({ name: 'Find' })
    if (!created.ok) throw new Error('seed failed')
    const result = await getCategoryById(created.data.id)
    expect(result.ok).toBe(true)
    if (result.ok) expect(result.data.name).toBe('Find')
  })
})

describe('updateCategory', () => {
  it('returns 404 for unknown id', async () => {
    const result = await updateCategory(999_999, { name: 'X' })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.status).toBe(404)
  })

  it('updates the name', async () => {
    const created = await createCategory({ name: 'Old' })
    if (!created.ok) throw new Error('seed failed')
    const result = await updateCategory(created.data.id, { name: 'Newer' })
    expect(result.ok).toBe(true)
    if (result.ok) expect(result.data.name).toBe('Newer')
  })
})

describe('deleteCategory', () => {
  it('returns 404 for unknown id', async () => {
    const result = await deleteCategory(999_999)
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.status).toBe(404)
  })

  it('deletes the category from DB', async () => {
    const created = await createCategory({ name: 'Del' })
    if (!created.ok) throw new Error('seed failed')
    const result = await deleteCategory(created.data.id)
    expect(result.ok).toBe(true)

    const rows = await db.select().from(categories).where(eq(categories.id, created.data.id))
    expect(rows.length).toBe(0)
  })

  // FA-09.7: cascade decommissioning on category delete
  it('cascade-decommissions all active infra of every product in the category (FA-09.7)', async () => {
    const pm = await createUser({ role: 'project_manager' })
    const cat = await seedCategory('CatCascade')
    const product1 = await seedProduct(cat.id, 'P1')
    const product2 = await seedProduct(cat.id, 'P2')
    const ci = await createCiSource()
    const env = await createEnvironment(ci.id)
    const project = await createProject(pm.id)
    const orderA = await seedOrder(project.id, product1.id, env.id, pm.id)
    const orderB = await seedOrder(project.id, product2.id, env.id, pm.id)
    await createInfraElement(orderA.id, project.id, env.id, product1.id)
    await createInfraElement(orderB.id, project.id, env.id, product2.id)

    const result = await deleteCategory(cat.id)
    expect(result.ok).toBe(true)

    expect(mockedWebhooks).toHaveBeenCalledTimes(2)
    const calls = mockedWebhooks.mock.calls.map((c) => c[0]).sort()
    expect(calls).toEqual([product1.id, product2.id].sort())
    // The products were ordered, so category and products are retired rather than
    // deleted (issue #142) and the infra rows stay put, mid-decommission, for the
    // callback that reconciles them. They used to vanish with the cascade.
    const rows = await db.select().from(infrastructureElements)
    expect(rows.length).toBe(2)
    expect(rows.every((r) => r.status === 'decommissioning')).toBe(true)
  })

  // FA-09.8: skip already-in-flight elements
  it('does not trigger destroy for infra already decommissioning/decommissioned (FA-09.8)', async () => {
    const pm = await createUser({ role: 'project_manager' })
    const cat = await seedCategory('CatSkip')
    const product = await seedProduct(cat.id, 'P')
    const ci = await createCiSource()
    const env = await createEnvironment(ci.id)
    const project = await createProject(pm.id)
    const order = await seedOrder(project.id, product.id, env.id, pm.id)
    await createInfraElement(order.id, project.id, env.id, product.id, { status: 'decommissioning' })
    await createInfraElement(order.id, project.id, env.id, product.id, { status: 'decommissioned' })
    await createInfraElement(order.id, project.id, env.id, product.id, { status: 'active' })

    const result = await deleteCategory(cat.id)
    expect(result.ok).toBe(true)

    expect(mockedWebhooks).toHaveBeenCalledTimes(1)
  })
})

describe('deleteCategory preserves order history (issue #142)', () => {
  const seedOrderedCategory = async () => {
    const pm = await createUser({ role: 'project_manager' })
    const cat = await seedCategory('Ordered')
    const product = await seedProduct(cat.id, 'P')
    const ci = await createCiSource()
    const env = await createEnvironment(ci.id)
    await linkProductEnvironment(product.id, env.id)
    const project = await createProject(pm.id)
    const order = await seedOrder(project.id, product.id, env.id, pm.id, { status: 'completed' })
    return { cat, product, order }
  }

  // products.category_id cascades to products and from there to orders, so this
  // endpoint erased order history one level deeper than deleteProduct did.
  it('keeps the order, retiring the category and its products instead', async () => {
    const { cat, product, order } = await seedOrderedCategory()

    const result = await deleteCategory(cat.id)
    expect(result.ok).toBe(true)

    expect((await db.select().from(orders).where(eq(orders.id, order.id))).length).toBe(1)

    const catRows = await db.select().from(categories).where(eq(categories.id, cat.id))
    expect(catRows.length).toBe(1)
    expect(catRows[0].retiredAt).toBeInstanceOf(Date)

    const productRows = await db.select().from(products).where(eq(products.id, product.id))
    expect(productRows.length).toBe(1)
    expect(productRows[0].retiredAt).toBeInstanceOf(Date)
  })

  it('counts an order that commits while the delete is running, and keeps it', async () => {
    // Issue #195. The count used to be taken before the destroy-trigger loop — one
    // HTTP call per active element, seconds and for a large category minutes —
    // while the category stayed fully orderable. An order placed in that window was
    // not counted, so the bare DELETE that ended the function cascaded it and its
    // `product_snapshot` away. The holder stands in for that order: it takes the
    // FOR KEY SHARE lock on the product that an order insert takes, and does not
    // commit until the delete is genuinely waiting behind it.
    const pm = await createUser({ role: 'project_manager' })
    const cat = await seedCategory('Racing')
    const product = await seedProduct(cat.id, 'P')
    const ci = await createCiSource()
    const env = await createEnvironment(ci.id)
    await linkProductEnvironment(product.id, env.id)
    const project = await createProject(pm.id)
    await warmPool()

    const held = latch()
    const holder = db.transaction(async (tx) => {
      await tx.insert(orders).values({
        projectId: project.id,
        productId: product.id,
        environmentId: env.id,
        userId: pm.id,
        status: 'completed',
      })
      held.open()
      await waitUntilBlocked('the delete never claimed the products in the category')
    })
    await held.opened

    const [result] = await Promise.all([deleteCategory(cat.id), holder])
    expect(result.ok).toBe(true)

    // Counted, so the category was retired — and the order it was counted for
    // survives. The stale count hard-deleted the category and cascaded it away.
    expect(await db.select().from(orders)).toHaveLength(1)
    const [row] = await db.select().from(categories).where(eq(categories.id, cat.id))
    expect(row.retiredAt).toBeInstanceOf(Date)
  })

  it('withdraws the offerings and drops out of the category list', async () => {
    const { cat, product } = await seedOrderedCategory()
    await deleteCategory(cat.id)

    const offerings = await db
      .select()
      .from(productEnvironments)
      .where(eq(productEnvironments.productId, product.id))
    expect(offerings.length).toBe(0)

    const list = await listCategories()
    expect(list.ok).toBe(true)
    if (list.ok) expect(list.data.map((c) => c.id)).not.toContain(cat.id)

    const byId = await getCategoryById(cat.id)
    expect(byId.ok).toBe(false)
    if (!byId.ok) expect(byId.status).toBe(404)
  })

  it('returns 404 when the same category is deleted twice', async () => {
    const { cat } = await seedOrderedCategory()
    expect((await deleteCategory(cat.id)).ok).toBe(true)

    const again = await deleteCategory(cat.id)
    expect(again.ok).toBe(false)
    if (!again.ok) expect(again.status).toBe(404)
  })
})

describe('category audit trail (issue #137)', () => {
  it('records create, update and delete against the acting admin', async () => {
    const actor = await createUser({ role: 'admin' })

    const created = await createCategory({ name: 'Audited' }, actor.id)
    if (!created.ok) throw new Error('seed failed')
    await updateCategory(created.data.id, { name: 'Renamed' }, actor.id)
    await deleteCategory(created.data.id, actor.id)

    const rows = await db.select().from(auditLog)
    expect(rows.map((r) => r.action).sort()).toEqual([
      'category.created',
      'category.deleted',
      'category.updated',
    ])
    for (const row of rows) expect(row.userId).toBe(actor.id)
    expect(rows.find((r) => r.action === 'category.updated')?.details).toBe('Changed: name')
  })

  it('rejects an empty update with a 400 instead of a 500', async () => {
    const created = await createCategory({ name: 'Empty' })
    if (!created.ok) throw new Error('seed failed')

    const result = await updateCategory(created.data.id, {})
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.status).toBe(400)
  })
})
