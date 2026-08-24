import type { SessionUser } from '@open-hybrid-cloud/types'
import { db } from '@/lib/db/client'
import {
  cartItems,
  products,
  productEnvironments,
  deploymentEnvironments,
} from '@/lib/db/schema'
import { and, eq, sql, inArray } from 'drizzle-orm'
import { logAudit } from '@/lib/audit'
import { ok, err, type Result } from '@/lib/services/result'
import { prepareOrder, createPreparedOrder, type PreparedOrder } from '@/lib/services/orders'
import {
  resolveOfferingPrice,
  validateQuantity,
  linePriceSql,
  lineCurrencySql,
  lineSizeLabelSql,
  lineSizeStillOfferedSql,
} from '@/lib/services/sizes'
import { productNameSql } from '@/lib/services/productName'

export interface CartRow {
  id: number
  productId: number
  environmentId: number
  parameters: Record<string, string>
  createdAt: Date
  productName: string | null
  imageAlt: string | null
  environmentName: string | null
  /**
   * The chosen size (issue #98), null when the offering has none, and the label it
   * reads as today. The label is resolved for display only — the code is what the
   * line stores and what checkout is validated against.
   */
  sizeCode: string | null
  sizeLabel: string | null
  /** How many elements this line will provision (issue #104). */
  quantity: number
  /**
   * UNIT price — the chosen size's, or the offering's when the line has no size.
   * The line total is this times `quantity`, computed where it is displayed so the
   * conversion to the viewer's currency happens once.
   */
  price: string | null
  currency: string | null
  /**
   * False when the product is no longer offered in that environment, OR when the
   * size the line chose has been retired. The item stays in the cart and says so,
   * rather than vanishing without explanation or failing at checkout.
   */
  stillOffered: boolean
}

/** A cart of unbounded size is a way to fire unbounded pipelines in one request. */
export const MAX_CART_ITEMS = 25

/**
 * Ceiling on the ELEMENTS one checkout may provision.
 *
 * MAX_CART_ITEMS alone stopped bounding the work once a line could ask for twenty
 * elements: 25 lines × 20 is 500 pipeline runs from one request. The cap is on the
 * sum rather than on the lines, because that is the number that actually reaches
 * CI. A cart that exceeds it is checked out in two goes, which is a far better
 * answer than a request that fires 500 pipelines.
 */
export const MAX_CHECKOUT_ELEMENTS = 100

/**
 * The caller's cart, oldest first.
 *
 * Product and environment names are resolved here so the overview does not need a
 * request per item, and the offering is checked so an item whose product was
 * withdrawn can be shown as unavailable instead of silently failing at checkout.
 */
export const listCart = async (session: SessionUser, lang: string): Promise<Result<CartRow[]>> => {
  const rows = await db
    .select({
      id: cartItems.id,
      productId: cartItems.productId,
      environmentId: cartItems.environmentId,
      parameters: cartItems.parameters,
      createdAt: cartItems.createdAt,
      // A scalar subquery rather than the join this used to carry: the join
      // pinned the row to one language_code, which is what made the cart
      // contradict the catalogue the item was added from (issue #162).
      productName: productNameSql(cartItems.productId, lang),
      imageAlt: products.imageAlt,
      environmentName: deploymentEnvironments.name,
      sizeCode: cartItems.sizeCode,
      quantity: cartItems.quantity,
      // The chosen size's price, falling back to the offering's for a line with no
      // size. Shared SQL rather than a local copy — see `linePriceSql` for why
      // there is exactly one definition of "which price applies".
      price: linePriceSql(cartItems.productId, cartItems.environmentId, cartItems.sizeCode),
      currency: lineCurrencySql(cartItems.productId, cartItems.environmentId, cartItems.sizeCode),
      sizeLabel: lineSizeLabelSql(cartItems.productId, cartItems.environmentId, cartItems.sizeCode),
      sizeStillOffered: lineSizeStillOfferedSql(
        cartItems.productId,
        cartItems.environmentId,
        cartItems.sizeCode,
      ),
    })
    .from(cartItems)
    // The image description lives on the product row, so that table has to be in
    // the join chain — selecting a column from it without joining produces a
    // cross join, which is how adding imageAlt broke every cart test at once.
    .leftJoin(products, eq(cartItems.productId, products.id))
    .leftJoin(deploymentEnvironments, eq(cartItems.environmentId, deploymentEnvironments.id))
    // Left, not inner: an item whose offering was withdrawn must still be listed,
    // so the user can see why checkout will refuse it.
    .leftJoin(
      productEnvironments,
      and(
        eq(cartItems.productId, productEnvironments.productId),
        eq(cartItems.environmentId, productEnvironments.environmentId),
      ),
    )
    .where(eq(cartItems.userId, session.id))
    .orderBy(cartItems.createdAt, cartItems.id)

  return ok(
    rows.map(({ sizeStillOffered, ...row }) => ({
      ...row,
      // Two ways a line can have become unorderable, and both have to say so here
      // rather than at checkout: the offering was withdrawn (no price resolves at
      // all) or the size it names was retired.
      stillOffered: row.price !== null && sizeStillOffered,
    })),
  )
}

