import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { SessionUser } from '@open-hybrid-cloud/types'

vi.mock('@/lib/notification', () => ({
  sendOrderCreated: vi.fn().mockResolvedValue(undefined),
  sendApprovalRequest: vi.fn().mockResolvedValue(undefined),
  sendOrderApproved: vi.fn().mockResolvedValue(undefined),
  sendOrderRejected: vi.fn().mockResolvedValue(undefined),
}))

let pipelineSeq = 0
vi.mock('@/lib/ci/webhooks', () => ({
  // A distinct id per call, so "which pipelines belong to which element" is
  // actually observable rather than collapsing into one shared id.
  triggerProductWebhooksTracked: vi
    .fn()
    .mockImplementation(async () => ({ pipelineIds: [`pipe-${++pipelineSeq}`], failures: [] })),
  triggerPipelineStacksTracked: vi.fn().mockResolvedValue({ pipelineIds: [], failures: [] }),
}))

import { createOrder } from './orders'
import { approveOrder } from './approvals'
import { addToCart, checkoutCart, listCart, updateCartItem, MAX_CHECKOUT_ELEMENTS } from './cart'
import { getCostReport, getCostRows } from './costs'
import { triggerProductWebhooksTracked } from '@/lib/ci/webhooks'
import { db } from '@/lib/db/client'
import { infrastructureElements, orders } from '@/lib/db/schema'
import { eq } from 'drizzle-orm'
import {
  createUser,
  createCategory,
  createProduct,
  createCiSource,
  createEnvironment,
  createProject,
  linkProductEnvironment,
  createSize,
} from '@/test/helpers'

const makeSession = (u: { id: number; email: string; name: string; role: string }): SessionUser =>
  ({ id: u.id, email: u.email, name: u.name, role: u.role as SessionUser['role'] })

const mockedWebhooks = vi.mocked(triggerProductWebhooksTracked)

beforeEach(() => {
  pipelineSeq = 0
  mockedWebhooks
    .mockReset()
    .mockImplementation(async () => ({ pipelineIds: [`pipe-${++pipelineSeq}`], failures: [] }))
})

const setup = async () => {
  const admin = await createUser({ role: 'admin', email: 'admin@test.dev', name: 'Admin' })
  const pm = await createUser({ role: 'project_manager', email: 'pm@test.dev', name: 'PM' })
  const cat = await createCategory()
  const product = await createProduct(cat.id, 'VM')
  const ci = await createCiSource()
  const env = await createEnvironment(ci.id, undefined, 'Frankfurt')
  await linkProductEnvironment(product.id, env.id, { price: '99.00' })
  const project = await createProject(pm.id)
  return { admin, pm, product, env, project }
}

