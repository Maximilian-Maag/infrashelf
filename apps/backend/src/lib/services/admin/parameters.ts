import { db } from '@/lib/db/client'
import { parameters, parameterProjects, products, productEnvironments, projects, type Parameter } from '@/lib/db/schema'
import { and, eq, inArray } from 'drizzle-orm'
import { ok, err, type Result } from '@/lib/services/result'
import { recordProductVersion } from '@/lib/services/versions'
import { logAudit, changedFields } from '@/lib/audit'
import { isEmptyUpdate, EMPTY_UPDATE_MESSAGE } from '@/lib/services/updates'
import { isReservedCiVariable } from '@/lib/ci/reserved'
import { SIZE_CODE_MAX_LENGTH } from '@/lib/services/sizes'

/**
 * A parameter's name becomes a CI trigger variable verbatim, so a definition
 * named after one the server decides hands the ordering user that decision —
 * REF chose the git ref the provisioning pipeline ran, TF_ACTION turned a
 * provisioning order into a destroy (issue #183).
 *
 * Braces, not belt: the trigger layer strips these names from every parameter map
 * regardless, because this check cannot reach the rows that already exist. What it
 * buys is that an admin finds out at the point of naming rather than by watching a
 * field silently do nothing.
 */
const reservedNameError = (name: string | undefined): Result<never> | null =>
  name !== undefined && isReservedCiVariable(name)
    ? err(400, `Parameter name "${name}" is reserved for a CI variable the server sets`)
    : null

export type ParameterType = 'string' | 'number' | 'bool' | 'dropdown' | 'size'

/**
 * A `size` parameter's map has to be usable, and the checks are cheap.
 *
 * Nothing here validates the keys against the offering's actual size codes: a
 * parameter is scoped to a product (or a category, or globally) and the sizes
 * belong to one product+environment offering, so the two do not line up at write
 * time. A size with no value is caught where it matters, at order time, naming
 * both the size and the parameter — see `validateAndApplyParameters`.
 */
export const sizeValuesError = (
  type: ParameterType | undefined,
  sizeValues: Record<string, string> | undefined,
): Result<never> | null => {
  if (sizeValues === undefined) return null
  if (type !== undefined && type !== 'size' && Object.keys(sizeValues).length > 0) {
    return err(400, 'Only a size parameter can carry per-size values')
  }
  for (const [code, value] of Object.entries(sizeValues)) {
    if (code.trim() === '') return err(400, 'A per-size value needs a size code')
    if (code.length > SIZE_CODE_MAX_LENGTH) {
      return err(400, `Size code ${code} is longer than ${SIZE_CODE_MAX_LENGTH} characters`)
    }
    // Bounded for the same reason a parameter value is: it becomes a CI trigger
    // variable, and an unbounded one is an unbounded request body.
    if (value.length > 4096) return err(400, `The value for size ${code} is too long`)
  }
  return null
}

export interface ParameterFilters {
  scope?: 'global' | 'category' | 'product'
  scopeId?: number
}

export interface CreateParameterInput {
  scope: 'global' | 'category' | 'product'
  scopeId?: number
  environmentId?: number | null
  name: string
  label?: string
  type: ParameterType
  description?: string
  defaultValue?: string
  required?: boolean
  sensitive?: boolean
  /** Required, and only meaningful, when `type` is `size`. See `sizeValuesError`. */
  sizeValues?: Record<string, string>
  /** Projects this parameter is narrowed to; empty or absent means all of them (#275). */
  projectIds?: number[]
}

export interface UpdateParameterInput {
  name?: string
  label?: string
  type?: ParameterType
  description?: string
  defaultValue?: string
  required?: boolean
  sensitive?: boolean
  environmentId?: number | null
  sizeValues?: Record<string, string>
  /**
   * The projects this parameter is narrowed to. An empty array means every
   * project, which is what every parameter is until somebody says otherwise
   * (#275).
   *
   * Absent on an update means "leave the narrowing alone"; `[]` means "clear
   * it". The distinction matters because an update that omits the field must
   * not silently unnarrow a parameter, and one that sends `[]` must be able to.
   */
  projectIds?: number[]
}

/**
 * Refuse a narrowing that names a project which does not exist.
 *
 * Without this the foreign key rejects the insert, the transaction throws, and
 * the route answers 500 — for what is an ordinary stale selection: an admin
 * with the form open while somebody else deletes a project sends an id that was
 * valid when the page loaded. That deserves a 400 saying which one.
 *
 * Checked before the transaction rather than by catching the FK violation:
 * translating a driver error back into "which id was it" means parsing a
 * message, and the message is the driver's to change.
 */