/**
 * Add a product+environment to the caller's cart.
 *
 * Parameters are stored as given, without validation: a cart is a shopping list,
 * and refusing to hold an incomplete item would defeat the point of collecting
 * first and filling in at checkout. What IS checked is that the offering exists —
 * an item that could never be ordered has no business in the cart.
 */
export const addToCart = async (
  session: SessionUser,
  input: {
    productId: number
    environmentId: number
    parameters?: Record<string, string>
    sizeCode?: string | null
    quantity?: number
  },
  /** Only for the row echoed back, which is a `listCart` row and has to read like one. */
  lang: string,
): Promise<Result<CartRow>> => {
  const [offering] = await db
    .select({ productId: productEnvironments.productId })
    .from(productEnvironments)
    .where(
      and(
        eq(productEnvironments.productId, input.productId),
        eq(productEnvironments.environmentId, input.environmentId),
      ),
    )
    .limit(1)

  if (!offering) return err(400, 'Product is not offered in the selected environment')

  // The size and quantity ARE validated on the way in, unlike the parameters: they
  // are not something the user fills in later at checkout, they are what the line
  // IS. A line naming a size that does not exist is not an incomplete shopping
  // list entry, it is a line that can never be ordered.
  const priced = await resolveOfferingPrice(input.productId, input.environmentId, input.sizeCode)
  if (!priced.ok) return priced
  const quantity = validateQuantity(input.quantity)
  if (!quantity.ok) return quantity

  const [{ count }] = await db
    .select({ count: sql<number>`COUNT(*)::int` })
    .from(cartItems)
    .where(eq(cartItems.userId, session.id))

  if (count >= MAX_CART_ITEMS) {
    return err(400, `A cart can hold at most ${MAX_CART_ITEMS} items`)
  }

  // Duplicates are allowed on purpose: two instances of the same product in the
  // same environment is a normal thing to want, and they differ by parameters.
  const [item] = await db
    .insert(cartItems)
    .values({
      userId: session.id,
      productId: input.productId,
      environmentId: input.environmentId,
      parameters: input.parameters ?? {},
      sizeCode: priced.data.sizeCode,
      quantity: quantity.data,
    })
    .returning()

  const listed = await listCart(session, lang)
  const enriched = listed.ok ? listed.data.find((r) => r.id === item.id) : undefined
  return ok(
    enriched ?? {
      ...item,
      productName: null,
      imageAlt: null,
      environmentName: null,
      sizeLabel: priced.data.sizeLabel,
      price: priced.data.price,
      currency: priced.data.currency,
      stillOffered: true,
    },
  )
}

/**
 * Update one line: its parameter prefill, its size, or how many it asks for.
 *
 * Lets the checkout form save progress without re-adding the item, and keeps the
 * cart the single source of what the user has typed. Quantity is editable HERE
 * because that is where a shopper changes it (issue #104) — the alternative,
 * removing the line and adding it again, loses the parameters they had typed.
 *
 * A patch, not a replacement: sending only `quantity` must not wipe the
 * parameters, so an absent field means "leave it alone".
 */
