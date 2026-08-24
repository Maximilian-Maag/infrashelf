import type { SessionUser } from '@open-hybrid-cloud/types'
import { db } from '@/lib/db/client'
import {
  orders,
  infrastructureElements,
  deploymentEnvironments,
  productEnvironments,
  products,
  projects,
  users,
  costCenters,
  type Parameter,
} from '@/lib/db/schema'
import { eq, and, sql, inArray } from 'drizzle-orm'
import { logAudit } from '@/lib/audit'
import { sendOrderCreated, sendApprovalRequest } from '@/lib/notification'
import { triggerProductWebhooksTracked, triggerPipelineStacksTracked } from '@/lib/ci/webhooks'
import {
  beginOrderTriggerRun,
  recordOrderPipelineId,
  finishOrderTriggerRun,
  clearOrderTriggerRun,
} from '@/lib/services/pipelineTracking'
import { ELEMENT_SEQUENCE_VAR, STATE_KEY_NAMESPACE_VAR } from '@/lib/ci/stateKey'
import { isReservedCiVariable, withoutReservedCiVariables } from '@/lib/ci/reserved'
import { findProductName, findUserEmail, findUserName, findAdminEmails } from '@/lib/db/queries'
import { ok, err, type Result } from '@/lib/services/result'
import { loadApplicableParameters, resolveParameterDefs } from '@/lib/services/catalog'
import { redactParametersForOrders, REDACTED } from '@/lib/services/parameterRedaction'
import { resolveTrial, trialVariables, trialExpiry } from '@/lib/services/trial'
import { captureProductSnapshot, type ProductSnapshot } from '@/lib/services/snapshot'
import { substitutionsByEmail } from '@/lib/services/delegations'
import { resolveOfferingPrice, validateQuantity } from '@/lib/services/sizes'

export interface OrderRow {
  id: number
  projectId: number
  productId: number
  environmentId: number
  userId: number
  status: string
  parameters: Record<string, string>
  costCenterId: number | null
  rejectionNote: string | null
  pipelineId: string[]
  createdAt: Date
  updatedAt: Date
  /** Ordered as a time-boxed trial (issue #1). */
  isTrial: boolean
  /** The chosen size (issue #98); null when the offering has none. */
  sizeCode: string | null
  /** How many infrastructure elements this order asked for (issue #104). */
  quantity: number
  /**
   * What the customer was offered when the order was placed (issue #38). Null for
   * orders placed before snapshots existed.
   */
  productSnapshot: ProductSnapshot | null
  productName: string
  environmentName: string | null
  userName: string | null
}

export interface CreateOrderInput {
  projectId: number
  productId: number
  environmentId: number
  costCenterId?: number
  parameters: Record<string, string>
  /** Order as a time-boxed trial (issue #1). Requires a trial-enabled offering. */
  trial?: boolean
  /**
   * The size to order (issue #98). Mandatory for an offering that defines sizes,
   * and refused for one that does not — see `resolveOfferingPrice`.
   */
  sizeCode?: string | null
  /**
   * How many infrastructure elements to provision (issue #104). Defaults to 1, and
   * the whole order — one approval, one snapshot — covers all of them.
   */
  quantity?: number
}

export interface CreatedOrder {
  id: number
  projectId: number
  productId: number
  environmentId: number
  userId: number
  status: string
  parameters: Record<string, string>
  costCenterId: number | null
  rejectionNote: string | null
  pipelineId: string[]
  createdAt: Date
  updatedAt: Date
  isTrial: boolean
  sizeCode: string | null
  quantity: number
  /**
   * The FIRST element of the order, kept for the callers and clients that were
   * written when an order had exactly one. `infraIds` is the honest answer now
   * that an order can have N (issue #104).
   */
  infraId?: number
  /** Every element the order provisioned, in sequence order. */
  infraIds?: number[]
}

