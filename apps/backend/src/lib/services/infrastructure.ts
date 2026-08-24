import type { SessionUser } from '@open-hybrid-cloud/types'
import { db } from '@/lib/db/client'
import {
  infrastructureElements,
  deploymentEnvironments,
  projects,
  orders,
  productEnvironments,
  costCenters,
} from '@/lib/db/schema'
import { eq, and, sql, gte, lte } from 'drizzle-orm'
import { logAudit } from '@/lib/audit'
import { fireDestroyTriggers, destroyVariables } from '@/lib/services/teardown'
import { TRIGGERING_KEY, TRIGGERING_VALUE } from '@/lib/webhook/settle'
import { recordOrderPipelineId, finishOrderTriggerRun } from '@/lib/services/pipelineTracking'
import { triggerProductWebhooksTracked, triggerPipelineStacksTracked } from '@/lib/ci/webhooks'
import { ELEMENT_SEQUENCE_VAR, STATE_KEY_NAMESPACE_VAR } from '@/lib/ci/stateKey'
import { withoutReservedCiVariables } from '@/lib/ci/reserved'
import { ok, err, type Result } from '@/lib/services/result'
import { trialVariables, trialExpiry } from '@/lib/services/trial'
import {
  loadSensitiveParameterNames,
  loadSnapshotSensitiveNames,
  redactParameters,
  redactParametersForOrders,
  union,
} from '@/lib/services/parameterRedaction'

export interface InfraRow {
  id: number
  orderId: number
  projectId: number
  environmentId: number
  productId: number
  status: string
  parameters: Record<string, string>
  pipelineId: string[]
  outputs: Record<string, string>
  deployedAt: Date | null
  /** When set, the element is torn down automatically at or after this instant. */
  scheduledDecommissionAt: Date | null
  /** The size this element was ordered at (issue #98); null when it has none. */
  sizeCode: string | null
  /**
   * Which of its order's elements this is, 1-based (issue #104). Shown so a row of
   * twenty identical elements can be told apart, and it is what the element's
   * Terraform state key is derived from.
   */
  sequence: number
  /** How many elements the order asked for, so a row can read "3 of 20". */
  orderQuantity: number | null
  productName: string
  environmentName: string | null
  projectName: string | null
  /**
   * Status of the order this element was provisioned from.
   *
   * Exposed because the element's own status cannot express a failed deployment:
   * it is inserted `active` the moment provisioning starts and stays there when
   * the pipeline fails. Without this the list shows `active` for infrastructure
   * that was never successfully provisioned — and the Retry action (issue #29)
   * has nothing to key off.
   */
  orderStatus: string | null
}

/** The `status` values an infrastructure element can actually hold. */
export const INFRA_STATUSES = ['active', 'decommissioning', 'decommissioned'] as const
export type InfraStatus = (typeof INFRA_STATUSES)[number]

/**
 * What the list can be filtered by, which is NOT the same set.
 *
 * 'failed' is not a stored status — a failed deployment is an `active` element
 * whose ORDER failed (see orderStatus above), which is what the row already
 * displays. Without it in the filter vocabulary the list showed a Failed badge it
 * could not filter for, and 'active' silently included those rows.
 */
export const INFRA_STATUS_FILTERS = [...INFRA_STATUSES, 'failed'] as const
export type InfraStatusFilter = (typeof INFRA_STATUS_FILTERS)[number]

export const INFRA_SORT_FIELDS = ['date', 'name', 'status'] as const
export type InfraSortField = (typeof INFRA_SORT_FIELDS)[number]

export interface InfraFilters {
  productId?: number
  projectId?: number
  environmentId?: number
  /** Free text matched against product, environment and project name. */
  search?: string
  status?: InfraStatusFilter
  /** Inclusive lower / upper bound on `deployed_at`. */
  deployedFrom?: Date
  deployedTo?: Date
  sort?: InfraSortField
  direction?: 'asc' | 'desc'
}

// Matched against the same expression the row displays, so a search hit is
// always visibly explicable. Deliberately excludes `parameters`: the values
// there include ones flagged sensitive, and a substring match would turn the
// filter into an oracle for confirming a secret's value.
const productNameSql = sql<string>`(
  SELECT name FROM product_translations
  WHERE product_id = ${infrastructureElements.productId}
    AND language_code = 'en'
  LIMIT 1
)`

