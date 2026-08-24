import { Column, getTableName, is, sql, type SQL } from 'drizzle-orm'

/**
 * The language a record — as opposed to a screen — is written in.
 *
 * Notification mail is composed entirely in English ("Order #12 Created — …"),
 * and nothing records which language a recipient reads: `users` has no language
 * column, and the only signal the app ever has is the request that a browser made,
 * which no background job or webhook callback has. So the product name in a mail
 * resolves with English at the head of the chain — the rest of the sentence around
 * it is English too — and the fallback below is what stops a German-only product
 * arriving as `Product #7`.
 */
export const RECORD_LANGUAGE = 'en'

/**
 * A column reference that stays qualified wherever it is interpolated.
 *
 * Drizzle renders a column in a `sql` template UNQUALIFIED (`"product_id"`, not
 * `"orders"."product_id"`) whenever the query selects from exactly one table —
 * `buildSelection` treats a single-table select as unambiguous. Inside a
 * correlated subquery over `product_translations` that is not merely ugly, it is
 * wrong: `WHERE pt.product_id = "product_id"` binds the bare name to the SUBQUERY's
 * table first, and `product_translations.product_id` exists, so the predicate
 * becomes `pt.product_id = pt.product_id` and the subquery silently stops being
 * correlated — every product resolves to the same arbitrary name.
 *
 * The chain the catalogue shipped with survived that only because it correlated on
 * `products.id` and `product_translations` happens to have no `id` column, so the
 * bare name fell through to the outer scope. That is one added column away from
 * breaking, and it produces no error when it does. Qualifying here removes the
 * coincidence from the load-bearing path.
 */
const qualified = (productId: Column | SQL): SQL =>
  is(productId, Column)
    ? sql`${sql.identifier(getTableName(productId.table))}.${sql.identifier(productId.name)}`
    : productId

/**
 * One translated product field, with the four-step fallback FA-12.3 asks for:
 * the requested language, then English, then German, then whatever translation
 * exists.
 *
 * The final step is ordered by language code rather than left to whichever row
 * Postgres returns first, so that `name` and `description` of a product with
 * neither English nor German fall back to the SAME language. Unordered, a
 * French-and-Polish product could render a French title over a Polish body.
 *
 * `product_translations` is aliased and every reference to it qualified, so that
 * neither this subquery's columns nor the caller's can be captured by the other
 * scope — see `qualified`.
 */
const translatedField = (
  field: 'name' | 'description',
  productId: Column | SQL,
  lang: string,
): SQL[] => {
  const id = qualified(productId)
  const pick = (where: SQL) =>
    sql`(SELECT pt.${sql.identifier(field)} FROM product_translations pt WHERE pt.product_id = ${id}${where} ORDER BY pt.language_code LIMIT 1)`
  return [
    pick(sql` AND pt.language_code = ${lang}`),
    pick(sql` AND pt.language_code = 'en'`),
    pick(sql` AND pt.language_code = 'de'`),
    pick(sql``),
  ]
}

/**
 * The product's name in `lang`, as SQL.
 *
 * Written once and shared by every read path that names a product, because the
 * alternative is what issue #162 documents: three implementations of one lookup,
 * of which only the catalogue's honoured the requested language, so a German user
 * browsed *Virtuelle Maschine* and then found *Virtual Machine* in their own cart.
 *
 * NULL only for a product with no translation row at all, which
 * `createProduct` cannot produce. Callers that render the value keep their
 * `?? 'Product #id'` fallback for rows that predate the constraint.
 */
export const productNameSql = (productId: Column | SQL, lang: string): SQL<string | null> =>
  sql<string | null>`COALESCE(${sql.join(translatedField('name', productId, lang), sql`, `)})`

/** The same for the description, which callers type as non-null — hence the `''`. */
export const productDescriptionSql = (productId: Column | SQL, lang: string): SQL<string> =>
  sql<string>`COALESCE(${sql.join(translatedField('description', productId, lang), sql`, `)}, '')`
