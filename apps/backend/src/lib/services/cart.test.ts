import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import type { SessionUser } from '@infrashelf/types'

vi.mock('@/lib/notification', () => ({
  sendOrderCreated: vi.fn().mockResolvedValue(undefined),
  sendApprovalRequest: vi.fn().mockResolvedValue(undefined),
}))

vi.mock('@/lib/ci/webhooks', () => ({
  triggerProductWebhooksTracked: vi.fn().mockResolvedValue({ pipelineIds: ['pipe-1'], failures: [] }),
  triggerPipelineStacksTracked: vi.fn().mockResolvedValue({ pipelineIds: [], failures: [] }),
}))

import {
  listCart,
  addToCart,
  updateCartItem,
  removeFromCart,
  clearCart,
  checkoutCart,
  countCart,
  pruneOrphanedCartItems,
  MAX_CART_ITEMS,
} from './cart'
import { triggerProductWebhooksTracked } from '@/lib/ci/webhooks'
import { createIntegration } from '@/lib/services/admin/integrations'
import { db } from '@/lib/db/client'
import { cartItems, orders, parameters, products, productEnvironments, auditLog, costCenters, projects } from '@/lib/db/schema'
import { and, eq } from 'drizzle-orm'
import {
  createUser,
  createCategory,
  createProduct,
  createCiSource,
  createEnvironment,
  createProject,
  linkProductEnvironment,
  createCostCenter,
} from '@/test/helpers'

const makeSession = (u: { id: number; email: string; name: string; role: string }): SessionUser =>
  ({ id: u.id, email: u.email, name: u.name, role: u.role as SessionUser['role'] })

const mockedWebhooks = vi.mocked(triggerProductWebhooksTracked)

beforeEach(() => {
  mockedWebhooks.mockReset().mockResolvedValue({ pipelineIds: ['pipe-1'], failures: [] })
})

const setup = async () => {
  const admin = await createUser({ role: 'admin', email: 'cart-admin@test.dev', name: 'Admin' })
  const pm = await createUser({ role: 'project_manager', email: 'cart-pm@test.dev', name: 'PM' })
  const other = await createUser({ role: 'project_manager', email: 'cart-other@test.dev', name: 'Other' })
  const cat = await createCategory()
  const nginx = await createProduct(cat.id, 'Nginx Gateway')
  const postgres = await createProduct(cat.id, 'Managed Postgres')
  const ci = await createCiSource()
  const env = await createEnvironment(ci.id, undefined, 'AWS Frankfurt')
  const unofferedEnv = await createEnvironment(ci.id, undefined, 'Unoffered')
  await linkProductEnvironment(nginx.id, env.id, { price: '10.00' })
  await linkProductEnvironment(postgres.id, env.id, { price: '20.00' })
  const project = await createProject(pm.id)
  const adminProject = await createProject(admin.id)
  return { admin, pm, other, nginx, postgres, env, unofferedEnv, project, adminProject }
}