export const listInfrastructure = async (
  session: SessionUser,
  filters: InfraFilters,
): Promise<Result<InfraRow[]>> => {
  const isAdmin = session.role === 'admin' || session.role === 'root'

  const conditions: ReturnType<typeof sql>[] = []
  if (!isAdmin) conditions.push(sql`${projects.ownerId} = ${session.id}`)
  if (filters.productId) conditions.push(sql`${infrastructureElements.productId} = ${filters.productId}`)
  if (filters.projectId) conditions.push(sql`${infrastructureElements.projectId} = ${filters.projectId}`)
  if (filters.environmentId) conditions.push(sql`${infrastructureElements.environmentId} = ${filters.environmentId}`)
  if (filters.status === 'failed') {
    // The failure lives on the order, not the element.
    conditions.push(sql`${orders.status} = 'failed'`)
  } else if (filters.status === 'active') {
    // A failed deployment is stored 'active', and the row shows it as Failed — so
    // including it here would contradict the badge the user is looking at.
    conditions.push(sql`${infrastructureElements.status} = 'active'`)
    conditions.push(sql`(${orders.status} IS NULL OR ${orders.status} <> 'failed')`)
  } else if (filters.status) {
    conditions.push(sql`${infrastructureElements.status} = ${filters.status}`)
  }

  if (filters.search) {
    // Escape the LIKE metacharacters so a literal % or _ in the query narrows
    // the result set instead of widening it to everything.
    const pattern = `%${filters.search.replace(/[\\%_]/g, (c) => `\\${c}`)}%`
    conditions.push(sql`(
      ${productNameSql} ILIKE ${pattern} ESCAPE '\\'
      OR ${deploymentEnvironments.name} ILIKE ${pattern} ESCAPE '\\'
      OR ${projects.name} ILIKE ${pattern} ESCAPE '\\'
    )`)
  }

  // Both bounds are inclusive; the caller passes the exact boundary it wants
  // (parseInfraFilters widens a bare date to cover the whole day). gte/lte
  // rather than a raw sql template because the driver needs the column's type to
  // bind a JS Date — a hand-written `>= ${date}` fails at query time.
  if (filters.deployedFrom) conditions.push(gte(infrastructureElements.deployedAt, filters.deployedFrom))
  if (filters.deployedTo) conditions.push(lte(infrastructureElements.deployedAt, filters.deployedTo))

  const where = conditions.length > 0
    ? conditions.reduce((acc, cond) => sql`${acc} AND ${cond}`)
    : undefined

  // Whitelisted rather than interpolated — the sort field reaches this from a
  // query string.
  const direction = filters.direction === 'asc' ? sql`ASC` : sql`DESC`
  const orderBy = {
    date: sql`${infrastructureElements.deployedAt} ${direction}`,
    name: sql`${productNameSql} ${direction}`,
    status: sql`${infrastructureElements.status} ${direction}`,
  }[filters.sort ?? 'date']

  const rows = await db
    .select({
      id: infrastructureElements.id,
      orderId: infrastructureElements.orderId,
      projectId: infrastructureElements.projectId,
      environmentId: infrastructureElements.environmentId,
      productId: infrastructureElements.productId,
      status: infrastructureElements.status,
      parameters: infrastructureElements.parameters,
      pipelineId: infrastructureElements.pipelineId,
      outputs: infrastructureElements.outputs,
      deployedAt: infrastructureElements.deployedAt,
      scheduledDecommissionAt: infrastructureElements.scheduledDecommissionAt,
      sizeCode: infrastructureElements.sizeCode,
      sequence: infrastructureElements.sequence,
      orderQuantity: orders.quantity,
      productName: productNameSql,
      environmentName: deploymentEnvironments.name,
      projectName: projects.name,
      orderStatus: orders.status,
    })
    .from(infrastructureElements)
    .leftJoin(
      deploymentEnvironments,
      eq(infrastructureElements.environmentId, deploymentEnvironments.id),
    )
    .leftJoin(projects, eq(infrastructureElements.projectId, projects.id))
    .leftJoin(orders, eq(infrastructureElements.orderId, orders.id))
    .where(where)
    // Tie-break on id so a page of rows sharing a sort key (same status, same
    // deploy timestamp) comes back in a stable order across requests — an
    // export is expected to match the list it was taken from.
    .orderBy(orderBy, sql`${infrastructureElements.id} DESC`)

  // The list is an API endpoint in its own right (GET /api/infrastructure), so it
  // cannot rely on a consumer redacting: the CSV export happens to do it, which
  // left the export as the ONLY line of defence and the list itself serving the
  // values in cleartext (issue #131). Redacting here makes the export's own pass a
  // harmless no-op, and matches the search filter above — which already excludes
  // `parameters` precisely because these values are secret.
  return ok(await redactParametersForOrders(rows as InfraRow[], (row) => row.orderId))
}

export interface InfraFacets {
  environments: { id: number; name: string }[]
  projects: { id: number; name: string }[]
  products: { id: number; name: string }[]
}