describe('one order, N infrastructure elements (issue #104)', () => {
  it('provisions one element per unit, numbered from 1', async () => {
    const { admin, product, env, project } = await setup()

    const result = await createOrder(makeSession(admin), {
      projectId: project.id,
      productId: product.id,
      environmentId: env.id,
      parameters: {},
      quantity: 3,
    })

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.data.quantity).toBe(3)

    const elements = await db
      .select()
      .from(infrastructureElements)
      .where(eq(infrastructureElements.orderId, result.data.id))
      .orderBy(infrastructureElements.sequence)

    expect(elements).toHaveLength(3)
    expect(elements.map((e) => e.sequence)).toEqual([1, 2, 3])
    // One order, so one row in `orders` — not three orders.
    expect(result.data.infraIds).toEqual(elements.map((e) => e.id))
  })

  it('fans the pipeline trigger out per element, with the element sequence', async () => {
    const { admin, product, env, project } = await setup()

    await createOrder(makeSession(admin), {
      projectId: project.id,
      productId: product.id,
      environmentId: env.id,
      parameters: {},
      quantity: 3,
    })

    expect(mockedWebhooks).toHaveBeenCalledTimes(3)
    const sequences = mockedWebhooks.mock.calls.map(
      (call) => (call[2] as Record<string, string>).ELEMENT_SEQUENCE,
    )
    // Distinct per element: this is what makes each element's Terraform state its
    // own rather than the second element applying over the first's.
    expect(sequences).toEqual(['1', '2', '3'])
  })

  it("gives every element its own pipeline ids, and the order their union", async () => {
    const { admin, product, env, project } = await setup()

    const result = await createOrder(makeSession(admin), {
      projectId: project.id,
      productId: product.id,
      environmentId: env.id,
      parameters: {},
      quantity: 2,
    })
    if (!result.ok) throw new Error('order failed')

    const elements = await db
      .select()
      .from(infrastructureElements)
      .where(eq(infrastructureElements.orderId, result.data.id))
      .orderBy(infrastructureElements.sequence)
    const [order] = await db.select().from(orders).where(eq(orders.id, result.data.id))

    // Per element, so a teardown of element 2 tracks element 2's run …
    expect(elements[0].pipelineId).toEqual(['pipe-1'])
    expect(elements[1].pipelineId).toEqual(['pipe-2'])
    // … while the order waits for both, which is what the callback handler
    // matches events against.
    expect(order.pipelineId).toEqual(['pipe-1', 'pipe-2'])
  })

  it('provisions all N on a single approval', async () => {
    const { admin, pm, product, env, project } = await setup()

    const created = await createOrder(makeSession(pm), {
      projectId: project.id,
      productId: product.id,
      environmentId: env.id,
      parameters: {},
      quantity: 4,
    })
    if (!created.ok) throw new Error('order failed')
    // A project manager's order queues for approval and provisions nothing yet.
    expect(
      await db
        .select()
        .from(infrastructureElements)
        .where(eq(infrastructureElements.orderId, created.data.id)),
    ).toHaveLength(0)

    const approved = await approveOrder(makeSession(admin), created.data.id)

    expect(approved.ok).toBe(true)
    if (!approved.ok) return
    // One decision, four elements.
    expect(approved.data.infraIds).toHaveLength(4)
    expect(approved.data.infraId).toBe(approved.data.infraIds[0])
  })

  it('leaves no element behind when not one could be started, so a retried approval provisions N and not 2N', async () => {
    const { admin, pm, product, env, project } = await setup()

    const created = await createOrder(makeSession(pm), {
      projectId: project.id,
      productId: product.id,
      environmentId: env.id,
      parameters: {},
      quantity: 3,
    })
    if (!created.ok) throw new Error('order failed')

    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    mockedWebhooks.mockRejectedValue(new Error('GitLab trigger failed: 500'))

    await expect(approveOrder(makeSession(admin), created.data.id)).rejects.toThrow('GitLab trigger failed')

    // The rows go in before their triggers fire, and nothing else would remove
    // them: order_id carries no ON DELETE CASCADE. Left behind they are 'active'
    // elements with no pipeline — counted in inventory, and decommissioning them
    // fires destroy pipelines at infrastructure that was never created.
    expect(
      await db
        .select()
        .from(infrastructureElements)
        .where(eq(infrastructureElements.orderId, created.data.id)),
    ).toHaveLength(0)
    const [released] = await db.select().from(orders).where(eq(orders.id, created.data.id))
    expect(released.status).toBe('pending')

    // CI comes back, the admin approves again: three elements, not the six that
    // a second insert on top of the first batch produced.
    mockedWebhooks.mockImplementation(async () => ({ pipelineIds: [`pipe-${++pipelineSeq}`], failures: [] }))
    const approved = await approveOrder(makeSession(admin), created.data.id)

    expect(approved.ok).toBe(true)
    const elements = await db
      .select()
      .from(infrastructureElements)
      .where(eq(infrastructureElements.orderId, created.data.id))
    expect(elements).toHaveLength(3)
    expect(elements.map((el) => el.sequence).sort()).toEqual([1, 2, 3])
    error.mockRestore()
  })

  it('defaults to one element, exactly as every order before quantity existed', async () => {
    const { admin, product, env, project } = await setup()

    const result = await createOrder(makeSession(admin), {
      projectId: project.id,
      productId: product.id,
      environmentId: env.id,
      parameters: {},
    })
    if (!result.ok) throw new Error('order failed')

    expect(result.data.quantity).toBe(1)
    const elements = await db
      .select()
      .from(infrastructureElements)
      .where(eq(infrastructureElements.orderId, result.data.id))
    expect(elements).toHaveLength(1)
    expect(elements[0].sequence).toBe(1)
    // No suffix for element 1, so its state key is what it always was.
    const vars = mockedWebhooks.mock.calls[0][2] as Record<string, string>
    expect(vars.ELEMENT_SEQUENCE).toBe('1')
  })

  it('refuses a quantity above the cap without creating anything', async () => {
    const { admin, product, env, project } = await setup()

    const result = await createOrder(makeSession(admin), {
      projectId: project.id,
      productId: product.id,
      environmentId: env.id,
      parameters: {},
      quantity: 21,
    })

    expect(result.ok).toBe(false)
    expect(await db.select().from(orders)).toHaveLength(0)
    expect(mockedWebhooks).not.toHaveBeenCalled()
  })
})