export const listOrders = async (session: SessionUser): Promise<Result<OrderRow[]>> => {
  const isAdmin = session.role === 'admin' || session.role === 'root'

  const rows = await db
    .select({
      id: orders.id,
      projectId: orders.projectId,
      productId: orders.productId,
      environmentId: orders.environmentId,
      userId: orders.userId,
      status: orders.status,
      parameters: orders.parameters,
      costCenterId: orders.costCenterId,
      rejectionNote: orders.rejectionNote,
      pipelineId: orders.pipelineId,
      createdAt: orders.createdAt,
      updatedAt: orders.updatedAt,
      isTrial: orders.isTrial,
      sizeCode: orders.sizeCode,
      quantity: orders.quantity,
      productSnapshot: orders.productSnapshot,
      productName: sql<string>`(
        SELECT name FROM product_translations
        WHERE product_id = ${orders.productId}
          AND language_code = 'en'
        LIMIT 1
      )`,
      environmentName: deploymentEnvironments.name,
      userName: users.name,
    })
    .from(orders)
    .leftJoin(deploymentEnvironments, eq(orders.environmentId, deploymentEnvironments.id))
    .leftJoin(users, eq(orders.userId, users.id))
    .where(isAdmin ? undefined : eq(orders.userId, session.id))
    .orderBy(sql`${orders.createdAt} DESC`)

  // Server-side, because the only masking used to be the order detail page's
  // `def?.sensitive ? '••••••'` — which reads the definition off the order's
  // snapshot, so an order placed before snapshots existed rendered the secret in
  // plaintext, and the raw value was in the JSON either way (issue #131).
  return ok(await redactParametersForOrders(rows as OrderRow[], (row) => row.id))
}

export const getOrderById = async (
  session: SessionUser,
  orderId: number,
): Promise<Result<OrderRow>> => {
  const rows = await db
    .select({
      id: orders.id,
      projectId: orders.projectId,
      productId: orders.productId,
      environmentId: orders.environmentId,
      userId: orders.userId,
      status: orders.status,
      parameters: orders.parameters,
      costCenterId: orders.costCenterId,
      rejectionNote: orders.rejectionNote,
      pipelineId: orders.pipelineId,
      createdAt: orders.createdAt,
      updatedAt: orders.updatedAt,
      isTrial: orders.isTrial,
      sizeCode: orders.sizeCode,
      quantity: orders.quantity,
      productSnapshot: orders.productSnapshot,
      productName: sql<string>`(
        SELECT name FROM product_translations
        WHERE product_id = ${orders.productId}
          AND language_code = 'en'
        LIMIT 1
      )`,
      environmentName: deploymentEnvironments.name,
      userName: users.name,
    })
    .from(orders)
    .leftJoin(deploymentEnvironments, eq(orders.environmentId, deploymentEnvironments.id))
    .leftJoin(users, eq(orders.userId, users.id))
    .where(eq(orders.id, orderId))
    .limit(1)

  if (!rows.length) return err(404, 'Order not found')

  const order = rows[0] as OrderRow
  if (session.role === 'project_manager' && order.userId !== session.id) {
    return err(403, 'Forbidden')
  }

  // See listOrders: the values leave the service redacted, whoever is asking.
  const [redacted] = await redactParametersForOrders([order], (row) => row.id)
  return ok(redacted)
}

/**
 * Validate the submitted parameter values against the applicable parameter
 * definitions and fill in defaults for omitted optional parameters. Returns the
 * effective parameter map to persist/trigger with, or a 400 Result on the first
 * validation failure. Only keys that have a matching definition are kept —
 * submitted keys with no applicable definition are dropped so a client cannot
 * inject arbitrary CI trigger variables. Server-only trigger vars (ORDER_ID,
 * TF_ACTION, …) are appended later in the trigger layer.
 *
 * A definition whose NAME is one of those server-owned variables is dropped too.
 * It used not to be, and that was the whole of issue #183: dropping undefined
 * keys protects nothing once a definition legitimately carries the name, and
 * `sync-parameters` creates definitions from a Terraform file without anyone
 * typing one. Dropping it here keeps the value out of `orders.parameters`, so it
 * is not there to be replayed when a pending order is approved months later.
 */