/**
 * The distinct environments, projects and products present in the caller's
 * visible infrastructure — the option lists for the list page's filters.
 *
 * Derived from the elements rather than from the admin catalogue endpoints for
 * two reasons: those are root-only, so a project manager could not populate the
 * dropdowns at all; and offering an environment with nothing deployed in it only
 * gives the user a way to filter down to an empty list.
 *
 * Scoping mirrors listInfrastructure exactly, so the facets can never hint at
 * the existence of a project the caller cannot otherwise see.
 */
export const listInfrastructureFacets = async (
  session: SessionUser,
): Promise<Result<InfraFacets>> => {
  const isAdmin = session.role === 'admin' || session.role === 'root'
  const scope = isAdmin ? undefined : sql`${projects.ownerId} = ${session.id}`

  const rows = await db
    .selectDistinct({
      environmentId: infrastructureElements.environmentId,
      environmentName: deploymentEnvironments.name,
      projectId: infrastructureElements.projectId,
      projectName: projects.name,
      productId: infrastructureElements.productId,
      productName: productNameSql,
    })
    .from(infrastructureElements)
    .leftJoin(
      deploymentEnvironments,
      eq(infrastructureElements.environmentId, deploymentEnvironments.id),
    )
    .leftJoin(projects, eq(infrastructureElements.projectId, projects.id))
    .where(scope)

  const collect = (
    pairs: { id: number; name: string | null }[],
  ): { id: number; name: string }[] => {
    const byId = new Map<number, string>()
    for (const { id, name } of pairs) if (!byId.has(id)) byId.set(id, name ?? `#${id}`)
    return [...byId.entries()]
      .map(([id, name]) => ({ id, name }))
      .sort((a, b) => a.name.localeCompare(b.name))
  }

  return ok({
    environments: collect(rows.map((r) => ({ id: r.environmentId, name: r.environmentName }))),
    projects: collect(rows.map((r) => ({ id: r.projectId, name: r.projectName }))),
    products: collect(rows.map((r) => ({ id: r.productId, name: r.productName }))),
  })
}

/**
 * Re-fire provisioning for an element whose deployment failed (issue #29).
 *
 * On the failure model, since issue #29 describes one this codebase does not
 * have: there is no `failed` infrastructure status. The element is inserted as
 * `active` the moment provisioning STARTS (see approveOrder / createOrder), and a
 * failed pipeline sets `orders.status = 'failed'` while leaving the element
 * `active` — claiming infrastructure that was never successfully provisioned.
 * So the retryable condition lives on the order, and that is what this checks.
 *
 * Recovery uses the element's stored parameters, which are the ones the order was
 * placed with, so a retry cannot quietly provision something different from what
 * was approved. Previously the only route was a brand-new order, which duplicated
 * the record and lost the original approval context.
 */
