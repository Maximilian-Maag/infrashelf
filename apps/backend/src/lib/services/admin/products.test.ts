import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('@/lib/ai', () => ({
  translateProduct: vi.fn().mockResolvedValue({}),
}))

vi.mock('@/lib/ci/webhooks', () => ({
  triggerProductWebhooks: vi.fn().mockResolvedValue(['pipe-destroy']),
  triggerPipelineStacks: vi.fn().mockResolvedValue([]),
  // The teardown paths use the *Tracked variants so a trigger that fails to
  // start is reported rather than swallowed.
  triggerProductWebhooksTracked: vi.fn().mockResolvedValue({ pipelineIds: ['pipe-destroy'], failures: [] }),
  triggerPipelineStacksTracked: vi.fn().mockResolvedValue({ pipelineIds: [], failures: [] }),
}))

import {
  listProducts,
  createProduct,
  getProductAdmin,
  updateProduct,
  deleteProduct,
  setProductRetired,
  addProductImage,
  updateProductImageAlt,
  listProductImages,
  reorderProductImages,
  deleteProductImage,
  MAX_IMAGES_PER_PRODUCT,
  translateProductById,
  listTranslations,
  upsertTranslation,
  listProductEnvironments,
  createProductEnvironment,
  updateProductEnvironment,
  deleteProductEnvironment,
  listProductWebhooks,
  createProductWebhook,
  updateProductWebhook,
  deleteProductWebhook,
} from './products'
import { translateProduct } from '@/lib/ai'
import { triggerProductWebhooksTracked, triggerPipelineStacksTracked } from '@/lib/ci/webhooks'
import { db } from '@/lib/db/client'
import {
  products,
  productImages,
  productTranslations,
  productEnvironments,
  infrastructureElements,
  orders,
  auditLog,
} from '@/lib/db/schema'
import { eq, sql, and } from 'drizzle-orm'
import { listCatalog, getProduct } from '@/lib/services/catalog'
import {
  createUser,
  createCategory,
  createCiSource,
  createEnvironment,
  createProduct as seedProduct,
  createProject,
  createOrder as seedOrder,
  createInfraElement,
  createCostCenter,
  linkProductEnvironment,
} from '@/test/helpers'
import type { ProductSnapshot } from '@/lib/services/snapshot'

const mockedTranslate = vi.mocked(translateProduct)
const mockedWebhooks = vi.mocked(triggerProductWebhooksTracked)
const mockedStacks = vi.mocked(triggerPipelineStacksTracked)

beforeEach(() => {
  mockedTranslate.mockReset().mockResolvedValue({})
  mockedWebhooks.mockReset().mockResolvedValue({ pipelineIds: ['pipe-destroy'], failures: [] })
  mockedStacks.mockReset().mockResolvedValue({ pipelineIds: [], failures: [] })
})

describe('listProducts', () => {
  it('returns all products with English translation', async () => {
    const cat = await createCategory()
    await seedProduct(cat.id, 'Alpha')
    await seedProduct(cat.id, 'Beta')

    const result = await listProducts()
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.data.items.length).toBe(2)
      expect(result.data.items.map((p) => p.name).sort()).toEqual(['Alpha', 'Beta'])
      expect(result.data.total).toBe(2)
    }
  })
})

describe('createProduct', () => {
  it('inserts a product with translation for baseLanguage', async () => {
    const cat = await createCategory()
    const result = await createProduct({
      categoryId: cat.id,
      baseLanguage: 'de',
      name: 'Deutsch Name',
      description: 'beschr',
    })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.data.name).toBe('Deutsch Name')

    const tRows = await db
      .select()
      .from(productTranslations)
      .where(eq(productTranslations.productId, result.data.id))
    const codes = tRows.map((r) => r.languageCode).sort()
    expect(codes).toContain('de')
    expect(codes).toContain('en')
  })
})

describe('getProductAdmin', () => {
  it('returns 404 for unknown id', async () => {
    const result = await getProductAdmin(999_999)
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.status).toBe(404)
  })

  it('returns the product when found', async () => {
    const cat = await createCategory()
    const p = await seedProduct(cat.id, 'Find')
    const result = await getProductAdmin(p.id)
    expect(result.ok).toBe(true)
    if (result.ok) expect(result.data.name).toBe('Find')
  })
})

describe('updateProduct', () => {
  it('returns 404 for unknown id', async () => {
    const result = await updateProduct(999_999, { name: 'X' })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.status).toBe(404)
  })

  it('updates name in the English translation', async () => {
    const cat = await createCategory()
    const p = await seedProduct(cat.id, 'Before')

    const result = await updateProduct(p.id, { name: 'After' })
    expect(result.ok).toBe(true)

    const tRows = await db
      .select()
      .from(productTranslations)
      .where(eq(productTranslations.productId, p.id))
    const en = tRows.find((r) => r.languageCode === 'en')
    expect(en?.name).toBe('After')
  })
})

/**
 * Issue #161. `updateProduct` mirrored the base-language text into the `en` row
 * with `onConflictDoUpdate`, so fixing a typo in a German product name silently
 * replaced the English translation someone had written.
 *
 * That is not one language's problem: ten read paths select `language_code =
 * 'en'` with no fallback — the cart, the order list and detail, the
 * infrastructure list and search, the approvals queue, the cost report, the admin
 * product list, the order snapshot, the notification subject line — so the German
 * string then showed to EVERY user in every language, and `snapshot.ts` froze it
 * into `product_snapshot` for each new order after that.
 */
