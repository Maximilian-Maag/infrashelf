import { db } from '@/lib/db/client'
import { products, productEnvironments, deploymentEnvironments, costCenters, parameters, type Parameter } from '@/lib/db/schema'
import { eq, or, and, isNull, sql } from 'drizzle-orm'
import { ok, err, type Result } from '@/lib/services/result'
import { withoutSensitiveDefaults } from '@/lib/services/parameterRedaction'
import { productNameSql, productDescriptionSql } from '@/lib/services/productName'
import { safeImageContentType } from '@/lib/services/imageUpload'
import { listActiveSizesForProduct } from '@/lib/services/sizes'

/**
 * Load the parameter definitions that apply to a product in a given
 * environment. Merges the global-, category- and product-scoped rows from the
 * `parameters` table and filters by environment (env-specific rows plus rows
 * that apply to every environment, i.e. environment_id IS NULL).
 *
 * Shared by the catalog (to render the order form) and the order service (to
 * validate submitted parameters server-side) so both agree on which
 * definitions are in scope.
 */
export const loadApplicableParameters = async (
  productId: number,
  categoryId: number,
  environmentId?: number,
): Promise<Parameter[]> => {
  const scopeWhere = or(
    eq(parameters.scope, 'global'),
    and(eq(parameters.scope, 'category'), eq(parameters.scopeId, categoryId)),
    and(eq(parameters.scope, 'product'), eq(parameters.scopeId, productId)),
  )

  const paramWhere =
    environmentId !== undefined
      ? and(
          scopeWhere,
          or(sql`${parameters.environmentId} IS NULL`, eq(parameters.environmentId, environmentId)),
        )
      : scopeWhere

  return db.select().from(parameters).where(paramWhere)
}

/**
 * Collapse the applicable rows to one definition per parameter name, applying
 * scope precedence (product > category > global) and preferring an
 * environment-specific row over an all-environments (NULL) row. This is the
 * effective definition a submitted value is validated against.
 */
export const resolveParameterDefs = (rows: Parameter[]): Parameter[] => {
  const scopeRank: Record<string, number> = { global: 0, category: 1, product: 2 }
  const byName = new Map<string, Parameter>()

  for (const row of rows) {
    const current = byName.get(row.name)
    if (!current) {
      byName.set(row.name, row)
      continue
    }
    const moreSpecificScope = scopeRank[row.scope] > scopeRank[current.scope]
    const sameScopeButEnvSpecific =
      scopeRank[row.scope] === scopeRank[current.scope] &&
      row.environmentId !== null &&
      current.environmentId === null
    if (moreSpecificScope || sameScopeButEnvSpecific) {
      byName.set(row.name, row)
    }
  }

  return [...byName.values()]
}

/**
 * Resolve without knowing the environment yet: collapse duplicates WITHIN each
 * environment scope, but never across environments.
 *
 * `resolveParameterDefs` keys purely by name, which is correct once an
 * environment is known but destructive when it isn't — an env-A override would
 * out-rank the all-environments definition of the same name and then be
 * filtered out again for env B, so the form would render no control for a
 * parameter `createOrder` still validates (and may require) for env B.
 * Resolving per environment keeps one candidate per (name, environment); the
 * client narrows to the selected environment by refetching with `environmentId`
 * so what it renders is exactly what the order service resolves.
 */
export const resolveParameterDefsPerEnvironment = (rows: Parameter[]): Parameter[] => {
  const byEnvironment = new Map<number | null, Parameter[]>()
  for (const row of rows) {
    const group = byEnvironment.get(row.environmentId)
    if (group) group.push(row)
    else byEnvironment.set(row.environmentId, [row])
  }
  return [...byEnvironment.values()].flatMap((group) => resolveParameterDefs(group))
}

export interface CatalogItem {
  id: number
  categoryId: number
  baseLanguage: string
  createdAt: Date
  /** Required alongside an image (#105); null on a product that has none. */
  imageAlt: string | null
  name: string
  description: string
}

