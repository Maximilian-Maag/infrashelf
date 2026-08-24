import { db } from '@/lib/db/client'
import { countWhere } from '@/lib/db/queries'
import {
  products,
  productTranslations,
  productEnvironments,
  productWebhooks,
  deploymentEnvironments,
  categories,
  costCenters,
  infrastructureElements,
  parameters,
  orders,
  cartItems,
  productFavorites,
  type Product,
  type ProductTranslation,
  type ProductEnvironment,
  type ProductWebhook,
  type Parameter,
} from '@/lib/db/schema'
import { count, eq, sql, and, inArray, isNull } from 'drizzle-orm'
import { translateProduct } from '@/lib/ai'
import { ok, err, type Result } from '@/lib/services/result'
import { fireDestroyTriggers, destroyVariables } from '@/lib/services/teardown'
import { recordProductVersion } from '@/lib/services/versions'
import { logAudit, logAuditWith, changedFields } from '@/lib/audit'
import { isEmptyUpdate, EMPTY_UPDATE_MESSAGE } from '@/lib/services/updates'
import { productNameSql, productDescriptionSql } from '@/lib/services/productName'
import {
  ALLOWED_IMAGE_MIMES,
  MAX_IMAGE_BYTES,
  detectImageMime,
} from '@/lib/services/imageUpload'

// Re-exported from their new home in `imageUpload.ts`: the branding logo needs the
// same sniffing and the same cap, and it should not have to import them through
// the product service to get them.
export { ALLOWED_IMAGE_MIMES, MAX_IMAGE_BYTES, detectImageMime }

export interface ProductAdminRow {
  id: number
  categoryId: number
  baseLanguage: string
  createdAt: Date
  categoryName: string | null
  name: string
  description: string
}

export interface CreateProductInput {
  categoryId: number
  baseLanguage?: string
  name: string
  description?: string
}

export interface UpdateProductInput {
  categoryId?: number
  baseLanguage?: string
  name?: string
  description?: string
  /** Optional free text describing the change (issue #38). */
  changelog?: string
  /** Recorded as the version's author. */
  userId?: number | null
}

export interface CreateProductEnvironmentInput {
  environmentId: number
  /** Optional free text describing the change (issue #38). */
  changelog?: string
  userId?: number | null
  price?: string
  currency?: string
  costCenterMode?: 'project' | 'select' | 'overhead'
  forcedCostCenter?: boolean
  overheadCostCenterId?: number | null
  trialEnabled?: boolean
  trialDurationMinutes?: number
}

export interface UpdateProductEnvironmentInput {
  changelog?: string
  userId?: number | null
  price?: string
  currency?: string
  costCenterMode?: 'project' | 'select' | 'overhead'
  forcedCostCenter?: boolean
  overheadCostCenterId?: number | null
  trialEnabled?: boolean
  trialDurationMinutes?: number
}

export interface CreateWebhookInput {
  environmentId: number
  name: string
  webhookUrl: string
  webhookToken: string
  execOrder?: number
}

export interface UpdateWebhookInput {
  environmentId?: number
  name?: string
  webhookUrl?: string
  webhookToken?: string
  execOrder?: number
}

export interface UpsertTranslationInput {
  name: string
  description?: string
}

// The admin list and detail read the same expression as the catalogue, so a
// product a root user just created in German reads back in German instead of
// showing whatever happened to be in the `en` row. Before, those two screens were
// the only place the `en` mirror this service used to write (issue #161) was
// visible, which is what made the mirror look necessary.
const adminProductSelect = (lang: string) => ({
  id: products.id,
  categoryId: products.categoryId,
  baseLanguage: products.baseLanguage,
  createdAt: products.createdAt,
  categoryName: categories.name,
  name: productNameSql(products.id, lang),
  description: productDescriptionSql(products.id, lang),
})

export const listProducts = async (lang: string): Promise<Result<ProductAdminRow[]>> => {
  const rows = await db
    .select(adminProductSelect(lang))
    .from(products)
    .leftJoin(categories, eq(products.categoryId, categories.id))
    // Retired products are gone as far as every catalogue and admin screen is
    // concerned; the row only survives so its orders keep a referent (issue #142).
    .where(isNull(products.retiredAt))
    .orderBy(products.id)

  return ok(rows as ProductAdminRow[])
}

