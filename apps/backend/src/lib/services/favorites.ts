import type { SessionUser } from '@open-hybrid-cloud/types'
import { db } from '@/lib/db/client'
import { productFavorites, products } from '@/lib/db/schema'
import { and, eq, sql } from 'drizzle-orm'
import { ok, err, type Result } from '@/lib/services/result'
import { productNameSql, productDescriptionSql } from '@/lib/services/productName'

export interface FavoriteProduct {
  productId: number
  categoryId: number
  name: string
  description: string
  /** Carried for the same reason the catalogue carries it: the card needs an alt text. */
  imageAlt: string | null
  createdAt: Date
}

/**
 * The caller's favourited products, resolved to catalogue rows.
 *
 * Returns the same name/description/imageAlt shape as the catalogue list,
 * translated with the same COALESCE fallback chain, so the favourites section can
 * render product cards without a second round trip per product — and without
 * needing the product to be on the catalogue page the browser happens to hold,
 * which is what paging the catalogue (#91) took away.
 */
export const listFavorites = async (
  session: SessionUser,
  lang: string,
): Promise<Result<FavoriteProduct[]>> => {
  const rows = await db
    .select({
      productId: productFavorites.productId,
      categoryId: products.categoryId,
      imageAlt: products.imageAlt,
      createdAt: productFavorites.createdAt,
      name: productNameSql(products.id, lang),
      description: productDescriptionSql(products.id, lang),
    })
    .from(productFavorites)
    // Inner join, not left: a favourite whose product is gone has nothing to
    // render. The FK cascades, so this only guards against a stale read.
    .innerJoin(products, eq(productFavorites.productId, products.id))
    .where(eq(productFavorites.userId, session.id))
    // Most recently favourited first — the section is a shortcut list, and what
    // a user just starred is what they are most likely reaching for.
    .orderBy(sql`${productFavorites.createdAt} DESC`)

  return ok(rows as FavoriteProduct[])
}

/**
 * Favourite a product for the caller.
 *
 * Idempotent: starring something already starred is a no-op success rather than a
 * conflict. The UI toggles optimistically, so a double-fire from an impatient
 * click must not surface as an error.
 */
export const addFavorite = async (
  session: SessionUser,
  productId: number,
): Promise<Result<void>> => {
  const [product] = await db
    .select({ id: products.id })
    .from(products)
    .where(eq(products.id, productId))
    .limit(1)
  if (!product) return err(404, 'Product not found')

  await db
    .insert(productFavorites)
    .values({ userId: session.id, productId })
    .onConflictDoNothing()

  return ok(undefined)
}

/**
 * Un-favourite a product for the caller. Idempotent for the same reason as
 * addFavorite — removing one that is already gone is the state the caller wanted.
 */
export const removeFavorite = async (
  session: SessionUser,
  productId: number,
): Promise<Result<void>> => {
  await db
    .delete(productFavorites)
    .where(
      and(
        eq(productFavorites.userId, session.id),
        eq(productFavorites.productId, productId),
      ),
    )

  return ok(undefined)
}