describe('sizing through the order flow (issue #98)', () => {
  it('charges the size price, not the offering price, and records it in the snapshot', async () => {
    const { admin, product, env, project } = await setup()
    await createSize(product.id, env.id, { code: 'S', label: 'Small', price: '10.00', sortOrder: 1 })
    await createSize(product.id, env.id, { code: 'XL', label: 'Extra large', price: '400.00', sortOrder: 2 })

    const result = await createOrder(makeSession(admin), {
      projectId: project.id,
      productId: product.id,
      environmentId: env.id,
      parameters: {},
      sizeCode: 'XL',
      quantity: 2,
    })
    if (!result.ok) throw new Error('order failed')

    const [order] = await db.select().from(orders).where(eq(orders.id, result.data.id))
    expect(order.sizeCode).toBe('XL')
    // 400, not the offering's 99: the price moved to the size.
    expect(order.productSnapshot?.price).toBe('400.00')
    expect(order.productSnapshot?.sizeCode).toBe('XL')
    expect(order.productSnapshot?.sizeLabel).toBe('Extra large')
  })

  it('passes the size to CI, and passes none for an offering without sizes', async () => {
    const { admin, product, env, project } = await setup()
    await createSize(product.id, env.id, { code: 'XL', price: '400.00' })

    await createOrder(makeSession(admin), {
      projectId: project.id,
      productId: product.id,
      environmentId: env.id,
      parameters: {},
      sizeCode: 'XL',
    })
    expect((mockedWebhooks.mock.calls[0][2] as Record<string, string>).SIZE).toBe('XL')

    const other = await createEnvironment(await createCiSource().then((c) => c.id), undefined, 'Sizeless')
    await linkProductEnvironment(product.id, other.id, { price: '99.00' })
    mockedWebhooks.mockClear()

    await createOrder(makeSession(admin), {
      projectId: project.id,
      productId: product.id,
      environmentId: other.id,
      parameters: {},
    })
    // Absent, not empty: a template can tell "no sizing" from "a size named ''".
    expect((mockedWebhooks.mock.calls[0][2] as Record<string, string>).SIZE).toBeUndefined()
  })

  it('keeps the snapshot price when the size is re-priced afterwards', async () => {
    const { admin, product, env, project } = await setup()
    await createSize(product.id, env.id, { code: 'XL', price: '400.00' })

    const result = await createOrder(makeSession(admin), {
      projectId: project.id,
      productId: product.id,
      environmentId: env.id,
      parameters: {},
      sizeCode: 'XL',
      quantity: 2,
    })
    if (!result.ok) throw new Error('order failed')

    // The admin doubles the price the day after.
    await db.execute(
      (await import('drizzle-orm')).sql`UPDATE product_environment_sizes SET price = '800.00'`,
    )

    const report = await getCostReport(makeSession(admin))
    expect(report.ok).toBe(true)
    if (!report.ok) return
    // 2 × 400, the price that applied — not 2 × 800, which would restate history.
    expect(report.data.totalEur).toBe(800)
    expect(report.data.estimatedOrders).toBe(0)
  })

  it('multiplies the cost report and the export by the quantity', async () => {
    const { admin, product, env, project } = await setup()
    await createSize(product.id, env.id, { code: 'M', label: 'Medium', price: '25.00' })

    const result = await createOrder(makeSession(admin), {
      projectId: project.id,
      productId: product.id,
      environmentId: env.id,
      parameters: {},
      sizeCode: 'M',
      quantity: 4,
    })
    if (!result.ok) throw new Error('order failed')

    const report = await getCostReport(makeSession(admin))
    if (!report.ok) throw new Error('report failed')
    expect(report.data.totalEur).toBe(100)

    const rows = await getCostRows(makeSession(admin))
    if (!rows.ok) throw new Error('rows failed')
    expect(rows.data).toHaveLength(1)
    // The unit price stays the unit price; the line total is what reconciles.
    expect(rows.data[0].price).toBe('25.00')
    expect(rows.data[0].quantity).toBe(4)
    expect(rows.data[0].lineTotalEur).toBe(100)
    expect(rows.data[0].size).toBe('Medium')
  })

  it('keeps pricing a legacy order off a size that has since been RETIRED', async () => {
    // `linePriceSql` deliberately does not filter on `active`. Retiring a size must
    // not erase the spend of orders placed while it was live — and this is the path
    // that reaches it, since a snapshot would otherwise answer first.
    const { admin, product, env, project } = await setup()
    await createSize(product.id, env.id, { code: 'XL', price: '400.00' })

    const result = await createOrder(makeSession(admin), {
      projectId: project.id,
      productId: product.id,
      environmentId: env.id,
      parameters: {},
      sizeCode: 'XL',
    })
    if (!result.ok) throw new Error('order failed')

    const { sql } = await import('drizzle-orm')
    await db.execute(sql`UPDATE orders SET product_snapshot = NULL`)
    await db.execute(sql`UPDATE product_environment_sizes SET active = FALSE`)

    const report = await getCostReport(makeSession(admin))
    if (!report.ok) throw new Error('report failed')
    expect(report.data.totalEur).toBe(400)
    expect(report.data.estimatedOrders).toBe(1)
  })

  it("does not reprice a legacy order onto the offering when its size was DELETED", async () => {
    const { admin, product, env, project } = await setup()
    await createSize(product.id, env.id, { code: 'XL', price: '400.00' })

    const result = await createOrder(makeSession(admin), {
      projectId: project.id,
      productId: product.id,
      environmentId: env.id,
      parameters: {},
      sizeCode: 'XL',
    })
    if (!result.ok) throw new Error('order failed')

    const { sql } = await import('drizzle-orm')
    await db.execute(sql`UPDATE orders SET product_snapshot = NULL`)
    await db.execute(sql`DELETE FROM product_environment_sizes`)

    const report = await getCostReport(makeSession(admin))
    if (!report.ok) throw new Error('report failed')
    // Not the offering's 99: that is the price of an unsized line, and this order
    // named a size. Nothing is a truer answer here than the wrong thing.
    expect(report.data.totalEur).toBe(0)

    // The export reports an unpriceable line as zero and flags it estimated — the
    // same `?? '0'` an order whose offering was withdrawn entirely has always hit.
    const rows = await getCostRows(makeSession(admin))
    if (!rows.ok) throw new Error('rows failed')
    expect(rows.data[0].price).toBe('0')
    expect(rows.data[0].lineTotalEur).toBe(0)
    expect(rows.data[0].estimated).toBe(true)
  })

  it('prices a legacy order with no size off the offering, as it always did', async () => {
    const { admin, product, env, project } = await setup()

    const result = await createOrder(makeSession(admin), {
      projectId: project.id,
      productId: product.id,
      environmentId: env.id,
      parameters: {},
    })
    if (!result.ok) throw new Error('order failed')

    const report = await getCostReport(makeSession(admin))
    if (!report.ok) throw new Error('report failed')
    expect(report.data.totalEur).toBe(99)
  })
})