describe("the English mirror does not overwrite a real translation (#161)", () => {
  // A real row, because `audit_log.user_id` is a foreign key. The test schema was
  // missing that one constraint (#195) and these cases passed with a `userId` no
  // account had; in production the id always comes from a session.
  let editorId = 0
  beforeEach(async () => {
    editorId = (await createUser({ role: 'admin' })).id
  })

  const germanProduct = async () => {
    const cat = await createCategory()
    const created = await createProduct({
      categoryId: cat.id,
      baseLanguage: 'de',
      name: 'Virtuelle Maschine',
      description: 'Eine VM',
    })
    if (!created.ok) throw new Error('fixture failed')
    return created.data
  }

  const translationsOf = async (productId: number) => {
    const rows = await db
      .select()
      .from(productTranslations)
      .where(eq(productTranslations.productId, productId))
    return Object.fromEntries(rows.map((r) => [r.languageCode, r]))
  }

  it('leaves a translated English name alone when the German name changes', async () => {
    const product = await germanProduct()
    await upsertTranslation(product.id, 'en', { name: 'Virtual Machine', description: 'A VM' })

    await updateProduct(product.id, { name: 'Virtuelle Maschine (Linux)', userId: editorId })

    const rows = await translationsOf(product.id)
    expect(rows.de.name).toBe('Virtuelle Maschine (Linux)')
    expect(rows.en.name).toBe('Virtual Machine')
  })

  it('still moves the mirror along when nobody has translated it', async () => {
    // The mirror exists so the ten `language_code = 'en'` readers have something
    // to show. While it is untouched it must keep tracking the base language, or
    // the cart and the order list go stale instead of blank.
    const product = await germanProduct()

    await updateProduct(product.id, { name: 'Virtuelle Maschine (Linux)', userId: editorId })

    const rows = await translationsOf(product.id)
    expect(rows.en.name).toBe('Virtuelle Maschine (Linux)')
  })

  it('decides per field: a translated name and an untracked description', async () => {
    const product = await germanProduct()
    // Only the name is translated; the description is still the German mirror.
    await upsertTranslation(product.id, 'en', { name: 'Virtual Machine', description: 'Eine VM' })

    await updateProduct(product.id, {
      name: 'Virtuelle Maschine (Linux)',
      description: 'Eine Linux-VM',
      userId: editorId,
    })

    const rows = await translationsOf(product.id)
    expect(rows.en.name).toBe('Virtual Machine')
    expect(rows.en.description).toBe('Eine Linux-VM')
  })

  it('seeds an English row when the product somehow has none', async () => {
    const product = await germanProduct()
    await db
      .delete(productTranslations)
      .where(
        and(
          eq(productTranslations.productId, product.id),
          eq(productTranslations.languageCode, 'en'),
        ),
      )

    await updateProduct(product.id, { name: 'Virtuelle Maschine (Linux)', userId: editorId })

    const rows = await translationsOf(product.id)
    expect(rows.en?.name).toBe('Virtuelle Maschine (Linux)')
  })

  it('an English-base product still updates its own row', async () => {
    const cat = await createCategory()
    const created = await createProduct({
      categoryId: cat.id,
      baseLanguage: 'en',
      name: 'Virtual Machine',
      description: 'A VM',
    })
    if (!created.ok) throw new Error('fixture failed')

    await updateProduct(created.data.id, { name: 'Virtual Machine (Linux)', userId: editorId })

    const rows = await translationsOf(created.data.id)
    expect(rows.en.name).toBe('Virtual Machine (Linux)')
  })
})

