import { db } from '@/lib/db/client'
import { products, productImages, productEnvironments, deploymentEnvironments, costCenters, parameters, type Parameter } from '@/lib/db/schema'
import { eq, or, and, isNull, sql, getTableColumns } from 'drizzle-orm'
import { ok, err, type Result } from '@/lib/services/result'
import { withoutSensitiveDefaults } from '@/lib/services/parameterRedaction'
import { safeImageContentType } from '@/lib/services/imageUpload'
import { listActiveSizesForProduct } from '@/lib/services/sizes'
import { productNameSql, productDescriptionSql, productLongDescriptionSql } from '@/lib/db/productText'
// The gallery payload is the shared API type, not a local twin of it. This module
// declared its own identical `ProductImageMeta`, and admin/products.ts imported
// that one while the frontend's ProductGallery imported the package's — two
// definitions of one wire format, free to drift apart unnoticed.
import type { ProductImageMeta } from '@infrashelf/types'

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
/**
 * A parameter row plus what the load learned about it.
 *
 * `projectScoped` is not a column — it is whether `parameter_projects` names
 * any project for this parameter, which is what the resolver needs in order to
 * prefer a narrowed row over an unnarrowed one of the same name and scope
 * (#275). Optional so a caller assembling rows by hand, and every test that
 * already does, keeps compiling; absent reads as "not narrowed", which is what
 * every parameter was before this existed.
 */
export type ApplicableParameter = Parameter & { projectScoped?: boolean }

export const loadApplicableParameters = async (
  productId: number,
  categoryId: number,
  environmentId?: number,
  projectId?: number,
): Promise<Parameter[]> => {
  const scopeWhere = or(
    eq(parameters.scope, 'global'),
    and(eq(parameters.scope, 'category'), eq(parameters.scopeId, categoryId)),
    and(eq(parameters.scope, 'product'), eq(parameters.scopeId, productId)),
  )

  /*
   * Narrowing to projects, when the parameter says so (#275).
   *
   * `parameter_projects` is empty for every parameter that has not been
   * narrowed, and empty means "every project" — so the condition is "this
   * parameter names no projects at all, OR it names this one". A parameter
   * narrowed to projects the caller is not ordering for drops out entirely.
   *
   * Written as NOT EXISTS / EXISTS rather than a LEFT JOIN because a join would
   * multiply a parameter by its project count and then need distinguishing
   * again; these two are index lookups on the composite key and the project
   * index respectively.
   *
   * Skipped when no project is known. The catalogue renders the order form
   * before a project is chosen, and filtering to "unnarrowed only" there would
   * hide a control the order will still validate.
   */
  const projectWhere =
    projectId === undefined
      ? undefined
      : or(
          sql`NOT EXISTS (SELECT 1 FROM parameter_projects pp WHERE pp.parameter_id = ${parameters.id})`,
          sql`EXISTS (SELECT 1 FROM parameter_projects pp WHERE pp.parameter_id = ${parameters.id} AND pp.project_id = ${projectId})`,
        )

  const environmentWhere =
    environmentId === undefined
      ? undefined
      : or(sql`${parameters.environmentId} IS NULL`, eq(parameters.environmentId, environmentId))

  const conditions = [scopeWhere, environmentWhere, projectWhere].filter((c) => c !== undefined)

  return db
    .select({
      ...getTableColumns(parameters),
      // Whether this row was narrowed to specific projects at all. The filter
      // above has already decided that it APPLIES; this is what lets the
      // resolver prefer it over an unnarrowed row of the same name and scope,
      // the same way an environment-specific row is preferred (#275).
      projectScoped: sql<boolean>`EXISTS (SELECT 1 FROM parameter_projects pp WHERE pp.parameter_id = ${parameters.id})`,
    })
    .from(parameters)
    .where(and(...conditions))
    /*
     * Ordered, because these rows ARE the order form's controls and, worse,
     * because `resolveParameterDefs` reads them in sequence.
     *
     * Without it the order is whatever plan Postgres chose. That decided two
     * things it had no business deciding: the order a person fills the form in,
     * and — where two rows tie on every precedence rule below — WHICH
     * definition wins. See the tie-break there; this is the half that makes the
     * input to it stable.
     *
     * By `id`, which is creation order: an administrator who adds parameters in
     * a sensible order gets them back that way. `parameters` has no display
     * column, and adding one is a bigger question than making this deterministic.
     */
    .orderBy(parameters.id)
}