describe('addToCart', () => {
  it('adds an item and resolves its display fields', async () => {
    const { pm, nginx, env } = await setup()
    const result = await addToCart(makeSession(pm), { productId: nginx.id, environmentId: env.id })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.data).toMatchObject({
      productId: nginx.id,
      productName: 'Nginx Gateway',
      environmentName: 'AWS Frankfurt',
      price: '10.00',
      stillOffered: true,
    })
  })

  it('stores unvalidated parameters — a cart is a shopping list', async () => {
    // Refusing to hold an incomplete item would defeat collecting first and
    // filling in at checkout.
    const { pm, nginx, env } = await setup()
    await db.insert(parameters).values({
      scope: 'product', scopeId: nginx.id, name: 'SIZE', type: 'number', required: true,
    })

    const result = await addToCart(makeSession(pm), {
      productId: nginx.id,
      environmentId: env.id,
      parameters: { SIZE: 'not-a-number' },
    })
    expect(result.ok).toBe(true)
    const [row] = await db.select().from(cartItems)
    expect(row.parameters).toEqual({ SIZE: 'not-a-number' })
  })

  it('refuses an item that is not offered — it could never be ordered', async () => {
    const { pm, nginx, unofferedEnv } = await setup()
    const result = await addToCart(makeSession(pm), { productId: nginx.id, environmentId: unofferedEnv.id })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.status).toBe(400)
    expect(await db.select().from(cartItems)).toHaveLength(0)
  })

  it('allows the same product twice — they differ by parameters', async () => {
    const { pm, nginx, env } = await setup()
    await addToCart(makeSession(pm), { productId: nginx.id, environmentId: env.id, parameters: { H: 'a' } })
    await addToCart(makeSession(pm), { productId: nginx.id, environmentId: env.id, parameters: { H: 'b' } })
    expect(await db.select().from(cartItems)).toHaveLength(2)
  })

  it('caps the cart size', async () => {
    // An unbounded cart is a way to fire unbounded pipelines in one request.
    const { pm, nginx, env } = await setup()
    for (let i = 0; i < MAX_CART_ITEMS; i++) {
      await addToCart(makeSession(pm), { productId: nginx.id, environmentId: env.id })
    }
    const result = await addToCart(makeSession(pm), { productId: nginx.id, environmentId: env.id })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.message).toMatch(/at most/i)
  })

  // The cap was a read followed by an unguarded insert, so two adds at 24 both
  // saw 24 and the cart held 26 (#188). It is now a count and an insert inside a
  // transaction holding FOR UPDATE on the shopper's own row.
  //
  // No test here claims to reproduce the race, and that is deliberate. Two
  // concurrent `addToCart` calls only collide if their reads actually overlap,
  // which is a matter of round-trip timing — such a test passes on the broken
  // code most of the time, which is worse than no test. And a test that holds the
  // lock externally proves nothing either: `cart_items.user_id` is a foreign key,
  // so the INSERT takes FOR KEY SHARE on the users row and blocks against an
  // outside FOR UPDATE whether or not this code asks for one. What it does NOT do
  // is block against ANOTHER insert — two FOR KEY SHARE locks are compatible —
  // and that is exactly the case the explicit FOR UPDATE exists to serialise.
  it('still refuses the item that would exceed the cap', async () => {
    const { pm, nginx, env } = await setup()
    for (let i = 0; i < MAX_CART_ITEMS - 1; i++) {
      await addToCart(makeSession(pm), { productId: nginx.id, environmentId: env.id })
    }

    const last = await addToCart(makeSession(pm), { productId: nginx.id, environmentId: env.id })
    const over = await addToCart(makeSession(pm), { productId: nginx.id, environmentId: env.id })

    expect(last.ok).toBe(true)
    expect(over.ok).toBe(false)
    const rows = await db.select().from(cartItems).where(eq(cartItems.userId, pm.id))
    expect(rows).toHaveLength(MAX_CART_ITEMS)
  })

  // The lock is on the shopper, not on the table: two people adding at the same
  // time must not wait on each other, and neither may be refused.
  it('does not let one shopper\'s cap refuse another', async () => {
    const { pm, other, nginx, env } = await setup()
    for (let i = 0; i < MAX_CART_ITEMS; i++) {
      await addToCart(makeSession(pm), { productId: nginx.id, environmentId: env.id })
    }

    const result = await addToCart(makeSession(other), { productId: nginx.id, environmentId: env.id })

    expect(result.ok).toBe(true)
  })
})

describe('addToCart and a withdrawn product', () => {
  // The offering existing no longer means the product can be ordered.
  it('refuses to add one', async () => {
    const { pm, nginx, env } = await setup()
    await db.update(products).set({ retiredAt: new Date() }).where(eq(products.id, nginx.id))

    const result = await addToCart(makeSession(pm), { productId: nginx.id, environmentId: env.id })

    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.status).toBe(400)
    expect(result.message).toMatch(/no longer available to order/i)
  })
})

