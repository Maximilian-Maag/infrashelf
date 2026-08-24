import { describe, it, expect } from 'vitest'
import type { SessionUser } from '@open-hybrid-cloud/types'
import { db } from '@/lib/db/client'
import { orders, products, productTranslations } from '@/lib/db/schema'
import { and, eq } from 'drizzle-orm'
import {
  createUser,
  createCategory,
  createCiSource,
  createEnvironment,
  createProject,
  createOrder,
  createInfraElement,
  linkProductEnvironment,
} from '@/test/helpers'
import { productNameSql } from './productName'
import { listCatalog } from './catalog'
import { listCart, addToCart } from './cart'
import { listOrders, getOrderById } from './orders'
import { listApprovals } from './approvals'
import { listInfrastructure, listInfrastructureFacets } from './infrastructure'
import { getCostReport, getCostRows } from './costs'
import { listProducts } from './admin/products'
import { findProductName } from '@/lib/db/queries'
import { captureProductSnapshot } from './snapshot'

/**
 * One product, one language, every surface that names it (issue #162).
 *
 * The bug was never in any single query — each of the nine read paths was
 * internally consistent. It was that they disagreed with the catalogue, and only a
 * test that walks the same product across all of them can say so: a German user
 * saw *Virtuelle Maschine* in the catalogue, *Virtual Machine* in their own cart,
 * and `Product #7` once the product had no English translation at all.
 */

const makeSession = (u: { id: number; email: string; name: string; role: string }): SessionUser =>
  ({ id: u.id, email: u.email, name: u.name, role: u.role as SessionUser['role'] })

/** A product that exists in German only — the normal case, not an edge one. */
const germanOnlyProduct = async (categoryId: number, name = 'Virtuelle Maschine') => {
  const [product] = await db
    .insert(products)
    .values({ categoryId, baseLanguage: 'de' })
    .returning()
  await db
    .insert(productTranslations)
    .values({ productId: product.id, languageCode: 'de', name, description: 'Eine VM' })
  return product
}

const setup = async () => {
  const admin = await createUser({ role: 'admin', email: 'pn-admin@test.dev', name: 'Admin' })
  const pm = await createUser({ role: 'project_manager', email: 'pn-pm@test.dev', name: 'PM' })
  const cat = await createCategory()
  const product = await germanOnlyProduct(cat.id)
  const ci = await createCiSource()
  const env = await createEnvironment(ci.id, undefined, 'AWS Frankfurt')
  await linkProductEnvironment(product.id, env.id, { price: '10.00' })
  const project = await createProject(pm.id)
  return { admin, pm, cat, product, env, project }
}

describe('productNameSql — the shared lookup', () => {
  /*
   * A guard on the emitted SQL rather than a reproduction of a live failure.
   *
   * Drizzle renders a column interpolated into a `sql` template UNQUALIFIED when
   * the query selects from exactly one table — the chain catalog.ts shipped came
   * out as `WHERE product_id = "id"`, and only worked because
   * `product_translations` has no `id` column for the bare name to bind to first.
   * Correlate on `orders.product_id` instead, which the translations table DOES
   * have, and the predicate becomes `pt.product_id = pt.product_id`: true for every
   * row, the subquery stops being correlated, and every order reports the same
   * arbitrary product name with no error anywhere.
   *
   * Nothing today emits the vulnerable shape, so this cannot fail on the old code —
   * it exists so a refactor that drops the explicit qualification cannot
   * reintroduce it silently.
   */
  it('names the outer table on the correlating column', () => {
    for (const [column, expected] of [
      [products.id, '"products"."id"'],
      [orders.productId, '"orders"."product_id"'],
    ] as const) {
      const { sql: text } = db.select({ name: productNameSql(column, 'de') }).from(products).toSQL()
      expect(text).toContain(expected)
    }
  })

  it('falls back through the requested language, English, German, then anything', async () => {
    const cat = await createCategory()
    const [product] = await db
      .insert(products)
      .values({ categoryId: cat.id, baseLanguage: 'fr' })
      .returning()
    await db.insert(productTranslations).values([
      { productId: product.id, languageCode: 'fr', name: 'Machine virtuelle', description: 'Une VM' },
      { productId: product.id, languageCode: 'pl', name: 'Maszyna wirtualna', description: 'Maszyna' },
    ])

    const read = async (lang: string) =>
      (await db.select({ name: productNameSql(products.id, lang) }).from(products))[0].name

    expect(await read('fr')).toBe('Machine virtuelle')
    // No English and no German: any translation beats nothing, and it is the same
    // one every time because the last step is ordered.
    expect(await read('sv')).toBe('Machine virtuelle')
    expect(await read('sv')).toBe('Machine virtuelle')
  })
})