const unknownProjectIds = async (projectIds?: number[]): Promise<Result<never> | null> => {
  if (!projectIds || projectIds.length === 0) return null
  const unique = [...new Set(projectIds)]
  const found = await db
    .select({ id: projects.id })
    .from(projects)
    .where(inArray(projects.id, unique))
  const known = new Set(found.map((row) => row.id))
  const missing = unique.filter((id) => !known.has(id))
  if (missing.length === 0) return null
  return err(400, `No such project: ${missing.join(', ')}`)
}

export const listParameters = async (filters: ParameterFilters): Promise<Result<Parameter[]>> => {
  const conditions = []
  if (filters.scope) conditions.push(eq(parameters.scope, filters.scope))
  if (filters.scopeId !== undefined) conditions.push(eq(parameters.scopeId, filters.scopeId))

  const rows = await db
    .select()
    .from(parameters)
    .where(conditions.length > 0 ? and(...conditions) : undefined)
    .orderBy(parameters.scope, parameters.scopeId, parameters.name)

  // One query for every narrowing rather than one per parameter: the admin
  // screen renders the whole list at once, and N+1 here would be N+1 on every
  // page load.
  const links = rows.length === 0
    ? []
    : await db
        .select()
        .from(parameterProjects)
        .where(inArray(parameterProjects.parameterId, rows.map((r) => r.id)))

  const byParameter = new Map<number, number[]>()
  for (const link of links) {
    byParameter.set(link.parameterId, [...(byParameter.get(link.parameterId) ?? []), link.projectId])
  }

  return ok(rows.map((row) => ({ ...row, projectIds: byParameter.get(row.id) ?? [] })))
}

/**
 * Replace a parameter's project narrowing with exactly this set.
 *
 * Delete-then-insert rather than a diff: the set is small, the write is inside
 * the caller's transaction, and a diff would be more code for the same result
 * with more ways to be subtly wrong. An empty array leaves the parameter
 * unnarrowed, which is the default state and needs no rows at all (#275).
 */
const setProjectNarrowing = async (
  tx: Parameters<Parameters<typeof db.transaction>[0]>[0],
  parameterId: number,
  projectIds: number[],
): Promise<void> => {
  await tx.delete(parameterProjects).where(eq(parameterProjects.parameterId, parameterId))
  const unique = [...new Set(projectIds)]
  if (unique.length > 0) {
    await tx.insert(parameterProjects).values(unique.map((projectId) => ({ parameterId, projectId })))
  }
}

export const createParameter = async (
  input: CreateParameterInput,
  userId?: number,
): Promise<Result<Parameter>> => {
  const reserved = reservedNameError(input.name)
  if (reserved) return reserved
  const badSizes = sizeValuesError(input.type, input.sizeValues)
  if (badSizes) return badSizes
  const unknown = await unknownProjectIds(input.projectIds)
  if (unknown) return unknown

  // One transaction: a parameter that exists but whose narrowing did not get
  // written applies to EVERY project, which is the opposite of what was asked
  // for and the more dangerous of the two ways to fail (#275).
  const param = await db.transaction(async (tx) => {
    const [created] = await tx
      .insert(parameters)
      .values({
        scope: input.scope,
        scopeId: input.scopeId ?? 0,
        environmentId: input.environmentId ?? null,
        name: input.name,
        label: input.label ?? '',
        type: input.type,
        description: input.description ?? '',
        defaultValue: input.defaultValue ?? '',
        required: input.required ?? false,
        sensitive: input.sensitive ?? false,
        sizeValues: input.sizeValues ?? {},
      })
      .returning()
    if (input.projectIds && input.projectIds.length > 0) {
      await setProjectNarrowing(tx, created.id, input.projectIds)
    }
    return created
  })

  await recordParameterChange(param, 'added', userId ?? null)
  // `sensitive` is called out by name: it decides whether the value this parameter
  // carries is redacted everywhere downstream, so flipping it is a security event.
  await logAudit(
    userId ?? null,
    'parameter.created',
    param.id,
    `Created ${param.scope} parameter ${param.name}${param.sensitive ? ' (sensitive)' : ''}`,
  )
  return ok(param)
}