export const createProduct = async (
  input: CreateProductInput,
  actorId?: number,
): Promise<Result<ProductAdminRow>> => {
  const { categoryId, baseLanguage = 'de', name, description = '' } = input

  const [product] = await db
    .insert(products)
    .values({ categoryId, baseLanguage })
    .returning()

  // Exactly one row, in the language the text was actually written in.
  //
  // This used to seed a second, identical `en` row for a non-English product, to
  // keep the "there is always an `en` row" invariant that ten read paths depended
  // on (issue #162). Those paths resolve through the shared fallback chain now, so
  // the invariant is gone — and with it a row that claimed to be an English
  // translation while holding German text, indistinguishable from a real one both
  // to the admin translations tab and to `updateProduct`, which is what let a
  // German typo fix overwrite the English name for every user (issue #161).
  await db
    .insert(productTranslations)
    .values({ productId: product.id, languageCode: baseLanguage, name, description })

  await logAudit(
    actorId ?? null,
    'product.created',
    product.id,
    `Created product ${name} in category #${categoryId}`,
  )

  return ok({ ...product, name, description, categoryName: null } as ProductAdminRow)
}

export const getProductAdmin = async (id: number, lang: string): Promise<Result<ProductAdminRow & { environments: ProductEnvironment[]; parameters: Parameter[] }>> => {
  const rows = await db
    .select(adminProductSelect(lang))
    .from(products)
    .leftJoin(categories, eq(products.categoryId, categories.id))
    .where(and(eq(products.id, id), isNull(products.retiredAt)))
    .limit(1)

  if (!rows.length) return err(404, 'Not found')

  const envRows = await db
    .select({
      productId: productEnvironments.productId,
      environmentId: productEnvironments.environmentId,
      price: productEnvironments.price,
      currency: productEnvironments.currency,
      costCenterMode: productEnvironments.costCenterMode,
      forcedCostCenter: productEnvironments.forcedCostCenter,
      overheadCostCenterId: productEnvironments.overheadCostCenterId,
      trialEnabled: productEnvironments.trialEnabled,
      trialDurationMinutes: productEnvironments.trialDurationMinutes,
    })
    .from(productEnvironments)
    .where(eq(productEnvironments.productId, id))

  const paramRows = await db
    .select()
    .from(parameters)
    .where(and(eq(parameters.scope, 'product'), eq(parameters.scopeId, id)))

  return ok({ ...rows[0], environments: envRows, parameters: paramRows } as ProductAdminRow & { environments: ProductEnvironment[]; parameters: Parameter[] })
}

export const updateProduct = async (
  id: number,
  input: UpdateProductInput,
): Promise<Result<Product>> => {
  const { name, description, changelog, userId, ...productFields } = input

  // `userId` is injected by the route on every call, so isEmptyUpdate(input) would
  // never fire — the emptiness that matters is "no field the caller asked to
  // change", which is what this spells out.
  if (
    name === undefined &&
    description === undefined &&
    changelog === undefined &&
    isEmptyUpdate(productFields)
  ) {
    return err(400, EMPTY_UPDATE_MESSAGE)
  }

  const existing = await db
    .select({ id: products.id, baseLanguage: products.baseLanguage })
    .from(products)
    .where(eq(products.id, id))
    .limit(1)

  if (!existing.length) return err(404, 'Not found')

  if (Object.keys(productFields).length > 0) {
    await db.update(products).set(productFields).where(eq(products.id, id))
  }

  if (name !== undefined || description !== undefined) {
    // Re-read rather than reuse `existing`: the update above may have just changed
    // the base language, and the text in this request is written in the new one.
    const productRows = await db
      .select({ baseLanguage: products.baseLanguage })
      .from(products)
      .where(eq(products.id, id))
      .limit(1)

    const lang = productRows[0]?.baseLanguage ?? 'en'
    const updateData: Partial<{ name: string; description: string }> = {}
    if (name !== undefined) updateData.name = name
    if (description !== undefined) updateData.description = description

    // ONE row, and it is the base language's — never a second language's as well.
    //
    // This used to mirror the same text into the `en` row with onConflictDoUpdate
    // whenever the base language was not English, so fixing a typo in a German name
    // silently replaced the English TRANSLATION with German text — for every user,
    // in the cart, the order list, the approvals queue, the cost report and the
    // subject line of every notification mail, with nothing in the version history
    // saying so (issue #161). The base language and English are the same row only
    // when the base language IS English; the primary key is (product_id,
    // language_code), so they are otherwise two rows and always were.
    //
    // Not merely softened to onConflictDoNothing, which would still write German
    // into `en` for a product that had no English translation yet: with the mirror
    // deleted there is no statement here that can name a language other than the
    // one the admin declared they are typing in. `upsertTranslation` and
    // `translateProductById` are the only ways to write any other row, and both are
    // told which language they are writing.
    await db
      .insert(productTranslations)
      .values({ productId: id, languageCode: lang, name: name ?? '', description: description ?? '' })
      .onConflictDoUpdate({
        target: [productTranslations.productId, productTranslations.languageCode],
        set: updateData,
      })
  }

  const updated = await db
    .select()
    .from(products)
    .where(eq(products.id, id))
    .limit(1)

  // A product-level change is not specific to one environment, so it carries no
  // offering snapshot — there is no single one to take.
  await recordProductVersion({
    productId: id,
    environmentId: null,
    summary: describeProductChange(input),
    changelog,
    userId: userId ?? null,
  })

  await logAudit(userId ?? null, 'product.updated', id, changedFields({ name, description, changelog, ...productFields }))

  return ok(updated[0])
}