export interface ProductDetail extends CatalogItem {
  environments: unknown[]
  parameters: unknown[]
}

/** Page size when the caller does not ask for one — a full grid on the catalogue page. */
export const CATALOG_DEFAULT_LIMIT = 24
/** Ceiling on what one request may ask for, so `limit=100000` cannot be a denial of service. */
export const CATALOG_MAX_LIMIT = 100

export interface CatalogFilters {
  /** Free text matched against the product's translated name and description. */
  search?: string
  categoryId?: number
  limit?: number
  offset?: number
}

export interface CatalogPage {
  items: CatalogItem[]
  /** Rows matching the filters, ignoring the page window — what the UI counts. */
  total: number
  limit: number
  offset: number
}

/**
 * Escape a search term for use inside a LIKE pattern.
 *
 * Without this, a user searching for `50%` matches everything and one for `a_b`
 * matches `axb` — the wildcards are the user's own text, not their intent.
 * Backslash is LIKE's default escape character, so escaping it first matters.
 */
const likePattern = (search: string): string => `%${search.replace(/[\\%_]/g, (c) => `\\${c}`)}%`

/**
 * The catalogue, filtered and paged in the database.
 *
 * It used to load every product and filter in JavaScript — in the service for
 * `search`, and again in the browser, which passed neither parameter and filtered
 * the whole list a third time. That was fine for a handful of products and got
 * steadily worse: the entire catalogue crossed the wire on every visit, and the
 * filter could not use anything the database knew (issue #91).
 *
 * `search` matches the same translated expressions the row displays, so a hit is
 * always visibly explicable — the convention `listInfrastructure` follows for the
 * same reason.
 */
export const listCatalog = async (
  lang: string,
  filters: CatalogFilters = {},
): Promise<Result<CatalogPage>> => {
  const limit = Math.min(filters.limit ?? CATALOG_DEFAULT_LIMIT, CATALOG_MAX_LIMIT)
  const offset = filters.offset ?? 0

  // Built once and used in both the SELECT and the WHERE: searching against a
  // different expression than the one displayed is how a search result becomes
  // inexplicable.
  const nameSql = productNameSql(products.id, lang)
  const descriptionSql = productDescriptionSql(products.id, lang)

  // Retired products stay in the table as the referent their orders need
  // (products.retiredAt, issue #142) and must never appear in the catalogue.
  const conditions: ReturnType<typeof sql>[] = [sql`${products.retiredAt} IS NULL`]
  if (filters.categoryId !== undefined) {
    conditions.push(sql`${products.categoryId} = ${filters.categoryId}`)
  }
  if (filters.search) {
    const pattern = likePattern(filters.search)
    // ILIKE rather than lower(...) LIKE: it is the same case-insensitive match
    // and it reads as what it is.
    conditions.push(sql`(${nameSql} ILIKE ${pattern} OR ${descriptionSql} ILIKE ${pattern})`)
  }
  const where = conditions.length > 0 ? sql.join(conditions, sql` AND `) : undefined

  const rows = await db
    .select({
      id: products.id,
      categoryId: products.categoryId,
      baseLanguage: products.baseLanguage,
      createdAt: products.createdAt,
      // Carried with the product so every component that renders the picture uses
      // the description its uploader wrote, instead of inventing one.
      imageAlt: products.imageAlt,
      name: nameSql,
      description: descriptionSql,
    })
    .from(products)
    .where(where)
    .orderBy(products.id)
    .limit(limit)
    .offset(offset)

  // Counted separately rather than with a window function: a page past the end of
  // the result set returns no rows, and "no rows" must not be reported as
  // "nothing matched".
  const [counted] = await db
    .select({ total: sql<number>`COUNT(*)::int` })
    .from(products)
    .where(where)

  return ok({
    items: rows as CatalogItem[],
    total: counted?.total ?? 0,
    limit,
    offset,
  })
}

