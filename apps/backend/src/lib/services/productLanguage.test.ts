import { describe, it, expect, vi, beforeEach } from 'vitest'
import { eq } from 'drizzle-orm'
import { db } from '@/lib/db/client'
import { productTranslations, cartItems } from '@/lib/db/schema'
import type { SessionUser } from '@infrashelf/types'
import {
  createUser,
  createCategory,
  createProduct,
  createCiSource,
  createEnvironment,
  createProject,
  createOrder,
  createInfraElement,
  linkProductEnvironment,
} from '@/test/helpers'

vi.mock('@/lib/ci/webhooks', () => ({
  triggerProductWebhooks: vi.fn().mockResolvedValue([]),
  triggerPipelineStacks: vi.fn().mockResolvedValue([]),
  triggerProductWebhooksTracked: vi.fn().mockResolvedValue({ pipelineIds: [], failures: [] }),
  triggerPipelineStacksTracked: vi.fn().mockResolvedValue({ pipelineIds: [], failures: [] }),
}))

const { listCart } = await import('./cart')
const { listOrders, getOrderById } = await import('./orders')
const { listApprovals } = await import('./approvals')
const { listInfrastructure, listInfrastructureFacets, getInfrastructureElement } =
  await import('./infrastructure')
const { getCostReport, getCostRows } = await import('./costs')
const { listProducts, getProductAdmin } = await import('./admin/products')
const { findProductName } = await import('@/lib/db/queries')

const session = (user: { id: number; role: string }): SessionUser =>
  ({ id: user.id, role: user.role, email: 'x@test.dev', name: 'X' }) as SessionUser

/**
 * Issue #162. One product, named in German and in English, read through every
 * surface that shows a product name.
 *
 * The catalogue honoured `lang` and the other nine read paths hardcoded
 * `language_code = 'en'`, so a single German session crossed all three
 * implementations: *Virtuelle Maschine* in the catalogue, *Virtual Machine* in
 * the cart it was added to, the order it became, the approvals queue an admin
 * saw, the infrastructure list, the cost report — and the subject line of every
 * email about it.
 *
 * Each case here asks one surface for German and asserts it gets German. They
 * would all have passed before this change if they had asked for English, which
 * is why they ask for German.
 */
const NAME_DE = 'Virtuelle Maschine'
const NAME_EN = 'Virtual Machine'

const scenario = async () => {
  const admin = await createUser({ role: 'admin', email: 'admin@test.dev' })
  const pm = await createUser({ role: 'project_manager', email: 'pm@test.dev' })
  const cat = await createCategory()
  const product = await createProduct(cat.id, NAME_EN)
  await db
    .insert(productTranslations)
    .values({ productId: product.id, languageCode: 'de', name: NAME_DE, description: 'Eine VM' })
  const ci = await createCiSource()
  const env = await createEnvironment(ci.id)
  await linkProductEnvironment(product.id, env.id, { price: '10' })
  const project = await createProject(pm.id)
  return { admin, pm, product, env, project }
}

beforeEach(() => {
  vi.clearAllMocks()
})