const describeProductChange = (input: UpdateProductInput): string => {
  const changed: string[] = []
  if (input.name !== undefined) changed.push('name')
  if (input.description !== undefined) changed.push('description')
  if (input.categoryId !== undefined) changed.push('category')
  if (input.baseLanguage !== undefined) changed.push('base language')
  return changed.length > 0 ? `Product updated: ${changed.join(', ')}` : 'Product updated'
}

export const deleteProduct = async (id: number, actorId?: number): Promise<Result<void>> => {
  // An already-retired product is gone from every screen, so asking to delete it
  // again is a 404 like any other missing product.
  const existing = await db
    .select({ id: products.id })
    .from(products)
    .where(and(eq(products.id, id), isNull(products.retiredAt)))
    .limit(1)
  if (!existing.length) return err(404, 'Not found')

  /*
   * Whether this delete has to preserve order history (issue #142).
   *
   * `orders.product_id` is ON DELETE CASCADE, so deleting a product deleted every
   * order placed for it — and with them `orders.product_snapshot`, the column that
   * exists precisely so a later catalogue change cannot rewrite what a customer
   * was offered. The delete erased the record it was designed to protect.
   *
   * Refusing the delete outright was the other option the issue offers, and it does
   * not work here: `infrastructure_elements.order_id` is NOT NULL, so every product
   * that has ever been provisioned has an order, and refusing would make FA-09.6
   * — cascade decommissioning on product delete, the behaviour the rest of this
   * function implements — unreachable in exactly the case it exists for.
   *
   * So an ordered product is RETIRED instead of deleted (see `products.retiredAt`).
   * A product nobody ever ordered has no history to keep and is still deleted
   * outright, which keeps the table from filling up with tombstones.
   */
  const activeInfra = await db
    .select({ id: infrastructureElements.id, orderId: infrastructureElements.orderId, productId: infrastructureElements.productId, environmentId: infrastructureElements.environmentId, parameters: infrastructureElements.parameters, sequence: infrastructureElements.sequence, sizeCode: infrastructureElements.sizeCode })
    .from(infrastructureElements)
    .where(and(eq(infrastructureElements.productId, id), eq(infrastructureElements.status, 'active')))

  // Await the destroy trigger request BEFORE deleting the product. The delete
  // cascades to infrastructure_elements (ON DELETE CASCADE); firing the webhook
  // fire-and-forget raced the cascade. NOTE: awaiting only guarantees the CI
  // system accepted the trigger — the destroy pipeline still runs asynchronously
  // afterwards, so a late failure cannot be reconciled once the rows are gone.
  const triggerFailures: string[] = []
  for (const infra of activeInfra) {
    // Atomically claim the row (active → decommissioning) so two concurrent
    // deletes can't both fire a destroy pipeline for the same element.
    const claimed = await db
      .update(infrastructureElements)
      .set({ status: 'decommissioning' })
      .where(and(eq(infrastructureElements.id, infra.id), eq(infrastructureElements.status, 'active')))
      .returning({ id: infrastructureElements.id })
    if (!claimed.length) continue
    const destroyVars = destroyVariables(infra)
    try {
      // Fires destroy for BOTH product webhooks and pipeline stacks — stack-
      // provisioned infra would otherwise leak on product deletion.
      const outcome = await fireDestroyTriggers(infra, destroyVars)
      triggerFailures.push(...outcome.failures.map((f) => `infra #${infra.id}: ${f}`))
    } catch (e) {
      console.error(e)
      triggerFailures.push(`infra #${infra.id}: ${e instanceof Error ? e.message : String(e)}`)
    }
  }

  // Block the delete when any destroy could not be started. Deleting anyway
  // cascades the infrastructure_elements rows away, which would leave the
  // provisioned infrastructure running with nothing left to reconcile it
  // against. The claimed rows keep their state (fireDestroyTriggers hands back
  // the ones where nothing started), so the operator can retry.
  if (triggerFailures.length > 0) {
    return err(
      502,
      `Cannot delete product: ${triggerFailures.length} destroy trigger(s) could not be started, so deleting now would leak infrastructure. Fix and retry — ${triggerFailures.join('; ')}`,
    )
  }

  /*
   * Retire-or-delete is decided HERE, not before the loop above.
   *
   * The order count used to be taken before the destroy triggers were fired. Those
   * are network calls to the CI system, one per active element, and they take
   * seconds — during which the product is still fully orderable: cart-add and order
   * creation only need a matching `product_environments` row, and those rows are
   * not withdrawn until the retire transaction at the end. An order placed in that
   * window was not counted, so `retire` stayed false, the product was hard-deleted,
   * and `orders.product_id ON DELETE CASCADE` took the order and its
   * `product_snapshot` with it — the exact loss issue #142 exists to prevent.
   *
   * Counting inside the transaction that also performs the delete closes the window
   * rather than narrowing it. `FOR UPDATE` on the product row is the part that makes
   * it airtight: inserting a row that references `products.id` takes a FOR KEY SHARE
   * lock on that row, which conflicts with FOR UPDATE, so a concurrent order insert
   * either committed before the lock (and is counted) or waits behind it. If it
   * waits and this ends in a hard delete, its foreign key fails and the order is
   * refused — a rejected order, not a silently destroyed one.
   *
   * Withdrawing the offerings first and deciding afterwards was the other option.
   * It was rejected because the 502 above returns without deleting anything: a call
   * that refuses to proceed would have already stripped every offering — price,
   * currency, cost-center mode — with nothing to restore them from.
   */
  return db.transaction(async (tx): Promise<Result<void>> => {
    const locked = await tx
      .select({ id: products.id })
      .from(products)
      .where(and(eq(products.id, id), isNull(products.retiredAt)))
      .for('update')
      .limit(1)
    if (!locked.length) return err(404, 'Not found')

    // Counted by Postgres rather than selected and measured: the figure is exact
    // because the audit entry below quotes it, but a popular product has as many
    // rows here as it has ever had orders and none of them are otherwise read.
    const orderCount = await countWhere(tx.select({ n: count() }).from(orders).where(eq(orders.productId, id)))

    if (orderCount > 0) {
      // Withdraw every offering in the same transaction as the retirement flag. Both
      // cart-add and order creation require a matching product_environments row, so
      // removing them is what actually makes a retired product unorderable — the flag
      // only keeps it out of the catalogue's reads.
      //
      // The infrastructure_elements rows are left in place, unlike the old cascade:
      // they are mid-decommission, and their pipelines report back to the callback
      // that reconciles them. That is what the note above wished for.
      await tx.update(products).set({ retiredAt: new Date() }).where(eq(products.id, id))
      await tx.delete(productEnvironments).where(eq(productEnvironments.productId, id))
      // Transient rows that would otherwise dangle against something nobody can
      // order any more. Both cascade on a hard delete today.
      await tx.delete(cartItems).where(eq(cartItems.productId, id))
      await tx.delete(productFavorites).where(eq(productFavorites.productId, id))

      // On the transaction's own connection, so it rolls back with the retirement.
      await logAuditWith(
        tx,
        actorId ?? null,
        'product.retired',
        id,
        `Retired product (${orderCount} order(s) keep their history), withdrew all offerings, decommissioning ${activeInfra.length} infrastructure element(s)`,
      )

      return ok(undefined)
    }

    await tx.delete(products).where(eq(products.id, id))

    await logAuditWith(
      tx,
      actorId ?? null,
      'product.deleted',
      id,
      `Deleted product, decommissioning ${activeInfra.length} infrastructure element(s)`,
    )

    return ok(undefined)
  })
}

