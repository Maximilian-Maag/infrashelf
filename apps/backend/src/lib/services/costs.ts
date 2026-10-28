import type { SessionUser } from '@infrashelf/types'
import { db } from '@/lib/db/client'
import {
  orders,
  projects,
  productEnvironments,
  costCenters,
  deploymentEnvironments,
  exchangeRates,
} from '@/lib/db/schema'
import { and, eq, gte, lte, inArray, sql } from 'drizzle-orm'
import { alias } from 'drizzle-orm/pg-core'
import { ok, err, type Result } from '@/lib/services/result'
import { linePriceSql, lineCurrencySql } from '@/lib/services/sizes'
import { productNameSql } from '@/lib/db/productText'
import { readBaseCurrency } from '@/lib/exchange/baseCurrency'
import { countWhere } from '@/lib/db/queries'
import { EXPORT_MAX_ROWS } from '@/lib/services/page'

/**
 * Spending overview (issue #32).
 *
 * ── What counts as spend ──────────────────────────────────────────────────────
 * Only orders that actually reached provisioning: 'provisioning' and 'completed'.
 * A rejected or pending order never cost anything, and counting it would inflate
 * every figure on the page. A 'failed' order is excluded too — its pipeline did not
 * deliver infrastructure — which means a retried order (issue #29) starts counting
 * again once it succeeds, not twice.
 *
 * ── Which price ───────────────────────────────────────────────────────────────
 * The price stored in the order's snapshot (issue #38), which is what the customer
 * was actually charged at the time. Falling back to the offering's CURRENT price
 * would silently restate history every time an admin edits a price — the exact
 * problem snapshots exist to prevent. Orders that predate snapshots have none, so
 * they fall back to the current price and are counted in `estimatedOrders` so the
 * total can be read with that in mind rather than presented as exact.
 *
 * ── Which cost centre an order counts against ─────────────────────────────────
 * The order's own `cost_center_id` where it has one — 'select' mode, where the
 * orderer chose it, and 'overhead' mode, where the offering fixed it. In 'project'
 * mode (the DEFAULT) the order deliberately stores none, because attribution
 * follows the project, so the project's cost centre is used instead. Reading only
 * the order-level column would file every default-mode order under "no cost
 * centre" and leave the per-cost-centre breakdown empty for most catalogues.
 *
 * ── What the figures are NOT ───────────────────────────────────────────────────
 * `product_environments.price` records an amount and a currency but no billing
 * period, so there is no honest way to derive a monthly run rate from it. These
 * are sums of the recorded price of each provisioned order in the window, not a
 * time-based projection. The UI says so.
 */

export type CostGrouping = 'project' | 'costCenter' | 'product' | 'environment'

export interface CostFilters {
  from?: Date
  to?: Date
  /** Narrow to one project. Ignored when the caller cannot see it. */
  projectId?: number
}

export interface CostBucket {
  id: number | null
  label: string
  /** Total in the configured base currency (FA-11.3). The client converts it to the viewer's currency. */
  totalBase: number
  orderCount: number
}

/**
 * One calendar month of the filtered window (issue #106).
 *
 * ── Why months and not weeks ──────────────────────────────────────────────────
 * Every range preset is already month-aligned — `resolveRange` snaps `from` to the
 * first of a month — so a monthly grain is the only one whose buckets line up with
 * the window the user picked. A weekly grain would straddle both edges of every
 * preset (the first and last bucket would be partial for a reason the user cannot
 * see) and would turn `last12Months` into 52 columns nobody can read. It is also
 * the grain the question is asked in: "this month vs last".
 */
export interface CostPeriod {
  /** Calendar month in UTC, `YYYY-MM`. UTC because the boundaries the filters use are. */
  period: string
  totalBase: number
  orderCount: number
  /** Orders in this month priced from the live offering because they predate snapshots. */
  estimatedOrders: number
  /**
   * True when the month has not finished yet, so its figure will still grow.
   * Without it a trend chart shows the current month as a cliff and a
   * month-on-month comparison reads a half-finished month as a fall in spend.
   */
  partial: boolean
}