describe('listCart', () => {
  it('returns only the caller\'s items, oldest first', async () => {
    const { pm, other, nginx, postgres, env } = await setup()
    await addToCart(makeSession(pm), { productId: nginx.id, environmentId: env.id })
    await addToCart(makeSession(pm), { productId: postgres.id, environmentId: env.id })
    await addToCart(makeSession(other), { productId: nginx.id, environmentId: env.id })

    const result = await listCart(makeSession(pm))
    expect(result.ok && result.data.map((r) => r.productName)).toEqual(['Nginx Gateway', 'Managed Postgres'])
  })

  it('keeps an item whose offering was withdrawn, marked unavailable', async () => {
    // Vanishing without explanation is worse than showing why checkout will refuse.
    const { pm, nginx, env } = await setup()
    await addToCart(makeSession(pm), { productId: nginx.id, environmentId: env.id })
    await db
      .delete(productEnvironments)
      .where(and(eq(productEnvironments.productId, nginx.id), eq(productEnvironments.environmentId, env.id)))

    const result = await listCart(makeSession(pm))
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.data).toHaveLength(1)
    expect(result.data[0].stillOffered).toBe(false)
  })

  /*
   * A withdrawn product keeps its offerings, so it can be put back at the price
   * it had (#251) — which means the price still resolves and the line still
   * looks orderable. `retiredAt` is the third way a line can have become
   * unorderable, and it has to say so here rather than at the till.
   */
  it('marks a line unavailable when its product has been withdrawn', async () => {
    const { pm, nginx, env } = await setup()
    await addToCart(makeSession(pm), { productId: nginx.id, environmentId: env.id })
    await db.update(products).set({ retiredAt: new Date() }).where(eq(products.id, nginx.id))

    const result = await listCart(makeSession(pm))
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.data).toHaveLength(1)
    expect(result.data[0].stillOffered).toBe(false)
    // The offering survived, which is what makes putting it back worth anything.
    expect(result.data[0].price).not.toBeNull()
  })

  it('offers it again once the product is put back', async () => {
    const { pm, nginx, env } = await setup()
    await addToCart(makeSession(pm), { productId: nginx.id, environmentId: env.id })
    await db.update(products).set({ retiredAt: new Date() }).where(eq(products.id, nginx.id))
    await db.update(products).set({ retiredAt: null }).where(eq(products.id, nginx.id))

    const result = await listCart(makeSession(pm))
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.data[0].stillOffered).toBe(true)
  })

  it('returns an empty cart rather than an error', async () => {
    const { pm } = await setup()
    expect((await listCart(makeSession(pm))).ok).toBe(true)
  })
})

describe('updateCartItem / removeFromCart / clearCart', () => {
  it('saves a parameter prefill', async () => {
    const { pm, nginx, env } = await setup()
    const added = await addToCart(makeSession(pm), { productId: nginx.id, environmentId: env.id })
    if (!added.ok) throw new Error('setup failed')

    const result = await updateCartItem(makeSession(pm), added.data.id, { parameters: { HOST: 'web-01' } })
    expect(result.ok).toBe(true)
    const [row] = await db.select().from(cartItems)
    expect(row.parameters).toEqual({ HOST: 'web-01' })
  })

  it('will not touch another user\'s item', async () => {
    const { pm, other, nginx, env } = await setup()
    const added = await addToCart(makeSession(pm), { productId: nginx.id, environmentId: env.id })
    if (!added.ok) throw new Error('setup failed')

    const updated = await updateCartItem(makeSession(other), added.data.id, { parameters: { HOST: 'stolen' } })
    expect(updated.ok).toBe(false)
    if (!updated.ok) expect(updated.status).toBe(404)

    await removeFromCart(makeSession(other), added.data.id)
    expect(await db.select().from(cartItems)).toHaveLength(1)
  })

  it('removes one item idempotently', async () => {
    const { pm, nginx, env } = await setup()
    const added = await addToCart(makeSession(pm), { productId: nginx.id, environmentId: env.id })
    if (!added.ok) throw new Error('setup failed')

    expect((await removeFromCart(makeSession(pm), added.data.id)).ok).toBe(true)
    expect((await removeFromCart(makeSession(pm), added.data.id)).ok).toBe(true)
    expect(await db.select().from(cartItems)).toHaveLength(0)
  })

  it('clears only the caller\'s cart', async () => {
    const { pm, other, nginx, env } = await setup()
    await addToCart(makeSession(pm), { productId: nginx.id, environmentId: env.id })
    await addToCart(makeSession(other), { productId: nginx.id, environmentId: env.id })

    await clearCart(makeSession(pm))
    expect(await db.select().from(cartItems)).toHaveLength(1)
  })

  it('counts the caller\'s items', async () => {
    const { pm, nginx, env } = await setup()
    expect(await countCart(makeSession(pm))).toBe(0)
    await addToCart(makeSession(pm), { productId: nginx.id, environmentId: env.id })
    expect(await countCart(makeSession(pm))).toBe(1)
  })

  it('prunes items whose product was deleted', async () => {
    const { pm, nginx, env } = await setup()
    await addToCart(makeSession(pm), { productId: nginx.id, environmentId: env.id })
    // The FK cascades on product delete, so this asserts the guard is harmless
    // rather than load-bearing — it exists for a product removed by other means.
    await db.delete(products).where(eq(products.id, nginx.id))
    await pruneOrphanedCartItems(makeSession(pm))
    expect(await db.select().from(cartItems)).toHaveLength(0)
  })
})