/** Longest useful alt text; beyond this it is a description, not a label. */
export const MAX_IMAGE_ALT_LENGTH = 300

export const updateProductImage = async (
  id: number,
  buffer: Buffer,
  alt: string,
  actorId?: number,
): Promise<Result<{ mime: string }>> => {
  // Required, not optional: an empty alt is a claim that the picture carries no
  // information, and only the person uploading it can make that claim. Every
  // component that renders it used to decide for itself — the catalogue tile and
  // the cart thumbnail passed "", the product page passed the product name.
  const description = alt.trim()
  if (description === '') return err(400, 'An image description is required')
  if (description.length > MAX_IMAGE_ALT_LENGTH) {
    return err(400, `The image description must be at most ${MAX_IMAGE_ALT_LENGTH} characters`)
  }

  if (buffer.length === 0) return err(400, 'The uploaded file is empty')
  if (buffer.length > MAX_IMAGE_BYTES) {
    return err(413, `Image is larger than ${MAX_IMAGE_BYTES / (1024 * 1024)} MB`)
  }

  const mime = detectImageMime(buffer)
  if (mime === null) {
    return err(415, `Unsupported image type — allowed: ${ALLOWED_IMAGE_MIMES.join(', ')}`)
  }

  const updated = await db
    .update(products)
    .set({ image: buffer, imageMime: mime, imageAlt: description })
    .where(eq(products.id, id))
    .returning({ id: products.id })

  // Previously this silently reported success for a product id that does not
  // exist, because an UPDATE matching no rows is not an error.
  if (updated.length === 0) return err(404, 'Product not found')

  await logAudit(actorId ?? null, 'product.image_updated', id, `Image replaced (${mime}, ${buffer.length} bytes)`)

  return ok({ mime })
}