/** Two adjacent months of the series, so "this month vs last" needs no client arithmetic. */
export interface CostComparison {
  current: CostPeriod
  previous: CostPeriod
  /** current − previous, in the base currency. */
  changeBase: number
  /**
   * Percentage change, or null when the previous month was zero — there is no
   * honest percentage from a zero base, and 100 % or Infinity would both be lies.
   */
  changePct: number | null
}

export interface CostReport {
  totalBase: number
  orderCount: number
  /** Orders whose price came from the live offering because they predate snapshots. */
  estimatedOrders: number
  /**
   * Spend per calendar month over the filtered window, oldest first, with the
   * empty months in between filled in — a trend that silently omits a zero month
   * draws a straight line through a gap and misstates the slope. Sums exactly to
   * `totalBase`, because it is computed from the same de-duplicated rows as the
   * breakdowns rather than by a second query that could disagree.
   */
  series: CostPeriod[]
  /**
   * The last two months of `series`, or null when the window covers fewer than
   * two — a comparison against a month the filter excluded would compare against
   * zero and read as "spend doubled".
   */
  comparison: CostComparison | null
  byProject: CostBucket[]
  byCostCenter: CostBucket[]
  byProduct: CostBucket[]
  byEnvironment: CostBucket[]
  /**
   * Amounts that could not be converted because no rate is stored for their
   * currency. Surfaced rather than dropped: a silently missing currency would make
   * the total quietly wrong.
   */
  unconverted: { currency: string; amount: number }[]
  /**
   * Orders counted in `orderCount` for which no price could be recovered at all
   * — neither a snapshot nor a live offering (#189).
   *
   * They contribute nothing to `totalBase`, which is unavoidable: there is no
   * amount to add. What is avoidable is doing that SILENTLY. An order reaches
   * this state when it predates `product_snapshot` and the offering it was placed
   * against has since been withdrawn — `deleteProductEnvironment` and the retire
   * branches of `deleteCategory` and product retirement all delete the
   * `product_environments` row, so the `leftJoin` that supplies the fallback
   * price yields nothing.
   *
   * Before this the order still appeared in `orderCount`, still exported with
   * `price: '0'`, and its historical spend simply left the total. A count is not
   * the money back, but it is the difference between a total that is wrong and a
   * total that says how far.
   */
  unpricedOrders: number
  /** True when the caller sees every project's spend. */
  global: boolean
}

/** The cost_centers row reached through the project rather than the order. */
const projectCostCenters = alias(costCenters, 'project_cost_centers')

/** Statuses that represent infrastructure that was actually provisioned. */
const SPENDING_STATUSES = ['provisioning', 'completed'] as const

interface CostRow {
  orderId: number
  /** Bucketed into a calendar month for the series. */
  createdAt: Date | null
  projectId: number
  projectName: string | null
  costCenterId: number | null
  costCenterLabel: string | null
  /** The project's cost centre, used when the order carries none. */
  projectCostCenterId: number | null
  projectCostCenterLabel: string | null
  productId: number
  productName: string | null
  environmentId: number
  environmentName: string | null
  snapshotPrice: string | null
  snapshotCurrency: string | null
  livePrice: string | null
  liveCurrency: string | null
  /** How many elements the order provisioned (issue #104). */
  quantity: number | null
}