describe('checkoutCart', () => {
  const stocked = async () => {
    const ctx = await setup()
    const a = await addToCart(makeSession(ctx.pm), { productId: ctx.nginx.id, environmentId: ctx.env.id })
    const b = await addToCart(makeSession(ctx.pm), { productId: ctx.postgres.id, environmentId: ctx.env.id })
    if (!a.ok || !b.ok) throw new Error('setup failed')
    return { ...ctx, first: a.data, second: b.data }
  }

  const item = (cartItemId: number, over?: Partial<{ parameters: Record<string, string> }>) => ({
    cartItemId,
    parameters: over?.parameters ?? {},
  })

  it('creates one order per item and empties the cart', async () => {
    const ctx = await stocked()
    const result = await checkoutCart(makeSession(ctx.pm), {
      projectId: ctx.project.id,
      items: [item(ctx.first.id), item(ctx.second.id)],
    })

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.data.orderIds).toHaveLength(2)
    expect(result.data.failed).toEqual([])
    expect(await db.select().from(cartItems)).toHaveLength(0)

    const created = await db.select().from(orders)
    expect(created.map((o) => o.productId).sort()).toEqual([ctx.nginx.id, ctx.postgres.id].sort())
  })

  it('creates NOTHING when any one item fails validation', async () => {
    // The all-or-nothing validation gate is what makes checkout safe: order
    // creation fires pipelines, so partial creation cannot be undone.
    const ctx = await stocked()
    await db.insert(parameters).values({
      scope: 'product', scopeId: ctx.postgres.id, name: 'SIZE', type: 'number', required: true,
    })

    const result = await checkoutCart(makeSession(ctx.pm), {
      projectId: ctx.project.id,
      items: [item(ctx.first.id), item(ctx.second.id)],
    })

    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.status).toBe(400)
      expect(result.message).toMatch(/nothing was ordered/i)
      expect(result.message).toMatch(/SIZE/)
    }
    expect(await db.select().from(orders)).toHaveLength(0)
    // The cart is untouched, so the user fixes the named item and resubmits.
    expect(await db.select().from(cartItems)).toHaveLength(2)
    expect(mockedWebhooks).not.toHaveBeenCalled()
  })

  it('validates each item against the same rules a single order uses', async () => {
    // A cost centre the offering forces is required here too.
    const ctx = await stocked()
    await db
      .update(productEnvironments)
      .set({ costCenterMode: 'select', forcedCostCenter: true })
      .where(eq(productEnvironments.productId, ctx.nginx.id))

    const withoutCc = await checkoutCart(makeSession(ctx.pm), {
      projectId: ctx.project.id,
      items: [item(ctx.first.id), item(ctx.second.id)],
    })
    expect(withoutCc.ok).toBe(false)
    if (!withoutCc.ok) expect(withoutCc.message).toMatch(/cost center is required/i)

    const cc = await createCostCenter()
    const withCc = await checkoutCart(makeSession(ctx.pm), {
      projectId: ctx.project.id,
      items: [{ ...item(ctx.first.id), costCenterId: cc.id }, item(ctx.second.id)],
    })
    expect(withCc.ok).toBe(true)
  })

  it('reports an over-budget order as a warning, not a failure (#325)', async () => {
    // The order exists and its pipeline may already be running, so this is not
    // something to retry — it is something to say. A `warn` budget whose warning
    // never leaves the service is the setting doing nothing at all.
    const ctx = await stocked()
    const cc = await createCostCenter()
    await db.update(costCenters).set({
      budgetAmount: '0.00', budgetCurrency: 'EUR', budgetPeriod: 'total', budgetBehaviour: 'warn',
    }).where(eq(costCenters.id, cc.id))
    await db.update(projects).set({ costCenterId: cc.id }).where(eq(projects.id, ctx.project.id))

    const result = await checkoutCart(makeSession(ctx.pm), {
      projectId: ctx.project.id,
      items: [item(ctx.first.id)],
    })

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.data.failed).toEqual([])
    expect(result.data.orderIds).toHaveLength(1)
    expect(result.data.warnings).toHaveLength(1)
    // Keyed on the order, because a cart can span two projects' cost centres and
    // "something was over budget" does not say which.
    expect(result.data.warnings[0].orderId).toBe(result.data.orderIds[0])
    expect(result.data.warnings[0].message).toMatch(/over budget/i)
  })

  it('warns about nothing when every order was inside its budget (#325)', async () => {
    const ctx = await stocked()
    const cc = await createCostCenter()
    await db.update(costCenters).set({
      budgetAmount: '100000.00', budgetCurrency: 'EUR', budgetPeriod: 'total', budgetBehaviour: 'warn',
    }).where(eq(costCenters.id, cc.id))
    await db.update(projects).set({ costCenterId: cc.id }).where(eq(projects.id, ctx.project.id))

    const result = await checkoutCart(makeSession(ctx.pm), {
      projectId: ctx.project.id,
      items: [item(ctx.first.id)],
    })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.data.warnings).toEqual([])
  })

  it('applies the parameters submitted at checkout, not the cart prefill', async () => {
    const ctx = await setup()
    await db.insert(parameters).values({
      scope: 'product', scopeId: ctx.nginx.id, name: 'HOST', type: 'string',
    })
    const added = await addToCart(makeSession(ctx.pm), {
      productId: ctx.nginx.id,
      environmentId: ctx.env.id,
      parameters: { HOST: 'stale-prefill' },
    })
    if (!added.ok) throw new Error('setup failed')

    const result = await checkoutCart(makeSession(ctx.pm), {
      projectId: ctx.project.id,
      items: [item(added.data.id, { parameters: { HOST: 'final-value' } })],
    })
    expect(result.ok).toBe(true)
    if (!result.ok) return

    const [order] = await db.select().from(orders).where(eq(orders.id, result.data.orderIds[0]))
    expect(order.parameters).toEqual({ HOST: 'final-value' })
  })

  it('queues a project manager\'s orders for approval', async () => {
    const ctx = await stocked()
    const result = await checkoutCart(makeSession(ctx.pm), {
      projectId: ctx.project.id,
      items: [item(ctx.first.id), item(ctx.second.id)],
    })
    if (!result.ok) throw new Error('checkout failed')

    const created = await db.select().from(orders)
    expect(created.every((o) => o.status === 'pending')).toBe(true)
    // Nothing provisioned, so no pipelines fired.
    expect(mockedWebhooks).not.toHaveBeenCalled()
  })

  it('provisions an admin\'s orders immediately', async () => {
    const ctx = await setup()
    const a = await addToCart(makeSession(ctx.admin), { productId: ctx.nginx.id, environmentId: ctx.env.id })
    if (!a.ok) throw new Error('setup failed')

    const result = await checkoutCart(makeSession(ctx.admin), {
      projectId: ctx.adminProject.id,
      items: [item(a.data.id)],
    })
    if (!result.ok) throw new Error('checkout failed')

    const [order] = await db.select().from(orders)
    expect(order.status).toBe('provisioning')
    expect(mockedWebhooks).toHaveBeenCalledTimes(1)
  })

  it('refuses a project the caller does not own', async () => {
    const ctx = await stocked()
    const result = await checkoutCart(makeSession(ctx.pm), {
      projectId: ctx.adminProject.id,
      items: [item(ctx.first.id)],
    })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.message).toMatch(/forbidden/i)
    expect(await db.select().from(orders)).toHaveLength(0)
  })

  it('refuses an item from another user\'s cart', async () => {
    const ctx = await stocked()
    const theirs = await addToCart(makeSession(ctx.other), { productId: ctx.nginx.id, environmentId: ctx.env.id })
    if (!theirs.ok) throw new Error('setup failed')

    const result = await checkoutCart(makeSession(ctx.pm), {
      projectId: ctx.project.id,
      items: [item(ctx.first.id), item(theirs.data.id)],
    })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.message).toMatch(/cart changed/i)
    expect(await db.select().from(orders)).toHaveLength(0)
  })

  it('refuses an unknown cart item rather than ordering a subset', async () => {
    const ctx = await stocked()
    const result = await checkoutCart(makeSession(ctx.pm), {
      projectId: ctx.project.id,
      items: [item(ctx.first.id), item(999_999)],
    })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.message).toMatch(/cart changed/i)
  })

  it('refuses the same item submitted twice', async () => {
    // Otherwise one cart entry would silently become two orders.
    const ctx = await stocked()
    const result = await checkoutCart(makeSession(ctx.pm), {
      projectId: ctx.project.id,
      items: [item(ctx.first.id), item(ctx.first.id)],
    })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.message).toMatch(/more than once/i)
  })

  it('refuses an empty checkout', async () => {
    const ctx = await setup()
    const result = await checkoutCart(makeSession(ctx.pm), { projectId: ctx.project.id, items: [] })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.message).toMatch(/empty/i)
  })

  it('leaves a failed item in the cart and reports it', async () => {
    // Past the validation gate a failure cannot be undone, so the honest answer is
    // to say which items landed and keep the rest for a retry.
    const ctx = await setup()
    const a = await addToCart(makeSession(ctx.admin), { productId: ctx.nginx.id, environmentId: ctx.env.id })
    const b = await addToCart(makeSession(ctx.admin), { productId: ctx.postgres.id, environmentId: ctx.env.id })
    if (!a.ok || !b.ok) throw new Error('setup failed')

    mockedWebhooks
      .mockResolvedValueOnce({ pipelineIds: ['pipe-ok'], failures: [] })
      .mockRejectedValueOnce(new Error('CI unreachable'))

    const result = await checkoutCart(makeSession(ctx.admin), {
      projectId: ctx.adminProject.id,
      items: [item(a.data.id), item(b.data.id)],
    })

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.data.orderIds).toHaveLength(1)
    expect(result.data.failed).toMatchObject([{ cartItemId: b.data.id }])

    // Only the successful item left the cart.
    const remaining = await db.select().from(cartItems)
    expect(remaining.map((r) => r.id)).toEqual([b.data.id])
  })

  // A double-click, or the checkout open in two tabs. Both requests read the same
  // items, both pass validation, and before #188 both created every order: six
  // orders from three items, six sets of pipelines, up to six times `quantity`
  // real machines, and six lines of spend. The loser's delete was a no-op, which
  // is why nothing surfaced it.
  it('orders a cart once when two checkouts race', async () => {
    const ctx = await setup()
    const a = await addToCart(makeSession(ctx.admin), { productId: ctx.nginx.id, environmentId: ctx.env.id })
    const b = await addToCart(makeSession(ctx.admin), { productId: ctx.postgres.id, environmentId: ctx.env.id })
    if (!a.ok || !b.ok) throw new Error('setup failed')
    const body = { projectId: ctx.adminProject.id, items: [item(a.data.id), item(b.data.id)] }

    const [first, second] = await Promise.all([
      checkoutCart(makeSession(ctx.admin), body),
      checkoutCart(makeSession(ctx.admin), body),
    ])

    const winners = [first, second].filter((r) => r.ok)
    const losers = [first, second].filter((r) => !r.ok)
    expect(winners).toHaveLength(1)
    expect(losers).toHaveLength(1)

    // Two items ordered, not four.
    const placed = await db.select().from(orders)
    expect(placed).toHaveLength(2)
    // And the cart is empty — the loser put nothing back that the winner took.
    expect(await db.select().from(cartItems)).toHaveLength(0)
  })

  // A lost race must leave the cart exactly as it found it, or the second tab
  // silently eats the items the first one did not get to.
  it('leaves the cart untouched for the checkout that loses the race', async () => {
    const ctx = await setup()
    const a = await addToCart(makeSession(ctx.admin), { productId: ctx.nginx.id, environmentId: ctx.env.id })
    const b = await addToCart(makeSession(ctx.admin), { productId: ctx.postgres.id, environmentId: ctx.env.id })
    if (!a.ok || !b.ok) throw new Error('setup failed')

    // One checkout takes only the first item; the other asks for both and must
    // find one of them already gone.
    const [, both] = await Promise.all([
      checkoutCart(makeSession(ctx.admin), { projectId: ctx.adminProject.id, items: [item(a.data.id)] }),
      checkoutCart(makeSession(ctx.admin), { projectId: ctx.adminProject.id, items: [item(a.data.id), item(b.data.id)] }),
    ])

    // Whichever way the two land, the second item is never ordered twice and is
    // never lost: it is either in the cart or in exactly one order.
    const remaining = await db.select().from(cartItems)
    const placed = await db.select().from(orders)
    expect(placed.length + remaining.length).toBe(2)
    expect(remaining.every((r) => r.id === a.data.id || r.id === b.data.id)).toBe(true)
    void both
  })

  it('returns 502 when no order at all could be created', async () => {
    const ctx = await setup()
    const a = await addToCart(makeSession(ctx.admin), { productId: ctx.nginx.id, environmentId: ctx.env.id })
    if (!a.ok) throw new Error('setup failed')
    mockedWebhooks.mockRejectedValue(new Error('CI unreachable'))

    const result = await checkoutCart(makeSession(ctx.admin), {
      projectId: ctx.adminProject.id,
      items: [item(a.data.id)],
    })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.status).toBe(502)
    expect(await db.select().from(cartItems)).toHaveLength(1)
  })

  it('audits the checkout', async () => {
    const ctx = await stocked()
    await checkoutCart(makeSession(ctx.pm), {
      projectId: ctx.project.id,
      items: [item(ctx.first.id), item(ctx.second.id)],
    })

    const [entry] = await db.select().from(auditLog).where(eq(auditLog.action, 'cart.checked_out'))
    expect(entry.userId).toBe(ctx.pm.id)
    expect(entry.details).toMatch(/2 item/)
  })

  it('refuses an item whose offering was withdrawn after it was added', async () => {
    const ctx = await stocked()
    await db
      .delete(productEnvironments)
      .where(and(eq(productEnvironments.productId, ctx.nginx.id), eq(productEnvironments.environmentId, ctx.env.id)))

    const result = await checkoutCart(makeSession(ctx.pm), {
      projectId: ctx.project.id,
      items: [item(ctx.first.id), item(ctx.second.id)],
    })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.message).toMatch(/not offered/i)
    // The gate held: the still-valid second item was not ordered either.
    expect(await db.select().from(orders)).toHaveLength(0)
  })
})