describe('the cart line: product × environment × size × quantity', () => {
  it('stores the size and quantity and prices the line off the size', async () => {
    const { pm, product, env } = await setup()
    await createSize(product.id, env.id, { code: 'L', label: 'Large', price: '50.00' })

    const added = await addToCart(makeSession(pm), {
      productId: product.id,
      environmentId: env.id,
      sizeCode: 'L',
      quantity: 3,
    })
    expect(added.ok).toBe(true)

    const listed = await listCart(makeSession(pm))
    if (!listed.ok) throw new Error('list failed')
    expect(listed.data[0].sizeCode).toBe('L')
    expect(listed.data[0].sizeLabel).toBe('Large')
    expect(listed.data[0].quantity).toBe(3)
    // The UNIT price. The cart multiplies it where it displays the line.
    expect(listed.data[0].price).toBe('50.00')
    expect(listed.data[0].stillOffered).toBe(true)
  })

  it('refuses to hold a line with no size when the offering has sizes', async () => {
    const { pm, product, env } = await setup()
    await createSize(product.id, env.id, { code: 'L', price: '50.00' })

    const added = await addToCart(makeSession(pm), { productId: product.id, environmentId: env.id })

    // Unlike the parameters, the size is not something filled in later: a line
    // that could never be ordered has no business in the cart.
    expect(added.ok).toBe(false)
  })

  it('edits the quantity without wiping the parameter prefill', async () => {
    const { pm, product, env } = await setup()
    const added = await addToCart(makeSession(pm), {
      productId: product.id,
      environmentId: env.id,
      parameters: { HOST: 'web-01' },
    })
    if (!added.ok) throw new Error('add failed')

    const updated = await updateCartItem(makeSession(pm), added.data.id, { quantity: 7 })

    expect(updated.ok).toBe(true)
    const listed = await listCart(makeSession(pm))
    if (!listed.ok) throw new Error('list failed')
    expect(listed.data[0].quantity).toBe(7)
    expect(listed.data[0].parameters).toEqual({ HOST: 'web-01' })
  })

  it('reports a line whose size was retired as no longer offered', async () => {
    const { pm, product, env } = await setup()
    await createSize(product.id, env.id, { code: 'L', price: '50.00' })
    const added = await addToCart(makeSession(pm), {
      productId: product.id,
      environmentId: env.id,
      sizeCode: 'L',
    })
    if (!added.ok) throw new Error('add failed')

    await db.execute(
      (await import('drizzle-orm')).sql`UPDATE product_environment_sizes SET active = FALSE`,
    )

    const listed = await listCart(makeSession(pm))
    if (!listed.ok) throw new Error('list failed')
    // Said on the line, so the shopper can act on it — not as a checkout error.
    expect(listed.data[0].stillOffered).toBe(false)
  })

  it('leaves a line whose size was DELETED with no price, not the offering\'s', async () => {
    const { pm, product, env } = await setup()
    await createSize(product.id, env.id, { code: 'L', price: '50.00' })
    const added = await addToCart(makeSession(pm), {
      productId: product.id,
      environmentId: env.id,
      sizeCode: 'L',
      quantity: 3,
    })
    if (!added.ok) throw new Error('add failed')

    await db.execute((await import('drizzle-orm')).sql`DELETE FROM product_environment_sizes`)

    const listed = await listCart(makeSession(pm))
    if (!listed.ok) throw new Error('list failed')
    // The offering's own 99.00 is the price of a line with NO size; this line has
    // one. Returning it here put an unorderable line into the cart's subtotal.
    expect(listed.data[0].price).toBe(null)
    expect(listed.data[0].currency).toBe(null)
    expect(listed.data[0].stillOffered).toBe(false)
  })

  it('keeps showing the price of a size that was merely RETIRED', async () => {
    const { pm, product, env } = await setup()
    await createSize(product.id, env.id, { code: 'L', price: '50.00' })
    const added = await addToCart(makeSession(pm), {
      productId: product.id,
      environmentId: env.id,
      sizeCode: 'L',
    })
    if (!added.ok) throw new Error('add failed')

    await db.execute(
      (await import('drizzle-orm')).sql`UPDATE product_environment_sizes SET active = FALSE`,
    )

    const listed = await listCart(makeSession(pm))
    if (!listed.ok) throw new Error('list failed')
    // The row is still there, so what the line was struck at is still knowable and
    // worth showing beside the flag that stops it being checked out.
    expect(listed.data[0].price).toBe('50.00')
    expect(listed.data[0].stillOffered).toBe(false)
  })

  it('checks a line out as ONE order with N elements', async () => {
    // An admin's checkout, so provisioning happens immediately and the elements
    // are observable without a second approval step.
    const { admin, product, env, project } = await setup()
    await createSize(product.id, env.id, { code: 'M', price: '25.00' })
    const added = await addToCart(makeSession(admin), {
      productId: product.id,
      environmentId: env.id,
      sizeCode: 'M',
      quantity: 5,
    })
    if (!added.ok) throw new Error('add failed')

    const result = await checkoutCart(makeSession(admin), {
      projectId: project.id,
      items: [{ cartItemId: added.data.id, parameters: {} }],
    })

    expect(result.ok).toBe(true)
    if (!result.ok) return
    // One order …
    expect(result.data.orderIds).toHaveLength(1)
    // … with five elements.
    const elements = await db
      .select()
      .from(infrastructureElements)
      .where(eq(infrastructureElements.orderId, result.data.orderIds[0]))
    expect(elements).toHaveLength(5)
    const [order] = await db.select().from(orders).where(eq(orders.id, result.data.orderIds[0]))
    expect(order.quantity).toBe(5)
    expect(order.sizeCode).toBe('M')
  })

  it('refuses a checkout that would provision more elements than the cap', async () => {
    const { admin, product, env, project } = await setup()
    const items: number[] = []
    // Six lines of twenty is 120 elements — over the cap, though well under the
    // 25-line cart limit, which is exactly the hole quantity opened.
    for (let i = 0; i < 6; i++) {
      const added = await addToCart(makeSession(admin), {
        productId: product.id,
        environmentId: env.id,
        quantity: 20,
      })
      if (!added.ok) throw new Error('add failed')
      items.push(added.data.id)
    }

    const result = await checkoutCart(makeSession(admin), {
      projectId: project.id,
      items: items.map((cartItemId) => ({ cartItemId, parameters: {} })),
    })

    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.message).toContain(String(MAX_CHECKOUT_ELEMENTS))
    expect(await db.select().from(orders)).toHaveLength(0)
  })
})