export const retryProvisioning = async (
  session: SessionUser,
  infraId: number,
): Promise<Result<{ pipelineIds: string[] }>> => {
  const [infra] = await db
    .select()
    .from(infrastructureElements)
    .where(eq(infrastructureElements.id, infraId))
    .limit(1)

  if (!infra) return err(404, 'Infrastructure element not found')

  const [order] = await db
    .select({ id: orders.id, status: orders.status, isTrial: orders.isTrial })
    .from(orders)
    .where(eq(orders.id, infra.orderId))
    .limit(1)

  if (!order) return err(404, 'Order not found')
  if (order.status !== 'failed') {
    return err(400, `Only a failed deployment can be retried — this order is ${order.status}`)
  }

  // Atomically claim the order (failed → provisioning) and clear the previous
  // attempt's pipeline tracking in the same statement. Only one concurrent
  // caller can win, so a double-clicked Retry cannot fire two sets of pipelines
  // against the same infrastructure.
  //
  // The claim opens this retry's trigger run as well (see pipelineTracking): the
  // ids below are recorded as they start, so a pipeline that fails instantly can
  // still find its order — and the `triggering` entry is what stops the FIRST of
  // them succeeding from completing an order whose remaining elements have not
  // been re-fired yet.
  const claimed = await db
    .update(orders)
    .set({
      status: 'provisioning',
      pipelineId: [],
      pipelineStatus: { [TRIGGERING_KEY]: TRIGGERING_VALUE },
      updatedAt: new Date(),
    })
    .where(and(eq(orders.id, order.id), eq(orders.status, 'failed')))
    .returning({ id: orders.id })

  if (!claimed.length) return err(409, 'Retry already in progress for this deployment')

  // A trial's CI variables are server-generated, so they are not in the element's
  // stored parameters — without them the retried pipeline would run as an ordinary
  // deployment and lose the trial intent the order was placed with. The duration is
  // re-read from the offering, exactly as initial provisioning does, so a duration
  // an admin corrected in the meantime is the one that applies.
  const trialDurationMinutes = order.isTrial
    ? await resolveTrialDuration(infra.productId, infra.environmentId)
    : 0

  // EVERY element of the order, not only the one whose Retry was clicked (issue
  // #104). The order is the unit that failed and the unit that has to become
  // 'completed' again: re-firing one element of twenty would leave the order
  // waiting on that element alone and complete it while nineteen were still
  // broken. For the one-element orders that were the only kind before quantity
  // existed, this loop runs exactly once and does exactly what it always did.
  const siblings = await db
    .select()
    .from(infrastructureElements)
    .where(eq(infrastructureElements.orderId, infra.orderId))
    .orderBy(infrastructureElements.sequence, infrastructureElements.id)

  const elements = siblings.length ? siblings : [infra]

  const outcome: { pipelineIds: string[]; failures: string[] } = { pipelineIds: [], failures: [] }
  const perElementPipelines = new Map<number, string[]>()

  for (const element of elements) {
    const variables = {
      // Same filter the provisioning and teardown paths apply: a stored parameter
      // named after a server-owned variable (issue #183) is not the retry's to
      // honour, and REF in particular would decide which git ref this rerun uses.
      ...withoutReservedCiVariables(element.parameters as Record<string, string>),
      // Pipeline stacks derive TF_STATE_NAME from stateKeyParam ?? ORDER_ID, and
      // the stored parameters do not carry the server-generated order id. Reusing
      // the ORIGINAL order id is the point: the retry has to target the same
      // Terraform state the failed attempt was working on.
      ORDER_ID: String(infra.orderId),
      // And the element's own sequence, for the same reason: it is what suffixes
      // the state key, so element 3 retries element 3's state and not element 1's.
      [ELEMENT_SEQUENCE_VAR]: String(element.sequence),
      // And the element's own state-key namespace, unchanged: a retry works on the
      // state the failed attempt was working on, so an element provisioned before
      // #183 (namespace NULL) has to keep deriving its key from the raw parameter.
      ...(element.stateKeyNamespace !== null
        ? { [STATE_KEY_NAMESPACE_VAR]: element.stateKeyNamespace }
        : {}),
      ...(element.sizeCode !== null ? { SIZE: element.sizeCode } : {}),
      ...(order.isTrial ? trialVariables(trialDurationMinutes) : {}),
    }

    const onStarted = (pipelineId: string) => recordOrderPipelineId(order.id, pipelineId)

    try {
      const webhooks = await triggerProductWebhooksTracked(element.productId, element.environmentId, variables, onStarted)
      const stacks = await triggerPipelineStacksTracked(element.productId, element.environmentId, variables, onStarted)
      const started = [...webhooks.pipelineIds, ...stacks.pipelineIds]
      perElementPipelines.set(element.id, started)
      outcome.pipelineIds.push(...started)
      outcome.failures.push(...webhooks.failures, ...stacks.failures)
    } catch (e) {
      // A throw on the FIRST element means nothing is running, so the claim can be
      // released cleanly. Once something is running it cannot be recalled, so the
      // failure is recorded as a sentinel instead and the order stays unfinished.
      if (outcome.pipelineIds.length === 0) {
        await releaseRetryClaim(order.id)
        throw e
      }
      outcome.failures.push(
        `element #${element.id}: ${e instanceof Error ? e.message : String(e)}`,
      )
    }
  }

  if (outcome.pipelineIds.length === 0) {
    // Nothing started, so nothing changed: hand the order back to 'failed' so
    // the Retry button stays available rather than leaving it stuck in a
    // 'provisioning' state no callback will ever resolve.
    await releaseRetryClaim(order.id)
    await logAudit(
      session.id,
      'infra.retry_failed',
      infraId,
      `No pipeline could be started: ${outcome.failures.join('; ')}`,
    )
    return err(502, `Could not start the deployment: ${outcome.failures.join('; ')}`)
  }

  // The elements are rewritten BEFORE the order's run is closed: closing it can
  // complete the order there and then (every pipeline may already have reported
  // while this loop was still firing), and completing an order reads each
  // element's pipeline ids to attribute the Terraform outputs.
  for (const element of elements) {
    await db
      .update(infrastructureElements)
      .set({
        status: 'active',
        // Its OWN pipelines, not the order's union: the element has to be
        // trackable and tearable-down on its own ("decommission 3 of 20").
        pipelineId: perElementPipelines.get(element.id) ?? [],
        pipelineStatus: {},
        // Outputs are parsed from the job trace on success. Any left over from an
        // earlier attempt describe infrastructure this retry is about to replace.
        outputs: {},
        // A trial's clock restarts here for the same reason it starts at
        // provisioning rather than ordering: the failed attempt may have burned the
        // whole window, and the sweep would tear this retry down on sight. Only a
        // trial's schedule is touched — a decommission an operator scheduled by hand
        // (issue #30) must survive a retry.
        ...(order.isTrial ? { scheduledDecommissionAt: trialExpiry(trialDurationMinutes) } : {}),
      })
      .where(eq(infrastructureElements.id, element.id))
  }

  // Closes the run: reconciles the recorded ids and replaces the `triggering`
  // entry with one sentinel per trigger that failed to start. A failed trigger
  // contributes no pipeline id, so without the sentinel the order would complete
  // as soon as the pipelines that DID start succeed — reporting a successful
  // retry while one webhook never fired.
  await finishOrderTriggerRun(
    order.id,
    outcome.pipelineIds,
    outcome.failures,
    `All pipelines of order ${order.id} succeeded`,
  )

  await logAudit(
    session.id,
    'infra.retried',
    infraId,
    `Deployment retried by ${session.email} (order #${infra.orderId}, ${outcome.pipelineIds.length} pipeline(s))`,
  )

  if (outcome.failures.length > 0) {
    // Some pipelines ARE running and cannot be recalled, so the order stays
    // 'provisioning' and the sentinels above keep it from ever reporting itself
    // complete. Tell the operator what still needs attention.
    return err(
      502,
      `Retry started ${outcome.pipelineIds.length} pipeline(s), but ${outcome.failures.length} could not be started: ${outcome.failures.join('; ')}`,
    )
  }

  return ok({ pipelineIds: outcome.pipelineIds })
}