/*
 * Policy enforcement at the checkout (#110).
 *
 * What these cover is the WIRING through the cart: the gate itself lives in
 * `lib/policy/gate.test.ts`, and the order it produces is `orders.ts`'s. The one
 * thing only the cart can get wrong is telling the shopper what happened — an
 * order policy held back provisions nothing, and a checkout that says nothing
 * about it looks exactly like one where the order is building.
 */
describe('checkoutCart — policy (#110)', () => {
  afterEach(() => vi.restoreAllMocks())

  const stocked = async () => {
    const ctx = await setup()
    const admin = ctx.admin
    const a = await addToCart(makeSession(admin), { productId: ctx.nginx.id, environmentId: ctx.env.id })
    if (!a.ok) throw new Error('setup failed')
    return { ...ctx, admin, first: a.data }
  }

  const withEngine = async () => {
    const root = await createUser({ role: 'root', email: 'cart-root@test.dev', name: 'Root' })
    await createIntegration(root.id, {
      kind: 'opa',
      name: 'Policy engine',
      baseUrl: 'https://opa.example.com',
      authType: 'none',
      failureMode: 'blocking',
    })
  }

  const decides = (payload: Record<string, unknown>) =>
    vi.spyOn(global, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ result: payload }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    )

  it('reports an order policy held for approval on its own list, not as a warning (#110)', async () => {
    /*
     * Two different things, and a shopper has to be able to tell them apart: a
     * warning says the order went through anyway (over budget), while this one
     * says it did NOT — an admin's order provisions immediately, and policy is
     * why this one is sitting in the approvals queue instead.
     */
    const ctx = await stocked()
    await withEngine()
    decides({
      decision: 'needs-approval',
      rule: 'sod/production',
      message: 'Production needs a second pair of eyes.',
    })

    const result = await checkoutCart(makeSession(ctx.admin), {
      projectId: ctx.project.id,
      items: [{ cartItemId: ctx.first.id, parameters: {} }],
    })

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.data.approvalRequired).toHaveLength(1)
    expect(result.data.approvalRequired?.[0].orderId).toBe(result.data.orderIds[0])
    expect(result.data.approvalRequired?.[0].message).toContain('sod/production')
    // Not in `warnings`: that list means "placed, with something to say", and
    // the cart styles it as the over-budget notice.
    expect(result.data.warnings).toEqual([])

    const [row] = await db.select().from(orders).where(eq(orders.id, result.data.orderIds[0]))
    expect(row.status).toBe('pending')
  })

  it('says nothing on that list when policy allowed the order', async () => {
    const ctx = await stocked()
    await withEngine()
    decides({ decision: 'allow', rule: 'baseline' })

    const result = await checkoutCart(makeSession(ctx.admin), {
      projectId: ctx.project.id,
      items: [{ cartItemId: ctx.first.id, parameters: {} }],
    })

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.data.approvalRequired).toEqual([])
  })
})
