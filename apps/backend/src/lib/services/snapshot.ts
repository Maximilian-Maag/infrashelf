import { db } from '@/lib/db/client'
import {
  productTranslations,
  productEnvironments,
  productEnvironmentSizes,
  deploymentEnvironments,
  costCenters,
} from '@/lib/db/schema'
import { and, eq } from 'drizzle-orm'
import { loadApplicableParameters, resolveParameterDefs } from '@/lib/services/catalog'
import { RECORD_LANGUAGE } from '@/lib/services/productName'

/**
 * The single name/description a snapshot records alongside the full set.
 *
 * The same order as the SQL fallback chain — RECORD_LANGUAGE, then German, then
 * whatever exists — spelled out in TypeScript because the rows are already loaded
 * and a second round trip to have Postgres apply the identical COALESCE would buy
 * nothing.
 */
const resolveRecorded = <T extends { languageCode: string }>(rows: T[]): T | undefined =>
  rows.find((r) => r.languageCode === RECORD_LANGUAGE) ??
  rows.find((r) => r.languageCode === 'de') ??
  rows[0]

/**
 * Point-in-time capture of what a customer was actually offered (issue #38).
 *
 * Orders and infrastructure reference a product by id, so a later price change or
 * a removed parameter silently rewrites history: the order detail page would show
 * today's configuration as though it were the one that was approved. The snapshot
 * is what makes an order's own record of itself durable.
 *
 * Deliberately a denormalised JSON blob rather than a set of versioned rows. The
 * point is that it can never be changed by anything that happens to the catalogue
 * afterwards, and a foreign key into versioned tables would reintroduce exactly
 * that coupling. Migrating the shape is the price; it is the right one.
 */
export interface ParameterSnapshot {
  name: string
  label: string
  type: string
  description: string
  defaultValue: string
  required: boolean
  sensitive: boolean
}

export interface ProductSnapshot {
  /** Schema marker, so a reader can tell an old snapshot from a new one. */
  version: 1
  capturedAt: string
  productName: string
  productDescription: string
  /**
   * Every name the product had, keyed by language code, as they read at capture
   * time (issue #162).
   *
   * The snapshot is what makes an order's own record of itself durable, and a
   * single string made that record English-only: a German customer's own order
   * history could never be German, whatever was fixed upstream. Recording the
   * whole set keeps both properties at once — the reader picks their language and
   * still sees the name as it stood, not as the catalogue reads today.
   *
   * ABSENT on snapshots taken before this field existed, exactly as `sizeCode` is:
   * a reader must fall back to `productName`, not conclude the product had no
   * translations. Names only, deliberately — the order detail renders the name and
   * nothing renders the description, so carrying 25 paragraphs per order would be
   * paid on every order forever for a string nobody reads.
   */
  productNames?: Record<string, string>
  environmentName: string
  /**
   * The UNIT price that applied — the chosen size's, or the offering's when the
   * order named no size (issue #98).
   *
   * Kept as `price`, the field it has always been, precisely so that every
   * existing reader (the cost report, the order detail page, the CSV/PDF export)
   * becomes correct by reading what it already read. The line total is this times
   * the order's quantity, which lives on the order row rather than here: quantity
   * is a fact about the order, not about what the catalogue offered.
   */
  price: string
  currency: string
  /**
   * The size that was ordered (issue #98), and its label as it read at the time.
   *
   * Both optional and both null-able, and the two absences mean different things:
   * ABSENT means the snapshot predates sizing, NULL means the offering had no
   * sizes when the order was placed. Recorded as text rather than an id because an
   * admin may retire or re-price a size, and this record has to survive that — it
   * is the whole reason the snapshot exists.
   */
  sizeCode?: string | null
  sizeLabel?: string | null
  costCenterMode: string
  forcedCostCenter: boolean
  /**
   * The overhead account this offering bills to, as a durable label (issue #22).
   *
   * Optional because snapshots taken before it was recorded do not carry it; a
   * reader must treat absent as "unknown", not as "none". Stored as a label rather
   * than an id for the same reason every other field here is denormalised — the id
   * could be reassigned or deleted out from under the record.
   */
  overheadCostCenter?: string | null
  trialEnabled: boolean
  trialDurationMinutes: number
  parameters: ParameterSnapshot[]
}

/** Stand-in for a sensitive parameter's default value. */
export const REDACTED_DEFAULT = '[redacted]'

/**
 * Capture the product/environment offering as it stands right now.
 *
 * Returns null when the product is not offered in that environment — the caller
 * decides whether that is an error. Order creation has already validated the
 * offering by the time it snapshots, so for it a null means something raced.
 */