describe('deleteProduct', () => {
  it('returns 404 for unknown id', async () => {
    const result = await deleteProduct(999_999)
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.status).toBe(404)
  })

  /*
   * #251 made `retired_at` a reversible Disable, so a disabled product is on
   * screen with an Enable button beside a Delete button. Delete used to answer
   * "Not found" for it, every time, and there was no other way to remove it
   * (#312) — reported against a real product on dev.
   */
  it('deletes a product that was disabled first', async () => {
    const cat = await createCategory()
    const p = await seedProduct(cat.id, 'Disabled then deleted')
    const disabled = await setProductRetired(p.id, true)
    expect(disabled.ok).toBe(true)

    const result = await deleteProduct(p.id)

    expect(result.ok).toBe(true)
    expect(await db.select().from(products).where(eq(products.id, p.id))).toHaveLength(0)
  })

  it('deletes from DB', async () => {
    const cat = await createCategory()
    const p = await seedProduct(cat.id, 'Del')
    const result = await deleteProduct(p.id)
    expect(result.ok).toBe(true)

    const rows = await db.select().from(products).where(eq(products.id, p.id))
    expect(rows.length).toBe(0)
  })

  // FA-09.6: cascade decommissioning on product delete
  it('cascade-decommissions all active infra elements provisioned from the product (FA-09.6)', async () => {
    const pm = await createUser({ role: 'project_manager' })
    const cat = await createCategory()
    const product = await seedProduct(cat.id, 'ToDelete')
    const ci = await createCiSource()
    const env = await createEnvironment(ci.id)
    const project = await createProject(pm.id)
    const order = await seedOrder(project.id, product.id, env.id, pm.id)
    await createInfraElement(order.id, project.id, env.id, product.id)
    await createInfraElement(order.id, project.id, env.id, product.id)

    const result = await deleteProduct(product.id)
    expect(result.ok).toBe(true)

    expect(mockedWebhooks).toHaveBeenCalledTimes(2)
    expect(mockedWebhooks).toHaveBeenCalledWith(
      product.id,
      env.id,
      expect.objectContaining({ TF_ACTION: 'destroy' }),
      // The recorder that stores each pipeline id as it starts (issue #132).
      expect.any(Function),
    )
    // Pipeline-stack destroy fired for every active element too.
    expect(mockedStacks).toHaveBeenCalledTimes(2)
    expect(mockedStacks).toHaveBeenCalledWith(
      product.id,
      env.id,
      expect.objectContaining({ TF_ACTION: 'destroy' }),
      expect.any(Function),
      // Fifth argument, which the webhook trigger does not take: the element's
      // parameters with reserved names still in them, read only to derive the
      // state key. A legacy stack keyed on a reserved name has no other way to
      // find the value its own apply used.
      expect.anything(),
      // Sixth: the keys this element was PROVISIONED under (#200). The destroy
      // has to address the state that exists, not one re-derived from a stack
      // row that may have moved since.
      expect.anything(),
    )
    // The product was ordered, so it is retired rather than deleted (issue #142)
    // and its infrastructure rows stay put, mid-decommission, for the callback that
    // reconciles them. They used to vanish with the cascade.
    const rows = await db.select().from(infrastructureElements).where(eq(infrastructureElements.productId, product.id))
    expect(rows.length).toBe(2)
    expect(rows.every((r) => r.status === 'decommissioning')).toBe(true)
  })

  // FA-09.8: skip already-in-flight elements
  it('does not re-trigger destroy for elements already decommissioning/decommissioned (FA-09.8)', async () => {
    const pm = await createUser({ role: 'project_manager' })
    const cat = await createCategory()
    const product = await seedProduct(cat.id, 'MixState')
    const ci = await createCiSource()
    const env = await createEnvironment(ci.id)
    const project = await createProject(pm.id)
    const order = await seedOrder(project.id, product.id, env.id, pm.id)
    await createInfraElement(order.id, project.id, env.id, product.id, { status: 'decommissioning' })
    await createInfraElement(order.id, project.id, env.id, product.id, { status: 'decommissioned' })
    await createInfraElement(order.id, project.id, env.id, product.id, { status: 'active' })

    const result = await deleteProduct(product.id)
    expect(result.ok).toBe(true)

    expect(mockedWebhooks).toHaveBeenCalledTimes(1)
    expect(mockedStacks).toHaveBeenCalledTimes(1)
  })

  // Cascade-delete race: the destroy trigger must complete BEFORE the product
  // (and its cascaded infra rows) are deleted.
  it('awaits the destroy trigger before retiring the product', async () => {
    const pm = await createUser({ role: 'project_manager' })
    const cat = await createCategory()
    const product = await seedProduct(cat.id, 'AwaitDestroy')
    const ci = await createCiSource()
    const env = await createEnvironment(ci.id)
    const project = await createProject(pm.id)
    const order = await seedOrder(project.id, product.id, env.id, pm.id)
    await createInfraElement(order.id, project.id, env.id, product.id)

    let productExistedAtTrigger = false
    let infraExistedAtTrigger = false
    mockedWebhooks.mockImplementationOnce(async () => {
      productExistedAtTrigger =
        (await db.select().from(products).where(eq(products.id, product.id))).length > 0
      infraExistedAtTrigger =
        (await db.select().from(infrastructureElements).where(eq(infrastructureElements.productId, product.id))).length > 0
      return { pipelineIds: ['pipe-destroy'], failures: [] }
    })

    const result = await deleteProduct(product.id)
    expect(result.ok).toBe(true)

    expect(productExistedAtTrigger).toBe(true)
    expect(infraExistedAtTrigger).toBe(true)

    // It was ordered, so the row survives — retired, and out of every catalogue.
    const rows = await db.select().from(products).where(eq(products.id, product.id))
    expect(rows.length).toBe(1)
    expect(rows[0].retiredAt).not.toBeNull()
  })

  it('refuses to delete the product when a destroy trigger could not be started', async () => {
    const pm = await createUser({ role: 'project_manager' })
    const cat = await createCategory()
    const product = await seedProduct(cat.id, 'TriggerFails')
    const ci = await createCiSource()
    const env = await createEnvironment(ci.id)
    const project = await createProject(pm.id)
    const order = await seedOrder(project.id, product.id, env.id, pm.id)
    await createInfraElement(order.id, project.id, env.id, product.id)
    mockedStacks.mockResolvedValueOnce({ pipelineIds: [], failures: ['pipeline stack "s" (#3): refused'] })

    const result = await deleteProduct(product.id)
    // Deleting would cascade the infrastructure_elements rows away and leave the
    // provisioned infrastructure running with nothing to reconcile it against.
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.status).toBe(502)
      expect(result.message).toContain('refused')
    }

    // Product and its tracking rows survive so the operator can retry.
    const rows = await db.select().from(products).where(eq(products.id, product.id))
    expect(rows.length).toBe(1)
    const infra = await db
      .select()
      .from(infrastructureElements)
      .where(eq(infrastructureElements.productId, product.id))
    expect(infra.length).toBe(1)
  })
})