export const getCostReport = async (
  session: SessionUser,
  filters: CostFilters = {},
  /** Injected so a test can pin which month counts as unfinished. */
  now: Date = new Date(),
  lang = 'en',
): Promise<Result<CostReport>> => {
  const isAdmin = session.role === 'admin' || session.role === 'root'

  const conditions = [inArray(orders.status, [...SPENDING_STATUSES])]

  // A project manager sees the spend of the projects they OWN, not merely the
  // orders they placed: cost is a property of the project they are accountable for,
  // and an order somebody else placed into it still spends their budget.
  if (!isAdmin) conditions.push(eq(projects.ownerId, session.id))

  if (filters.projectId !== undefined) conditions.push(eq(orders.projectId, filters.projectId))
  if (filters.from) conditions.push(gte(orders.createdAt, filters.from))
  if (filters.to) conditions.push(lte(orders.createdAt, filters.to))

  const rows = (await db
    .select({
      orderId: orders.id,
      createdAt: orders.createdAt,
      projectId: orders.projectId,
      projectName: projects.name,
      costCenterId: orders.costCenterId,
      costCenterLabel: sql<string>`${costCenters.code} || ' — ' || ${costCenters.name}`,
      projectCostCenterId: projects.costCenterId,
      projectCostCenterLabel: sql<string>`${projectCostCenters.code} || ' — ' || ${projectCostCenters.name}`,
      productId: orders.productId,
      productName: productNameSql(lang, orders.productId),
      environmentId: orders.environmentId,
      environmentName: deploymentEnvironments.name,
      // The snapshot is the authoritative price: what the customer was charged.
      snapshotPrice: sql<string | null>`${orders.productSnapshot} ->> 'price'`,
      snapshotCurrency: sql<string | null>`${orders.productSnapshot} ->> 'currency'`,
      // The size's price where the order named one, the offering's otherwise
      // (issue #98). Only ever reached by an order that predates snapshots — the
      // snapshot above is authoritative — but it has to be the RIGHT fallback, or
      // a legacy order of an offering that has since gained sizes would be priced
      // at the offering's stale figure.
      livePrice: linePriceSql(orders.productId, orders.environmentId, orders.sizeCode),
      liveCurrency: lineCurrencySql(orders.productId, orders.environmentId, orders.sizeCode),
      quantity: orders.quantity,
    })
    .from(orders)
    .leftJoin(projects, eq(orders.projectId, projects.id))
    .leftJoin(costCenters, eq(orders.costCenterId, costCenters.id))
    // Second join on the same table for the project's cost centre: a 'project'-mode
    // order has no cost centre of its own to join to.
    .leftJoin(projectCostCenters, eq(projects.costCenterId, projectCostCenters.id))
    .leftJoin(deploymentEnvironments, eq(orders.environmentId, deploymentEnvironments.id))
    // Left: an offering withdrawn since the order was placed must not drop the
    // order out of the report, which would make past spend disappear.
    .leftJoin(
      productEnvironments,
      and(
        eq(orders.productId, productEnvironments.productId),
        eq(orders.environmentId, productEnvironments.environmentId),
      ),
    )
    .where(and(...conditions))) as CostRow[]

  const rates = await loadRates()
  // The currency the stored prices are kept in and the rates are quoted against
  // (FA-11.3). The report sums into it; EUR by default, and the anchor the old
  // hardcoded 'EUR' always assumed it was (#592).
  const baseCurrency = await readBaseCurrency()

  let totalBase = 0
  let estimatedOrders = 0
  let unpricedOrders = 0
  const unconverted = new Map<string, number>()
  const buckets: Record<CostGrouping, Map<string, CostBucket>> = {
    project: new Map(),
    costCenter: new Map(),
    product: new Map(),
    environment: new Map(),
  }
  /** Keyed by `YYYY-MM`; filled in the same pass so the series cannot drift from the total. */
  const months = new Map<string, CostPeriod>()

  // One row per order, from the query. There used to be a `seen` set here, and a
  // guard skipping repeats, because the query joined `infrastructure_elements`
  // for a column nothing read — and `order_id` is not unique there, so the join
  // multiplied the result set and this loop then undid it. Both are gone; the
  // export path never had the join and was already right (#160).
  for (const row of rows) {
    const usingSnapshot = row.snapshotPrice !== null && row.snapshotCurrency !== null
    const rawPrice = usingSnapshot ? row.snapshotPrice : row.livePrice
    const currency = (usingSnapshot ? row.snapshotCurrency : row.liveCurrency) ?? 'EUR'
    if (!usingSnapshot) estimatedOrders += 1

    // Unit price × quantity: an order of twenty XL VMs costs twenty times one
    // (issue #104). The quantity comes from the order row rather than the
    // snapshot because it is a fact about the order, not about what the catalogue
    // offered; a row written before the column existed reads 1 through the
    // column default, which is what it asked for.
    // `null` is not `'0'`. A free offering is priced; an order whose offering has
    // been withdrawn and which predates snapshots is UNPRICED, and collapsing the
    // two makes withdrawn history look like a giveaway (#189).
    if (rawPrice === null || rawPrice === undefined) {
      unpricedOrders += 1
      addTo(buckets, row, 0)
      bumpMonth(months, row, 0, usingSnapshot, now)
      continue
    }

    const unit = Number(rawPrice)
    const quantity = row.quantity !== null && row.quantity >= 1 ? row.quantity : 1
    const amount = Number.isFinite(unit) ? unit * quantity : unit
    // An unparseable or absent price contributes nothing rather than NaN, which
    // would poison every total it touched.
    if (!Number.isFinite(amount) || amount === 0) {
      addTo(buckets, row, 0)
      bumpMonth(months, row, 0, usingSnapshot, now)
      continue
    }

    const base = toBase(amount, currency, rates, baseCurrency)
    if (base === null) {
      unconverted.set(currency, (unconverted.get(currency) ?? 0) + amount)
      addTo(buckets, row, 0)
      // Counted at zero, exactly as the breakdowns do: the amount is reported in
      // unconverted[] instead of being guessed at a rate that does not exist.
      bumpMonth(months, row, 0, usingSnapshot, now)
      continue
    }

    totalBase += base
    addTo(buckets, row, base)
    bumpMonth(months, row, base, usingSnapshot, now)
  }

  const series = fillMonths(months, now)

  return ok({
    totalBase: round(totalBase),
    // Was `seen.size` — the count of DISTINCT orders left after the JS dedupe.
    // One row per order now, so the two are the same number.
    orderCount: rows.length,
    estimatedOrders,
    series,
    comparison: compare(series),
    byProject: finalise(buckets.project),
    byCostCenter: finalise(buckets.costCenter),
    byProduct: finalise(buckets.product),
    byEnvironment: finalise(buckets.environment),
    unconverted: [...unconverted.entries()].map(([currency, amount]) => ({
      currency,
      amount: round(amount),
    })),
    unpricedOrders,
    global: isAdmin,
  })
}