export const updateCartItem = async (
  session: SessionUser,
  itemId: number,
  patch: {
    parameters?: Record<string, string>
    sizeCode?: string | null
    quantity?: number
  },
): Promise<Result<void>> => {
  // Read first: changing the size has to be validated against THIS line's
  // offering, which only the stored row knows.
  const [existing] = await db
    .select({
      productId: cartItems.productId,
      environmentId: cartItems.environmentId,
      sizeCode: cartItems.sizeCode,
    })
    .from(cartItems)
    .where(and(eq(cartItems.id, itemId), eq(cartItems.userId, session.id)))
    .limit(1)

  if (!existing) return err(404, 'Cart item not found')

  const values: {
    parameters?: Record<string, string>
    sizeCode?: string | null
    quantity?: number
  } = {}

  if (patch.parameters !== undefined) values.parameters = patch.parameters

  if (patch.sizeCode !== undefined) {
    const priced = await resolveOfferingPrice(
      existing.productId,
      existing.environmentId,
      patch.sizeCode,
    )
    if (!priced.ok) return priced
    values.sizeCode = priced.data.sizeCode
  }

  if (patch.quantity !== undefined) {
    const quantity = validateQuantity(patch.quantity)
    if (!quantity.ok) return quantity
    values.quantity = quantity.data
  }

  // Nothing to change is not an error — the caller's intent is already the state.
  if (Object.keys(values).length === 0) return ok(undefined)

  const updated = await db
    .update(cartItems)
    .set(values)
    // Scoped by user id, so an item id from another user's cart cannot be touched.
    .where(and(eq(cartItems.id, itemId), eq(cartItems.userId, session.id)))
    .returning({ id: cartItems.id })

  if (!updated.length) return err(404, 'Cart item not found')
  return ok(undefined)
}

/** Remove one item. Idempotent — removing what is already gone is the wanted state. */
export const removeFromCart = async (
  session: SessionUser,
  itemId: number,
): Promise<Result<void>> => {
  await db
    .delete(cartItems)
    .where(and(eq(cartItems.id, itemId), eq(cartItems.userId, session.id)))
  return ok(undefined)
}

/** Empty the caller's cart. */
export const clearCart = async (session: SessionUser): Promise<Result<void>> => {
  await db.delete(cartItems).where(eq(cartItems.userId, session.id))
  return ok(undefined)
}

export interface CheckoutItemInput {
  cartItemId: number
  parameters: Record<string, string>
  costCenterId?: number
  trial?: boolean
}

export interface CheckoutFailure {
  cartItemId: number
  message: string
}

export interface CheckoutResult {
  orderIds: number[]
  /** Items whose orders could not be created after validation passed. */
  failed: CheckoutFailure[]
}

/**
 * Order every item in the cart against one project.
 *
 * On "atomically", which the issue asks for: order creation fires CI pipelines,
 * and a fired pipeline cannot be recalled, so a transaction spanning the whole
 * checkout is not available. What IS available — and what actually protects the
 * user — is an all-or-nothing VALIDATION gate: every item is validated first,
 * through the very same prepareOrder a single order goes through, and nothing is
 * created unless all of them pass. A cart of five where the third has a missing
 * required parameter creates zero orders, not two.
 *
 * Past that gate, creation is per item and any failure is reported per item. That
 * residual risk is inherent: once item one's pipeline is running, item two failing
 * cannot undo it. Reporting which items did land is the only honest answer.
 */
