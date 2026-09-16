import { db } from '@/lib/db/client'
import { countWhere } from '@/lib/db/queries'
import {
  products,
  productImages,
  productTranslations,
  productEnvironments,
  productWebhooks,
  deploymentEnvironments,
  categories,
  costCenters,
  infrastructureElements,
  parameters,
  orders,
  type Product,
  type ProductTranslation,
  type ProductEnvironment,
  type ProductWebhook,
  type Parameter,
} from '@/lib/db/schema'
import type { ProductImageMeta } from '@infrashelf/types'
import { count, eq, sql, and, inArray } from 'drizzle-orm'
import { translateProduct } from '@/lib/ai'
import { ok, err, type Result } from '@/lib/services/result'
import { fireDestroyTriggers, destroyVariables } from '@/lib/services/teardown'
import { recordProductVersion } from '@/lib/services/versions'
import { logAudit, logAuditWith, changedFields } from '@/lib/audit'
import { isEmptyUpdate, EMPTY_UPDATE_MESSAGE } from '@/lib/services/updates'
import {
  ALLOWED_IMAGE_MIMES,
  MAX_IMAGE_BYTES,
  detectImageMime,
} from '@/lib/services/imageUpload'
import { productNameSql, productDescriptionSql } from '@/lib/db/productText'

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
  /** Trust content shown on the product page (issue #107); null when unset. */
  owner: string | null
  docsUrl: string | null
  /**
   * When the product was taken out of the catalogue, or null while it is live.
   *
   * The admin list SHOWS retired products (#251) — it is the one place someone
   * needs to see them, because it is the only place they can be put back. The
   * catalogue keeps filtering them out.
   */
  retiredAt: Date | null
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
  /** Empty string clears it — the admin form has no other way to say "nobody". */
  owner?: string | null
  docsUrl?: string | null
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
  /** The long text the detail page shows (issue #107). Omitted leaves it unchanged. */
  longDescription?: string
}

/**
 * Built per call rather than once at module scope, because the name it selects
 * now depends on the admin's own language.
 *
 * Before #162 this selected `language_code = 'en'` flat, so the admin product
 * list showed nothing at all — not the base-language name, `null`, rendered by
 * the frontend as `Product #7` — for any product whose only translation was
 * German. Which was ordinary: the admin form offered four of the 25 languages.
 */
const adminProductSelect = (lang: string) => ({
  id: products.id,
  categoryId: products.categoryId,
  baseLanguage: products.baseLanguage,
  createdAt: products.createdAt,
  categoryName: categories.name,
  owner: products.owner,
  docsUrl: products.docsUrl,
  name: productNameSql(lang),
  description: productDescriptionSql(lang),
  retiredAt: products.retiredAt,
})

export const listProducts = async (lang = 'en'): Promise<Result<ProductAdminRow[]>> => {
  const rows = await db
    .select(adminProductSelect(lang))
    .from(products)
    .leftJoin(categories, eq(products.categoryId, categories.id))
    // No filter. Retired products belong on the ADMIN list — marked — because it
    // is the only screen from which they can be put back (#251). Hiding them here
    // was what made retirement a one-way trapdoor. `listCatalog` and `getProduct`
    // still filter, which is the filter that was always meant.
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

  await db
    .insert(productTranslations)
    .values({ productId: product.id, languageCode: baseLanguage, name, description })

  if (baseLanguage !== 'en') {
    await db
      .insert(productTranslations)
      .values({ productId: product.id, languageCode: 'en', name, description })
      .onConflictDoNothing()
  }

  await logAudit(
    actorId ?? null,
    'product.created',
    product.id,
    `Created product ${name} in category #${categoryId}`,
  )

  return ok({ ...product, name, description, categoryName: null } as ProductAdminRow)
}

