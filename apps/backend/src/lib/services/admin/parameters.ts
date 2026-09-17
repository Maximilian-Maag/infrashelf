import { createHash } from 'node:crypto'
import { db } from '@/lib/db/client'
import { parameters, parameterProjects, products, productEnvironments, projects, type Parameter } from '@/lib/db/schema'
import { and, eq, inArray, isNull } from 'drizzle-orm'
import { ok, err, type Result } from '@/lib/services/result'
import { recordProductVersion } from '@/lib/services/versions'
import { logAudit, changedFields } from '@/lib/audit'
import { isEmptyUpdate, EMPTY_UPDATE_MESSAGE } from '@/lib/services/updates'
import { isReservedCiVariable } from '@/lib/ci/reserved'
import { pgErrorCode, pgConstraintName, UNIQUE_VIOLATION } from '@/lib/db/pgError'
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

/**
 * What makes two definitions the same definition (#477, part of #404).
 *
 * Scope, scope id, name and environment — plus the SET OF PROJECTS the parameter
 * is narrowed to, which is the part a plain unique index cannot express because
 * it lives in `parameter_projects` (#275). Leaving it out of the key is not a
 * simplification: narrowing one definition to a project while another applies
 * everywhere is the whole feature, and treating those two as duplicates would
 * forbid it.
 *
 * Sorted and de-duplicated so `[7, 4]`, `[4, 7]` and `[4, 4, 7]` are one key —
 * the order the ids arrive in is the order a form serialised them, and nobody
 * meant it.
 */
export const narrowingKey = (projectIds: number[]): string =>
  [...new Set(projectIds)].sort((a, b) => a - b).join(',')

/**
 * The same key as a fingerprint, for the column the unique index is on (#404).
 *
 * sha256 of `narrowingKey`, so the value is a fixed 64 characters however many
 * projects a parameter names — a btree tuple has 2704 bytes to spend and a few
 * hundred ids would not fit. Nothing reads it back for meaning:
 * `parameter_projects` is the truth and this is derived from it.
 *
 * The empty set is sha256(''), which is also the column's DEFAULT, so a row
 * written without narrowing is already correct before this is called.
 */
export const narrowingFingerprint = (projectIds: number[]): string =>
  createHash('sha256').update(narrowingKey(projectIds)).digest('hex')

/**
 * Refuse a second definition of the same name in the same place (#477).
 *
 * `resolveParameterDefs` collapses the applicable rows to one effective
 * definition per name, by scope, then environment-specific over
 * all-environments, then project-narrowed over unnarrowed. Two rows alike on all
 * of those hit none of the rules, so #402's last-resort tie-break decides —
 * most recently created wins. That is repeatable, but nobody chose it, and
 * `sensitive` is the sharp edge: it decides whether the value is redacted
 * everywhere downstream (#131), so a disagreeing pair makes "is this secret
 * redacted?" a question about which row was written last.
 *
 * A check-then-insert, and honestly so: two simultaneous creates can still race
 * past it. The alternative is a unique index, which cannot be written while the
 * key contains a set from a child table — see the note on #404. What the race
 * produces is a duplicate somebody can then delete, with #402 deciding which of
 * the two applies meanwhile; what this stops is the ordinary case, an admin
 * defining the same thing twice and one of them silently doing nothing.
 */
const duplicateParameterError = async (
  key: {
    scope: 'global' | 'category' | 'product'
    scopeId: number
    name: string
    environmentId: number | null
    projectIds: number[]
  },
  excludeId?: number,
  // The transaction to read on, when this is asked inside one — a project
  // delete has to see its own uncommitted state (#404).
  executor: Pick<typeof db, 'select'> = db,
): Promise<Result<never> | null> => {
  const rivals = await executor
    .select({ id: parameters.id })
    .from(parameters)
    .where(and(
      eq(parameters.scope, key.scope),
      eq(parameters.scopeId, key.scopeId),
      eq(parameters.name, key.name),
      // `= NULL` is never true in SQL, so an all-environments parameter has to be
      // matched with IS NULL or every one of them would look unique.
      key.environmentId === null
        ? isNull(parameters.environmentId)
        : eq(parameters.environmentId, key.environmentId),
    ))

  // A row is not its own duplicate: an update that leaves the key alone must not
  // refuse itself.
  const others = rivals.filter((row) => row.id !== excludeId)
  if (others.length === 0) return null

  const links = await executor
    .select()
    .from(parameterProjects)
    .where(inArray(parameterProjects.parameterId, others.map((row) => row.id)))
  const narrowing = new Map<number, number[]>()
  for (const link of links) {
    narrowing.set(link.parameterId, [...(narrowing.get(link.parameterId) ?? []), link.projectId])
  }

  const wanted = narrowingKey(key.projectIds)
  const clash = others.find((row) => narrowingKey(narrowing.get(row.id) ?? []) === wanted)
  if (!clash) return null

  return err(
    409,
    `A ${key.scope} parameter named "${key.name}" already exists for the same environment and projects (#${clash.id})`,
  )
}