const addTo = (
  buckets: Record<CostGrouping, Map<string, CostBucket>>,
  row: CostRow,
  eur: number,
): void => {
  bump(buckets.project, row.projectId, row.projectName ?? `Project #${row.projectId}`, eur)
  // 'project' mode (the default) stores no cost centre on the order because
  // attribution follows the project, so fall through to the project's own. Only an
  // order whose project has none either is genuinely unattributed.
  const costCenterId = row.costCenterId ?? row.projectCostCenterId
  bump(
    buckets.costCenter,
    costCenterId,
    row.costCenterLabel ?? row.projectCostCenterLabel ?? 'No cost centre',
    eur,
  )
  bump(buckets.product, row.productId, row.productName ?? `Product #${row.productId}`, eur)
  bump(buckets.environment, row.environmentId, row.environmentName ?? `Environment #${row.environmentId}`, eur)
}

const bump = (
  bucket: Map<string, CostBucket>,
  id: number | null,
  label: string,
  eur: number,
): void => {
  const key = String(id ?? 'none')
  const existing = bucket.get(key)
  if (existing) {
    existing.totalBase += eur
    existing.orderCount += 1
    return
  }
  bucket.set(key, { id, label, totalBase: eur, orderCount: 1 })
}

/** `YYYY-MM` in UTC. */
const monthKey = (date: Date): string =>
  `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, '0')}`