export const updateProductImageAlt = async (
  id: number,
  alt: string,
  actorId?: number,
): Promise<Result<void>> => {
  const description = alt.trim()
  if (description === '') return err(400, 'An image description is required')
  if (description.length > MAX_IMAGE_ALT_LENGTH) {
    return err(400, `The image description must be at most ${MAX_IMAGE_ALT_LENGTH} characters`)
  }

  const [row] = await db
    .select({ hasImage: products.image })
    .from(products)
    .where(eq(products.id, id))
    .limit(1)

  if (!row) return err(404, 'Product not found')
  // Describing a picture that is not there would leave a description behind for
  // whatever is uploaded next.
  if (!row.hasImage) return err(409, 'This product has no image to describe')

  await db.update(products).set({ imageAlt: description }).where(eq(products.id, id))

  await logAudit(actorId ?? null, 'product.image_alt_updated', id, 'Image description changed')

  return ok(undefined)
}

export const deleteProductImage = async (id: number, actorId?: number): Promise<Result<void>> => {
  const updated = await db
    .update(products)
    .set({ image: null, imageMime: null, imageAlt: null })
    .where(eq(products.id, id))
    .returning({ id: products.id })

  if (updated.length === 0) return err(404, 'Product not found')

  await logAudit(actorId ?? null, 'product.image_deleted', id, 'Image removed')

  return ok(undefined)
}