/**
 * The trial duration currently configured for an offering.
 *
 * Falls back to the schema default rather than blocking a retry an operator asked
 * for: an offering withdrawn or misconfigured since the order was placed still
 * gets a time-boxed deployment, which is the point of the trial.
 */
const resolveTrialDuration = async (productId: number, environmentId: number): Promise<number> => {
  const [offering] = await db
    .select({ trialDurationMinutes: productEnvironments.trialDurationMinutes })
    .from(productEnvironments)
    .where(
      and(
        eq(productEnvironments.productId, productId),
        eq(productEnvironments.environmentId, environmentId),
      ),
    )
    .limit(1)
  return offering && offering.trialDurationMinutes > 0 ? offering.trialDurationMinutes : 30
}

/**
 * Hand a claimed order back to 'failed' after a retry that started nothing.
 *
 * The tracking goes with it: the claim above opened a trigger run, and a
 * `triggering` entry left in the map would still be there on the next retry —
 * which resets it, but only after the operator has been shown an order that can
 * never settle.
 */
const releaseRetryClaim = async (orderId: number): Promise<void> => {
  await db
    .update(orders)
    .set({ status: 'failed', pipelineId: [], pipelineStatus: {}, updatedAt: new Date() })
    .where(eq(orders.id, orderId))
}

export const decommissionInfra = async (
  session: SessionUser,
  infraId: number,
): Promise<Result<{ pipelineIds: string[] }>> => {
  const infraRows = await db
    .select()
    .from(infrastructureElements)
    .where(eq(infrastructureElements.id, infraId))
    .limit(1)

  if (!infraRows.length) return err(404, 'Infrastructure element not found')

  const infra = infraRows[0]

  const authorized = await assertMayTeardown(session, infra.projectId)
  if (!authorized.ok) return authorized

  return claimAndDestroy(infra, { userId: session.id, reason: `initiated by ${session.email}` })
}

/**
 * Set or clear an element's automatic-teardown time (issue #30).
 *
 * Pass null to clear. Authorisation matches decommissionInfra — scheduling a
 * teardown is a deferred teardown, so it cannot be a lower bar than doing it now.
 */
export const scheduleDecommission = async (
  session: SessionUser,
  infraId: number,
  scheduledAt: Date | null,
): Promise<Result<{ scheduledDecommissionAt: Date | null }>> => {
  const [infra] = await db
    .select()
    .from(infrastructureElements)
    .where(eq(infrastructureElements.id, infraId))
    .limit(1)

  if (!infra) return err(404, 'Infrastructure element not found')

  const authorized = await assertMayTeardown(session, infra.projectId)
  if (!authorized.ok) return authorized

  // Only an active element can be scheduled. One already tearing down has
  // nothing left to schedule, and a schedule on a decommissioned element would
  // sit there forever waiting for a status that will never come back.
  if (infra.status !== 'active') {
    return err(400, 'Only an active infrastructure element can be scheduled for decommissioning')
  }

  if (scheduledAt !== null && scheduledAt.getTime() <= Date.now()) {
    // A past time would be swept on the very next run, which is a decommission,
    // not a schedule. Refuse rather than silently tearing something down now.
    return err(400, 'The scheduled time must be in the future')
  }

  await db
    .update(infrastructureElements)
    .set({ scheduledDecommissionAt: scheduledAt })
    .where(eq(infrastructureElements.id, infraId))

  await logAudit(
    session.id,
    scheduledAt ? 'infra.decommission_scheduled' : 'infra.decommission_schedule_cleared',
    infraId,
    scheduledAt
      ? `Scheduled for ${scheduledAt.toISOString()} by ${session.email}`
      : `Schedule cleared by ${session.email}`,
  )

  return ok({ scheduledDecommissionAt: scheduledAt })
}