const validateAndApplyParameters = (
  defs: Parameter[],
  submitted: Record<string, string>,
): Result<Record<string, string>> => {
  const resolved = resolveParameterDefs(defs)
  const result: Record<string, string> = {}

  for (const def of resolved) {
    // Silently, and including when the definition is `required`: the name is one
    // the server decides, so there is nothing for the customer to supply and an
    // error would only make such a product unorderable.
    if (isReservedCiVariable(def.name)) continue
    const raw = submitted[def.name]
    // Normalize once, then validate and store the normalized value so a value
    // like `" true "` or `" 4 "` is accepted and persisted without whitespace
    // (which would otherwise leak into the CI trigger variables).
    const value = raw?.trim() ?? ''
    // A client that posts back the redaction sentinel is echoing the placeholder
    // it was shown, which means "unchanged" — never "the literal string
    // [redacted]". Reads are redacted (#131), so the reorder and apply-template
    // prefills hand the form this sentinel for every sensitive parameter; without
    // this line it would be stored as the value and shipped to the pipeline as a
    // trigger variable, overwriting the real secret.
    const provided = value !== '' && value !== REDACTED

    if (!provided) {
      // The default is applied BEFORE the required check, not after. A required
      // parameter that has a stored default is satisfied by it — and since #131
      // reads that value back redacted, the form can only ever return the
      // sentinel or an empty string for a required SENSITIVE one. Checking
      // `required` first made those orders impossible to place at all: the
      // server held the value, refused to use it, and asked the user for
      // something they are deliberately never shown.
      if (def.defaultValue !== '') {
        result[def.name] = def.defaultValue
        continue
      }
      if (def.required) return err(400, `Missing required parameter: ${def.name}`)
      continue
    }

    if (def.type === 'number') {
      if (!/^-?\d+(\.\d+)?$/.test(value) || Number.isNaN(Number(value))) {
        return err(400, `Parameter ${def.name} must be a number`)
      }
    } else if (def.type === 'bool') {
      if (value !== 'true' && value !== 'false') {
        return err(400, `Parameter ${def.name} must be 'true' or 'false'`)
      }
    }
    // `dropdown` definitions carry no stored option list in the schema, so
    // there is no allowed-value constraint to enforce here.

    result[def.name] = value
  }

  return ok(result)
}

/**
 * Resolve and validate the cost centre for an order against the rules stored on
 * the product/environment offering (FA-10.4).
 *
 * - `project`   the cost centre comes from the project, so a submitted one is
 *               ignored rather than silently stored against the order.
 * - `overhead`  the offering names a fixed shared cost centre. The user never
 *               picks, so a submitted one is ignored here too.
 * - `select`    the user picks one. `forcedCostCenter` makes that choice
 *               mandatory; otherwise it may be omitted.
 *
 * A cost centre must exist AND be active, whichever way it was arrived at — the
 * foreign key only proves existence, and ordering against a deactivated cost
 * centre is exactly what deactivating one is meant to prevent. That applies to a
 * configured overhead account as much as to a user's choice: it may have been
 * deactivated long after the offering was set up.
 */
const validateCostCenter = async (
  offering: { costCenterMode: string; forcedCostCenter: boolean; overheadCostCenterId: number | null },
  costCenterId: number | undefined,
): Promise<Result<number | null>> => {
  if (offering.costCenterMode === 'overhead') {
    // The whole point of an overhead account is that it is fixed by the
    // offering. Falling back to the submitted value here is what made this mode
    // indistinguishable from 'select'.
    if (offering.overheadCostCenterId === null) {
      if (offering.forcedCostCenter) {
        return err(400, 'No overhead cost center is configured for this environment')
      }
      return ok(null)
    }
    return validateActiveCostCenter(offering.overheadCostCenterId, 'Overhead cost center')
  }

  if (offering.costCenterMode !== 'select') {
    // 'project' mode: attribution follows the project, so don't store a
    // caller-supplied value that the UI never offered.
    return ok(null)
  }

  if (costCenterId === undefined || costCenterId === null) {
    if (offering.forcedCostCenter) {
      return err(400, 'A cost center is required for this environment')
    }
    return ok(null)
  }

  return validateActiveCostCenter(costCenterId, 'Cost center')
}

const validateActiveCostCenter = async (
  costCenterId: number,
  label: string,
): Promise<Result<number>> => {
  const [cc] = await db
    .select({ id: costCenters.id, active: costCenters.active })
    .from(costCenters)
    .where(eq(costCenters.id, costCenterId))
    .limit(1)

  if (!cc) return err(400, `${label} not found`)
  if (!cc.active) return err(400, `${label} is not active`)

  return ok(cc.id)
}

/**
 * Everything an order needs, resolved and validated, with nothing written yet.
 *
 * Extracted so the cart checkout (issue #28) can validate EVERY item before
 * creating any of them. Order creation fires CI pipelines, which cannot be
 * un-fired, so a checkout's only meaningful atomicity is an all-or-nothing
 * validation gate — and that gate has to apply exactly the rules a single order
 * would, not a second copy of them that drifts.
 */