/**
 * Accumulate one counted order into its calendar month.
 *
 * An order with no `created_at` cannot be placed on a timeline, so it is left out
 * of the series rather than dropped into an arbitrary month — it still counts in
 * `totalBase`, which is why the series is documented as summing to the total only
 * over the orders that have a date. The column is NOT NULL, so this is defensive.
 */
const bumpMonth = (
  months: Map<string, CostPeriod>,
  row: CostRow,
  eur: number,
  usingSnapshot: boolean,
  now: Date,
): void => {
  if (!row.createdAt) return
  const period = monthKey(row.createdAt)
  const existing = months.get(period)
  if (existing) {
    existing.totalBase += eur
    existing.orderCount += 1
    if (!usingSnapshot) existing.estimatedOrders += 1
    return
  }
  months.set(period, {
    period,
    totalBase: eur,
    orderCount: 1,
    estimatedOrders: usingSnapshot ? 0 : 1,
    partial: period === monthKey(now),
  })
}

/**
 * Oldest first, with the empty months between the first and last filled in.
 *
 * Without the fill a chart draws two adjacent columns for months that are a year
 * apart, which reads as continuous spend. The range is bounded by the data rather
 * than by the filter: the filter may have no lower bound at all (`range=all`), and
 * inventing months before the first order would pad every chart with leading zeros.
 */
const fillMonths = (months: Map<string, CostPeriod>, now: Date): CostPeriod[] => {
  const present = [...months.values()].sort((a, b) => a.period.localeCompare(b.period))
  if (present.length === 0) return []

  const parse = (period: string): { year: number; month: number } => {
    const [year, month] = period.split('-').map(Number)
    return { year, month }
  }
  const first = parse(present[0].period)
  const last = parse(present[present.length - 1].period)
  const currentPeriod = monthKey(now)

  const out: CostPeriod[] = []
  for (
    let cursor = Date.UTC(first.year, first.month - 1, 1);
    cursor <= Date.UTC(last.year, last.month - 1, 1);
    cursor = Date.UTC(new Date(cursor).getUTCFullYear(), new Date(cursor).getUTCMonth() + 1, 1)
  ) {
    const period = monthKey(new Date(cursor))
    const found = months.get(period)
    out.push(
      found
        ? { ...found, totalBase: round(found.totalBase) }
        : { period, totalBase: 0, orderCount: 0, estimatedOrders: 0, partial: period === currentPeriod },
    )
  }
  return out
}

/**
 * The last two months of the series.
 *
 * Deliberately taken from the series and not from a second, wider query: comparing
 * against a month the filter excluded would compare against zero and read as
 * "spend doubled this month". A window of one month yields null, and the UI says
 * the window is too short rather than drawing a comparison against nothing.
 */
const compare = (series: CostPeriod[]): CostComparison | null => {
  if (series.length < 2) return null
  const previous = series[series.length - 2]
  const current = series[series.length - 1]
  return {
    current,
    previous,
    changeBase: round(current.totalBase - previous.totalBase),
    changePct:
      previous.totalBase === 0
        ? null
        : Math.round(((current.totalBase - previous.totalBase) / previous.totalBase) * 1000) / 10,
  }
}

/** Largest spend first — the point of the page is to see where the money goes. */
const finalise = (bucket: Map<string, CostBucket>): CostBucket[] =>
  [...bucket.values()]
    .map((b) => ({ ...b, totalBase: round(b.totalBase) }))
    .sort((a, b) => b.totalBase - a.totalBase || a.label.localeCompare(b.label))

const loadRates = async (): Promise<Record<string, number>> => {
  const rows = await db.select().from(exchangeRates)
  const rates: Record<string, number> = {}
  for (const row of rows) {
    const rate = Number(row.rate)
    if (Number.isFinite(rate) && rate > 0) rates[row.currencyCode] = rate
  }
  return rates
}