describe('deleteProduct preserves order history (issue #142)', () => {
  const seedOrderedProduct = async () => {
    const pm = await createUser({ role: 'project_manager' })
    const cat = await createCategory()
    const product = await seedProduct(cat.id, 'Ordered')
    const ci = await createCiSource()
    const env = await createEnvironment(ci.id)
    await linkProductEnvironment(product.id, env.id, { price: '9.99' })
    const project = await createProject(pm.id)
    const order = await seedOrder(project.id, product.id, env.id, pm.id, { status: 'completed' })
    return { pm, product, env, order, project }
  }

  // orders.product_id is ON DELETE CASCADE, so the delete used to take the order
  // and its product_snapshot — the column that exists to keep exactly this.
  it('keeps the order and its snapshot, retiring the product instead of deleting it', async () => {
    const { product, order } = await seedOrderedProduct()
    // Only survival of the column is under test, so the snapshot is a stub rather
    // than eleven fields of fiction.
    await db
      .update(orders)
      .set({ productSnapshot: { name: 'Ordered', price: '9.99' } as unknown as ProductSnapshot })
      .where(eq(orders.id, order.id))

    const result = await deleteProduct(product.id)
    expect(result.ok).toBe(true)

    const orderRows = await db.select().from(orders).where(eq(orders.id, order.id))
    expect(orderRows.length).toBe(1)
    expect(orderRows[0].productSnapshot).toEqual({ name: 'Ordered', price: '9.99' })

    const productRows = await db.select().from(products).where(eq(products.id, product.id))
    expect(productRows.length).toBe(1)
    expect(productRows[0].retiredAt).toBeInstanceOf(Date)
  })

  /*
   * This used to assert the opposite — that every offering was DELETED — and
   * that was the mechanism: the flag only kept the product out of the
   * catalogue's reads, and the missing `product_environments` row was what
   * actually made it unorderable.
   *
   * It also made the withdrawal irreversible. Price, currency and cost-centre
   * mode were gone with nothing to restore them from, so a product put back was
   * not the product it had been — and #251 asks for a withdrawal that can be
   * undone. `retiredAt` is the check now, in `addToCart` and `prepareOrder`.
   */
  it('keeps every offering, so the product can be put back at the price it had', async () => {
    const { product } = await seedOrderedProduct()

    const result = await deleteProduct(product.id)
    expect(result.ok).toBe(true)

    const offerings = await db
      .select()
      .from(productEnvironments)
      .where(eq(productEnvironments.productId, product.id))
    expect(offerings.length).toBeGreaterThan(0)
  })

  // And it is still unorderable, which is the property the deletion of the
  // offerings used to provide.
  it('is unorderable while withdrawn, by the flag rather than by the missing offering', async () => {
    const { product } = await seedOrderedProduct()
    await deleteProduct(product.id)

    const [row] = await db.select().from(products).where(eq(products.id, product.id))
    expect(row.retiredAt).toBeInstanceOf(Date)
  })

  /*
   * The catalogue, yes. The admin list, no — and that reversal is the whole of
   * #251.
   *
   * Hiding a withdrawn product from the ADMIN list is what made retirement a
   * one-way trapdoor: it is the only screen it can be brought back from, so a
   * product withdrawn by pressing Delete could not be reached again short of a
   * database update.
   */
  it('takes the retired product out of the catalogue but leaves it on the admin list', async () => {
    const { product } = await seedOrderedProduct()
    await deleteProduct(product.id)

    const admin = await listProducts()
    expect(admin.ok).toBe(true)
    if (admin.ok) {
      expect(admin.data.items.map((p) => p.id)).toContain(product.id)
      // Marked, so the list does not read as though it were live.
      expect(admin.data.items.find((p) => p.id === product.id)?.retiredAt).toBeTruthy()
    }

    const shop = await listCatalog('en')
    expect(shop.ok).toBe(true)
    if (shop.ok) {
      expect(shop.data.items.map((p) => p.id)).not.toContain(product.id)
      // The count has to agree with the rows, or the pager lies about a page.
      expect(shop.data.total).toBe(0)
    }

    const detail = await getProduct(product.id, 'en')
    expect(detail.ok).toBe(false)
    if (!detail.ok) expect(detail.status).toBe(404)

    // And the admin READ succeeds too, for the same reason the list shows it:
    // fixing a product and putting it back is one action in two steps, and a
    // 404 in between makes the second step impossible.
    const adminDetail = await getProductAdmin(product.id)
    expect(adminDetail.ok).toBe(true)
    if (adminDetail.ok) expect(adminDetail.data.retiredAt).toBeInstanceOf(Date)
  })

  /*
   * Deleting an ordered product twice is idempotent, not a 404.
   *
   * This asserted 404 until #312. "Not found" was a lie about a product sitting
   * in the admin list with an Enable button, and the lie was load-bearing: the
   * same pre-check made a product that had only ever been DISABLED — never
   * deleted — impossible to remove at all. There is no test that distinguishes
   * the two cases, because at the row level there is nothing to distinguish.
   *
   * `ok` without a hard delete is already this function's contract: the first
   * call on an ordered product retires it and returns ok too. Both calls leave
   * the caller's stated end state — out of the catalogue, history intact — and
   * say so the same way. `setProductRetired` makes the same choice one screen
   * over: "the caller wanted it disabled and it is disabled".
   */
  it('is idempotent for an ordered product, which stays retired', async () => {
    const { product } = await seedOrderedProduct()
    expect((await deleteProduct(product.id)).ok).toBe(true)

    const again = await deleteProduct(product.id)

    expect(again.ok).toBe(true)
    const rows = await db.select().from(products).where(eq(products.id, product.id))
    expect(rows).toHaveLength(1)
    expect(rows[0].retiredAt).toBeInstanceOf(Date)
  })

  it('still 404s for an id that was never there', async () => {
    expect(await deleteProduct(999_999)).toMatchObject({ ok: false, status: 404 })
  })

  /*
   * From review. #251 gave `retiredAt` a second writer — `setProductRetired`,
   * the Disable button — and `deleteProduct` fires its destroy triggers BEFORE
   * it takes the product-row lock. A disable landing in that window used to
   * turn the delete's locked select into a miss, so the call answered 404 after
   * it had already claimed every infrastructure row and started tearing them
   * down. "Nothing happened" while the installation is being decommissioned is
   * the worst answer available.
   *
   * The window is real time, so this drives it rather than approximating it:
   * the destroy trigger is mocked, and the mock disables the product while the
   * delete is inside its trigger loop. That is exactly where a concurrent
   * request would land.
   */
  it('does not answer 404 when the product is disabled mid-delete', async () => {
    const { product, env, project, order } = await seedOrderedProduct()
    // An active element, so the delete actually enters its destroy loop — the
    // loop is the window this test drives.
    await createInfraElement(order.id, project.id, env.id, product.id)

    mockedWebhooks.mockImplementationOnce(async () => {
      await setProductRetired(product.id, true)
      return { pipelineIds: ['pipe-destroy'], failures: [] }
    })

    const result = await deleteProduct(product.id)

    // Not 404. The destroy triggers fired, so an answer of "no such product"
    // would be a lie about what the call had already done.
    expect(result.ok).toBe(true)
    const [row] = await db.select().from(products).where(eq(products.id, product.id))
    expect(row.retiredAt).toBeInstanceOf(Date)
  })

  it('records the retirement in the audit log', async () => {
    const { product } = await seedOrderedProduct()
    const actor = await createUser({ role: 'root' })

    await deleteProduct(product.id, actor.id)

    const rows = await db.select().from(auditLog).where(eq(auditLog.action, 'product.retired'))
    expect(rows.length).toBe(1)
    expect(rows[0].userId).toBe(actor.id)
    expect(rows[0].entityId).toBe(product.id)
  })

  /*
   * The window this closes: the order count used to be taken BEFORE the destroy
   * triggers, which are per-element network calls taking seconds, and the product
   * stayed orderable for all of them — its offerings are only withdrawn in the
   * retire transaction at the very end. An order placed in there was not counted,
   * so the product was hard-deleted and `orders.product_id ON DELETE CASCADE` took
   * that order and its snapshot with it.
   *
   * The trigger mock is the window: it runs at exactly the moment a real destroy
   * request is in flight. The infrastructure is attached to another product's order
   * so that THIS product has no orders when the delete starts — infrastructure
   * rows require an order (`order_id` is NOT NULL), and a product that already had
   * one would be retired for that reason instead of this one.
   */
  it('counts an order placed while the destroy triggers are in flight', async () => {
    const pm = await createUser({ role: 'project_manager' })
    const cat = await createCategory()
    const product = await seedProduct(cat.id, 'RacedByAnOrder')
    const other = await seedProduct(cat.id, 'OwnsTheInfraOrder')
    const ci = await createCiSource()
    const env = await createEnvironment(ci.id)
    await linkProductEnvironment(product.id, env.id, { price: '9.99' })
    const project = await createProject(pm.id)
    const unrelated = await seedOrder(project.id, other.id, env.id, pm.id)
    await createInfraElement(unrelated.id, project.id, env.id, product.id)

    let racedOrderId = 0
    mockedWebhooks.mockImplementationOnce(async () => {
      const [placed] = await db
        .insert(orders)
        .values({
          projectId: project.id,
          productId: product.id,
          environmentId: env.id,
          userId: pm.id,
          status: 'pending',
          pipelineId: [],
          productSnapshot: { name: 'RacedByAnOrder', price: '9.99' } as unknown as ProductSnapshot,
        })
        .returning({ id: orders.id })
      racedOrderId = placed.id
      return { pipelineIds: ['pipe-destroy'], failures: [] }
    })

    const result = await deleteProduct(product.id)
    expect(result.ok).toBe(true)

    // The order that arrived mid-delete survives, snapshot and all.
    const raced = await db.select().from(orders).where(eq(orders.id, racedOrderId))
    expect(raced.length).toBe(1)
    expect(raced[0].productSnapshot).toEqual({ name: 'RacedByAnOrder', price: '9.99' })

    // ...because the product was retired rather than hard-deleted.
    const rows = await db.select().from(products).where(eq(products.id, product.id))
    expect(rows.length).toBe(1)
    expect(rows[0].retiredAt).toBeInstanceOf(Date)
  })

  it('still hard-deletes a product nobody ever ordered', async () => {
    const cat = await createCategory()
    const product = await seedProduct(cat.id, 'NeverOrdered')

    const result = await deleteProduct(product.id)
    expect(result.ok).toBe(true)
    expect((await db.select().from(products).where(eq(products.id, product.id))).length).toBe(0)
  })
})