export interface PreparedOrder {
  projectId: number
  productId: number
  environmentId: number
  parameters: Record<string, string>
  costCenterId: number | null
  isTrial: boolean
  trialDurationMinutes: number
  productSnapshot: ProductSnapshot | null
  isAdmin: boolean
  /** The validated size, or null when the offering has none (issue #98). */
  sizeCode: string | null
  /** How many elements to provision, validated against the cap (issue #104). */
  quantity: number
}

export const prepareOrder = async (
  session: SessionUser,
  input: CreateOrderInput,
): Promise<Result<PreparedOrder>> => {
  const { projectId, productId, environmentId, costCenterId } = input
  const isAdmin = session.role === 'admin' || session.role === 'root'

  // Ownership: a project_manager may only order into a project they own.
  if (!isAdmin) {
    const [project] = await db
      .select({ ownerId: projects.ownerId })
      .from(projects)
      .where(eq(projects.id, projectId))
      .limit(1)
    if (!project) return err(404, 'Project not found')
    if (project.ownerId !== session.id) return err(403, 'Forbidden')
  }

  // The product must be resolvable (needed for parameter scope) …
  const [product] = await db
    .select({ categoryId: products.categoryId })
    .from(products)
    .where(eq(products.id, productId))
    .limit(1)
  if (!product) return err(404, 'Product not found')

  // … and must actually be offered in the chosen environment. The offering row
  // also carries the cost-centre rules, which are validated below.
  const [offered] = await db
    .select({
      productId: productEnvironments.productId,
      costCenterMode: productEnvironments.costCenterMode,
      forcedCostCenter: productEnvironments.forcedCostCenter,
      overheadCostCenterId: productEnvironments.overheadCostCenterId,
    })
    .from(productEnvironments)
    .where(
      and(
        eq(productEnvironments.productId, productId),
        eq(productEnvironments.environmentId, environmentId),
      ),
    )
    .limit(1)
  if (!offered) return err(400, 'Product is not offered in the selected environment')

  // Size and quantity (issues #98 / #104), both server-side for the same reason
  // the cost-centre rules are: the size picker does not exist in the browser for
  // an offering with no sizes, and a quantity field is trivially edited. An
  // offering that HAS sizes has no price of its own worth charging, so a request
  // that names none is refused rather than billed at the legacy offering price.
  const priced = await resolveOfferingPrice(productId, environmentId, input.sizeCode)
  if (!priced.ok) return priced
  const quantityResult = validateQuantity(input.quantity)
  if (!quantityResult.ok) return quantityResult

  // Cost-centre rules (FA-10.4). These were previously enforced only in the
  // browser — OrderForm computes `needsCostCenter` and marks the field required —
  // so a direct POST could omit the cost centre on an environment that forces
  // one, or attach an inactive one. Both land in billing attribution, so the
  // server has to decide.
  const costCenterResult = await validateCostCenter(offered, costCenterId)
  if (!costCenterResult.ok) return costCenterResult
  const resolvedCostCenterId = costCenterResult.data

  // Trials are opt-in per offering (issue #1). Checked here rather than trusted
  // from the request: the toggle is hidden in the browser for products that do
  // not offer one, and a hidden control is not a control.
  const isTrial = input.trial === true
  let trialDurationMinutes = 0
  if (isTrial) {
    const trial = await resolveTrial(productId, environmentId)
    if (!trial.ok) return trial
    trialDurationMinutes = trial.data.trialDurationMinutes
  }

  // Server-side parameter validation (required/type checks + defaults).
  const defs = await loadApplicableParameters(productId, product.categoryId, environmentId)
  const validated = validateAndApplyParameters(defs, input.parameters)
  if (!validated.ok) return validated
  const parameters = validated.data

  // Captured before anything is written, so both an admin's direct order and a
  // project manager's pending order record what was actually offered (issue #38).
  // Taken after validation, so the offering is known to exist.
  // Passed the size, so the snapshot records the price of what was actually
  // chosen. Without it an order's history goes wrong the first time an admin
  // re-prices a size — which is the whole reason snapshots exist (issue #38).
  const productSnapshot = await captureProductSnapshot(
    productId,
    product.categoryId,
    environmentId,
    priced.data.sizeCode,
  )

  return ok({
    projectId,
    productId,
    environmentId,
    parameters,
    costCenterId: resolvedCostCenterId,
    isTrial,
    trialDurationMinutes,
    productSnapshot,
    isAdmin,
    sizeCode: priced.data.sizeCode,
    quantity: quantityResult.data,
  })
}