export const checkoutCart = async (
  session: SessionUser,
  input: { projectId: number; items: CheckoutItemInput[] },
): Promise<Result<CheckoutResult>> => {
  if (input.items.length === 0) return err(400, 'The cart is empty')
  if (input.items.length > MAX_CART_ITEMS) {
    return err(400, `A checkout can cover at most ${MAX_CART_ITEMS} items`)
  }

  const ids = input.items.map((i) => i.cartItemId)
  if (new Set(ids).size !== ids.length) {
    return err(400, 'The same cart item was submitted more than once')
  }

  const owned = await db
    .select({
      id: cartItems.id,
      productId: cartItems.productId,
      environmentId: cartItems.environmentId,
      sizeCode: cartItems.sizeCode,
      quantity: cartItems.quantity,
    })
    .from(cartItems)
    .where(and(eq(cartItems.userId, session.id), inArray(cartItems.id, ids)))

  // Counted over the ELEMENTS, not the lines: with quantity, the number of lines
  // no longer bounds the number of pipeline runs this request will start.
  const totalElements = owned.reduce((sum, item) => sum + Math.max(item.quantity, 1), 0)
  if (totalElements > MAX_CHECKOUT_ELEMENTS) {
    return err(
      400,
      `A checkout can provision at most ${MAX_CHECKOUT_ELEMENTS} elements; this one asks for ${totalElements}`,
    )
  }

  if (owned.length !== input.items.length) {
    // Either an id belongs to somebody else's cart or the cart changed in another
    // tab. Refusing beats silently ordering a subset.
    return err(400, 'The cart changed — reload the checkout and try again')
  }

  const byId = new Map(owned.map((item) => [item.id, item]))

  // Phase one: validate everything, create nothing.
  const prepared: { cartItemId: number; order: PreparedOrder }[] = []
  const invalid: CheckoutFailure[] = []
  for (const item of input.items) {
    const cartItem = byId.get(item.cartItemId)
    if (!cartItem) continue
    const result = await prepareOrder(session, {
      projectId: input.projectId,
      productId: cartItem.productId,
      environmentId: cartItem.environmentId,
      parameters: item.parameters,
      costCenterId: item.costCenterId,
      trial: item.trial,
      // From the stored line, never from the request: the size and the quantity
      // are what the user put in the cart, and accepting them again here would let
      // a checkout re-price or multiply a line the cart never showed.
      sizeCode: cartItem.sizeCode,
      quantity: cartItem.quantity,
    })
    if (result.ok) prepared.push({ cartItemId: item.cartItemId, order: result.data })
    else invalid.push({ cartItemId: item.cartItemId, message: result.message })
  }

  if (invalid.length > 0) {
    // Nothing has been written, so this is a clean rejection: the user fixes the
    // named items and submits the whole cart again.
    return err(
      400,
      `Nothing was ordered. ${invalid.length} item(s) need attention: ${invalid
        .map((f) => `#${f.cartItemId}: ${f.message}`)
        .join('; ')}`,
    )
  }

  // Phase two: create. Past this point failures are per item and cannot be undone.
  const orderIds: number[] = []
  const failed: CheckoutFailure[] = []
  const orderedCartItemIds: number[] = []

  for (const { cartItemId, order } of prepared) {
    try {
      const created = await createPreparedOrder(session, order)
      if (created.ok) {
        orderIds.push(created.data.id)
        orderedCartItemIds.push(cartItemId)
      } else {
        failed.push({ cartItemId, message: created.message })
      }
    } catch (e) {
      failed.push({ cartItemId, message: e instanceof Error ? e.message : String(e) })
    }
  }

  // Only the items that actually became orders leave the cart. A failed item stays
  // so the user can retry it rather than having to reconstruct it from memory.
  if (orderedCartItemIds.length > 0) {
    await db
      .delete(cartItems)
      .where(and(eq(cartItems.userId, session.id), inArray(cartItems.id, orderedCartItemIds)))
  }

  await logAudit(
    session.id,
    'cart.checked_out',
    // No single entity id: a checkout spans several orders, and picking one of them
    // would make the entry look like it was about that order alone.
    undefined,
    `Checked out ${orderIds.length} item(s) into project ${input.projectId}` +
      (failed.length > 0 ? `; ${failed.length} failed` : ''),
  )

  if (orderIds.length === 0) {
    return err(502, `No order could be created: ${failed.map((f) => f.message).join('; ')}`)
  }

  return ok({ orderIds, failed })
}

/** Whether the caller's cart contains anything, for badging the navigation. */
export const countCart = async (session: SessionUser): Promise<number> => {
  const [{ count }] = await db
    .select({ count: sql<number>`COUNT(*)::int` })
    .from(cartItems)
    .where(eq(cartItems.userId, session.id))
  return count
}

/** Re-exported so route handlers can validate ids without importing the schema. */
export const cartItemExists = async (session: SessionUser, itemId: number): Promise<boolean> => {
  const [row] = await db
    .select({ id: cartItems.id })
    .from(cartItems)
    .where(and(eq(cartItems.id, itemId), eq(cartItems.userId, session.id)))
    .limit(1)
  return row !== undefined
}

/** Guards against a cart item pointing at a product that has since been deleted. */
export const pruneOrphanedCartItems = async (session: SessionUser): Promise<void> => {
  await db
    .delete(cartItems)
    .where(
      and(
        eq(cartItems.userId, session.id),
        sql`NOT EXISTS (SELECT 1 FROM ${products} WHERE ${products.id} = ${cartItems.productId})`,
      ),
    )
}
