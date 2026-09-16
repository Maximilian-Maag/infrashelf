import { db } from '@/lib/db/client'
import { productVersions, products, users, deploymentEnvironments } from '@/lib/db/schema'
import { and, eq, sql, inArray } from 'drizzle-orm'
import { logAudit } from '@/lib/audit'
import { ok, err, type Result } from '@/lib/services/result'
import { captureProductSnapshot, type ProductSnapshot, type ParameterSnapshot } from '@/lib/services/snapshot'

export interface VersionRow {
  id: number
  productId: number
  environmentId: number | null
  changelog: string
  summary: string
  snapshot: ProductSnapshot | null
  createdBy: number | null
  createdAt: Date
  authorName: string | null
  environmentName: string | null
}

export const MAX_CHANGELOG_LENGTH = 2000

/**
 * Record a catalogue change to a product (issue #38).
 *
 * Called from the admin mutations rather than from a database trigger so the entry
 * can carry a human summary and an author — a trigger would know that a row
 * changed but not who asked or why.
 *
 * Best-effort by design: a failure here must not fail the edit it is describing.
 * Losing one history row is a smaller problem than an operator being unable to fix
 * a price because the history table is full.
 */
export const recordProductVersion = async (input: {
  productId: number
  /** Null for a change to the product itself, which is not environment-specific. */
  environmentId: number | null
  summary: string
  changelog?: string
  userId: number | null
}): Promise<void> => {
  try {
    const [product] = await db
      .select({ categoryId: products.categoryId })
      .from(products)
      .where(eq(products.id, input.productId))
      .limit(1)

    // Only an environment-scoped change has an offering to snapshot; a rename has
    // no single one, and picking an arbitrary environment would be misleading.
    const snapshot =
      product && input.environmentId !== null
        ? await captureProductSnapshot(input.productId, product.categoryId, input.environmentId)
        : null

    const changelog = (input.changelog ?? '').trim().slice(0, MAX_CHANGELOG_LENGTH)

    await db.insert(productVersions).values({
      productId: input.productId,
      environmentId: input.environmentId,
      summary: input.summary,
      changelog,
      snapshot,
      createdBy: input.userId,
    })

    // Also audited, as the issue asks: the version table is catalogue history and
    // can be deleted with the product, while the audit log is the immutable record.
    await logAudit(
      input.userId,
      'product.version_recorded',
      input.productId,
      changelog ? `${input.summary} — ${changelog}` : input.summary,
    )
  } catch (e) {
    // Which product, in which environment, and what the version would have said
    // (#482). Losing a history row must not fail the edit that caused it, so
    // this line is the whole record of the loss.
    console.error(
      `[versions] Failed to record a version for product #${input.productId} `
      + `(environment ${input.environmentId ?? 'all'}): ${input.summary}:`,
      e,
    )
  }
}

/** History for one product, newest first. */
export const listProductVersions = async (productId: number): Promise<Result<VersionRow[]>> => {
  const [product] = await db
    .select({ id: products.id })
    .from(products)
    .where(eq(products.id, productId))
    .limit(1)
  if (!product) return err(404, 'Not found')

  const rows = await db
    .select({
      id: productVersions.id,
      productId: productVersions.productId,
      environmentId: productVersions.environmentId,
      changelog: productVersions.changelog,
      summary: productVersions.summary,
      snapshot: productVersions.snapshot,
      createdBy: productVersions.createdBy,
      createdAt: productVersions.createdAt,
      authorName: users.name,
      environmentName: deploymentEnvironments.name,
    })
    .from(productVersions)
    .leftJoin(users, eq(productVersions.createdBy, users.id))
    .leftJoin(deploymentEnvironments, eq(productVersions.environmentId, deploymentEnvironments.id))
    .where(eq(productVersions.productId, productId))
    // id as tie-break: two changes inside the same millisecond must still come back
    // in the order they happened, or the diff view would pair the wrong versions.
    .orderBy(sql`${productVersions.createdAt} DESC`, sql`${productVersions.id} DESC`)

  return ok(rows as VersionRow[])
}