/** What `provisionOrderElements` needs to fan an order out over its elements. */
export interface ProvisionInput {
  orderId: number
  projectId: number
  productId: number
  environmentId: number
  sizeCode: string | null
  quantity: number
  parameters: Record<string, string>
  isTrial: boolean
  trialDurationMinutes: number
}

export interface ProvisionOutcome {
  /** Element ids in sequence order — element 1 first. */
  elementIds: number[]
  /** Every pipeline the order is waiting on, across all of its elements. */
  pipelineIds: string[]
}

/**
 * Provision the N infrastructure elements of one order (issues #98 / #104).
 *
 * One order, N elements, one approval — the shape the owner decided on. The
 * consequences it has to hold up under:
 *
 *  - The FAN-OUT is per element, not per order: each element gets its own
 *    pipeline run, because each is a separate piece of infrastructure that has to
 *    be retryable and tearable-down on its own ("decommission 3 of 20").
 *  - Each element therefore needs its own Terraform state, which is what
 *    ELEMENT_SEQUENCE is for: the trigger layer derives TF_STATE_NAME from it, so
 *    element 2 cannot apply on top of element 1's state. Element 1's key is
 *    unchanged from the pre-quantity behaviour, so existing infrastructure keeps
 *    working. See `elementStateSuffix`.
 *  - The ROW is created before its triggers fire, not after, so an element that
 *    fails to start is a visible element with no pipelines rather than a pipeline
 *    with no row.
 *  - The order's `pipelineId` is the union over its elements, which is what the
 *    callback handler matches events against and what makes "all pipelines
 *    succeeded" mean "every element provisioned".
 *
 * Shared by the admin's direct order and the approval path so the two cannot
 * drift; a second copy of the fan-out is a second set of state-key rules.
 *
 * Throws only if NOT ONE element could be started, which is the case both callers
 * already handle (they undo their claim). A partial failure records a sentinel in
 * the order's pipeline status instead, so the order can never report itself
 * complete while one of its elements was never triggered at all.
 *
 * The pipeline ids are recorded ONE AT A TIME, as each trigger returns, rather
 * than in one write at the end: the CI system can report a pipeline back before
 * this loop finishes, and a callback that cannot find its order strands it in
 * 'provisioning' with no retry path (issue #132). `beginOrderTriggerRun` and
 * `finishOrderTriggerRun` bracket that — see pipelineTracking for what the
 * bracket is holding shut.
 */