/**
 * Convert an amount into the base currency, the anchor the stored rates are
 * quoted against (FA-11.3).
 *
 * Returns null when no rate is stored, so the caller can report the amount as
 * unconverted instead of quietly treating it as the base — which would misstate
 * the total by whatever the exchange rate happens to be. The base itself is 1 by
 * construction, so it needs no rate entry; the currency named here used to be a
 * literal `'EUR'`, which was only right while EUR was the only base there could
 * be (#592).
 */
const toBase = (
  amount: number,
  currency: string,
  rates: Record<string, number>,
  baseCurrency: string,
): number | null => {
  if (currency === baseCurrency) return amount
  const rate = rates[currency]
  if (!rate) return null
  return amount / rate
}

/** Money, so two decimals — and no floating-point tail in the JSON. */
const round = (value: number): number => Math.round(value * 100) / 100

/**
 * Flat rows for the CSV/PDF export, one per counted order.
 *
 * Separate from the aggregate so the export can be reconciled: a total nobody can
 * break down is a total nobody trusts.
 */
export interface CostRowExport {
  orderId: number
  createdAt: Date | null
  projectName: string
  costCenter: string
  productName: string
  environmentName: string
  status: string
  /** The size that was ordered, blank when the offering had none (issue #98). */
  size: string
  /** How many elements the order provisioned (issue #104). */
  quantity: number
  /** UNIT price, as recorded. The line is this times `quantity`. */
  price: string
  currency: string
  /**
   * The unit price in the base currency, ROUNDED. Kept as it was so an existing
   * consumer of the CSV is not silently handed a different number under the name.
   *
   * Do not multiply this by `quantity` — round-then-multiply and
   * multiply-then-round disagree by a cent at exactly the rates that make it hard
   * to spot: 33.33 USD at 1.09, quantity 3, gives 91.74 that way and 91.73 the
   * right way. `lineTotalBase` below is the right way, and is the field that
   * reconciles.
   */
  priceBase: number | null
  /**
   * unit × quantity, in the base currency — the figure that reconciles with the report.
   *
   * Computed from the UNROUNDED conversion, so it agrees with the report's
   * `toBase(unit × quantity)` rather than with `priceBase × quantity`.
   */
  lineTotalBase: number | null
  /** True when the price came from the live offering, not the order's snapshot. */
  estimated: boolean
}