export const captureProductSnapshot = async (
  productId: number,
  categoryId: number,
  environmentId: number,
  /**
   * The size the order chose, if any.
   *
   * Three states, not two, matching the ABSENT/NULL distinction the snapshot
   * documents: omitting the argument leaves `sizeCode`/`sizeLabel` out of the
   * snapshot altogether, which is what the admin version-history paths want —
   * they snapshot an OFFERING, not an order, and have no answer to give. Passing
   * null records "this order named no size", which order creation does whenever
   * the offering has none.
   */
  sizeCode?: string | null,
): Promise<ProductSnapshot | null> => {
  const [offering] = await db
    .select({
      price: productEnvironments.price,
      currency: productEnvironments.currency,
      costCenterMode: productEnvironments.costCenterMode,
      forcedCostCenter: productEnvironments.forcedCostCenter,
      overheadCostCenterCode: costCenters.code,
      overheadCostCenterName: costCenters.name,
      trialEnabled: productEnvironments.trialEnabled,
      trialDurationMinutes: productEnvironments.trialDurationMinutes,
      environmentName: deploymentEnvironments.name,
    })
    .from(productEnvironments)
    .leftJoin(deploymentEnvironments, eq(productEnvironments.environmentId, deploymentEnvironments.id))
    .leftJoin(costCenters, eq(productEnvironments.overheadCostCenterId, costCenters.id))
    .where(
      and(
        eq(productEnvironments.productId, productId),
        eq(productEnvironments.environmentId, environmentId),
      ),
    )
    .limit(1)

  if (!offering) return null

  // The size's price, not the offering's, whenever the order named one. Read here
  // rather than passed in so the snapshot records what the DATABASE said at
  // capture time — the one thing this record is for. A code that no longer
  // resolves (retired between validation and capture) falls back to the offering's
  // price rather than losing the snapshot altogether.
  const size = sizeCode
    ? (
        await db
          .select({
            label: productEnvironmentSizes.label,
            price: productEnvironmentSizes.price,
            currency: productEnvironmentSizes.currency,
          })
          .from(productEnvironmentSizes)
          .where(
            and(
              eq(productEnvironmentSizes.productId, productId),
              eq(productEnvironmentSizes.environmentId, environmentId),
              eq(productEnvironmentSizes.code, sizeCode),
            ),
          )
          .limit(1)
      )[0]
    : undefined

  // Every translation, not the English one: see `productNames`. `productName` and
  // `productDescription` stay the single strings they have always been so that
  // existing snapshots, existing readers and the version diff all keep working;
  // they are resolved at RECORD_LANGUAGE through the shared fallback, which is what
  // stops a German-only product being frozen into the order as `Product #7`.
  const translationRows = await db
    .select({
      languageCode: productTranslations.languageCode,
      name: productTranslations.name,
      description: productTranslations.description,
    })
    .from(productTranslations)
    .where(eq(productTranslations.productId, productId))
    .orderBy(productTranslations.languageCode)

  const productNames = Object.fromEntries(translationRows.map((r) => [r.languageCode, r.name]))
  const translation = resolveRecorded(translationRows)

  // The same resolution the order form rendered and the order service validated
  // against, so the snapshot records the definitions that actually applied rather
  // than every row that happened to match.
  const defs = resolveParameterDefs(
    await loadApplicableParameters(productId, categoryId, environmentId),
  )

  return {
    version: 1,
    capturedAt: new Date().toISOString(),
    productName: translation?.name ?? `Product #${productId}`,
    productDescription: translation?.description ?? '',
    productNames,
    environmentName: offering.environmentName ?? `Environment #${environmentId}`,
    price: size?.price ?? offering.price,
    currency: size?.currency ?? offering.currency,
    // Spread, so an omitted argument leaves both fields absent rather than
    // writing null. Null here means "the order named no size", and a snapshot
    // that predates sizing means "nobody asked" — writing null unconditionally
    // made every version-history snapshot claim the first of those.
    ...(sizeCode !== undefined ? { sizeCode, sizeLabel: size?.label ?? null } : {}),
    costCenterMode: offering.costCenterMode,
    forcedCostCenter: offering.forcedCostCenter,
    // Null, not omitted: "no overhead account is configured" is a fact worth
    // recording, and it is what distinguishes this from an older snapshot that
    // simply never captured the field.
    overheadCostCenter:
      offering.overheadCostCenterCode === null
        ? null
        : `${offering.overheadCostCenterCode} — ${offering.overheadCostCenterName}`,
    trialEnabled: offering.trialEnabled,
    trialDurationMinutes: offering.trialDurationMinutes,
    parameters: defs
      .map((def) => ({
        name: def.name,
        label: def.label,
        type: def.type,
        description: def.description,
        // A sensitive parameter's default can be a placeholder secret, and the
        // snapshot is rendered on a page the ORDERER sees. The definition is worth
        // recording; its default is not worth leaking.
        defaultValue: def.sensitive ? REDACTED_DEFAULT : def.defaultValue,
        required: def.required,
        sensitive: def.sensitive,
      }))
      // Stable order so two snapshots of the same configuration diff as identical.
      .sort((a, b) => a.name.localeCompare(b.name)),
  }
}
