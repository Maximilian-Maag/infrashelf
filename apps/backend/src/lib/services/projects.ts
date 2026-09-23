import type { SessionUser } from '@infrashelf/types'
import { db } from '@/lib/db/client'
import { projects, users, costCenters, infrastructureElements, orders, type Project } from '@/lib/db/schema'
import { eq, sql, and, isNull, count } from 'drizzle-orm'
import { ok, err, type Result } from '@/lib/services/result'
import { fireDestroyTriggers, destroyVariables } from '@/lib/services/teardown'
import { isEmptyUpdate, EMPTY_UPDATE_MESSAGE } from '@/lib/services/updates'
import { logAudit, logAuditWith, changedFields } from '@/lib/audit'
import { refingerprintAfterProjectDelete } from '@/lib/services/admin/parameters'
import { resolveIntegrationEndpoint } from '@/lib/services/admin/integrations'
import { projectDashboardLink, type ObservabilityLink } from '@/lib/integrations/grafana'

export interface ProjectRow {
  id: number
  name: string
  description: string
  ownerId: number
  costCenterId: number | null
  createdAt: Date
  ownerName: string | null
  costCenterName: string | null
  /**
   * Where this project's machines can be watched (#546), or null when no
   * portal-wide Grafana integration is configured.
   *
   * Portal-wide only, deliberately: a project spans environments, so an
   * environment-scoped Grafana is not "the one for this project" — resolving one
   * would pick whichever environment happened to come first and quietly hide the
   * rest. The project dashboard is the view that answers "all of my machines".
   */
  observability: { grafana: ObservabilityLink | null }
}

export interface UpdateProjectInput {
  name?: string
  description?: string
  costCenterId?: number | null
}

export const listProjects = async (session: SessionUser): Promise<Result<ProjectRow[]>> => {
  const isAdmin = session.role === 'admin' || session.role === 'root'

  const rows = await db
    .select({
      id: projects.id,
      name: projects.name,
      description: projects.description,
      ownerId: projects.ownerId,
      costCenterId: projects.costCenterId,
      createdAt: projects.createdAt,
      ownerName: users.name,
      costCenterName: costCenters.name,
    })
    .from(projects)
    .leftJoin(users, eq(projects.ownerId, users.id))
    .leftJoin(costCenters, eq(projects.costCenterId, costCenters.id))
    // Retired projects are gone from every screen. Their rows survive only so the
    // orders inside them keep a `project_id` that resolves (#187).
    .where(isAdmin ? isNull(projects.retiredAt) : and(isNull(projects.retiredAt), eq(projects.ownerId, session.id)))
    .orderBy(sql`${projects.createdAt} DESC`)

  return ok(rows as ProjectRow[])
}

export const getProjectById = async (
  session: SessionUser,
  projectId: number,
): Promise<Result<ProjectRow>> => {
  const rows = await db
    .select({
      id: projects.id,
      name: projects.name,
      description: projects.description,
      ownerId: projects.ownerId,
      costCenterId: projects.costCenterId,
      createdAt: projects.createdAt,
      ownerName: users.name,
      costCenterName: costCenters.name,
    })
    .from(projects)
    .leftJoin(users, eq(projects.ownerId, users.id))
    .leftJoin(costCenters, eq(projects.costCenterId, costCenters.id))
    // A retired project is gone from every screen, including its own (#187).
    .where(and(eq(projects.id, projectId), isNull(projects.retiredAt)))
    .limit(1)

  if (!rows.length) return err(404, 'Project not found')

  const project = rows[0] as ProjectRow
  if (session.role === 'project_manager' && project.ownerId !== session.id) {
    return err(403, 'Forbidden')
  }

  // The project dashboard link (#546), resolved portal-wide — see ProjectRow.
  const grafana = await resolveIntegrationEndpoint('grafana', null)

  return ok({
    ...project,
    observability: {
      grafana: grafana ? projectDashboardLink(grafana.baseUrl, { projectId: project.id }) : null,
    },
  })
}