export const getCostRows = async (
  session: SessionUser,
  filters: CostFilters = {},
  lang = 'en',
  maxRows = EXPORT_MAX_ROWS,
): Promise<Result<CostRowExport[]>> => {
  const isAdmin = session.role === 'admin' || session.role === 'root'

  const conditions = [inArray(orders.status, [...SPENDING_STATUSES])]
  if (!isAdmin) conditions.push(eq(projects.ownerId, session.id))
  if (filters.projectId !== undefined) conditions.push(eq(orders.projectId, filters.projectId))
  if (filters.from) conditions.push(gte(orders.createdAt, filters.from))
  if (filters.to) conditions.push(lte(orders.createdAt, filters.to))
  const where = and(...conditions)

  // Bounded, like the infrastructure export (#158): an export asks for the whole
  // filtered set, and the count is what stands between a large download and the
  // container building it in memory. Counted over the same join the filter can
  // name, so the number is the number of rows the export would carry.
  const total = await countWhere(
    db
      .select({ n: sql<number>`count(*)::int` })
      .from(orders)
      .leftJoin(projects, eq(orders.projectId, projects.id))
      .where(where),
  )
  if (total > maxRows) {
    return err(
      413,
      `This export matches ${total.toLocaleString('en-US')} orders, which is more than one export can ` +
        `carry. Narrow it with the project or date filters and take the report a slice at a time.`,
    )
  }

  const rows = await db
    .select({
      orderId: orders.id,
      createdAt: orders.createdAt,
      status: orders.status,
      projectName: projects.name,
      costCenterLabel: sql<string>`${costCenters.code} || ' — ' || ${costCenters.name}`,
      projectCostCenterLabel: sql<string>`${projectCostCenters.code} || ' — ' || ${projectCostCenters.name}`,
      productName: productNameSql(lang, orders.productId),
      environmentName: deploymentEnvironments.name,
      snapshotPrice: sql<string | null>`${orders.productSnapshot} ->> 'price'`,
      snapshotCurrency: sql<string | null>`${orders.productSnapshot} ->> 'currency'`,
      livePrice: linePriceSql(orders.productId, orders.environmentId, orders.sizeCode),
      liveCurrency: lineCurrencySql(orders.productId, orders.environmentId, orders.sizeCode),
      sizeCode: orders.sizeCode,
      snapshotSizeLabel: sql<string | null>`${orders.productSnapshot} ->> 'sizeLabel'`,
      quantity: orders.quantity,
      projectId: orders.projectId,
      productId: orders.productId,
      environmentId: orders.environmentId,
    })
    .from(orders)
    .leftJoin(projects, eq(orders.projectId, projects.id))
    .leftJoin(costCenters, eq(orders.costCenterId, costCenters.id))
    .leftJoin(projectCostCenters, eq(projects.costCenterId, projectCostCenters.id))
    .leftJoin(deploymentEnvironments, eq(orders.environmentId, deploymentEnvironments.id))
    .leftJoin(
      productEnvironments,
      and(
        eq(orders.productId, productEnvironments.productId),
        eq(orders.environmentId, productEnvironments.environmentId),
      ),
    )
    .where(where)
    .orderBy(sql`${orders.createdAt} DESC`, sql`${orders.id} DESC`)
    .limit(maxRows)

  const rates = await loadRates()
  const baseCurrency = await readBaseCurrency()

  return ok(
    rows.map((row) => {
      const usingSnapshot = row.snapshotPrice !== null && row.snapshotCurrency !== null
      const price = (usingSnapshot ? row.snapshotPrice : row.livePrice) ?? '0'
      const currency = (usingSnapshot ? row.snapshotCurrency : row.liveCurrency) ?? 'EUR'
      const amount = Number(price)
      const base = Number.isFinite(amount) ? toBase(amount, currency, rates, baseCurrency) : null
      const quantity = row.quantity !== null && row.quantity >= 1 ? row.quantity : 1
      return {
        orderId: row.orderId,
        createdAt: row.createdAt,
        projectName: row.projectName ?? `Project #${row.projectId}`,
        // Same fall-through as the report: a 'project'-mode order counts against
        // its project's cost centre, or the export would not reconcile with the
        // per-cost-centre breakdown it is meant to explain.
        costCenter: row.costCenterLabel ?? row.projectCostCenterLabel ?? '',
        productName: row.productName ?? `Product #${row.productId}`,
        environmentName: row.environmentName ?? `Environment #${row.environmentId}`,
        status: row.status,
        // The snapshot's label first — that is what the size read as when it was
        // ordered — then the code, which survives a rename.
        size: row.snapshotSizeLabel || row.sizeCode || '',
        quantity,
        price,
        currency,
        priceBase: base === null ? null : round(base),
        lineTotalBase: base === null ? null : round(base * quantity),
        estimated: !usingSnapshot,
      }
    }),
  )
}

/**
 * Confirm a project filter names something the caller may see.
 *
 * Without this an unauthorised projectId would simply produce an empty report,
 * which reads as "this project has no spend" rather than "not yours".
 */
export const assertMaySeeProject = async (
  session: SessionUser,
  projectId: number,
): Promise<Result<void>> => {
  if (session.role === 'admin' || session.role === 'root') return ok(undefined)

  const [project] = await db
    .select({ ownerId: projects.ownerId })
    .from(projects)
    .where(eq(projects.id, projectId))
    .limit(1)

  if (!project) return err(404, 'Project not found')
  if (project.ownerId !== session.id) return err(403, 'Forbidden')
  return ok(undefined)
}