describe('the browsing surfaces name a product in the reader\'s language', () => {
  it('shows the German name in the catalogue AND in the cart', async () => {
    const { pm, product, env } = await setup()

    const catalogue = await listCatalog('de')
    expect(catalogue.ok && catalogue.data.items[0].name).toBe('Virtuelle Maschine')

    await addToCart(makeSession(pm), { productId: product.id, environmentId: env.id }, 'de')
    const cart = await listCart(makeSession(pm), 'de')
    expect(cart.ok && cart.data[0].productName).toBe('Virtuelle Maschine')
  })

  it('names the product in the order list and the order detail', async () => {
    const { pm, product, env, project } = await setup()
    const order = await createOrder(project.id, product.id, env.id, pm.id)

    const list = await listOrders(makeSession(pm), 'de')
    expect(list.ok && list.data[0].productName).toBe('Virtuelle Maschine')

    const detail = await getOrderById(makeSession(pm), order.id, 'de')
    expect(detail.ok && detail.data.productName).toBe('Virtuelle Maschine')
  })

  it('names the product in the approvals queue', async () => {
    const { pm, product, env, project } = await setup()
    await createOrder(project.id, product.id, env.id, pm.id, { status: 'pending' })

    const queue = await listApprovals('de')
    expect(queue.ok && queue.data[0].productName).toBe('Virtuelle Maschine')
  })

  it('names, searches and facets the product in the infrastructure list', async () => {
    const { pm, product, env, project } = await setup()
    const order = await createOrder(project.id, product.id, env.id, pm.id, { status: 'completed' })
    await createInfraElement(order.id, project.id, env.id, product.id)

    const listed = await listInfrastructure(makeSession(pm), {}, 'de')
    expect(listed.ok && listed.data[0].productName).toBe('Virtuelle Maschine')

    // The search box is the sharpest form of the bug: the list matched against the
    // English name only, so typing the name the row was DISPLAYING found nothing.
    const searched = await listInfrastructure(makeSession(pm), { search: 'Virtuelle' }, 'de')
    expect(searched.ok && searched.data).toHaveLength(1)

    const facets = await listInfrastructureFacets(makeSession(pm), 'de')
    expect(facets.ok && facets.data.products[0].name).toBe('Virtuelle Maschine')
  })

  it('names the product in the cost report and its CSV/PDF export', async () => {
    const { admin, pm, product, env, project } = await setup()
    await createOrder(project.id, product.id, env.id, pm.id, { status: 'completed' })

    const report = await getCostReport(makeSession(admin), {}, 'de')
    expect(report.ok && report.data.byProduct[0].label).toBe('Virtuelle Maschine')

    // The export is a rendering of the report; one that names products differently
    // from the screen it was taken from contradicts the document it claims to be.
    const rows = await getCostRows(makeSession(admin), {}, 'de')
    expect(rows.ok && rows.data[0].productName).toBe('Virtuelle Maschine')
  })

  it('names the product on the admin product list', async () => {
    const { cat } = await setup()
    await germanOnlyProduct(cat.id, 'Datenbank')

    const listed = await listProducts('de')
    expect(listed.ok && listed.data.map((r) => r.name)).toContain('Datenbank')
  })
})

describe('the record surfaces', () => {
  it('gives a notification mail the German name rather than "Product #id"', async () => {
    // Mail is English prose end to end and no caller has a reader to ask — two of
    // them run from a CI webhook. What the fallback buys is that a product with no
    // English translation is still NAMED.
    const { product } = await setup()
    expect(await findProductName(product.id)).toBe('Virtuelle Maschine')
  })

  it('freezes every name into the order snapshot, so history is never retranslated', async () => {
    const { cat, product, env } = await setup()
    await db
      .insert(productTranslations)
      .values({ productId: product.id, languageCode: 'en', name: 'Virtual Machine', description: 'A VM' })

    const snapshot = await captureProductSnapshot(product.id, cat.id, env.id)
    expect(snapshot?.productNames).toEqual({
      de: 'Virtuelle Maschine',
      en: 'Virtual Machine',
    })

    // Renaming the catalogue afterwards must not reach the snapshot — that is the
    // whole reason it exists (issue #38).
    await db
      .update(productTranslations)
      .set({ name: 'Etwas Anderes' })
      .where(and(
        eq(productTranslations.productId, product.id),
        eq(productTranslations.languageCode, 'de'),
      ))
    expect(snapshot?.productNames?.de).toBe('Virtuelle Maschine')
  })

  it('names a German-only product in the snapshot instead of "Product #id"', async () => {
    const { cat, product, env } = await setup()
    const snapshot = await captureProductSnapshot(product.id, cat.id, env.id)
    expect(snapshot?.productName).toBe('Virtuelle Maschine')
  })
})