const assertMayTeardown = async (
  session: SessionUser,
  projectId: number,
): Promise<Result<void>> => {
  if (session.role !== 'project_manager') return ok(undefined)

  const [project] = await db
    .select({ ownerId: projects.ownerId })
    .from(projects)
    .where(eq(projects.id, projectId))
    .limit(1)

  if (!project || project.ownerId !== session.id) return err(403, 'Forbidden')
  return ok(undefined)
}

/**
 * "The order that provisions this element is not still being provisioned."
 *
 * A trial's clock starts when its pipelines are TRIGGERED, not when they finish
 * (`trialExpiry`, and see `provisionOrderElements`), and the element row exists
 * and is 'active' from that same moment. A 5-minute trial of a product whose
 * apply takes 8 therefore came due while its own apply was still running: the
 * sweep claimed it and fired TF_ACTION=destroy at a state file Terraform was
 * mid-write on, and the apply's later success callback — which matches the ORDER,
 * untouched by any of this — completed the order and mailed the customer a
 * success for infrastructure that was being destroyed (issue #135).
 *
 * Expressed as NOT EXISTS rather than a join so the callers keep selecting plain
 * element rows, and deliberately as "not provisioning" rather than "completed": an
 * element of a FAILED order can be real, half-applied infrastructure with a trial
 * clock on it, and refusing to ever sweep it would trade this race for a permanent
 * leak. A retry moves its order back to 'provisioning', which closes this again
 * for the duration.
 */
const orderNotProvisioning = sql`NOT EXISTS (
  SELECT 1 FROM ${orders}
  WHERE ${orders.id} = ${infrastructureElements.orderId} AND ${orders.status} = 'provisioning'
)`

export interface SweepResult {
  /** Elements whose teardown was started. */
  decommissioned: number[]
  /** Elements that were due but could not be torn down, with the reason. */
  failed: { infraId: number; message: string }[]
}

/**
 * Tear down every active element whose scheduled time has arrived.
 *
 * On why this is an explicit call rather than an in-process timer: the issue asks
 * for the polling worker to be extended, but there is no polling worker — pipeline
 * status arrives by inbound webhook — and the backend is a horizontally scaled
 * Next.js app (see infra/helm .../hpa.yaml). An interval inside it would run once
 * per replica. So the sweep is exposed as an endpoint for an external scheduler
 * (a Kubernetes CronJob, a systemd timer, plain cron) to drive.
 *
 * That makes the timing coarse: an element is torn down at the first sweep at or
 * after its scheduled time, not to the second. For forgotten test environments —
 * what the feature is for — that is the right trade.
 *
 * Safe to call concurrently and repeatedly: claimAndDestroy's atomic
 * active → decommissioning claim means only one caller ever fires the destroy,
 * so overlapping sweeps or a sweep racing a user's Decommission button cannot
 * double-destroy. Each element is handled independently — one broken product's
 * triggers must not stop the rest of the sweep.
 */
export const sweepDueDecommissions = async (now: Date = new Date()): Promise<SweepResult> => {
  const due = await db
    .select()
    .from(infrastructureElements)
    .where(
      and(
        eq(infrastructureElements.status, 'active'),
        sql`${infrastructureElements.scheduledDecommissionAt} IS NOT NULL`,
        lte(infrastructureElements.scheduledDecommissionAt, now),
        // Skipped rather than reported as a failure: the element is due and will
        // be swept by the first run after its order stops provisioning, which is
        // the same "at or after its scheduled time" guarantee the sweep already
        // makes.
        orderNotProvisioning,
      ),
    )
    .orderBy(infrastructureElements.scheduledDecommissionAt)

  const result: SweepResult = { decommissioned: [], failed: [] }

  for (const infra of due) {
    try {
      const outcome = await claimAndDestroy(infra, {
        userId: null,
        reason: `by schedule (due ${infra.scheduledDecommissionAt?.toISOString()})`,
      })
      if (outcome.ok) result.decommissioned.push(infra.id)
      else result.failed.push({ infraId: infra.id, message: outcome.message })
    } catch (e) {
      // A thrown trigger has already restored the element to 'active', so it will
      // be picked up again by the next sweep.
      result.failed.push({ infraId: infra.id, message: e instanceof Error ? e.message : String(e) })
    }
  }

  return result
}