describe('product update validation (issue #143)', () => {
  it('rejects an empty offering update with a 400 instead of a 500', async () => {
    const cat = await createCategory()
    const product = await seedProduct(cat.id, 'P')
    const ci = await createCiSource()
    const env = await createEnvironment(ci.id)
    await linkProductEnvironment(product.id, env.id)

    // A well-formed `{}` from an all-optional schema, plus the userId the route
    // always injects — which is why isEmptyUpdate(input) alone would not do.
    const result = await updateProductEnvironment(product.id, env.id, { userId: 1 })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.status).toBe(400)
  })

  it('rejects an empty product update with a 400 instead of a 500', async () => {
    const cat = await createCategory()
    const product = await seedProduct(cat.id, 'P')

    const result = await updateProduct(product.id, { userId: 1 })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.status).toBe(400)
  })

  it('rejects an empty webhook update with a 400 instead of a 500', async () => {
    const cat = await createCategory()
    const product = await seedProduct(cat.id, 'P')
    const ci = await createCiSource()
    const env = await createEnvironment(ci.id)
    const created = await createProductWebhook(product.id, {
      environmentId: env.id,
      name: 'wh',
      webhookUrl: 'https://ci.example.com/hook',
      webhookToken: 'tok',
    })
    if (!created.ok) throw new Error('seed failed')

    const result = await updateProductWebhook(product.id, created.data.id, {})
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.status).toBe(400)
  })

  it('records a webhook token rotation by field name, never by value', async () => {
    const actor = await createUser({ role: 'root' })
    const cat = await createCategory()
    const product = await seedProduct(cat.id, 'P')
    const ci = await createCiSource()
    const env = await createEnvironment(ci.id)
    const created = await createProductWebhook(product.id, {
      environmentId: env.id,
      name: 'wh',
      webhookUrl: 'https://ci.example.com/hook',
      webhookToken: 'first-token',
    }, actor.id)
    if (!created.ok) throw new Error('seed failed')

    await updateProductWebhook(product.id, created.data.id, { webhookToken: 'rotated-token-secret' }, actor.id)

    const rows = await db.select().from(auditLog).where(eq(auditLog.action, 'product.webhook_updated'))
    expect(rows.length).toBe(1)
    expect(rows[0].details).toContain('webhookToken')
    expect(rows[0].details).not.toContain('rotated-token-secret')
    // The creation recorded the URL but not the token either.
    const createdRows = await db.select().from(auditLog).where(eq(auditLog.action, 'product.webhook_added'))
    expect(createdRows[0].details).toContain('https://ci.example.com/hook')
    expect(createdRows[0].details).not.toContain('first-token')
  })
})

describe('listTranslations / upsertTranslation', () => {
  it('lists all translations for a product', async () => {
    const cat = await createCategory()
    const p = await seedProduct(cat.id, 'P')
    await db.insert(productTranslations).values({
      productId: p.id,
      languageCode: 'de',
      name: 'P-DE',
      description: '',
    })

    const result = await listTranslations(p.id)
    expect(result.ok).toBe(true)
    if (result.ok) {
      const codes = result.data.map((t) => t.languageCode).sort()
      expect(codes).toEqual(['de', 'en'])
    }
  })

  it('inserts a new translation when none exists for that language', async () => {
    const cat = await createCategory()
    const p = await seedProduct(cat.id, 'P')

    const result = await upsertTranslation(p.id, 'fr', { name: 'Le Produit', description: 'fr desc' })
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.data.name).toBe('Le Produit')
      expect(result.data.languageCode).toBe('fr')
    }
  })

  it('updates an existing translation on conflict', async () => {
    const cat = await createCategory()
    const p = await seedProduct(cat.id, 'P')

    await upsertTranslation(p.id, 'fr', { name: 'Old FR', description: '' })
    const result = await upsertTranslation(p.id, 'fr', { name: 'New FR', description: 'updated' })
    expect(result.ok).toBe(true)
    if (result.ok) expect(result.data.name).toBe('New FR')

    const rows = await db
      .select()
      .from(productTranslations)
      .where(eq(productTranslations.productId, p.id))
    const fr = rows.filter((r) => r.languageCode === 'fr')
    expect(fr.length).toBe(1)
    expect(fr[0].name).toBe('New FR')
  })
})