export const getProductAdmin = async (id: number, lang = 'en'): Promise<Result<ProductAdminRow & { environments: ProductEnvironment[]; parameters: Parameter[] }>> => {
  const rows = await db
    .select(adminProductSelect(lang))
    .from(products)
    .leftJoin(categories, eq(products.categoryId, categories.id))
    // Retired products are editable (#251): fixing a product and putting it back
    // is one action in two steps, and a 404 in between makes it impossible.
    .where(eq(products.id, id))
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


/**
 * Keep an `en` row in step with the base language WITHOUT destroying a real
 * translation (#161).
 *
 * Ten read paths — the cart, the order list and detail, the infrastructure list
 * and search, the approvals queue, the cost report, the admin product list, the
 * order snapshot and the notification subject line — select
 * `language_code = 'en'` with no fallback. So an `en` row has to exist for every
 * product, whatever its base language, or those screens go blank.
 *
 * `createProduct` seeds one with `onConflictDoNothing`. `updateProduct` used to
 * refresh it with `onConflictDoUpdate`, which meant a typo fix in the German
 * name overwrote the English translation someone had written — silently, with no
 * version entry saying so, and visible only by opening the translations tab.
 * Because of those ten paths, the German string then showed to every user in
 * every language, and `snapshot.ts` froze it into `product_snapshot` for each new
 * order after that.
 *
 * The distinction that fixes it: is the `en` row still a MIRROR, or has someone
 * translated it? It is a mirror exactly while it still equals the base-language
 * text it was copied from. So:
 *
 *   - no `en` row yet          → insert the new text; the invariant needs a row
 *   - `en` field == old base   → still a mirror, move it along
 *   - `en` field != old base   → a translation. Leave it. It is not ours.
 *
 * Decided per FIELD, not per row: a product whose name was translated but whose
 * description never was should keep the name and still track the description.
 */
const mirrorIntoEnglish = async (
  productId: number,
  args: {
    updateData: Partial<{ name: string; description: string }>
    seed: { name: string; description: string }
    priorBase?: { name: string; description: string }
    priorEn?: { name: string; description: string }
  },
): Promise<void> => {
  const { updateData, seed, priorBase, priorEn } = args

  if (!priorEn) {
    // No row to protect. Seeding one is what keeps the ten `language_code = 'en'`
    // readers from showing an empty product name.
    await db
      .insert(productTranslations)
      .values({ productId, languageCode: 'en', name: seed.name, description: seed.description })
      .onConflictDoNothing()
    return
  }

  const stillMirrored: Partial<{ name: string; description: string }> = {}
  if (updateData.name !== undefined && priorEn.name === priorBase?.name) {
    stillMirrored.name = updateData.name
  }
  if (updateData.description !== undefined && priorEn.description === priorBase?.description) {
    stillMirrored.description = updateData.description
  }

  // Every field the caller changed has been translated. Nothing to mirror, and
  // an empty `set` is an error in the SQL rather than a no-op.
  if (Object.keys(stillMirrored).length === 0) return

  await db
    .update(productTranslations)
    .set(stillMirrored)
    .where(and(eq(productTranslations.productId, productId), eq(productTranslations.languageCode, 'en')))
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

  if (productFields.docsUrl !== undefined && productFields.docsUrl !== null) {
    const trimmed = productFields.docsUrl.trim()
    // Empty clears it; anything else has to be a link a browser will follow
    // safely, because the product page renders it as an href. `javascript:` and
    // `data:` URLs in an href are script execution, and an operator is not the
    // only person who can end up editing this field.
    if (trimmed === '') {
      productFields.docsUrl = null
    } else if (!/^https?:\/\//i.test(trimmed)) {
      return err(400, 'The documentation link must start with http:// or https://')
    } else {
      productFields.docsUrl = trimmed
    }
  }
  if (productFields.owner !== undefined && productFields.owner !== null) {
    const trimmed = productFields.owner.trim()
    productFields.owner = trimmed === '' ? null : trimmed
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
    const productRows = await db
      .select({ baseLanguage: products.baseLanguage })
      .from(products)
      .where(eq(products.id, id))
      .limit(1)

    const lang = productRows[0]?.baseLanguage ?? 'en'
    const updateData: Partial<{ name: string; description: string }> = {}
    if (name !== undefined) updateData.name = name
    if (description !== undefined) updateData.description = description

    // Read both rows BEFORE the base-language write, because deciding what to do
    // with the `en` mirror below needs the base text as it was, not as it is
    // about to become.
    const [priorBase, priorEn] = await Promise.all([
      db
        .select({ name: productTranslations.name, description: productTranslations.description })
        .from(productTranslations)
        .where(and(eq(productTranslations.productId, id), eq(productTranslations.languageCode, lang)))
        .limit(1),
      db
        .select({ name: productTranslations.name, description: productTranslations.description })
        .from(productTranslations)
        .where(and(eq(productTranslations.productId, id), eq(productTranslations.languageCode, 'en')))
        .limit(1),
    ])

    await db
      .insert(productTranslations)
      .values({ productId: id, languageCode: lang, name: name ?? '', description: description ?? '' })
      .onConflictDoUpdate({
        target: [productTranslations.productId, productTranslations.languageCode],
        set: updateData,
      })

    if (lang !== 'en') {
      await mirrorIntoEnglish(id, {
        updateData,
        seed: { name: name ?? '', description: description ?? '' },
        priorBase: priorBase[0],
        priorEn: priorEn[0],
      })
    }
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
  if (input.owner !== undefined) changed.push('owner')
  if (input.docsUrl !== undefined) changed.push('documentation link')
  return changed.length > 0 ? `Product updated: ${changed.join(', ')}` : 'Product updated'
}

/**
 * Take a product out of the catalogue, or put it back (#251).
 *
 * `retiredAt` already meant exactly "not in the catalogue" — it was simply not a
 * control anyone could reach. Nothing set it deliberately (it was a side effect
 * of `deleteProduct` refusing to destroy order history), nothing cleared it, and
 * the admin screens hid what it marked. A root administrator who pressed Delete
 * on a product that had ever been ordered got it withdrawn, removed from every
 * admin list, and no way back short of a database update.
 *
 * So: the same column, both directions, said out loud. No migration, and
 * deliberately no second boolean beside it — two columns meaning "not in the
 * catalogue" is the drift this repo has a policy rule against, and this one is
 * load-bearing for #142's order history.
 *
 * Offerings, cart lines and favourites are left alone in BOTH directions. That is
 * what makes it reversible in any useful sense: a product put back is the product
 * it was, at the price it was. What stops it being ordered meanwhile is the flag
 * itself, checked in `addToCart` and `prepareOrder`.
 */
export const setProductRetired = async (
  id: number,
  retired: boolean,
  actorId?: number,
): Promise<Result<{ retiredAt: Date | null }>> => {
  // Under a row lock, and the current state re-read inside it: two admins hitting
  // Disable and Enable at once would otherwise both succeed, and the audit log
  // would record two changes where the second is a no-op or, worse, record
  // "enabled" for a product that ended up disabled.
  return db.transaction(async (tx): Promise<Result<{ retiredAt: Date | null }>> => {
    const [locked] = await tx
      .select({ id: products.id, retiredAt: products.retiredAt })
      .from(products)
      .where(eq(products.id, id))
      .for('update')
      .limit(1)
    if (!locked) return err(404, 'Not found')

    // Already in the asked-for state. Not an error — the caller wanted it
    // disabled and it is disabled — but not an audit entry either.
    if ((locked.retiredAt !== null) === retired) return ok({ retiredAt: locked.retiredAt })

    const retiredAt = retired ? new Date() : null
    await tx.update(products).set({ retiredAt }).where(eq(products.id, id))

    await logAuditWith(
      tx,
      actorId ?? null,
      retired ? 'product.disabled' : 'product.enabled',
      id,
      retired
        ? 'Product withdrawn from the catalogue; offerings and order history kept'
        : 'Product returned to the catalogue',
    )

    return ok({ retiredAt })
  })
}

export const deleteProduct = async (id: number, actorId?: number): Promise<Result<void>> => {
  /*
   * By id, and NOT `AND retired_at IS NULL` — the same rule as the lock at the
   * end of this function, which has always been written that way.
   *
   * This used to filter on the flag, under the reasoning that "an already-
   * retired product is gone from every screen, so asking to delete it again is
   * a 404 like any other missing product". #251 ended that: `retired_at` became
   * a reversible Disable, so a disabled product is listed in the admin screens
   * with an Enable button beside a Delete button — and Delete answered "Not
   * found" every time, with no other way to remove it (#312).
   *
   * The two halves of this function disagreed and the one that runs first won.
   * They agree now, on the answer the second half already documented: an
   * ordered product ends up retired either way, and an unordered one is
   * deleted, which is what a root asking to delete a product with no history
   * asked for.
   */
  const existing = await db
    .select({ id: products.id })
    .from(products)
    .where(eq(products.id, id))
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
    .select({ id: infrastructureElements.id, orderId: infrastructureElements.orderId, productId: infrastructureElements.productId, environmentId: infrastructureElements.environmentId, parameters: infrastructureElements.parameters, sequence: infrastructureElements.sequence, sizeCode: infrastructureElements.sizeCode, stateKeyNamespace: infrastructureElements.stateKeyNamespace, stateKeys: infrastructureElements.stateKeys })
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
      // The id was already on the next line, pushed into `triggerFailures`, and
      // missing from the log (#482). A destroy that could not be STARTED is how a
      // machine outlives the product it belonged to, so the line has to say which one.
      console.error(`[destroy] Could not start the destroy for element #${infra.id}:`, e)
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
    /*
     * Locked on the id ALONE — deliberately not `AND retired_at IS NULL`, which
     * is what the pre-check at the top of this function uses.
     *
     * #251 gave retirement a second writer, `setProductRetired`, and it does
     * not hold this lock while the destroy triggers above are running. So a
     * root who disables the product in that window used to turn this select
     * into a miss, and the delete answered 404 — after it had already claimed
     * every infrastructure row and started tearing them down. The caller was
     * told nothing happened while the installation was being decommissioned.
     *
     * Matching on the id makes the two orderings agree instead: whoever set the
     * flag, the decision below is the same one this call came to make. An
     * ordered product ends up retired either way, and an unordered one is
     * deleted, which is what a root asking to delete a product with no history
     * asked for.
     *
     * This does not make retirement and deletion mutually exclusive — the
     * triggers still fire before any lock is held, and an Enable that commits
     * after this transaction would leave the product available with its
     * infrastructure gone. Closing that needs a deletion-in-progress state on
     * the row, which is a larger change than this one; what it does close is
     * the case where destruction happens and the answer says it did not.
     */
    const locked = await tx
      .select({ id: products.id })
      .from(products)
      .where(eq(products.id, id))
      .for('update')
      .limit(1)
    if (!locked.length) return err(404, 'Not found')

    // Counted by Postgres rather than selected and measured: the figure is exact
    // because the audit entry below quotes it, but a popular product has as many
    // rows here as it has ever had orders and none of them are otherwise read.
    const orderCount = await countWhere(tx.select({ n: count() }).from(orders).where(eq(orders.productId, id)))

    if (orderCount > 0) {
      // The flag, and NOTHING else (#251).
      //
      // This used to withdraw every offering as well, because the flag only kept
      // the product out of the catalogue's reads and the missing
      // product_environments row was what actually made it unorderable. That made
      // retirement destructive and therefore irreversible: price, currency and
      // cost-centre mode were gone, with nothing to restore them from — so
      // pressing Delete on an ordered product silently destroyed its pricing and
      // there was no way back.
      //
      // `retiredAt` is now the check itself, in `addToCart` and `prepareOrder`.
      // Retiring is reversible, the offerings survive it, and a product put back
      // is the product it was.
      //
      // The infrastructure_elements rows are left in place, unlike the old cascade:
      // they are mid-decommission, and their pipelines report back to the callback
      // that reconciles them. That is what the note above wished for.
      await tx.update(products).set({ retiredAt: new Date() }).where(eq(products.id, id))

      // On the transaction's own connection, so it rolls back with the retirement.
      await logAuditWith(
        tx,
        actorId ?? null,
        'product.retired',
        id,
        `Retired product (${orderCount} order(s) keep their history), decommissioning ${activeInfra.length} infrastructure element(s)`,
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

/**
 * How many pictures one product may have.
 *
 * A cap rather than none: every gallery image is bytea in the same row set the
 * catalogue reads, the detail page carries all of their descriptions in its
 * payload, and a thumbnail strip stops being navigable long before a hundred.
 */
export const MAX_IMAGES_PER_PRODUCT = 8

/** Validate an image description the way #105 requires it. */
const cleanAlt = (alt: string): Result<string> => {
  // Required, not optional: an empty alt is a claim that the picture carries no
  // information, and only the person uploading it can make that claim. Every
  // component that renders it used to decide for itself — the catalogue tile and
  // the cart thumbnail passed "", the product page passed the product name.
  const description = alt.trim()
  if (description === '') return err(400, 'An image description is required')
  if (description.length > MAX_IMAGE_ALT_LENGTH) {
    return err(400, `The image description must be at most ${MAX_IMAGE_ALT_LENGTH} characters`)
  }
  return ok(description)
}

/** The gallery as the admin UI lists it: order, ids and descriptions, no bytes. */
export const listProductImages = async (
  productId: number,
): Promise<Result<(ProductImageMeta & { position: number; mime: string })[]>> => {
  const [product] = await db
    .select({ id: products.id })
    .from(products)
    .where(eq(products.id, productId))
    .limit(1)
  if (!product) return err(404, 'Product not found')

  const rows = await db
    .select({
      id: productImages.id,
      alt: productImages.alt,
      position: productImages.position,
      mime: productImages.mime,
    })
    .from(productImages)
    .where(eq(productImages.productId, productId))
    .orderBy(productImages.position, productImages.id)

  return ok(rows)
}

/**
 * Append a picture to a product's gallery.
 *
 * Appends rather than replaces, which is the whole point of #107: the single
 * `PUT .../image` this replaced could only ever overwrite, so a product could
 * never have a second picture.
 */
export const addProductImage = async (
  productId: number,
  buffer: Buffer,
  alt: string,
  actorId?: number,
): Promise<Result<{ id: number; mime: string; position: number }>> => {
  const described = cleanAlt(alt)
  if (!described.ok) return described

  if (buffer.length === 0) return err(400, 'The uploaded file is empty')
  if (buffer.length > MAX_IMAGE_BYTES) {
    return err(413, `Image is larger than ${MAX_IMAGE_BYTES / (1024 * 1024)} MB`)
  }

  const mime = detectImageMime(buffer)
  if (mime === null) {
    return err(415, `Unsupported image type — allowed: ${ALLOWED_IMAGE_MIMES.join(', ')}`)
  }

  // The cap check, the next position and the INSERT run in one transaction under a
  // FOR UPDATE lock on the product row, so concurrent uploads to the same gallery
  // queue instead of both reading the same COUNT/MAX. Without it two uploads to a
  // product at the cap minus one both saw room and both took the same position,
  // leaving nine images and two of them claiming to be position 8.
  //
  // A lock rather than the conditional single-statement write used elsewhere in
  // this codebase (the TOTP guards, the delegation revoke): a conditional write
  // serialises because the row it claims already exists and Postgres re-evaluates
  // the predicate against the updated row. Here the write is an INSERT and the
  // invariant spans a *set* of rows, which no row-level predicate can guard — even
  // `INSERT ... SELECT ... HAVING COUNT(*) < n` reads its snapshot before either
  // writer is visible to the other.
  return db.transaction(async (tx): Promise<Result<{ id: number; mime: string; position: number }>> => {
    const [product] = await tx
      .select({ id: products.id })
      .from(products)
      .where(eq(products.id, productId))
      .for('update')
      .limit(1)
    // Checked explicitly: an INSERT with a bad FK raises a driver error, which the
    // route would report as a 500 rather than "no such product".
    if (!product) return err(404, 'Product not found')

    const [counted] = await tx
      .select({
        count: sql<number>`COUNT(*)::int`,
        maxPosition: sql<number | null>`MAX(${productImages.position})`,
      })
      .from(productImages)
      .where(eq(productImages.productId, productId))

    if (counted.count >= MAX_IMAGES_PER_PRODUCT) {
      return err(409, `A product may have at most ${MAX_IMAGES_PER_PRODUCT} images`)
    }

    const position = counted.maxPosition === null ? 0 : counted.maxPosition + 1

    const [row] = await tx
      .insert(productImages)
      .values({ productId, position, data: buffer, mime, alt: described.data })
      .returning({ id: productImages.id })

    // Through `tx`, like every other write in here: an entry written on the pool
    // would survive a rollback and claim an upload that never landed. The
    // description itself stays out of the entry — the audit log records which
    // picture was added, not what an operator typed about it.
    await logAuditWith(
      tx,
      actorId ?? null,
      'product.image_added',
      productId,
      `Image #${row.id} added at position ${position} (${mime}, ${buffer.length} bytes)`,
    )

    return ok({ id: row.id, mime, position })
  })
}

/** Change one picture's description without re-uploading it. */
export const updateProductImageAlt = async (
  productId: number,
  imageId: number,
  alt: string,
  actorId?: number,
): Promise<Result<void>> => {
  const described = cleanAlt(alt)
  if (!described.ok) return described

  const updated = await db
    .update(productImages)
    .set({ alt: described.data })
    .where(and(eq(productImages.id, imageId), eq(productImages.productId, productId)))
    .returning({ id: productImages.id })

  if (updated.length === 0) return err(404, 'Image not found')

  // The new description is not in the entry: names, not values (see `logAudit`).
  await logAudit(actorId ?? null, 'product.image_alt_updated', productId, `Image #${imageId}: description changed`)

  return ok(undefined)
}

/**
 * Remove one picture and close the gap it leaves.
 *
 * Positions are re-packed so they stay dense: a reorder sends the ids it wants in
 * the order it wants them, and a hole would make "position 3" mean two different
 * things to the two operations.
 */
export const deleteProductImage = async (
  productId: number,
  imageId: number,
  actorId?: number,
): Promise<Result<void>> => {
  return db.transaction(async (tx): Promise<Result<void>> => {
    // The same product-row lock `addProductImage` takes, for the same reason: at
    // READ COMMITTED a concurrent gallery mutation is invisible until it commits,
    // so a re-pack computed from this snapshot can write positions that were
    // already stale when it read them. Locking one row serialises every gallery
    // mutation for that product and nothing else.
    const [locked] = await tx
      .select({ id: products.id })
      .from(products)
      .where(eq(products.id, productId))
      .for('update')
      .limit(1)
    if (!locked) return err(404, 'Product not found')

    const deleted = await tx
      .delete(productImages)
      .where(and(eq(productImages.id, imageId), eq(productImages.productId, productId)))
      .returning({ id: productImages.id })

    if (deleted.length === 0) return err(404, 'Image not found')

    const remaining = await tx
      .select({ id: productImages.id })
      .from(productImages)
      .where(eq(productImages.productId, productId))
      .orderBy(productImages.position, productImages.id)

    for (const [index, row] of remaining.entries()) {
      await tx.update(productImages).set({ position: index }).where(eq(productImages.id, row.id))
    }

    // Inside the transaction that re-packs the positions, so the entry cannot
    // outlive a rollback. Position 0 is the picture the catalogue leads with, so
    // deleting it promotes the next one — worth saying in the entry, because that
    // is a visible change to a product nobody explicitly asked for.
    await logAuditWith(
      tx,
      actorId ?? null,
      'product.image_deleted',
      productId,
      `Image #${imageId} removed, ${remaining.length} image(s) left`,
    )

    return ok(undefined)
  })
}

/**
 * Put a product's gallery into the given order.
 *
 * The caller sends every image id exactly once, not a partial list: a reorder of a
 * subset has no single correct interpretation, and refusing it here means the
 * admin UI cannot half-apply one from a gallery it loaded before somebody else
 * added a picture.
 */
export const reorderProductImages = async (
  productId: number,
  order: number[],
  actorId?: number,
): Promise<Result<void>> => {
  return db.transaction(async (tx): Promise<Result<void>> => {
    // The same product-row lock `addProductImage` takes, for the same reason: at
    // READ COMMITTED a concurrent gallery mutation is invisible until it commits,
    // so a re-pack computed from this snapshot can write positions that were
    // already stale when it read them. Locking one row serialises every gallery
    // mutation for that product and nothing else. It also answers the question an
    // empty gallery cannot: no rows means either an unknown product or a real one
    // with no pictures, and those owe different answers.
    const [locked] = await tx
      .select({ id: products.id })
      .from(products)
      .where(eq(products.id, productId))
      .for('update')
      .limit(1)
    if (!locked) return err(404, 'Product not found')

    const rows = await tx
      .select({ id: productImages.id })
      .from(productImages)
      .where(eq(productImages.productId, productId))

    const known = new Set(rows.map((row) => row.id))
    const requested = new Set(order)

    if (requested.size !== order.length) {
      return err(400, 'The new order repeats an image')
    }
    if (requested.size !== known.size || [...requested].some((id) => !known.has(id))) {
      return err(400, 'The new order must list every image of this product exactly once')
    }

    for (const [index, id] of order.entries()) {
      await tx.update(productImages).set({ position: index }).where(eq(productImages.id, id))
    }

    // Written through `tx` with the position updates: a refused reorder rolls the
    // whole thing back, and an entry claiming one would be a lie.
    await logAuditWith(
      tx,
      actorId ?? null,
      'product.images_reordered',
      productId,
      `Gallery reordered (${order.length} image(s))`,
    )

    return ok(undefined)
  })
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
  // Only the fields the caller actually sent are overwritten: the AI translator
  // and the admin form both write name+description without knowing about the long
  // text, and an absent key must not blank out prose somebody wrote by hand.
  const set: Partial<{ name: string; description: string; longDescription: string }> = {
    name: input.name,
    description: input.description ?? '',
  }
  if (input.longDescription !== undefined) set.longDescription = input.longDescription

  const [row] = await db
    .insert(productTranslations)
    .values({
      productId: id,
      languageCode: lang,
      name: input.name,
      description: input.description ?? '',
      longDescription: input.longDescription ?? '',
    })
    .onConflictDoUpdate({
      target: [productTranslations.productId, productTranslations.languageCode],
      set,
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
  /*
   * Refuse while infrastructure is still live in this environment. Unlike
   * deleteProduct there is no cascade to follow here — infrastructure_elements
   * references products/deployment_environments directly — so removing the
   * offering would silently strand running infra without the price, currency and
   * cost-centre config that its order was placed under. Decommission first.
   *
   * Both statements in ONE transaction, with the offering row locked FOR UPDATE
   * (issue #188). This used to read, decide, and then delete unconditionally: an
   * approval inserting an element between the two withdrew the offering out from
   * under running infrastructure — exactly what the 409 exists to prevent. The
   * lock is what provisioning contends on, so the check and the delete see the
   * same world.
   */
  return await db.transaction(async (tx): Promise<Result<void>> => {
    const [offering] = await tx
      .select({ productId: productEnvironments.productId })
      .from(productEnvironments)
      .where(and(
        eq(productEnvironments.productId, id),
        eq(productEnvironments.environmentId, envId),
      ))
      .for('update')
      .limit(1)

    if (!offering) return err(404, 'Not found')

    const liveInfra = await tx
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

    await tx
      .delete(productEnvironments)
      .where(and(
        eq(productEnvironments.productId, id),
        eq(productEnvironments.environmentId, envId),
      ))

    // Recorded without a snapshot: there is no offering left to capture, and the
    // withdrawal is exactly what a reader of the history needs to see.
    await recordProductVersion({
      productId: id,
      environmentId: null,
      summary: `Environment #${envId} withdrawn`,
      userId: null,
    })

    // On the transaction's connection, so it rolls back with the withdrawal.
    await logAuditWith(tx, actorId ?? null, 'product.offering_withdrawn', id, `Environment #${envId} withdrawn`)

    return ok(undefined)
  })
}

/**
 * Everything about a product webhook except its trigger token (issue #144).
 *
 * `webhook_token` is the credential that fires the pipeline; returning the whole
 * row handed it back in cleartext from list, create and update. `webhookTokenSet`
 * is what the admin UI actually needs — it renders the name and URL and nothing
 * else — and the token can still be replaced through updateProductWebhook. Same
 * shape as `ProductWebhook` in @infrashelf/types, which never had the token
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