// ─── Diffing ──────────────────────────────────────────────────────────────────

export type FieldChange = { field: string; from: string; to: string }
export type ParameterChange =
  | { kind: 'added'; name: string; to: ParameterSnapshot }
  | { kind: 'removed'; name: string; from: ParameterSnapshot }
  | { kind: 'changed'; name: string; fields: FieldChange[] }

export interface SnapshotDiff {
  fields: FieldChange[]
  parameters: ParameterChange[]
  /** True when the two snapshots describe the same configuration. */
  identical: boolean
}

const OFFERING_FIELDS = [
  'productName',
  'productDescription',
  'price',
  'currency',
  'costCenterMode',
  'forcedCostCenter',
  // Changing the fixed billing account IS an offering change; without it two
  // versions that differ only in the overhead account diffed as identical.
  'overheadCostCenter',
  'trialEnabled',
  'trialDurationMinutes',
] as const

const PARAMETER_FIELDS = [
  'label',
  'type',
  'description',
  'defaultValue',
  'required',
  'sensitive',
] as const

/**
 * Diff two snapshots.
 *
 * Compares the fields that describe what a customer was offered, and deliberately
 * NOT capturedAt or environmentName — a snapshot taken a day later is not a change,
 * and every version of one offering names the same environment. Including either
 * would make every comparison report a difference.
 */
export const diffSnapshots = (
  from: ProductSnapshot | null,
  to: ProductSnapshot | null,
): SnapshotDiff => {
  if (!from || !to) return { fields: [], parameters: [], identical: false }

  const fields: FieldChange[] = []
  for (const field of OFFERING_FIELDS) {
    const before = String(from[field] ?? '')
    const after = String(to[field] ?? '')
    if (before !== after) fields.push({ field, from: before, to: after })
  }

  const byName = (list: ParameterSnapshot[]) => new Map(list.map((p) => [p.name, p]))
  const before = byName(from.parameters ?? [])
  const after = byName(to.parameters ?? [])

  const parameters: ParameterChange[] = []
  for (const [name, param] of after) {
    const previous = before.get(name)
    if (!previous) {
      parameters.push({ kind: 'added', name, to: param })
      continue
    }
    const changed: FieldChange[] = []
    for (const field of PARAMETER_FIELDS) {
      const a = String(previous[field] ?? '')
      const b = String(param[field] ?? '')
      if (a !== b) changed.push({ field, from: a, to: b })
    }
    if (changed.length > 0) parameters.push({ kind: 'changed', name, fields: changed })
  }
  for (const [name, param] of before) {
    if (!after.has(name)) parameters.push({ kind: 'removed', name, from: param })
  }

  // Sorted so the same pair of snapshots always produces the same diff, whatever
  // order the maps happened to iterate in.
  parameters.sort((a, b) => a.name.localeCompare(b.name))

  return { fields, parameters, identical: fields.length === 0 && parameters.length === 0 }
}

/**
 * Diff two version entries of one product.
 *
 * Both ids are checked against the product so a version belonging to a different
 * product cannot be compared through this product's URL.
 */
export const diffProductVersions = async (
  productId: number,
  fromId: number,
  toId: number,
): Promise<Result<SnapshotDiff & { fromVersionId: number; toVersionId: number }>> => {
  const rows = await db
    .select({ id: productVersions.id, snapshot: productVersions.snapshot })
    .from(productVersions)
    .where(and(eq(productVersions.productId, productId), inArray(productVersions.id, [fromId, toId])))

  const from = rows.find((r) => r.id === fromId)
  const to = rows.find((r) => r.id === toId)
  if (!from || !to) return err(404, 'Version not found')

  if (!from.snapshot || !to.snapshot) {
    // A product-level entry (a rename) carries no offering snapshot, so there is
    // nothing to compare field by field.
    return err(400, 'One of these versions has no configuration snapshot to compare')
  }

  return ok({
    ...diffSnapshots(from.snapshot, to.snapshot),
    fromVersionId: fromId,
    toVersionId: toId,
  })
}