describe('product environments', () => {
  const buildEnv = async () => {
    const cat = await createCategory()
    const p = await seedProduct(cat.id, 'P')
    const ci = await createCiSource()
    const env = await createEnvironment(ci.id)
    return { p, env }
  }

  it('createProductEnvironment then listProductEnvironments', async () => {
    const { p, env } = await buildEnv()

    const createRes = await createProductEnvironment(p.id, {
      environmentId: env.id,
      price: '50.00',
      currency: 'USD',
    })
    expect(createRes.ok).toBe(true)

    const listRes = await listProductEnvironments(p.id)
    expect(listRes.ok).toBe(true)
    if (listRes.ok) {
      expect(listRes.data.length).toBe(1)
      expect(listRes.data[0].environmentName).toBe('Test Env')
      expect(listRes.data[0].currency).toBe('USD')
    }
  })

  it('updateProductEnvironment returns 404 for unknown pair', async () => {
    const { p } = await buildEnv()
    const result = await updateProductEnvironment(p.id, 999_999, { price: '1.00' })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.status).toBe(404)
  })

  it('updateProductEnvironment updates fields', async () => {
    const { p, env } = await buildEnv()
    await createProductEnvironment(p.id, { environmentId: env.id, price: '1.00' })

    const result = await updateProductEnvironment(p.id, env.id, { price: '99.99', currency: 'CHF' })
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.data.currency).toBe('CHF')
    }
  })

  it('deleteProductEnvironment returns 404 for unknown pair, removes existing', async () => {
    const { p, env } = await buildEnv()
    const missing = await deleteProductEnvironment(p.id, 999_999)
    expect(missing.ok).toBe(false)

    await createProductEnvironment(p.id, { environmentId: env.id })
    const ok = await deleteProductEnvironment(p.id, env.id)
    expect(ok.ok).toBe(true)
  })

  it.each(['active', 'decommissioning'])(
    'deleteProductEnvironment refuses while %s infrastructure exists',
    async (status) => {
      const { p, env } = await buildEnv()
      await createProductEnvironment(p.id, { environmentId: env.id })
      const user = await createUser({ role: 'admin' })
      const project = await createProject(user.id)
      const order = await seedOrder(project.id, p.id, env.id, user.id)
      await createInfraElement(order.id, project.id, env.id, p.id, { status })

      const result = await deleteProductEnvironment(p.id, env.id)
      expect(result.ok).toBe(false)
      if (!result.ok) expect(result.status).toBe(409)

      // The offering must survive the refused delete.
      const listRes = await listProductEnvironments(p.id)
      expect(listRes.ok && listRes.data.length).toBe(1)
    },
  )

  it('deleteProductEnvironment ignores decommissioned infrastructure', async () => {
    const { p, env } = await buildEnv()
    await createProductEnvironment(p.id, { environmentId: env.id })
    const user = await createUser({ role: 'admin' })
    const project = await createProject(user.id)
    const order = await seedOrder(project.id, p.id, env.id, user.id)
    await createInfraElement(order.id, project.id, env.id, p.id, { status: 'decommissioned' })

    const result = await deleteProductEnvironment(p.id, env.id)
    expect(result.ok).toBe(true)
  })

  // ── overhead cost centre (issue #22) ──────────────────────────────────────
  it('stores and clears the overhead cost centre', async () => {
    const { p, env } = await buildEnv()
    const cc = await createCostCenter({ code: 'CC-OVERHEAD' })

    const created = await createProductEnvironment(p.id, {
      environmentId: env.id,
      costCenterMode: 'overhead',
      overheadCostCenterId: cc.id,
    })
    expect(created.ok).toBe(true)
    if (created.ok) expect(created.data.overheadCostCenterId).toBe(cc.id)

    const cleared = await updateProductEnvironment(p.id, env.id, { overheadCostCenterId: null })
    expect(cleared.ok).toBe(true)
    if (cleared.ok) expect(cleared.data.overheadCostCenterId).toBeNull()
  })

  it('defaults the overhead cost centre to null', async () => {
    const { p, env } = await buildEnv()
    const created = await createProductEnvironment(p.id, { environmentId: env.id })
    expect(created.ok && created.data.overheadCostCenterId).toBeNull()
  })

  it('rejects an unknown overhead cost centre on create and update', async () => {
    const { p, env } = await buildEnv()

    const created = await createProductEnvironment(p.id, { environmentId: env.id, overheadCostCenterId: 999_999 })
    expect(created.ok).toBe(false)
    if (!created.ok) {
      expect(created.status).toBe(400)
      expect(created.message).toMatch(/overhead cost center not found/i)
    }

    await createProductEnvironment(p.id, { environmentId: env.id })
    const updated = await updateProductEnvironment(p.id, env.id, { overheadCostCenterId: 999_999 })
    expect(updated.ok).toBe(false)
    if (!updated.ok) expect(updated.status).toBe(400)
  })

  it('rejects a deactivated overhead cost centre', async () => {
    // Accepting it here would only defer the failure to the next order placed
    // against the offering, long after the operator who set it has moved on.
    const { p, env } = await buildEnv()
    const cc = await createCostCenter({ code: 'CC-DEAD', active: false })

    const created = await createProductEnvironment(p.id, {
      environmentId: env.id,
      costCenterMode: 'overhead',
      overheadCostCenterId: cc.id,
    })
    expect(created.ok).toBe(false)
    if (!created.ok) expect(created.message).toMatch(/not active/i)
  })

  it('surfaces the overhead cost centre through the list and detail reads', async () => {
    const { p, env } = await buildEnv()
    const cc = await createCostCenter({ code: 'CC-OVERHEAD' })
    await createProductEnvironment(p.id, {
      environmentId: env.id,
      costCenterMode: 'overhead',
      overheadCostCenterId: cc.id,
    })

    const listRes = await listProductEnvironments(p.id)
    expect(listRes.ok && listRes.data[0].overheadCostCenterId).toBe(cc.id)

    const detailRes = await getProductAdmin(p.id)
    expect(detailRes.ok && detailRes.data.environments[0].overheadCostCenterId).toBe(cc.id)
  })

  it('deleteProductEnvironment ignores live infrastructure in a different environment', async () => {
    const { p, env } = await buildEnv()
    const otherEnv = await createEnvironment((await createCiSource()).id)
    await createProductEnvironment(p.id, { environmentId: env.id })
    const user = await createUser({ role: 'admin' })
    const project = await createProject(user.id)
    const order = await seedOrder(project.id, p.id, otherEnv.id, user.id)
    await createInfraElement(order.id, project.id, otherEnv.id, p.id, { status: 'active' })

    const result = await deleteProductEnvironment(p.id, env.id)
    expect(result.ok).toBe(true)
  })
})