/**
 * The 409 the unique index gives, when the guard above was raced past (#404).
 *
 * `duplicateParameterError` is a check-then-insert: two simultaneous creates
 * both read no rival and both proceed. The index is what actually stops the
 * second one, and it stops it with a 23505 that would otherwise leave the route
 * answering 500 for a request the caller could fix.
 *
 * Exported so it can be tested against a REAL driver error rather than only
 * through a race whose timing no test controls — see the note in
 * `parameters.test.ts` on what the concurrent-create test does and does not
 * prove.
 *
 * The message deliberately does NOT name the winning definition the way the
 * guard's does. At this point the winner is a row this transaction never read,
 * and inventing a lookup for it would be a second query on a path that exists
 * only for a race — a re-read tells the caller to look, which is the same
 * instruction with one fewer way to be wrong.
 */
export const duplicateIndexError = (e: unknown, scope: string, name: string): Result<never> => {
  if (pgErrorCode(e) !== UNIQUE_VIOLATION) throw e
  const constraint = pgConstraintName(e) ?? ''
  if (!constraint.startsWith('parameters_definition_')) throw e
  return err(
    409,
    `A ${scope} parameter named "${name}" already exists for the same environment and projects. ` +
      'It was created at the same moment as this request; re-read the list to see it.',
  )
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
  // The fingerprint the unique index is on, written on the same connection as
  // the rows it describes (#404). Derived state, so it has exactly one place it
  // is allowed to be written from, and this is it.
  await tx
    .update(parameters)
    .set({ narrowingKey: narrowingFingerprint(unique) })
    .where(eq(parameters.id, parameterId))
}

/**
 * What deleting a project would do to the fingerprints of its parameters (#404).
 *
 * `parameter_projects.project_id` is ON DELETE CASCADE, so deleting a project
 * silently changes what its parameters are narrowed to — and `narrowing_key` is
 * derived from exactly that. Left alone, the column would describe a narrowing
 * the row no longer has, and the unique index would be enforcing against a
 * fingerprint nothing can reproduce.
 *
 * A trigger on `parameter_projects` would cover this without anybody
 * remembering to call it. It is not used, for the reason given on the column:
 * drizzle cannot see a trigger, so `db:push` would build a local database
 * without one and the divergence would only show up in production (#141).
 *
 * READ-ONLY, and deliberately separate from the write below. CodeRabbit found
 * why on PR #495 and it was real: applying the updates as they are computed
 * commits the ones that came before the first collision. `deleteProject`
 * RETURNS its refusal from inside `db.transaction`, and drizzle commits a
 * callback that returns — it rolls back only when the callback throws. Those
 * rows would be left holding a `narrowing_key` that disagrees with
 * `parameter_projects`, which is the one state this whole column exists to
 * prevent.
 *
 * So the plan is computed whole, and applied only when there is nothing wrong
 * with it.
 */
const planRefingerprintForProjectDelete = async (
  executor: Pick<typeof db, 'select'>,
  projectId: number,
): Promise<{
  collisions: { id: number; name: string }[]
  updates: { id: number; narrowingKey: string }[]
}> => {
  const affected = await executor
    .select({ id: parameterProjects.parameterId })
    .from(parameterProjects)
    .where(eq(parameterProjects.projectId, projectId))
  if (affected.length === 0) return { collisions: [], updates: [] }

  const ids = affected.map((row) => row.id)
  const rows = await executor.select().from(parameters).where(inArray(parameters.id, ids))
  const links = await executor
    .select()
    .from(parameterProjects)
    .where(inArray(parameterProjects.parameterId, ids))

  const remaining = new Map<number, number[]>()
  for (const link of links) {
    if (link.projectId === projectId) continue
    remaining.set(link.parameterId, [...(remaining.get(link.parameterId) ?? []), link.projectId])
  }

  const collisions: { id: number; name: string }[] = []
  const updates: { id: number; narrowingKey: string }[] = []
  for (const row of rows) {
    const narrowedTo = remaining.get(row.id) ?? []
    const rival = await duplicateParameterError(
      {
        scope: row.scope,
        scopeId: row.scopeId,
        name: row.name,
        environmentId: row.environmentId,
        projectIds: narrowedTo,
      },
      row.id,
      executor,
    )
    if (rival) collisions.push({ id: row.id, name: row.name })
    else updates.push({ id: row.id, narrowingKey: narrowingFingerprint(narrowedTo) })
  }

  return { collisions, updates }
}