export const provisionOrderElements = async (
  input: ProvisionInput,
): Promise<ProvisionOutcome> => {
  const {
    orderId, projectId, productId, environmentId, sizeCode, quantity,
    parameters, isTrial, trialDurationMinutes,
  } = input

  const elementIds: number[] = []
  const pipelineIds: string[] = []
  const failures: string[] = []
  let firstError: unknown = null

  await beginOrderTriggerRun(orderId)

  for (let sequence = 1; sequence <= quantity; sequence++) {
    const [element] = await db
      .insert(infrastructureElements)
      .values({
        orderId,
        projectId,
        environmentId,
        productId,
        status: 'active',
        sizeCode,
        sequence,
        stateKeyNamespace: String(orderId),
        parameters,
        pipelineId: [],
        // The trial's clock starts here, at provisioning. The scheduled-decommission
        // sweep (issue #30) is what actually tears it down, so a trial needs no
        // teardown mechanism of its own.
        ...(isTrial ? { scheduledDecommissionAt: trialExpiry(trialDurationMinutes) } : {}),
      })
      .returning()
    elementIds.push(element.id)

    const triggerVars = elementTriggerVariables({
      parameters,
      orderId,
      sizeCode,
      sequence,
      isTrial,
      trialDurationMinutes,
    })

    // Recorded against the ORDER as each one starts — that is the row the
    // callback handler matches an event against. The element's own ids are
    // written once its fan-out is done, which is still before any callback can
    // act on them: the `triggering` sentinel keeps the order unsettleable until
    // every element has been through this loop.
    const onStarted = (pipelineId: string) => recordOrderPipelineId(orderId, pipelineId)

    let elementPipelineIds: string[]
    try {
      // The *Tracked variants, because a trigger that fails without throwing is
      // exactly the case that reported a half-deployed order as completed
      // (issue #134): the webhook 502s, the stack starts, and the order ends up
      // waiting on the stack alone.
      const webhooks = await triggerProductWebhooksTracked(productId, environmentId, triggerVars, onStarted)
      const stacks = await triggerPipelineStacksTracked(productId, environmentId, triggerVars, onStarted)
      elementPipelineIds = [...webhooks.pipelineIds, ...stacks.pipelineIds]
      failures.push(
        ...[...webhooks.failures, ...stacks.failures].map((f) => `element ${sequence}: ${f}`),
      )
    } catch (e) {
      // One element failing to start must not abandon the rest: the order is a
      // single decision, and nineteen of twenty VMs is still worth having. The
      // failure is recorded below so the order cannot be reported as complete.
      console.error(`[orders] Could not start element ${sequence} of order ${orderId}:`, e)
      failures.push(`element ${sequence}: ${e instanceof Error ? e.message : String(e)}`)
      if (firstError === null) firstError = e
      continue
    }

    if (elementPipelineIds.length > 0) {
      await db
        .update(infrastructureElements)
        .set({ pipelineId: elementPipelineIds })
        .where(eq(infrastructureElements.id, element.id))
      pipelineIds.push(...elementPipelineIds)
    }
  }

  // Nothing at all started: the caller undoes its claim, exactly as it did when
  // one order meant one trigger. Measured on the pipelines rather than on a count
  // of failed elements, because a trigger can now fail without throwing — an
  // order whose only webhook 502s used to fall through here and sit in
  // 'provisioning' waiting on nothing (issue #134).
  if (pipelineIds.length === 0 && failures.length > 0) {
    // Take the rows with it. They were inserted before their triggers fired (see
    // above) and nothing else would ever remove them: `order_id` carries no ON
    // DELETE CASCADE, and approveOrder puts the order back to 'pending' so the
    // approval can be retried — which inserts another N. Left behind they are
    // 'active' elements with no pipeline: counted in inventory, and decommissioning
    // them fires destroy pipelines at infrastructure that was never created.
    if (elementIds.length > 0) {
      await db.delete(infrastructureElements).where(inArray(infrastructureElements.id, elementIds))
    }
    await clearOrderTriggerRun(orderId)
    throw firstError ?? new Error(`Could not start any pipeline: ${failures.join('; ')}`)
  }

  // Closes the run: reconciles the recorded ids, replaces the `triggering` entry
  // with one `trigger-failed:*` sentinel per trigger that never started, and —
  // because a callback that arrived while `triggering` was set was refused the
  // completion decision — re-asks whether the order is already finished.
  await finishOrderTriggerRun(
    orderId,
    pipelineIds,
    failures,
    `All pipelines of order ${orderId} succeeded`,
  )

  return { elementIds, pipelineIds }
}

/**
 * The CI variables one element is provisioned with.
 *
 * `parameters` first, server-owned variables after: a customer-supplied parameter
 * must never be able to overwrite ORDER_ID or the size the order was priced on.
 *
 * Re-asserting a name only protects the names that are re-asserted, which is how
 * REF and TF_ACTION got through (issue #183). So the customer half is FILTERED
 * rather than overwritten: every server-owned name is removed from it, whatever
 * the parameter table happens to contain. That is what makes this safe for
 * `orders.parameters` rows written before #183 — a pending order carrying REF
 * still provisions on approval, just without choosing the git ref.
 */
const elementTriggerVariables = (input: {
  parameters: Record<string, string>
  orderId: number
  sizeCode: string | null
  sequence: number
  isTrial: boolean
  trialDurationMinutes: number
}): Record<string, string> => ({
  ...withoutReservedCiVariables(input.parameters),
  ORDER_ID: String(input.orderId),
  // Namespaces this element's Terraform state key, and is stored on the element
  // row so its teardown derives the same one.
  [STATE_KEY_NAMESPACE_VAR]: String(input.orderId),
  // The size has to reach the CI run (issue #98) — it is what decides how much
  // machine the template asks for. Absent, not empty, for an offering with no
  // sizes, so a template can tell "no sizing" from "a size called ''".
  ...(input.sizeCode !== null ? { SIZE: input.sizeCode } : {}),
  // Which of the order's N this run is provisioning. The trigger layer derives
  // TF_STATE_NAME from it; templates can use it to name resources.
  [ELEMENT_SEQUENCE_VAR]: String(input.sequence),
  ...(input.isTrial ? trialVariables(input.trialDurationMinutes) : {}),
})