export const translateProductById = async (
  id: number,
  actorId?: number,
): Promise<Result<{ languages: string[] }>> => {
  const productRows = await db
    .select({ baseLanguage: products.baseLanguage })
    .from(products)
    .where(eq(products.id, id))
    .limit(1)

  if (!productRows.length) return err(404, 'Product not found')

  const baseLanguage = productRows[0].baseLanguage

  const baseTranslationRows = await db
    .select({ name: productTranslations.name, description: productTranslations.description })
    .from(productTranslations)
    .where(sql`${productTranslations.productId} = ${id} AND ${productTranslations.languageCode} = ${baseLanguage}`)
    .limit(1)

  if (!baseTranslationRows.length) return err(404, 'Base translation not found')

  const { name, description } = baseTranslationRows[0]
  const translations = await translateProduct(name, description)

  for (const [lang, t] of Object.entries(translations)) {
    await db
      .insert(productTranslations)
      .values({ productId: id, languageCode: lang, name: t.name, description: t.description })
      .onConflictDoUpdate({
        target: [productTranslations.productId, productTranslations.languageCode],
        set: { name: t.name, description: t.description },
      })
  }

  await logAudit(
    actorId ?? null,
    'product.translated',
    id,
    `Machine-translated into ${Object.keys(translations).join(', ') || 'no languages'}`,
  )

  return ok({ languages: Object.keys(translations) })
}

export const listTranslations = async (id: number): Promise<Result<ProductTranslation[]>> => {
  const rows = await db
    .select()
    .from(productTranslations)
    .where(eq(productTranslations.productId, id))
    .orderBy(productTranslations.languageCode)

  return ok(rows)
}

export const upsertTranslation = async (
  id: number,
  lang: string,
  input: UpsertTranslationInput,
  actorId?: number,
): Promise<Result<ProductTranslation>> => {
  const [row] = await db
    .insert(productTranslations)
    .values({
      productId: id,
      languageCode: lang,
      name: input.name,
      description: input.description ?? '',
    })
    .onConflictDoUpdate({
      target: [productTranslations.productId, productTranslations.languageCode],
      set: { name: input.name, description: input.description ?? '' },
    })
    .returning()

  await logAudit(actorId ?? null, 'product.translation_updated', id, `Translation saved for ${lang}`)

  return ok(row)
}

export const listProductEnvironments = async (
  id: number,
): Promise<Result<(ProductEnvironment & { environmentName: string | null })[]>> => {
  const rows = await db
    .select({
      productId: productEnvironments.productId,
      environmentId: productEnvironments.environmentId,
      price: productEnvironments.price,
      currency: productEnvironments.currency,
      costCenterMode: productEnvironments.costCenterMode,
      forcedCostCenter: productEnvironments.forcedCostCenter,
      overheadCostCenterId: productEnvironments.overheadCostCenterId,
      trialEnabled: productEnvironments.trialEnabled,
      trialDurationMinutes: productEnvironments.trialDurationMinutes,
      environmentName: deploymentEnvironments.name,
    })
    .from(productEnvironments)
    .leftJoin(
      deploymentEnvironments,
      eq(productEnvironments.environmentId, deploymentEnvironments.id),
    )
    .where(eq(productEnvironments.productId, id))

  return ok(rows as (ProductEnvironment & { environmentName: string | null })[])
}

/**
 * Reject an overhead account that does not exist or has been deactivated.
 *
 * Ordering already refuses an inactive cost centre, so accepting one here would
 * only defer the failure to the next order placed against the offering — at
 * which point the operator who misconfigured it is long gone.
 */
const validateOverheadCostCenter = async (
  overheadCostCenterId: number | null | undefined,
): Promise<Result<void>> => {
  if (overheadCostCenterId === undefined || overheadCostCenterId === null) return ok(undefined)

  const [cc] = await db
    .select({ active: costCenters.active })
    .from(costCenters)
    .where(eq(costCenters.id, overheadCostCenterId))
    .limit(1)

  if (!cc) return err(400, 'Overhead cost center not found')
  if (!cc.active) return err(400, 'Overhead cost center is not active')
  return ok(undefined)
}