/**
 * Apply that plan, inside the transaction that deletes the project. Called
 * before the delete, so the narrowing it reads is the one the cascade is about
 * to remove.
 *
 * Writes nothing at all when anything collides, so the refusal the caller
 * returns — which drizzle COMMITS — leaves every fingerprint exactly as it
 * found it. The caller decides what to say about a collision; this function
 * refuses to be the thing that guesses.
 */
export const refingerprintAfterProjectDelete = async (
  tx: Parameters<Parameters<typeof db.transaction>[0]>[0],
  projectId: number,
): Promise<{ collisions: { id: number; name: string }[] }> => {
  const { collisions, updates } = await planRefingerprintForProjectDelete(tx, projectId)
  if (collisions.length > 0) return { collisions }

  for (const update of updates) {
    await tx
      .update(parameters)
      .set({ narrowingKey: update.narrowingKey })
      .where(eq(parameters.id, update.id))
  }
  return { collisions: [] }
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
  const duplicate = await duplicateParameterError({
    scope: input.scope,
    scopeId: input.scopeId ?? 0,
    name: input.name,
    environmentId: input.environmentId ?? null,
    projectIds: input.projectIds ?? [],
  })
  if (duplicate) return duplicate

  // One transaction: a parameter that exists but whose narrowing did not get
  // written applies to EVERY project, which is the opposite of what was asked
  // for and the more dangerous of the two ways to fail (#275).
  let param: Parameter
  try {
    param = await db.transaction(async (tx) => {
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
          /*
           * Written here and not left to `setProjectNarrowing` below (#404).
           *
           * The unique index is checked by the INSERT, so a row that arrives
           * with the DEFAULT fingerprint and is corrected a statement later has
           * already been compared against every other definition AS IF it were
           * narrowed to nothing. That refuses exactly the case #275 exists for:
           * a definition narrowed to one project, created beside one that
           * applies everywhere.
           *
           * Found by the tests for that property, which went red the first time
           * this migration ran.
           */
          narrowingKey: narrowingFingerprint(input.projectIds ?? []),
        })
        .returning()
      if (input.projectIds && input.projectIds.length > 0) {
        await setProjectNarrowing(tx, created.id, input.projectIds)
      }
      return created
    })
  } catch (e) {
    return duplicateIndexError(e, input.scope, input.name)
  }

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

  /*
   * Checked against the row as it will be AFTER the edit (#477).
   *
   * A rename or a move to another environment lands the parameter somewhere
   * else, and the definition it could collide with is at the destination — so
   * the key is the merge of what is stored and what is being sent, with the
   * narrowing read from the child table when the update does not mention it
   * (absent means "leave it alone").
   *
   * Skipped when the row does not exist: that is the 404 below, and answering
   * 409 for a parameter that is not there would be a worse answer.
   */
  if (before) {
    const narrowedTo = projectIds ?? (await db
      .select({ projectId: parameterProjects.projectId })
      .from(parameterProjects)
      .where(eq(parameterProjects.parameterId, id))).map((row) => row.projectId)
    const duplicate = await duplicateParameterError({
      scope: before.scope,
      scopeId: before.scopeId,
      name: input.name ?? before.name,
      environmentId: input.environmentId !== undefined ? input.environmentId : before.environmentId,
      projectIds: narrowedTo,
    }, id)
    if (duplicate) return duplicate
  }

  let updated: Parameter | undefined
  try {
    updated = await db.transaction(async (tx) => {
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
      if (row && projectIds !== undefined) {
        await setProjectNarrowing(tx, id, projectIds)
        // Re-read for the fingerprint `setProjectNarrowing` just wrote (#404).
        const [withKey] = await tx.select().from(parameters).where(eq(parameters.id, id))
        return withKey
      }
      return row
    })
  } catch (e) {
    return duplicateIndexError(e, before?.scope ?? 'global', input.name ?? before?.name ?? '')
  }

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