/**
 * Create one order, provisioning it immediately for an admin or queueing it for
 * approval for a project manager.
 */
export const createOrder = async (
  session: SessionUser,
  input: CreateOrderInput,
): Promise<Result<CreatedOrder>> => {
  const prepared = await prepareOrder(session, input)
  if (!prepared.ok) return prepared
  return createPreparedOrder(session, prepared.data)
}

/**
 * Write and provision an order that has already been validated.
 *
 * Separate from prepareOrder so the cart checkout can put its validation gate
 * between the two.
 */
export const createPreparedOrder = async (
  session: SessionUser,
  prepared: PreparedOrder,
): Promise<Result<CreatedOrder>> => {
  const {
    projectId, productId, environmentId, parameters,
    costCenterId: resolvedCostCenterId, isTrial, trialDurationMinutes, productSnapshot, isAdmin,
    sizeCode, quantity,
  } = prepared

  if (isAdmin) {
    const [order] = await db
      .insert(orders)
      .values({
        projectId,
        productId,
        environmentId,
        userId: session.id,
        status: 'provisioning',
        parameters,
        costCenterId: resolvedCostCenterId,
        isTrial,
        productSnapshot,
        sizeCode,
        quantity,
      })
      .returning()

    // One order, N elements: the fan-out lives in provisionOrderElements so the
    // approval path cannot derive the state keys differently.
    let provisioned: Awaited<ReturnType<typeof provisionOrderElements>>
    try {
      provisioned = await provisionOrderElements({
        orderId: order.id,
        projectId,
        productId,
        environmentId,
        sizeCode,
        quantity,
        parameters,
        isTrial,
        trialDurationMinutes,
      })
    } catch (e) {
      // Not one pipeline started, so the row inserted a moment ago describes an
      // order that is not being provisioned by anything. Left at 'provisioning'
      // it would say the opposite forever — no callback can arrive to correct it
      // and nothing polls (issue #132). The approval path releases its claim for
      // the same reason; this one has no claim to release, so it records the
      // truth instead.
      await db
        .update(orders)
        .set({ status: 'failed', updatedAt: new Date() })
        .where(eq(orders.id, order.id))
      return err(502, `Could not start the deployment: ${e instanceof Error ? e.message : String(e)}`)
    }

    await logAudit(
      session.id,
      'order.provisioning',
      order.id,
      `Admin-initiated order for product ${productId}` +
        (quantity > 1 ? ` (${quantity} elements)` : ''),
    )

    const email = await findUserEmail(session.id)
    const productName = await findProductName(productId)
    if (email) {
      await sendOrderCreated(email, productName, order.id)
    }

    return ok({
      ...order,
      pipelineId: provisioned.pipelineIds,
      // Both: `infraId` is what every existing caller reads, `infraIds` is what
      // an order of twenty actually produced.
      infraId: provisioned.elementIds[0],
      infraIds: provisioned.elementIds,
    })
  } else {
    const [order] = await db
      .insert(orders)
      .values({
        projectId,
        productId,
        environmentId,
        userId: session.id,
        status: 'pending',
        parameters,
        costCenterId: resolvedCostCenterId,
        // Carried to approval time, which is where the trial is actually
        // provisioned and where its clock starts.
        isTrial,
        productSnapshot,
        // Same for the size and the quantity: one approval covers the whole
        // order, so the approver's single decision has to carry all N elements.
        sizeCode,
        quantity,
      })
      .returning()

    await logAudit(session.id, 'order.created', order.id, `Order created for product ${productId}`)

    const email = await findUserEmail(session.id)
    const productName = await findProductName(productId)
    if (email) {
      await sendOrderCreated(email, productName, order.id)
    }

    const ordererName = await findUserName(session.id)
    const adminEmails = await findAdminEmails()
    // Delegation is a CC, not a redirect (issue #35): every admin still gets the
    // request, and a substitute's copy additionally says whose authority they are
    // holding. See sendApprovalRequest for why redirecting was rejected.
    const substitutions = await substitutionsByEmail()
    for (const adminEmail of adminEmails) {
      await sendApprovalRequest(
        adminEmail,
        productName,
        order.id,
        ordererName,
        substitutions.get(adminEmail) ?? [],
      )
    }

    return ok(order as CreatedOrder)
  }
}