export const createProductEnvironment = async (
  id: number,
  input: CreateProductEnvironmentInput,
): Promise<Result<ProductEnvironment>> => {
  const {
    environmentId,
    price = '0',
    currency = 'EUR',
    costCenterMode = 'project',
    forcedCostCenter = false,
    overheadCostCenterId = null,
    trialEnabled = false,
    trialDurationMinutes = 30,
  } = input

  const validated = await validateOverheadCostCenter(overheadCostCenterId)
  if (!validated.ok) return validated

  // A non-positive duration would schedule the teardown at or before the moment of
  // provisioning, so the trial would be swept away before it came up.
  if (trialEnabled && trialDurationMinutes <= 0) {
    return err(400, 'The trial duration must be at least one minute')
  }

  const values = {
    price, currency, costCenterMode, forcedCostCenter, overheadCostCenterId,
    trialEnabled, trialDurationMinutes,
  }

  // Read before the write so the version entry can say what actually changed
  // rather than just "saved".
  const [previous] = await db
    .select()
    .from(productEnvironments)
    .where(
      and(
        eq(productEnvironments.productId, id),
        eq(productEnvironments.environmentId, environmentId),
      ),
    )
    .limit(1)

  const [row] = await db
    .insert(productEnvironments)
    .values({ productId: id, environmentId, ...values })
    .onConflictDoUpdate({
      target: [productEnvironments.productId, productEnvironments.environmentId],
      set: values,
    })
    .returning()

  await recordProductVersion({
    productId: id,
    environmentId,
    summary: previous ? describeOfferingChange(previous, row) : 'Environment offered',
    changelog: input.changelog,
    userId: input.userId ?? null,
  })

  await logAudit(
    input.userId ?? null,
    previous ? 'product.offering_updated' : 'product.offering_added',
    id,
    `Environment #${environmentId}: ${changedFields(values)}`,
  )

  return ok(row)
}

/**
 * Name the fields that changed, for the history row's summary.
 *
 * A summary derived from the actual before/after rather than from which fields the
 * request happened to include: the admin form submits every field on every save, so
 * "what was sent" would report a change on every row every time.
 */
const describeOfferingChange = (
  before: ProductEnvironment,
  after: ProductEnvironment,
): string => {
  const fields: (keyof ProductEnvironment)[] = [
    'price', 'currency', 'costCenterMode', 'forcedCostCenter',
    'overheadCostCenterId', 'trialEnabled', 'trialDurationMinutes',
  ]
  const changed = fields.filter((f) => String(before[f] ?? '') !== String(after[f] ?? ''))
  return changed.length > 0 ? `Offering updated: ${changed.join(', ')}` : 'Offering saved (no change)'
}

export const updateProductEnvironment = async (
  id: number,
  envId: number,
  input: UpdateProductEnvironmentInput,
): Promise<Result<ProductEnvironment>> => {
  // `userId` is injected by the route, so the emptiness that matters is "no
  // column and no changelog" — a bare `{}` reached `.set({})` and 500'd.
  const { changelog: changelogOnly, userId: _actor, ...mutable } = input
  if (changelogOnly === undefined && isEmptyUpdate(mutable)) {
    return err(400, EMPTY_UPDATE_MESSAGE)
  }

  const validated = await validateOverheadCostCenter(input.overheadCostCenterId)
  if (!validated.ok) return validated

  if (input.trialDurationMinutes !== undefined && input.trialDurationMinutes <= 0) {
    return err(400, 'The trial duration must be at least one minute')
  }

  const [previous] = await db
    .select()
    .from(productEnvironments)
    .where(
      and(
        eq(productEnvironments.productId, id),
        eq(productEnvironments.environmentId, envId),
      ),
    )
    .limit(1)

  const { changelog, userId, ...columns } = input
  const [updated] = await db
    .update(productEnvironments)
    .set(columns)
    .where(
      and(
        eq(productEnvironments.productId, id),
        eq(productEnvironments.environmentId, envId),
      ),
    )
    .returning()

  if (!updated) return err(404, 'Not found')

  await recordProductVersion({
    productId: id,
    environmentId: envId,
    summary: previous ? describeOfferingChange(previous, updated) : 'Offering updated',
    changelog,
    userId: userId ?? null,
  })

  await logAudit(
    userId ?? null,
    'product.offering_updated',
    id,
    `Environment #${envId}: ${changedFields(columns)}`,
  )

  return ok(updated)
}