describe('every surface that names a product honours the reader\'s language (#162)', () => {
  it('the cart', async () => {
    const { pm, product, env } = await scenario()
    await db.insert(cartItems).values({
      userId: pm.id,
      productId: product.id,
      environmentId: env.id,
      quantity: 1,
    })

    const result = await listCart(session(pm), 'de')
    expect(result.ok).toBe(true)
    if (result.ok) expect(result.data[0].productName).toBe(NAME_DE)
  })

  it('the order list and the order detail', async () => {
    const { pm, product, env, project } = await scenario()
    const order = await createOrder(project.id, product.id, env.id, pm.id)

    const list = await listOrders(session(pm), 'de')
    expect(list.ok).toBe(true)
    if (list.ok) expect(list.data.items.find((o) => o.id === order.id)?.productName).toBe(NAME_DE)

    const detail = await getOrderById(session(pm), order.id, 'de')
    expect(detail.ok).toBe(true)
    if (detail.ok) expect(detail.data.productName).toBe(NAME_DE)
  })

  it('the approvals queue', async () => {
    const { pm, product, env, project } = await scenario()
    const order = await createOrder(project.id, product.id, env.id, pm.id, { status: 'pending' })

    const result = await listApprovals('de')
    expect(result.ok).toBe(true)
    if (result.ok) expect(result.data.find((o) => o.id === order.id)?.productName).toBe(NAME_DE)
  })

  it('the infrastructure list, its facets and its detail', async () => {
    const { pm, product, env, project } = await scenario()
    const order = await createOrder(project.id, product.id, env.id, pm.id, { status: 'completed' })
    const el = await createInfraElement(order.id, project.id, env.id, product.id)

    const list = await listInfrastructure(session(pm), {}, 'de')
    expect(list.ok).toBe(true)
    if (list.ok) expect(list.data.items[0].productName).toBe(NAME_DE)

    // The facets are the option list for the filters above those rows; a
    // dropdown naming products in another language reads as a list of products
    // the user does not have.
    const facets = await listInfrastructureFacets(session(pm), 'de')
    expect(facets.ok).toBe(true)
    if (facets.ok) expect(facets.data.products.map((p) => p.name)).toContain(NAME_DE)

    const detail = await getInfrastructureElement(session(pm), el.id, 'de')
    expect(detail.ok).toBe(true)
    if (detail.ok) expect(detail.data.productName).toBe(NAME_DE)
  })

  // The one the issue calls out by name: the search matched against English
  // while the row displayed whatever the catalogue had shown, so a German user
  // typing the words they had just read got nothing back.
  it('the infrastructure search, against the name it displays', async () => {
    const { pm, product, env, project } = await scenario()
    const order = await createOrder(project.id, product.id, env.id, pm.id, { status: 'completed' })
    await createInfraElement(order.id, project.id, env.id, product.id)

    const found = await listInfrastructure(session(pm), { search: 'Virtuelle' }, 'de')
    expect(found.ok).toBe(true)
    if (found.ok) expect(found.data.items).toHaveLength(1)

    // And the English term no longer matches a row that is not showing it.
    const notFound = await listInfrastructure(session(pm), { search: 'Virtual Machine' }, 'de')
    expect(notFound.ok).toBe(true)
    if (notFound.ok) expect(notFound.data.items).toHaveLength(0)
  })

  it('the cost report and its export', async () => {
    const { admin, pm, product, env, project } = await scenario()
    await createOrder(project.id, product.id, env.id, pm.id, { status: 'completed' })

    // `byProduct` is the breakdown the dashboard renders as a bar per product,
    // and its label is the name this chain produces.
    const report = await getCostReport(session(admin), {}, new Date(), 'de')
    expect(report.ok).toBe(true)
    if (report.ok) {
      expect(report.data.byProduct.map((b) => b.label)).toContain(NAME_DE)
    }

    const rows = await getCostRows(session(admin), {}, 'de')
    expect(rows.ok).toBe(true)
    if (rows.ok) expect(rows.data.some((r) => r.productName === NAME_DE)).toBe(true)
  })

  it('the admin product list and detail', async () => {
    const { product } = await scenario()

    const list = await listProducts('de')
    expect(list.ok).toBe(true)
    if (list.ok) expect(list.data.items.find((p) => p.id === product.id)?.name).toBe(NAME_DE)

    const detail = await getProductAdmin(product.id, 'de')
    expect(detail.ok).toBe(true)
    if (detail.ok) expect(detail.data.name).toBe(NAME_DE)
  })

  // Notifications have no request to take a language from — the recipient's own
  // language is not stored anywhere — so this one stays English on purpose. What
  // changed is that it now FALLS BACK instead of returning `Product #7`.
  it('a notification subject falls back rather than printing Product #n', async () => {
    const { product } = await scenario()
    await db
      .delete(productTranslations)
      .where(eq(productTranslations.productId, product.id))
    await db
      .insert(productTranslations)
      .values({ productId: product.id, languageCode: 'de', name: NAME_DE, description: '' })

    expect(await findProductName(product.id)).toBe(NAME_DE)
  })

  it('and still says Product #n when the product has no translations at all', async () => {
    const { product } = await scenario()
    await db
      .delete(productTranslations)
      .where(eq(productTranslations.productId, product.id))

    expect(await findProductName(product.id)).toBe(`Product #${product.id}`)
  })
})
