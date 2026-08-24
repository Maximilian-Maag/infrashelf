import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { SessionUser } from '@open-hybrid-cloud/types'

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
import { db } from '@/lib/db/client'
import { cartItems, orders, parameters, products, productEnvironments, auditLog } from '@/lib/db/schema'
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