export const deleteProductEnvironment = async (
  id: number,
  envId: number,
  actorId?: number,
): Promise<Result<void>> => {
  // Refuse while infrastructure is still live in this environment. Unlike
  // deleteProduct there is no cascade to follow here — infrastructure_elements
  // references products/deployment_environments directly — so removing the
  // offering would silently strand running infra without the price, currency
  // and cost-centre config that its order was placed under. Decommission first.
  const liveInfra = await db
    .select({ id: infrastructureElements.id })
    .from(infrastructureElements)
    .where(
      and(
        eq(infrastructureElements.productId, id),
        eq(infrastructureElements.environmentId, envId),
        inArray(infrastructureElements.status, ['active', 'decommissioning']),
      ),
    )
    .limit(1)

  if (liveInfra.length) {
    return err(409, 'Infrastructure is still deployed in this environment — decommission it first')
  }

  const deleted = await db
    .delete(productEnvironments)
    .where(
      and(
        eq(productEnvironments.productId, id),
        eq(productEnvironments.environmentId, envId),
      ),
    )
    .returning({ productId: productEnvironments.productId })

  if (!deleted.length) return err(404, 'Not found')

  // Recorded without a snapshot: there is no offering left to capture, and the
  // withdrawal is exactly what a reader of the history needs to see.
  await recordProductVersion({
    productId: id,
    environmentId: null,
    summary: `Environment #${envId} withdrawn`,
    userId: null,
  })

  await logAudit(actorId ?? null, 'product.offering_withdrawn', id, `Environment #${envId} withdrawn`)

  return ok(undefined)
}

/**
 * Everything about a product webhook except its trigger token (issue #144).
 *
 * `webhook_token` is the credential that fires the pipeline; returning the whole
 * row handed it back in cleartext from list, create and update. `webhookTokenSet`
 * is what the admin UI actually needs — it renders the name and URL and nothing
 * else — and the token can still be replaced through updateProductWebhook. Same
 * shape as `ProductWebhook` in @open-hybrid-cloud/types, which never had the token
 * in it: the frontend was already typed against the secret-free row.
 */
const publicWebhookColumns = {
  id: productWebhooks.id,
  productId: productWebhooks.productId,
  environmentId: productWebhooks.environmentId,
  name: productWebhooks.name,
  webhookUrl: productWebhooks.webhookUrl,
  execOrder: productWebhooks.execOrder,
  webhookTokenSet: sql<boolean>`${productWebhooks.webhookToken} <> ''`,
}

export type PublicProductWebhook = Omit<ProductWebhook, 'webhookToken'> & {
  webhookTokenSet: boolean
}

export const listProductWebhooks = async (id: number): Promise<Result<PublicProductWebhook[]>> => {
  const rows = await db
    .select(publicWebhookColumns)
    .from(productWebhooks)
    .where(eq(productWebhooks.productId, id))
    .orderBy(productWebhooks.execOrder)

  return ok(rows)
}

export const createProductWebhook = async (
  id: number,
  input: CreateWebhookInput,
  actorId?: number,
): Promise<Result<PublicProductWebhook>> => {
  const [webhook] = await db
    .insert(productWebhooks)
    .values({ productId: id, ...input, execOrder: input.execOrder ?? 0 })
    .returning(publicWebhookColumns)

  // URL but not token: the URL is what an operator needs to recognise the hook,
  // the token is a credential.
  await logAudit(
    actorId ?? null,
    'product.webhook_added',
    id,
    `Webhook ${input.name} for environment #${input.environmentId} → ${input.webhookUrl}`,
  )

  return ok(webhook)
}

export const updateProductWebhook = async (
  id: number,
  whId: number,
  input: UpdateWebhookInput,
  actorId?: number,
): Promise<Result<PublicProductWebhook>> => {
  if (isEmptyUpdate(input)) return err(400, EMPTY_UPDATE_MESSAGE)

  const [updated] = await db
    .update(productWebhooks)
    .set(input)
    .where(and(eq(productWebhooks.id, whId), eq(productWebhooks.productId, id)))
    .returning(publicWebhookColumns)

  if (!updated) return err(404, 'Not found')

  // Field names only — `webhookToken` is one of them.
  await logAudit(actorId ?? null, 'product.webhook_updated', id, `Webhook #${whId}: ${changedFields(input)}`)

  return ok(updated)
}

export const deleteProductWebhook = async (
  id: number,
  whId: number,
  actorId?: number,
): Promise<Result<void>> => {
  const deleted = await db
    .delete(productWebhooks)
    .where(and(eq(productWebhooks.id, whId), eq(productWebhooks.productId, id)))
    .returning({ id: productWebhooks.id })

  if (!deleted.length) return err(404, 'Not found')

  await logAudit(actorId ?? null, 'product.webhook_deleted', id, `Webhook #${whId} deleted`)

  return ok(undefined)
}