export const updateParameter = async (
  id: number,
  input: UpdateParameterInput,
  userId?: number,
): Promise<Result<Parameter>> => {
  if (isEmptyUpdate(input)) return err(400, EMPTY_UPDATE_MESSAGE)

  // Renames too, or the check would only cost an attacker one extra request.
  const reserved = reservedNameError(input.name)
  if (reserved) return reserved

  const badSizes = sizeValuesError(input.type, input.sizeValues)
  if (badSizes) return badSizes

  // Read the row first: an edit that MOVES the parameter to another environment
  // changes two sets of offerings, and the old one is only knowable from before.
  const [before] = await db.select().from(parameters).where(eq(parameters.id, id)).limit(1)

  // `projectIds` is not a column — it lives in `parameter_projects` — so it is
  // taken out before the row update and applied beside it, in one transaction.
  const { projectIds, ...columns } = input

  const unknown = await unknownProjectIds(projectIds)
  if (unknown) return unknown

  const updated = await db.transaction(async (tx) => {
    /*
     * An update that changes ONLY the narrowing leaves `columns` empty, and
     * drizzle throws "No values to set" on `.set({})` — so the one edit this
     * feature exists for would have answered 500. Read the row instead: it is
     * needed for the 404 either way, and there is nothing to write to it.
     */
    const [row] = Object.keys(columns).length === 0
      ? await tx.select().from(parameters).where(eq(parameters.id, id)).limit(1)
      : await tx
          .update(parameters)
          .set(columns)
          .where(eq(parameters.id, id))
          .returning()
    // Absent leaves the narrowing alone; `[]` clears it. An update that omitted
    // the field must not silently widen a parameter to every project.
    if (row && projectIds !== undefined) await setProjectNarrowing(tx, id, projectIds)
    return row
  })

  if (!updated) return err(404, 'Not found')

  await recordParameterChange(updated, 'updated', userId ?? null)
  if (before && before.environmentId !== updated.environmentId) {
    await recordParameterChange(before, 'removed', userId ?? null)
  }

  // Field names, plus the new state of `sensitive` when that is what moved: a
  // parameter turned non-sensitive stops being redacted in every order, infra
  // element and snapshot that renders it, and nothing else in the system says so.
  const sensitiveNote =
    input.sensitive !== undefined ? ` (sensitive now ${updated.sensitive})` : ''
  await logAudit(
    userId ?? null,
    'parameter.updated',
    id,
    `${changedFields(input)}${sensitiveNote}`,
  )

  return ok(updated)
}

export const deleteParameter = async (id: number, userId?: number): Promise<Result<void>> => {
  const deleted = await db
    .delete(parameters)
    .where(eq(parameters.id, id))
    .returning()

  if (!deleted.length) return err(404, 'Not found')

  await recordParameterChange(deleted[0], 'removed', userId ?? null)
  await logAudit(
    userId ?? null,
    'parameter.deleted',
    id,
    `Deleted ${deleted[0].scope} parameter ${deleted[0].name}`,
  )
  return ok(undefined)
}

/**
 * Record a catalogue version on every offering a parameter change affects
 * (issue #38).
 *
 * Parameter definitions are part of the offering snapshot, so without this a
 * change to one — its default, whether it is required, whether it is sensitive —
 * left no version to compare against and quietly folded itself into whatever
 * unrelated edit happened to be recorded next.
 *
 * One version per affected OFFERING rather than per product, because that is the
 * granularity a snapshot has. The fan-out is therefore the number of offerings in
 * the parameter's scope: one product's for 'product', a category's for 'category',
 * the catalogue's for 'global'. Best-effort, like the recorder itself — a change to
 * a parameter must not fail because its history could not be written.
 */
const recordParameterChange = async (
  param: { scope: string; scopeId: number; environmentId: number | null; name: string },
  action: 'added' | 'updated' | 'removed',
  userId: number | null,
): Promise<void> => {
  try {
    const conditions = []
    if (param.scope === 'product') conditions.push(eq(productEnvironments.productId, param.scopeId))
    if (param.scope === 'category') conditions.push(eq(products.categoryId, param.scopeId))
    // A parameter pinned to one environment only changes that offering; an
    // environment-agnostic one changes every offering of the products in scope.
    if (param.environmentId !== null) {
      conditions.push(eq(productEnvironments.environmentId, param.environmentId))
    }

    const offerings = await db
      .select({
        productId: productEnvironments.productId,
        environmentId: productEnvironments.environmentId,
      })
      .from(productEnvironments)
      .innerJoin(products, eq(productEnvironments.productId, products.id))
      .where(conditions.length > 0 ? and(...conditions) : undefined)

    for (const offering of offerings) {
      await recordProductVersion({
        productId: offering.productId,
        environmentId: offering.environmentId,
        summary: `Parameter ${param.name} ${action}`,
        userId,
      })
    }
  } catch (e) {
    // Names the parameter and its scope (#482). Best-effort by design — a
    // parameter edit must not fail because its history could not be written —
    // so this is the only trace, and "a version was not recorded" cannot be
    // matched to the change that caused it.
    console.error(
      `[parameters] Failed to record a version for ${param.scope} parameter "${param.name}" `
      + `(scope #${param.scopeId}, environment ${param.environmentId ?? 'all'}, ${action}):`,
      e,
    )
  }
}