export const getProduct = async (
  productId: number,
  lang: string,
  environmentId?: number,
): Promise<Result<ProductDetail>> => {
  const productRows = await db
    .select({
      id: products.id,
      categoryId: products.categoryId,
      baseLanguage: products.baseLanguage,
      createdAt: products.createdAt,
      // Carried with the product so every component that renders the picture uses
      // the description its uploader wrote, instead of inventing one.
      imageAlt: products.imageAlt,
      name: productNameSql(products.id, lang),
      description: productDescriptionSql(products.id, lang),
    })
    .from(products)
    // A retired product is gone as far as the shop is concerned, even though the
    // row survives for its orders (issue #142).
    .where(and(eq(products.id, productId), isNull(products.retiredAt)))
    .limit(1)

  if (!productRows.length) return err(404, 'Product not found')

  const product = productRows[0]

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
      environmentName: deploymentEnvironments.name,
      // Resolved for display: in `overhead` mode the order form shows which
      // shared account the order will be billed to instead of a picker.
      overheadCostCenterName: costCenters.name,
    })
    .from(productEnvironments)
    .leftJoin(
      deploymentEnvironments,
      eq(productEnvironments.environmentId, deploymentEnvironments.id),
    )
    .leftJoin(
      costCenters,
      eq(productEnvironments.overheadCostCenterId, costCenters.id),
    )
    .where(eq(productEnvironments.productId, productId))

  // The sizes of every offering in one query, attached to their environment. The
  // buy box and the order form both need them per environment, and a query per
  // environment is how a three-environment product becomes four round trips.
  // Sizes are the price list now (issue #98): an offering with none keeps its own
  // `price`, which is what every offering that predates sizing has.
  const sizesByEnvironment = await listActiveSizesForProduct(productId)

  const paramRows = await loadApplicableParameters(productId, product.categoryId, environmentId)

  // Collapse to one effective definition per name (scope + env precedence) so
  // the order form renders exactly the controls the order service will
  // validate against — raw rows can carry same-name duplicates from different
  // scopes, which would render overridden/duplicate controls.
  //
  // Only collapse across environments once one is actually selected: the
  // catalog page loads this endpoint with no environment (the user picks it in
  // the order form afterwards), and collapsing then would drop definitions that
  // still apply to the environment they end up choosing.
  const resolved =
    environmentId !== undefined
      ? resolveParameterDefs(paramRows)
      : resolveParameterDefsPerEnvironment(paramRows)

  // Redacted HERE and not in `loadApplicableParameters`: the order service shares
  // that loader to validate a submission and needs the real default to apply it
  // for an omitted optional parameter. This is the way OUT (issue #131).
  const environments = envRows.map((env) => ({
    ...env,
    sizes: sizesByEnvironment.get(env.environmentId) ?? [],
  }))

  return ok({
    ...product,
    environments,
    parameters: withoutSensitiveDefaults(resolved),
  } as ProductDetail)
}

export const getProductImage = async (
  productId: number,
): Promise<Result<{ data: Buffer; mime: string; alt: string | null } | null>> => {
  const rows = await db
    .select({ image: products.image, imageMime: products.imageMime, imageAlt: products.imageAlt })
    .from(products)
    .where(eq(products.id, productId))
    .limit(1)

  if (!rows.length) return err(404, 'Product not found')
  if (!rows[0].image) return ok(null)

  // Rows written before the mime type was recorded fall back to PNG, which is
  // what this route claimed for every image regardless of what it was.
  //
  // Then clamped to an allowed image type on the way out as well as on the way in:
  // a row written before the upload path sniffed the bytes can still hold whatever
  // type its uploader declared, and this blob is echoed straight back as a
  // Content-Type. Anything unrecognised becomes an opaque download.
  return ok({
    data: rows[0].image,
    mime: safeImageContentType(rows[0].imageMime ?? 'image/png'),
    alt: rows[0].imageAlt,
  })
}
