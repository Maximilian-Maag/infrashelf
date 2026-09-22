import { db } from '@/lib/db/client'
import { countWhere } from '@/lib/db/queries'
import { costCenters, projects, orders } from '@/lib/db/schema'
import type { CostCenter } from '@infrashelf/types'
import { count, eq } from 'drizzle-orm'
import { ok, err, type Result } from '@/lib/services/result'
import { logAudit, logAuditWith, changedFields } from '@/lib/audit'
import { isEmptyUpdate, EMPTY_UPDATE_MESSAGE } from '@/lib/services/updates'

/**
 * The four fields a cost centre IS (#539), selected rather than returned as a row.
 *
 * #325 put a budget on this table — `budgetAmount`, `budgetCurrency`,
 * `budgetPeriod`, `budgetBehaviour` — and made every verb that touches it `root`,
 * on purpose: "a budget is a spending limit, and who may see one is the same
 * question as who may set it". A bare `select()` or `returning()` here would give
 * those columns to callers who are not root, and `listCostCenters` is reached by
 * any signed-in session at all.
 *
 * It is also the contract: `CostCenter` in `@infrashelf/types` is these four, and
 * so is `costCenterSchema` in the spec. Naming the columns keeps a response equal
 * to the thing it is documented to be — and a column added to the table reaches a
 * client only if somebody writes it here.
 */
const costCenterColumns = {
  id: costCenters.id,
  code: costCenters.code,
  name: costCenters.name,
  active: costCenters.active,
}

export interface CreateCostCenterInput {
  code: string
  name: string
  active?: boolean
}

export interface UpdateCostCenterInput {
  code?: string
  name?: string
  active?: boolean
}

export const listCostCenters = async (): Promise<Result<CostCenter[]>> => {
  const rows = await db
    .select(costCenterColumns)
    .from(costCenters)
    .orderBy(costCenters.code)

  return ok(rows)
}

export const createCostCenter = async (
  input: CreateCostCenterInput,
  actorId?: number,
): Promise<Result<CostCenter>> => {
  const [cc] = await db
    .insert(costCenters)
    .values({ code: input.code, name: input.name, active: input.active ?? true })
    .returning(costCenterColumns)

  await logAudit(actorId ?? null, 'cost_center.created', cc.id, `Created cost center ${cc.code}`)

  return ok(cc)
}

export const getCostCenterById = async (id: number): Promise<Result<CostCenter>> => {
  const rows = await db
    .select(costCenterColumns)
    .from(costCenters)
    .where(eq(costCenters.id, id))
    .limit(1)

  if (!rows.length) return err(404, 'Not found')
  return ok(rows[0])
}

export const updateCostCenter = async (
  id: number,
  input: UpdateCostCenterInput,
  actorId?: number,
): Promise<Result<CostCenter>> => {
  if (isEmptyUpdate(input)) return err(400, EMPTY_UPDATE_MESSAGE)

  const [updated] = await db
    .update(costCenters)
    .set(input)
    .where(eq(costCenters.id, id))
    .returning(costCenterColumns)

  if (!updated) return err(404, 'Not found')

  await logAudit(actorId ?? null, 'cost_center.updated', id, changedFields(input))

  return ok(updated)
}

export const deleteCostCenter = async (id: number, actorId?: number): Promise<Result<void>> => {
  // Same shape as deleteEnvironment: the reference checks and the DELETE in one
  // transaction, holding FOR UPDATE on the cost centre row, so a concurrent
  // insert of a referencing row (which takes a FK KEY-SHARE lock on that same
  // row) cannot slip in between the pre-check and the delete.
  return db.transaction(async (tx): Promise<Result<void>> => {
    const existing = await tx
      .select({ id: costCenters.id, code: costCenters.code })
      .from(costCenters)
      .where(eq(costCenters.id, id))
      .for('update')
      .limit(1)
    if (!existing.length) return err(404, 'Not found')

    // projects.cost_center_id and orders.cost_center_id reference this without
    // ON DELETE CASCADE, so the bare delete raised 23503 and escaped as an
    // unhandled 500 — the frontend's "Delete does nothing" symptom.
    // product_environments.overhead_cost_center_id is deliberately NOT a blocker:
    // it is ON DELETE SET NULL, so the database handles it.
    // Counted by Postgres: the message quotes exact figures, but a cost center
    // that has been in use for a year references thousands of orders and every
    // one of them was being selected inside this transaction just to be counted.
    const projectCount = await countWhere(tx.select({ n: count() }).from(projects).where(eq(projects.costCenterId, id)))
    const orderCount = await countWhere(tx.select({ n: count() }).from(orders).where(eq(orders.costCenterId, id)))

    const blockers: string[] = []
    if (projectCount > 0) blockers.push(`${projectCount} project(s)`)
    if (orderCount > 0) blockers.push(`${orderCount} order(s)`)

    if (blockers.length > 0) {
      return err(
        409,
        `Cannot delete cost center: ${blockers.join(', ')} still reference it. Deactivate it instead (set active to false) so it can no longer be chosen.`,
      )
    }

    const deleted = await tx
      .delete(costCenters)
      .where(eq(costCenters.id, id))
      .returning({ id: costCenters.id })

    if (!deleted.length) return err(404, 'Not found')

    // On the transaction's own connection, so it rolls back with the delete.
    await logAuditWith(tx, actorId ?? null, 'cost_center.deleted', id, `Deleted cost center ${existing[0].code}`)

    return ok(undefined)
  })
}