export const createProject = async (
  session: SessionUser,
  input: { name: string; description?: string; costCenterId?: number },
): Promise<Result<Project>> => {
  const [project] = await db
    .insert(projects)
    .values({
      name: input.name,
      description: input.description ?? '',
      ownerId: session.id,
      costCenterId: input.costCenterId ?? null,
    })
    .returning()

  // Projects were the last mutating endpoint in the backend writing nothing to
  // the append-only log — #137 closed without them, presumably because they live
  // in `services/` rather than `services/admin/` (#187).
  await logAudit(session.id, 'project.created', project.id, `Created project ${project.name}`)

  return ok(project)
}

export const updateProject = async (
  session: SessionUser,
  projectId: number,
  input: UpdateProjectInput,
): Promise<Result<Project>> => {
  const existing = await db
    .select({ ownerId: projects.ownerId })
    .from(projects)
    .where(eq(projects.id, projectId))
    .limit(1)

  if (!existing.length) return err(404, 'Project not found')

  if (session.role === 'project_manager' && existing[0].ownerId !== session.id) {
    return err(403, 'Forbidden')
  }

  const update: Partial<UpdateProjectInput> = {}
  if (input.name !== undefined) update.name = input.name
  if (input.description !== undefined) update.description = input.description
  if (input.costCenterId !== undefined) update.costCenterId = input.costCenterId

  // A well-formed `{}` used to reach `.set({})`, where Drizzle's mapUpdateSet
  // throws "No values to set" — an unhandled 500 any project manager could hit on
  // their own project (issue #143). Checked after the ownership check so it cannot
  // be used to probe which projects exist.
  if (isEmptyUpdate(update)) return err(400, EMPTY_UPDATE_MESSAGE)

  const [updated] = await db
    .update(projects)
    .set(update)
    .where(eq(projects.id, projectId))
    .returning()

  await logAudit(session.id, 'project.updated', projectId, changedFields(update))

  return ok(updated)
}