/**
 * Collapse the applicable rows to one definition per parameter name, applying
 * scope precedence (product > category > global) and preferring an
 * environment-specific row over an all-environments (NULL) row. This is the
 * effective definition a submitted value is validated against.
 */
export const resolveParameterDefs = (rows: ApplicableParameter[]): ApplicableParameter[] => {
  const scopeRank: Record<string, number> = { global: 0, category: 1, product: 2 }
  const byName = new Map<string, ApplicableParameter>()

  for (const row of rows) {
    const current = byName.get(row.name)
    if (!current) {
      byName.set(row.name, row)
      continue
    }
    const sameScope = scopeRank[row.scope] === scopeRank[current.scope]
    const moreSpecificScope = scopeRank[row.scope] > scopeRank[current.scope]
    const sameScopeButEnvSpecific =
      sameScope && row.environmentId !== null && current.environmentId === null
    /*
     * Project narrowing is the third tie-break, below the environment (#275).
     *
     * The owner's decision is `product > category > project > global`, and the
     * scope rank above already delivers it: a product-scoped row out-ranks a
     * global one whether or not the global one names projects.
     *
     * What is left is two rows of the SAME scope where one is narrowed — a
     * global `region` for everybody and a global `region` for one project. The
     * narrowed one is the more specific statement and wins, exactly as the
     * environment-specific row does.
     *
     * Below the environment rather than above it, and this is a judgement
     * rather than a decision handed down: the environment decides which cloud
     * the value is even valid for, so a value that is wrong for the target
     * environment cannot be the right answer no matter which project asked. It
     * only matters when one row is env-specific and the other project-narrowed,
     * which no configuration in this repository produces yet.
     */
    const sameScopeAndEnvButProjectScoped =
      sameScope &&
      row.environmentId === current.environmentId &&
      row.projectScoped === true &&
      current.projectScoped !== true

    /*
     * The last tie-break, and it exists because without one the winner was
     * decided by the QUERY PLAN.
     *
     * `parameters` has no uniqueness constraint and the admin API has no
     * duplicate guard, so two rows can share a name at the same scope, the same
     * environment and the same project narrowing. Every rule above then says
     * "neither", the loop keeps whichever arrived first, and which `type`,
     * `defaultValue`, `required` and `sensitive` apply to every order placed
     * against that product becomes arbitrary.
     *
     * `sensitive` is the sharp edge: it decides whether the value is redacted
     * everywhere downstream (#131). Two tying rows that disagree about it made
     * "is this secret redacted?" a question about row order.
     *
     * Highest id wins — the most recently created definition, which is the rule
     * a person would guess and the only one the data can answer. It does not
     * make duplicates a good idea; it makes their effect repeatable. Removing
     * the duplicates themselves needs a constraint and a migration to dedupe
     * what is already stored.
     */
    const sameEverythingButNewer =
      sameScope &&
      row.environmentId === current.environmentId &&
      row.projectScoped === current.projectScoped &&
      row.id > current.id

    if (
      moreSpecificScope ||
      sameScopeButEnvSpecific ||
      sameScopeAndEnvButProjectScoped ||
      sameEverythingButNewer
    ) {
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

/**
 * The description of the picture a product leads with.
 *
 * `products.image_alt` was a column until 0021 moved the pictures into
 * `product_images`; every caller that renders a thumbnail still wants exactly one
 * alt text, so it is read from the first gallery image. Ordered by (position, id)
 * like every other read of that table, so "first" means the same thing here as it
 * does in the gallery.
 */
/*
 * The outer reference is written out rather than interpolated as `${products.id}`.
 * When this constant is a select field of a query whose FROM table is `products`,
 * drizzle renders that column unqualified as `"id"` — which then resolves in the
 * INNER scope to `product_images.id`, making the subquery
 * `WHERE product_images.product_id = product_images.id`: uncorrelated, and NULL
 * for almost every row. It renders qualified when `products` is a JOINED table
 * (cart.ts, favorites.ts), which is why only the catalogue reads were wrong.
 */
export const primaryImageAltSql = sql<string | null>`(
  SELECT alt FROM product_images
  WHERE product_id = ${sql.raw('"products"."id"')}
  ORDER BY position, id
  LIMIT 1
)`

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
  /** The gallery, in order. Empty on a product with no picture. */
  images: ProductImageMeta[]
  /** The product story. Empty string when nobody wrote one — the page then shows only `description`. */
  longDescription: string
  /** Who runs it, and where its documentation is. Null when unset (issue #107). */
  owner: string | null
  docsUrl: string | null
}

/** Page size when the caller does not ask for one — a full grid on the catalogue page. */
export const CATALOG_DEFAULT_LIMIT = 24
/** Ceiling on what one request may ask for, so `limit=100000` cannot be a denial of service. */
export const CATALOG_MAX_LIMIT = 100

/**
 * How far the match count will look before it gives up and says "at least".
 *
 * The search predicate cannot use an index — `ILIKE '%term%'` over a COALESCE
 * of correlated subqueries — so counting the matches costs a full evaluation
 * per row. This bounds that: the count stops at the cap, and above it `total`
 * is a floor with `totalIsExact: false` beside it (#236).
 *
 * 500 is chosen against the catalogue this portal is for — hundreds to a few
 * thousand products — where a search matching more than 500 is a search nobody
 * would page through, and every real one is counted exactly. A catalogue an
 * order of magnitude larger needs a trigram or full-text index rather than a
 * larger number here; see #236 for what each of those costs.
 */
export const CATALOG_COUNT_CAP = 500

export interface CatalogFilters {
  /** Free text matched against the product's translated name and description. */
  search?: string
  categoryId?: number
  limit?: number
  offset?: number
}

export interface CatalogPage {
  items: CatalogItem[]
  /**
   * Rows matching the filters, ignoring the page window — what the UI counts.
   *
   * Capped at `CATALOG_COUNT_CAP`. When the cap was reached this is a floor,
   * not a total, and `totalIsExact` is false.
   */
  total: number
  /**
   * Whether `total` is the real number of matches.
   *
   * False only when the search matched more rows than the count was willing to
   * walk. A UI that prints "1–24 of 500" for a result set of 4,000 is stating
   * something untrue; this is what lets it print "500+" instead (#236).
   */
  totalIsExact: boolean
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
  const nameSql = productNameSql(lang)
  const descriptionSql = productDescriptionSql(lang)

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
      imageAlt: primaryImageAltSql,
      name: nameSql,
      description: descriptionSql,
    })
    .from(products)
    .where(where)
    .orderBy(products.id)
    .limit(limit)
    .offset(offset)

  /*
   * Counted separately rather than with a window function: a page past the end
   * of the result set returns no rows, and "no rows" must not be reported as
   * "nothing matched".
   *
   * Counted through a CAPPED subquery, because this count is the expensive half
   * of a searched request and it used to be unbounded (#236).
   *
   * `name` is a four-branch COALESCE of correlated subqueries over
   * `product_translations` (requested language → en → de → any) and
   * `description` is three. They are deliberately the same expressions the rows
   * display — searching against something other than what you can see is how a
   * result becomes inexplicable — but it means the planner evaluates all seven
   * for every row before it can decide whether the row matches. The
   * `ILIKE '%term%'` around them cannot use a btree at all: a leading wildcard
   * rules it out. So a searched page paid for that twice, once for the rows and
   * once for a COUNT(*) with no LIMIT to stop it early.
   *
   * `LIMIT cap + 1` inside the subquery lets Postgres stop as soon as it has
   * enough, which turns the count from "proportional to the catalogue" into
   * "proportional to the cap". Above the cap the number is a floor, and
   * `totalIsExact` says so rather than letting the UI print a confident lie.
   */
  const [counted] = await db
    .select({ total: sql<number>`COUNT(*)::int` })
    .from(
      db
        .select({ one: sql`1` })
        .from(products)
        .where(where)
        .limit(CATALOG_COUNT_CAP + 1)
        .as('capped'),
    )

  const total = counted?.total ?? 0

  return ok({
    items: rows as CatalogItem[],
    total: Math.min(total, CATALOG_COUNT_CAP),
    totalIsExact: total <= CATALOG_COUNT_CAP,
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
      imageAlt: primaryImageAltSql,
      owner: products.owner,
      docsUrl: products.docsUrl,
      name: productNameSql(lang),
      description: productDescriptionSql(lang),
      longDescription: productLongDescriptionSql(lang),
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
    /*
     * Ordered, because this list IS the environment picker.
     *
     * Without it the order is whatever plan Postgres chose, which is not stable
     * across schema changes: adding four columns and four CHECK constraints to
     * `cost_centers` — the table this left-joins — was enough to flip it, and a
     * product whose first offering was orderable stopped being so. Whoever reads
     * the picker sees the same reshuffle for no reason they can see.
     *
     * By name, because that is what the picker displays, with the id as the
     * tie-break. Same expression `admin/sizes.ts` already uses for this join.
     */
    .orderBy(deploymentEnvironments.name, productEnvironments.environmentId)

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

  const imageRows = await listProductImageMeta(productId)

  return ok({
    ...product,
    environments,
    parameters: withoutSensitiveDefaults(resolved),
    images: imageRows,
  } as ProductDetail)
}

/**
 * The gallery's metadata — ids and descriptions, no bytes.
 *
 * Carried on the product detail so the page can render the whole gallery from one
 * request; the bytes come one at a time from the image routes, which is what makes
 * them cacheable.
 */
export const listProductImageMeta = async (productId: number): Promise<ProductImageMeta[]> =>
  db
    .select({ id: productImages.id, alt: productImages.alt })
    .from(productImages)
    .where(eq(productImages.productId, productId))
    .orderBy(productImages.position, productImages.id)

export interface ServedImage {
  data: Buffer
  mime: string
  alt: string
}

/**
 * The picture a product leads with — the first of its gallery.
 *
 * Still its own endpoint after #107 because that is what a tile, a cart row and a
 * favourites card want: one picture, at a URL they can build from the product id
 * alone. It is a view of `product_images`, not a second copy of it.
 */
export const getProductImage = async (productId: number): Promise<Result<ServedImage | null>> => {
  const [row] = await db
    .select({ data: productImages.data, mime: productImages.mime, alt: productImages.alt })
    .from(productImages)
    .where(eq(productImages.productId, productId))
    .orderBy(productImages.position, productImages.id)
    .limit(1)

  if (!row) {
    // A product that exists but has no picture is not a 404 on the product — the
    // caller renders a placeholder for the one and an error for the other.
    const [product] = await db
      .select({ id: products.id })
      .from(products)
      .where(eq(products.id, productId))
      .limit(1)
    return product ? ok(null) : err(404, 'Product not found')
  }

  // Clamped on the way out as well as on the way in: migration 0021 carried the
  // legacy `products.image_mime` into this column verbatim, so a row written
  // before the upload path sniffed the bytes can still hold whatever type its
  // uploader declared — and this blob is echoed straight back as a Content-Type.
  // Anything unrecognised becomes an opaque download.
  return ok({ ...row, mime: safeImageContentType(row.mime) })
}

/**
 * One specific picture of a product's gallery.
 *
 * Scoped by product id as well as image id so a URL cannot be walked across
 * products, and so a stale gallery URL from another product 404s instead of
 * serving the wrong picture.
 */
export const getProductImageById = async (
  productId: number,
  imageId: number,
): Promise<Result<ServedImage>> => {
  const [row] = await db
    .select({ data: productImages.data, mime: productImages.mime, alt: productImages.alt })
    .from(productImages)
    .where(and(eq(productImages.productId, productId), eq(productImages.id, imageId)))
    .limit(1)

  if (!row) return err(404, 'Image not found')
  return ok({ ...row, mime: safeImageContentType(row.mime) })
}