/**
 * Identity recorded against a teardown. `userId: null` marks a teardown nobody
 * asked for interactively — the scheduled sweep — matching how the webhook
 * handler audits callback-driven transitions.
 */
interface TeardownActor {
  userId: number | null
  reason: string
}

/**
 * Claim an active element and fire its destroy triggers.
 *
 * Shared by the interactive decommission and the scheduled sweep so both get the
 * same atomic claim and the same partial-failure reporting. The claim is what
 * makes the sweep safe to run from anywhere, any number of times: only the caller
 * that flips active → decommissioning fires anything, so a sweep racing a user's
 * Decommission button — or two replicas running the sweep at once — cannot
 * double-destroy.
 */
const claimAndDestroy = async (
  infra: typeof infrastructureElements.$inferSelect,
  actor: TeardownActor,
): Promise<Result<{ pipelineIds: string[] }>> => {
  const claimed = await db
    .update(infrastructureElements)
    .set({ status: 'decommissioning' })
    .where(
      and(
        eq(infrastructureElements.id, infra.id),
        eq(infrastructureElements.status, 'active'),
        // In the claim, not only in the sweep's query above: the sweep reads its
        // due rows and then claims them one at a time, and a retry started in
        // between would put the order back to 'provisioning' while a destroy went
        // out at the apply it just restarted.
        orderNotProvisioning,
      ),
    )
    .returning({ id: infrastructureElements.id })

  if (!claimed.length) {
    // Which of the two guards refused is worth the extra read: "not active" sends
    // an operator looking for a teardown that already happened, and this case is
    // the opposite — the element is fine and the answer is to wait.
    const [current] = await db
      .select({ status: infrastructureElements.status })
      .from(infrastructureElements)
      .where(eq(infrastructureElements.id, infra.id))
      .limit(1)
    if (current?.status === 'active') {
      return err(
        409,
        'This element is still being provisioned — destroying it now would run against a Terraform state its own apply is writing. Try again once the order has finished.',
      )
    }
    return err(400, 'Infrastructure element is not active')
  }

  // "Decommission 3 of 20" is per element, which is what the infrastructure list
  // already offers — the order gets no teardown of its own. `destroyVariables`
  // carries the element's sequence so the destroy targets that element's state.
  const variables = destroyVariables(infra)

  // Fires product webhooks AND pipeline stacks, and persists the started
  // pipeline ids (plus a sentinel per trigger that failed to start) so the
  // outcome is durable rather than swallowed.
  let outcome: Awaited<ReturnType<typeof fireDestroyTriggers>>
  try {
    outcome = await fireDestroyTriggers(infra, variables)
  } catch (e) {
    // Destroy pipeline could not be started — restore the element to active.
    await db
      .update(infrastructureElements)
      .set({ status: 'active' })
      .where(eq(infrastructureElements.id, infra.id))
    throw e
  }

  if (outcome.restoredToActive) {
    // Nothing was started, so nothing was destroyed: the element is back to
    // 'active' and the caller can simply try again.
    await logAudit(
      actor.userId,
      'infra.decommission_failed',
      infra.id,
      `No destroy pipeline could be started (${actor.reason}): ${outcome.failures.join('; ')}`,
    )
    return err(502, `Could not start the destroy pipeline: ${outcome.failures.join('; ')}`)
  }

  if (outcome.failures.length > 0) {
    // Some destroys ARE running and cannot be recalled, so the element stays
    // 'decommissioning' — and the sentinel written by fireDestroyTriggers keeps
    // it from ever reporting itself fully decommissioned. Tell the operator
    // which triggers need manual cleanup instead of returning success.
    await logAudit(
      actor.userId,
      'infra.decommission_partial',
      infra.id,
      `Destroy started for ${outcome.pipelineIds.length} pipeline(s) (${actor.reason}); could not start: ${outcome.failures.join('; ')}`,
    )
    return err(
      502,
      `Destroy started for ${outcome.pipelineIds.length} pipeline(s), but ${outcome.failures.length} could not be started and need manual cleanup: ${outcome.failures.join('; ')}`,
    )
  }

  await logAudit(
    actor.userId,
    'infra.decommissioning',
    infra.id,
    `Decommission ${actor.reason}`,
  )

  return ok({ pipelineIds: outcome.pipelineIds })
}