describe('product webhooks', () => {
  const buildEnv = async () => {
    const cat = await createCategory()
    const p = await seedProduct(cat.id, 'P')
    const ci = await createCiSource()
    const env = await createEnvironment(ci.id)
    return { p, env }
  }

  it('createProductWebhook then listProductWebhooks', async () => {
    const { p, env } = await buildEnv()
    const created = await createProductWebhook(p.id, {
      environmentId: env.id,
      name: 'wh',
      webhookUrl: 'http://example.com',
      webhookToken: 'tok',
      execOrder: 1,
    })
    expect(created.ok).toBe(true)

    const result = await listProductWebhooks(p.id)
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.data.length).toBe(1)
      expect(result.data[0].name).toBe('wh')
    }
  })

  it('updateProductWebhook returns 404 for unknown id', async () => {
    const { p } = await buildEnv()
    const result = await updateProductWebhook(p.id, 999_999, { name: 'x' })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.status).toBe(404)
  })

  it('updateProductWebhook updates fields', async () => {
    const { p, env } = await buildEnv()
    const created = await createProductWebhook(p.id, {
      environmentId: env.id,
      name: 'old',
      webhookUrl: 'http://e',
      webhookToken: 't',
    })
    if (!created.ok) throw new Error('seed failed')

    const result = await updateProductWebhook(p.id, created.data.id, { name: 'new' })
    expect(result.ok).toBe(true)
    if (result.ok) expect(result.data.name).toBe('new')
  })

  it('deleteProductWebhook returns 404 for unknown id, removes existing', async () => {
    const { p, env } = await buildEnv()
    const missing = await deleteProductWebhook(p.id, 999_999)
    expect(missing.ok).toBe(false)
    if (!missing.ok) expect(missing.status).toBe(404)

    const created = await createProductWebhook(p.id, {
      environmentId: env.id,
      name: 'wh',
      webhookUrl: 'http://e',
      webhookToken: 't',
    })
    if (!created.ok) throw new Error('seed failed')
    const ok = await deleteProductWebhook(p.id, created.data.id)
    expect(ok.ok).toBe(true)
  })
})

describe('addProductImage', () => {
  // A truncated signature is no longer enough: the type is now determined from
  // the bytes, so a fixture has to be a plausible file rather than four bytes.
  const png = Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    Buffer.alloc(32, 1),
  ])

  const gallery = (productId: number) =>
    db
      .select({ data: productImages.data, mime: productImages.mime, position: productImages.position })
      .from(productImages)
      .where(eq(productImages.productId, productId))
      .orderBy(productImages.position, productImages.id)

  it('stores the image buffer and the type it detected', async () => {
    const cat = await createCategory()
    const p = await seedProduct(cat.id, 'Img')

    const result = await addProductImage(p.id, png, 'A screenshot of the gateway dashboard')
    expect(result.ok).toBe(true)
    if (result.ok) expect(result.data.mime).toBe('image/png')

    const [row] = await gallery(p.id)
    expect(Buffer.from(row.data).equals(png)).toBe(true)
    expect(row.mime).toBe('image/png')
    expect(row.position).toBe(0)
  })

  it('appends at the next position instead of overwriting', async () => {
    const cat = await createCategory()
    const p = await seedProduct(cat.id, 'Img-append')

    await addProductImage(p.id, png, 'The first one')
    const second = await addProductImage(p.id, png, 'The second one')
    expect(second.ok).toBe(true)
    if (second.ok) expect(second.data.position).toBe(1)
    expect((await gallery(p.id)).map((row) => row.position)).toEqual([0, 1])
  })

  it('rejects bytes that are not an accepted image type', async () => {
    const cat = await createCategory()
    const p = await seedProduct(cat.id, 'Img2')

    const result = await addProductImage(p.id, Buffer.from('not an image but long enough'), 'Some description')
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.status).toBe(415)
  })

  it('reports an unknown product instead of silently succeeding', async () => {
    const result = await addProductImage(999_999, png, 'A description')
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.status).toBe(404)
  })

  it('caps how many pictures one gallery holds', async () => {
    const cat = await createCategory()
    const p = await seedProduct(cat.id, 'Img-cap')

    for (let i = 0; i < MAX_IMAGES_PER_PRODUCT; i += 1) {
      expect((await addProductImage(p.id, png, `Picture ${i}`)).ok).toBe(true)
    }

    const overflow = await addProductImage(p.id, png, 'One too many')
    expect(overflow.ok).toBe(false)
    if (!overflow.ok) expect(overflow.status).toBe(409)
  })

  it('holds the cap and keeps positions dense when uploads race', async () => {
    const cat = await createCategory()
    const p = await seedProduct(cat.id, 'Img-race')

    for (let i = 0; i < MAX_IMAGES_PER_PRODUCT - 1; i += 1) {
      expect((await addProductImage(p.id, png, `Picture ${i}`)).ok).toBe(true)
    }

    // Warm the pool first. postgres.js connects lazily, so on a cold pool the
    // later callers spend their first statement on a TCP handshake while the
    // first caller finishes all three of its queries — they never overlap and
    // the bug hides. Four warm racers rather than two: against the pre-fix code
    // two reproduced in 4 runs out of 5, four in 8 out of 8.
    const racers = 4
    await Promise.all(Array.from({ length: racers }, () => db.execute(sql`SELECT 1`)))

    // One free slot, four uploads. Before the FOR UPDATE lock every caller read
    // the same COUNT and the same MAX(position) before any of them inserted, so
    // all four were let through and all four took the same position — four over
    // the cap, with four rows claiming one place in the order.
    const results = await Promise.all(
      Array.from({ length: racers }, (_, i) => addProductImage(p.id, png, `Racer ${i}`)),
    )

    expect(results.filter((result) => result.ok)).toHaveLength(1)
    for (const result of results.filter((r) => !r.ok)) {
      if (!result.ok) expect(result.status).toBe(409)
    }

    const rows = await gallery(p.id)
    expect(rows).toHaveLength(MAX_IMAGES_PER_PRODUCT)
    expect(rows.map((row) => row.position)).toEqual(
      Array.from({ length: MAX_IMAGES_PER_PRODUCT }, (_, i) => i),
    )
  })
})