export const deleteProject = async (
  session: SessionUser,
  projectId: number,
): Promise<Result<void>> => {
  // ownership check for PMs
  if (session.role === 'project_manager') {
    const existing = await db.select({ ownerId: projects.ownerId }).from(projects).where(eq(projects.id, projectId)).limit(1)
    if (!existing.length) return err(404, 'Project not found')
    if (existing[0].ownerId !== session.id) return err(403, 'Forbidden')
  }

  // fire destroy webhooks for all active infra elements
  const activeInfra = await db
    .select({ id: infrastructureElements.id, orderId: infrastructureElements.orderId, productId: infrastructureElements.productId, environmentId: infrastructureElements.environmentId, parameters: infrastructureElements.parameters, sequence: infrastructureElements.sequence, sizeCode: infrastructureElements.sizeCode, stateKeyNamespace: infrastructureElements.stateKeyNamespace, stateKeys: infrastructureElements.stateKeys })
    .from(infrastructureElements)
    .where(and(eq(infrastructureElements.projectId, projectId), eq(infrastructureElements.status, 'active')))

  // Await the destroy trigger request BEFORE deleting the project. The delete
  // cascades to infrastructure_elements (ON DELETE CASCADE); firing the webhook
  // fire-and-forget raced the cascade. NOTE: awaiting only guarantees the CI
  // system accepted the trigger — the destroy pipeline still runs asynchronously
  // afterwards, so a late failure cannot be reconciled once the rows are gone.
  const triggerFailures: string[] = []
  for (const infra of activeInfra) {
    // Atomically claim the row (active → decommissioning) so two concurrent
    // deletes can't both fire a destroy pipeline for the same element.
    const claimed = await db
      .update(infrastructureElements)
      .set({ status: 'decommissioning' })
      .where(and(eq(infrastructureElements.id, infra.id), eq(infrastructureElements.status, 'active')))
      .returning({ id: infrastructureElements.id })
    if (!claimed.length) continue
    const destroyVars = destroyVariables(infra)
    try {
      // Fires destroy for BOTH product webhooks and pipeline stacks — stack-
      // provisioned infra would otherwise leak on project deletion.
      const outcome = await fireDestroyTriggers(infra, destroyVars)
      triggerFailures.push(...outcome.failures.map((f) => `infra #${infra.id}: ${f}`))
    } catch (e) {
      // The id was already on the next line, pushed into `triggerFailures`, and
      // missing from the log (#482). A destroy that could not be STARTED is how a
      // machine outlives the project it belonged to, so the line has to say which one.
      console.error(`[destroy] Could not start the destroy for element #${infra.id}:`, e)
      triggerFailures.push(`infra #${infra.id}: ${e instanceof Error ? e.message : String(e)}`)
    }
  }

  // Block the delete when any destroy could not be started — the cascade would
  // remove the infrastructure_elements rows and leave the provisioned
  // infrastructure running with nothing left to reconcile it against. The
  // claimed rows keep their state, so the operator can fix the CI side and retry.
  if (triggerFailures.length > 0) {
    return err(
      502,
      `Cannot delete project: ${triggerFailures.length} destroy trigger(s) could not be started, so deleting now would leak infrastructure. Fix and retry — ${triggerFailures.join('; ')}`,
    )
  }

  /*
   * Whether this delete has to preserve order history (#187).
   *
   * `orders.project_id` is ON DELETE CASCADE and `order_comments.order_id`
   * cascades from there, so deleting a project deleted every order inside it —
   * and with them `orders.product_snapshot`, the column that exists precisely so
   * a later catalogue change cannot rewrite what a customer was charged. The
   * spend those orders represent then leaves the dashboard, the CSV and the PDF,
   * retroactively and permanently.
   *
   * #142 gave `deleteProduct` and `deleteCategory` the retire-instead-of-delete
   * treatment. This one never got it, and it is the one of the three that
   * cascades to `orders` DIRECTLY rather than through `products`.
   *
   * So: a project that holds orders is RETIRED and its row stays, as the
   * `project_id` those orders point at. A project that never held one has no
   * history to keep and is still deleted outright.
   */
  return await db.transaction(async (tx) => {
    // FOR UPDATE and the count in the same transaction, so an order placed
    // between the two cannot be cascaded away by a delete that decided the
    // project was empty.
    const [locked] = await tx
      .select({ id: projects.id, name: projects.name, retiredAt: projects.retiredAt })
      .from(projects)
      .where(eq(projects.id, projectId))
      .limit(1)
      .for('update')

    // An already-retired project is gone from every screen, so asking to delete
    // it again is a 404 like any other missing project.
    if (!locked || locked.retiredAt !== null) return err(404, 'Project not found')

    const [{ orderCount }] = await tx
      .select({ orderCount: count() })
      .from(orders)
      .where(eq(orders.projectId, projectId))

    if (orderCount > 0) {
      await tx.update(projects).set({ retiredAt: new Date() }).where(eq(projects.id, projectId))

      // On the transaction's own connection, so it rolls back with the retirement.
      await logAuditWith(
        tx,
        session.id,
        'project.retired',
        projectId,
        `Retired project ${locked.name} (${orderCount} order(s) keep their history), decommissioning ${activeInfra.length} infrastructure element(s)`,
      )

      return ok(undefined)
    }

    /*
     * A parameter narrowed to this project is about to be narrowed to one fewer
     * (#404). `parameter_projects.project_id` cascades, and `narrowing_key` is
     * derived from those rows, so the fingerprint has to be recomputed here —
     * before the delete, while the narrowing being removed is still readable,
     * and on this transaction so it rolls back with everything else.
     *
     * A collision is possible and it is refused rather than resolved: losing the
     * narrowing can make a parameter identical to one that already exists, and
     * the two were distinct definitions right up until this request. Deleting
     * one of them as a side effect of deleting a PROJECT is not something an
     * operator asked for, and #402 decides which applies meanwhile, so nothing
     * is broken by saying so and stopping.
     */
    const { collisions } = await refingerprintAfterProjectDelete(tx, projectId)
    if (collisions.length > 0) {
      return err(
        409,
        `Cannot delete project ${locked.name}: ${collisions.length} parameter definition(s) ` +
          'are narrowed to it and would become duplicates of definitions that already exist — ' +
          `${collisions.map((c) => `"${c.name}" (#${c.id})`).join(', ')}. ` +
          'Delete or re-narrow those first.',
      )
    }

    await tx.delete(projects).where(eq(projects.id, projectId))

    await logAuditWith(
      tx,
      session.id,
      'project.deleted',
      projectId,
      `Deleted empty project ${locked.name}, decommissioning ${activeInfra.length} infrastructure element(s)`,
    )

    return ok(undefined)
  })
}