/**
 * One infrastructure element, with everything the detail page needs (issue #96).
 *
 * A separate query rather than filtering the list: the list deliberately does not
 * carry the cost centre or the pipeline status map, and a detail view that reused it
 * would either grow the list payload for every row or show less than it could.
 *
 * Sensitive parameter values are redacted with exactly the rules the CSV export
 * uses — the live catalogue unioned with the order's own snapshot — so the same
 * value cannot be hidden in one place and shown in the other.
 */
export interface InfraDetail extends InfraRow {
  /**
   * Status per pipeline id in `pipelineId`, taken from the run those ids belong
   * to — see `pipelinePhase`.
   */
  pipelineStatus: Record<string, string>
  /**
   * Which run `pipelineId` describes.
   *
   * The element's `pipelineId` is rewritten by a teardown (services/teardown),
   * so it holds provisioning ids while the element is active and destroy ids
   * once decommissioning has started. The two runs record their status in
   * different places, so the caller has to be told which one it is looking at.
   */
  pipelinePhase: 'provisioning' | 'teardown'
  costCenter: string | null
  orderCreatedAt: Date | null
  isTrial: boolean
  /** Names whose values were replaced with the redaction marker. */
  redactedParameters: string[]
}

export const getInfrastructureElement = async (
  session: SessionUser,
  id: number,
): Promise<Result<InfraDetail>> => {
  const isAdmin = session.role === 'admin' || session.role === 'root'

  const rows = await db
    .select({
      id: infrastructureElements.id,
      orderId: infrastructureElements.orderId,
      projectId: infrastructureElements.projectId,
      environmentId: infrastructureElements.environmentId,
      productId: infrastructureElements.productId,
      status: infrastructureElements.status,
      parameters: infrastructureElements.parameters,
      pipelineId: infrastructureElements.pipelineId,
      pipelineStatus: infrastructureElements.pipelineStatus,
      orderPipelineStatus: orders.pipelineStatus,
      outputs: infrastructureElements.outputs,
      deployedAt: infrastructureElements.deployedAt,
      scheduledDecommissionAt: infrastructureElements.scheduledDecommissionAt,
      productName: productNameSql,
      environmentName: deploymentEnvironments.name,
      projectName: projects.name,
      orderStatus: orders.status,
      orderCreatedAt: orders.createdAt,
      isTrial: orders.isTrial,
      projectOwnerId: projects.ownerId,
      costCenter: sql<string | null>`${costCenters.code} || ' — ' || ${costCenters.name}`,
    })
    .from(infrastructureElements)
    .leftJoin(
      deploymentEnvironments,
      eq(infrastructureElements.environmentId, deploymentEnvironments.id),
    )
    .leftJoin(projects, eq(infrastructureElements.projectId, projects.id))
    .leftJoin(orders, eq(infrastructureElements.orderId, orders.id))
    // The order carries the cost centre for 'select' and 'overhead' mode; in
    // 'project' mode it has none and the project's applies (see services/costs).
    .leftJoin(costCenters, eq(sql`COALESCE(${orders.costCenterId}, ${projects.costCenterId})`, costCenters.id))
    .where(eq(infrastructureElements.id, id))
    .limit(1)

  if (rows.length === 0) return err(404, 'Infrastructure element not found')
  const row = rows[0]

  // 404, not 403: telling a project manager that an element they may not see
  // exists is itself information about another project.
  if (!isAdmin && row.projectOwnerId !== session.id) {
    return err(404, 'Infrastructure element not found')
  }

  const sensitive = union(
    await loadSensitiveParameterNames(),
    (await loadSnapshotSensitiveNames([row.orderId])).get(row.orderId),
  )
  const parameters = row.parameters as Record<string, string>
  const redactedParameters = Object.keys(parameters ?? {}).filter((name) => sensitive.has(name))

  // The status of a PROVISIONING pipeline lives on the order: the webhook handler
  // merges success and failure into orders.pipeline_status, and only a teardown
  // writes the element's own map (see webhook/handler.ts and services/teardown).
  // Pairing the element's provisioning ids with the element's map — which is what
  // this endpoint used to do — reported every finished deployment as pending.
  const pipelinePhase = row.status === 'active' ? 'provisioning' : 'teardown'
  const pipelineStatus =
    pipelinePhase === 'teardown'
      ? (row.pipelineStatus ?? {})
      : (row.orderPipelineStatus ?? {})

  const { projectOwnerId: _ownerId, orderPipelineStatus: _orderStatus, ...rest } = row
  return ok({
    ...rest,
    pipelineStatus,
    pipelinePhase,
    parameters: redactParameters(parameters, sensitive),
    redactedParameters,
  } as InfraDetail)
}