describe('reorderProductImages / deleteProductImage', () => {
  it('audits every gallery mutation with the actor who made it', async () => {
    // #137's rule, applied to the routes this branch adds: an admin mutation that
    // writes no audit row is a change nobody can attribute afterwards.
    const root = await createUser({ role: 'root' })
    const cat = await createCategory()
    const product = await seedProduct(cat.id, 'Audited gallery')
    const png = Buffer.concat([
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
      Buffer.alloc(32, 1),
    ])
    const added = await addProductImage(product.id, png, 'A picture', root.id)
    expect(added.ok).toBe(true)
    if (!added.ok) return

    await updateProductImageAlt(product.id, added.data.id, 'A better description', root.id)
    await deleteProductImage(product.id, added.data.id, root.id)

    const entries = await db
      .select()
      .from(auditLog)
      .where(eq(auditLog.entityId, product.id))
    const actions = entries.map((e) => e.action)
    expect(actions).toEqual(
      expect.arrayContaining([
        'product.image_added',
        'product.image_alt_updated',
        'product.image_deleted',
      ]),
    )
    for (const entry of entries) expect(entry.userId).toBe(root.id)
    // Names, not values: the description an operator typed is not the log's business.
    expect(entries.map((e) => e.details).join(' ')).not.toContain('A better description')
  })

  it('answers 404 for a product that does not exist, whatever the order says', async () => {
    // An empty gallery is ambiguous, and the two cases owe different answers: an
    // empty list used to succeed (204) and a non-empty one used to be 400, so an
    // unknown product never produced a 404 by either route.
    for (const order of [[], [1, 2]]) {
      const result = await reorderProductImages(999_999, order)
      expect(result.ok).toBe(false)
      if (!result.ok) expect(result.status).toBe(404)
    }
  })

  const png = Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    Buffer.alloc(32, 1),
  ])

  const seedGallery = async (label: string) => {
    const cat = await createCategory()
    const p = await seedProduct(cat.id, label)
    for (const alt of ['First', 'Second', 'Third']) {
      const added = await addProductImage(p.id, png, alt)
      expect(added.ok).toBe(true)
    }
    const listed = await listProductImages(p.id)
    expect(listed.ok).toBe(true)
    return { product: p, images: listed.ok ? listed.data : [] }
  }

  it('assigns positions in the order given', async () => {
    const { product, images } = await seedGallery('Reorder')

    const result = await reorderProductImages(product.id, [images[2].id, images[0].id, images[1].id])
    expect(result.ok).toBe(true)

    const after = await listProductImages(product.id)
    if (after.ok) {
      expect(after.data.map((row) => row.alt)).toEqual(['Third', 'First', 'Second'])
      expect(after.data.map((row) => row.position)).toEqual([0, 1, 2])
    }
  })

  it('refuses an order that is not exactly this product\'s gallery', async () => {
    const { product, images } = await seedGallery('Reorder-partial')
    const other = await seedGallery('Reorder-other')

    for (const order of [
      [images[0].id, images[1].id],
      [images[0].id, images[0].id, images[1].id],
      [images[0].id, images[1].id, other.images[0].id],
    ]) {
      const result = await reorderProductImages(product.id, order)
      expect(result.ok).toBe(false)
      if (!result.ok) expect(result.status).toBe(400)
    }

    const after = await listProductImages(product.id)
    if (after.ok) expect(after.data.map((row) => row.alt)).toEqual(['First', 'Second', 'Third'])
  })

  it('closes the gap left by a deletion so positions stay dense', async () => {
    const { product, images } = await seedGallery('Delete')

    expect((await deleteProductImage(product.id, images[0].id)).ok).toBe(true)

    const after = await listProductImages(product.id)
    if (after.ok) {
      expect(after.data.map((row) => row.alt)).toEqual(['Second', 'Third'])
      expect(after.data.map((row) => row.position)).toEqual([0, 1])
    }
  })

  it('will not delete a picture through the wrong product', async () => {
    const mine = await seedGallery('Delete-mine')
    const theirs = await seedGallery('Delete-theirs')

    const result = await deleteProductImage(mine.product.id, theirs.images[0].id)
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.status).toBe(404)

    const after = await listProductImages(theirs.product.id)
    if (after.ok) expect(after.data).toHaveLength(3)
  })
})

describe('translateProductById', () => {
  it('returns 404 for unknown product', async () => {
    const result = await translateProductById(999_999)
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.status).toBe(404)
  })

  it('returns 404 when base translation is missing', async () => {
    const cat = await createCategory()
    // Insert product without any translation row
    const [raw] = await db
      .insert(products)
      .values({ categoryId: cat.id, baseLanguage: 'de' })
      .returning()

    const result = await translateProductById(raw.id)
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.status).toBe(404)
  })

  it('calls translateProduct with base text and upserts returned translations', async () => {
    const cat = await createCategory()
    const p = await seedProduct(cat.id, 'Hello')

    mockedTranslate.mockResolvedValueOnce({
      de: { name: 'Hallo', description: 'Beschreibung' },
      fr: { name: 'Bonjour', description: 'Description' },
    })

    const result = await translateProductById(p.id)
    expect(result.ok).toBe(true)
    if (result.ok) expect(result.data.languages.sort()).toEqual(['de', 'fr'])

    expect(mockedTranslate).toHaveBeenCalledTimes(1)

    const rows = await db
      .select()
      .from(productTranslations)
      .where(eq(productTranslations.productId, p.id))
    const codes = rows.map((r) => r.languageCode).sort()
    expect(codes).toContain('de')
    expect(codes).toContain('fr')
    const de = rows.find((r) => r.languageCode === 'de')
    expect(de?.name).toBe('Hallo')
  })
})
