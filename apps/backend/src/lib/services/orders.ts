import type { SessionUser, OrderStatus } from '@infrashelf/types'
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
  productWebhooks,
  pipelineStacks,
  type Parameter,
} from '@/lib/db/schema'
import { eq, and, sql, inArray } from 'drizzle-orm'
import { logAudit, logAuditWith } from '@/lib/audit'
import {
  attachBudgets,
  checkBudget,
  lockCostCentreBudget,
  resolveBudgetCostCentre,
  type BudgetState,
} from '@/lib/services/budgets'
import { sendOrderCreated, sendApprovalRequest } from '@/lib/notification'
import { triggerProductWebhooksTracked, triggerPipelineStacksTracked } from '@/lib/ci/webhooks'
import {
  beginOrderTriggerRun,
  recordOrderPipelineId,
  finishOrderTriggerRun,
  clearOrderTriggerRun,
} from '@/lib/services/pipelineTracking'
import { ELEMENT_SEQUENCE_VAR, STATE_KEY_NAMESPACE_VAR, stateKeyNamespaceFor } from '@/lib/ci/stateKey'
import { isReservedCiVariable, withoutReservedCiVariables } from '@/lib/ci/reserved'
import { findProductName, findUserEmail, findUserName, findAdminEmails } from '@/lib/db/queries'
import { ok, err, type Result } from '@/lib/services/result'
import { pageWindow, toPage, type Page } from '@/lib/services/page'
import { loadApplicableParameters, resolveParameterDefs } from '@/lib/services/catalog'
import { redactParametersForOrders, REDACTED } from '@/lib/services/parameterRedaction'
import { resolveTrial, trialVariables, trialExpiry } from '@/lib/services/trial'
import { captureProductSnapshot, type ProductSnapshot } from '@/lib/services/snapshot'
import { substitutionsByEmail } from '@/lib/services/delegations'
import { resolveOfferingPrice, validateQuantity } from '@/lib/services/sizes'
import { productNameSql } from '@/lib/db/productText'
import { evaluateOrderPolicy } from '@/lib/policy/gate'

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
  /** The project the order was placed for. Null only if the project is gone. */
  projectName: string | null
  userName: string | null
  /**
   * The cost centre as a person refers to it. Both null when the order has no
   * cost centre, which is a legitimate state — see `costCenterMode`.
   *
   * Selected only by `getOrderById`: the list has no column for it, and joining
   * a table per row for something nobody reads there is a cost with no reader.
   */
  costCenterCode?: string | null
  costCenterName?: string | null
  /**
   * The budget of the cost centre this order is billed to (#325).
   *
   * Filled by `listOrders` only for an admin or root caller asking for
   * `status=pending` — the approvals queue. Absent everywhere else: a budget is
   * a root-level figure with no business on a project manager's own orders, and
   * the lookup aggregates committed spend per cost centre, which no other list
   * should be paying for.
   */
  budget?: BudgetState | null
  /**
   * Per-pipeline outcome, keyed by pipeline id — `{ "pipe-a": "success" }`.
   *
   * The column has always been written by the webhook handler and was never
   * selected here, so the order detail page listed pipeline ids with nothing
   * against them and read as a run that never progressed. It is the same map
   * `/infrastructure/{id}` already renders; the order is simply where people
   * look first.
   */
  pipelineStatus: Record<string, string>
  /**
   * The infrastructure this order provisioned, in sequence order.
   *
   * Only populated by `getOrderById` — the list view would need one query per row
   * for something it does not show. Terraform outputs live on the ELEMENT, so
   * without this an order had no route to the endpoint, the address, the
   * credentials: the things the person who ordered it actually came back for.
   */
  elements?: OrderElement[]
}

/** One provisioned element, as the order detail page needs it. */
export interface OrderElement {
  id: number
  sequence: number
  status: string
  sizeCode: string | null
  outputs: Record<string, string>
}

export interface CreateOrderInput {
  projectId: number
  productId: number
  environmentId: number
  costCenterId?: number
  /**
   * Place the order even though the cost centre's budget is spent (#325).
   *
   * Root only, and audited. A block with no way past it becomes an outage
   * during an incident — the one time somebody genuinely needs to provision
   * against an exhausted budget — so the escape exists and leaves a record,
   * the way `order.window_overridden` already does for deployment windows.
   */
  overrideBudget?: boolean
  /**
   * Place the order even though a policy refused it (#110).
   *
   * Root only, and audited with the rule that was overridden — a SEPARATE right
   * from `overrideBudget`, deliberately. An approval says "this order is wanted";
   * an override says "this rule does not apply here". Conflating them would mean
   * an approver cannot approve anything without also waiving policy.
   *
   * It exists for the same reason the budget override does: a deny with no way
   * past it becomes an outage during an incident, and the escape is worth more
   * than the guarantee it weakens as long as it leaves a record naming the rule.
   */
  overridePolicy?: boolean
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
  /**
   * Set when the cost centre's budget is spent and its behaviour is `warn`
   * (#325). The order exists — this is what the orderer is told about it.
   */
  budgetWarning?: string
  /**
   * Set when policy allowed the order but wanted to say something (#110) — the
   * policy's own message, or the reason a `best_effort` engine could not be
   * asked. Mirrors `budgetWarning`, for the same reason: a warning nobody sees is
   * indistinguishable from no warning.
   */
  policyWarning?: string
  /**
   * Set when policy held the order for somebody else's approval (#110). The
   * order exists and is in the approvals queue — this says which rule asked, so
   * the person who placed it is not left watching an order that never starts.
   *
   * Separate from `policyWarning` because it is not a warning: the order did not
   * proceed as it otherwise would have (an admin's order provisions immediately,
   * and this one does not), and a caller that had to read the outcome off the
   * message would eventually get it wrong.
   */
  policyApprovalRequired?: string
}

/**
 * `Page<OrderRow>`, not `Page<Order>`: the service row carries the joined
 * display names the shared type does not.
 */
export type OrderPage = Page<OrderRow>

/**
 * What one request may narrow the order list to.
 *
 * `projectId` and `status` are here because two callers were ALREADY sending
 * them and the route was already ignoring them: the project detail page asks
 * for `/api/orders?projectId=7` and the approvals page fetches every order to
 * keep the pending ones. The first is a correctness bug — that page's "Orders
 * in this project" card was listing every order the viewer may see, which for
 * an administrator is the whole installation, each row linking off to an order
 * in some other project. The second is #158's shape exactly: download
 * everything, throw most of it away in JavaScript.
 *
 * Filtering in SQL fixes both, and it is what makes the page window mean
 * something — page 2 of the orders for one project is not page 2 of all orders
 * with the others dropped.
 */
export interface OrderFilters {
  limit?: number
  offset?: number
  projectId?: number
  status?: OrderStatus
}

/**
 * A window onto the orders the caller may see, newest first.
 *
 * It used to return every one of them. The row is not small — `parameters` and
 * `productSnapshot` are both jsonb, and a snapshot carrying ten parameter
 * definitions is around 1.5 KB — so for an administrator of a busy
 * installation this was tens of megabytes assembled in Node by
 * `NextResponse.json`, with no streaming, parsed whole again by the frontend
 * server, on every visit to the orders page (#158).
 *
 * `total` counts the matches and not the window, so a caller can say "1–50 of
 * 3,914" without asking for 3,914 rows to find out.
 */
export const listOrders = async (
  session: SessionUser,
  lang = 'en',
  filters: OrderFilters = {},
): Promise<Result<OrderPage>> => {
  const isAdmin = session.role === 'admin' || session.role === 'root'
  const window = pageWindow(filters.limit, filters.offset)

  const conditions = [
    isAdmin ? undefined : eq(orders.userId, session.id),
    filters.projectId ? eq(orders.projectId, filters.projectId) : undefined,
    filters.status ? eq(orders.status, filters.status) : undefined,
  ].filter((c) => c !== undefined)
  const where = conditions.length > 0 ? and(...conditions) : undefined

  // Counted separately rather than with a window function over the page, because
  // `COUNT(*)` over the join needs none of the jsonb columns and none of the
  // per-row name subqueries — it is the cheap half of the request, and making it
  // ride along with the expensive half would only make the expensive half wider.
  const [{ total }] = await db
    .select({ total: sql<number>`count(*)::int` })
    .from(orders)
    .where(where)

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
      pipelineStatus: orders.pipelineStatus,
      createdAt: orders.createdAt,
      updatedAt: orders.updatedAt,
      isTrial: orders.isTrial,
      sizeCode: orders.sizeCode,
      quantity: orders.quantity,
      productSnapshot: orders.productSnapshot,
      productName: productNameSql(lang, orders.productId),
      environmentName: deploymentEnvironments.name,
      // Selected since #208. The orders table has had a Project column all along,
      // reading `projectName` — a field on the shared `Order` type that nothing
      // ever filled, so the cell was always blank and the detail page always fell
      // back to `#12`. LEFT, like the other two: an inner join would drop rows
      // from a list whose whole job is to show everything the caller may see.
      projectName: projects.name,
      userName: users.name,
      // A lookup input for the budget attachment below, stripped from the rows
      // before they leave: an order in the default 'project' mode stores no cost
      // centre of its own, so the fall-through needs the project's.
      projectCostCenterId: projects.costCenterId,
    })
    .from(orders)
    .leftJoin(deploymentEnvironments, eq(orders.environmentId, deploymentEnvironments.id))
    .leftJoin(projects, eq(orders.projectId, projects.id))
    .leftJoin(users, eq(orders.userId, users.id))
    .where(where)
    // Tie-broken on id, because `created_at` is not unique — two orders placed in
    // the same millisecond can otherwise swap places between two requests, which
    // in a paged list means a row appears on both page 1 and page 2 while another
    // appears on neither.
    .orderBy(sql`${orders.createdAt} DESC`, sql`${orders.id} DESC`)
    .limit(window.limit)
    .offset(window.offset)

  // Server-side, because the only masking used to be the order detail page's
  // `def?.sensitive ? '••••••'` — which reads the definition off the order's
  // snapshot, so an order placed before snapshots existed rendered the secret in
  // plaintext, and the raw value was in the JSON either way (issue #131).
  /*
   * The approver's budget notice (#325), and only for them.
   *
   * `status=pending` and an admin or root caller is exactly the approvals queue
   * — the one list where a budget changes what the reader is about to do. Every
   * other call gets `projectCostCenterId` stripped and no budget at all, which
   * matters twice: a budget is a root-level figure and has no business on a
   * project manager's own orders page, and the lookup aggregates committed
   * spend per cost centre, which no other list should be paying for.
   */
  const withBudgets =
    isAdmin && filters.status === 'pending'
      ? await attachBudgets(rows)
      : rows.map(({ projectCostCenterId: _dropped, ...row }) => row)

  const items = await redactParametersForOrders(withBudgets as OrderRow[], (row) => row.id)
  return ok(toPage(items, total, window))
}

export const getOrderById = async (
  session: SessionUser,
  orderId: number,
  lang = 'en',
): Promise<Result<OrderRow>> => {
  const rows = await db
    .select({
      id: orders.id,
      projectId: orders.projectId,
      productId: orders.productId,
      environmentId: orders.environmentId,
      userId: orders.userId,
      status: orders.status,
      // #330. Only the detail view: the list shows a badge, and "Scheduled"
      // without a time is still an honest badge, while a column that is null
      // on every row but one is a column nobody reads.
      scheduledFor: orders.scheduledFor,
      windowOverrideAt: orders.windowOverrideAt,
      parameters: orders.parameters,
      costCenterId: orders.costCenterId,
      rejectionNote: orders.rejectionNote,
      pipelineId: orders.pipelineId,
      pipelineStatus: orders.pipelineStatus,
      createdAt: orders.createdAt,
      updatedAt: orders.updatedAt,
      isTrial: orders.isTrial,
      sizeCode: orders.sizeCode,
      quantity: orders.quantity,
      productSnapshot: orders.productSnapshot,
      productName: productNameSql(lang, orders.productId),
      environmentName: deploymentEnvironments.name,
      // Selected since #208. The orders table has had a Project column all along,
      // reading `projectName` — a field on the shared `Order` type that nothing
      // ever filled, so the cell was always blank and the detail page always fell
      // back to `#12`. LEFT, like the other two: an inner join would drop rows
      // from a list whose whole job is to show everything the caller may see.
      projectName: projects.name,
      userName: users.name,
      // The page printed `#3` for the cost centre because the id was all it had.
      // LEFT, like the other three: `costCenterId` is nullable and an inner join
      // would make an order without one disappear from its own detail page.
      costCenterCode: costCenters.code,
      costCenterName: costCenters.name,
    })
    .from(orders)
    .leftJoin(deploymentEnvironments, eq(orders.environmentId, deploymentEnvironments.id))
    .leftJoin(projects, eq(orders.projectId, projects.id))
    .leftJoin(users, eq(orders.userId, users.id))
    .leftJoin(costCenters, eq(orders.costCenterId, costCenters.id))
    .where(eq(orders.id, orderId))
    .limit(1)

  if (!rows.length) return err(404, 'Order not found')

  const order = rows[0] as OrderRow
  if (session.role === 'project_manager' && order.userId !== session.id) {
    return err(403, 'Forbidden')
  }

  // See listOrders: the values leave the service redacted, whoever is asking.
  const [redacted] = await redactParametersForOrders([order], (row) => row.id)

  // One extra query, on the detail view only. `outputs` is the reason: it is the
  // endpoint and the credentials the pipeline produced, it lives on the element,
  // and until now nothing on the order page led to it.
  const elements = await db
    .select({
      id: infrastructureElements.id,
      sequence: infrastructureElements.sequence,
      status: infrastructureElements.status,
      sizeCode: infrastructureElements.sizeCode,
      outputs: infrastructureElements.outputs,
    })
    .from(infrastructureElements)
    .where(eq(infrastructureElements.orderId, orderId))
    .orderBy(infrastructureElements.sequence)

  return ok({ ...redacted, elements })
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
  sizeCode: string | null,
): Result<Record<string, string>> => {
  const resolved = resolveParameterDefs(defs)
  const result: Record<string, string> = {}

  for (const def of resolved) {
    /*
     * A `size` variable is not something the customer types (#251-adjacent).
     * Its value is whatever the size they picked says it is, and `submitted` is
     * ignored entirely — the order form does not render an input for it, and a
     * hand-written request must not be able to buy an S and provision an XL.
     * That is the whole point of putting the mapping on the server: the price
     * and the hardware are decided by one choice.
     *
     * `instance_type` on an AWS VM is one of these. vSphere has three, all
     * driven by the same size, which is why the map lives on the VARIABLE.
     */
    if (def.type === 'size') {
      if (sizeCode === null) {
        // An offering with no sizes cannot answer a size variable, and guessing
        // would provision something nobody chose.
        return err(
          400,
          `Parameter ${def.name} is set by the size, and this offering has no sizes. ` +
            'Give the offering sizes, or change the parameter to another type.',
        )
      }
      const forSize = def.sizeValues?.[sizeCode]
      if (forSize === undefined || forSize === '') {
        // A size added after the mapping was written. Refusing beats
        // provisioning an empty instance_type and letting Terraform decide.
        return err(
          400,
          `Size ${sizeCode} has no value for ${def.name}. An administrator has to say what ${def.name} is at that size.`,
        )
      }
      result[def.name] = forSize
      continue
    }

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
  /** Root's audited escape from an exhausted budget (#325). */
  overrideBudget?: boolean
  /** Root's audited escape from a policy refusal (#110), a separate right. */
  overridePolicy?: boolean
}

/**
 * Does anything exist that could provision this product in this environment?
 *
 * The same two sources `provisionOrderElements` triggers, asked as a question
 * instead of an attempt. Two cheap existence checks rather than one join or a
 * count: the answer is a boolean, the second query only runs when the first
 * finds nothing, and `LIMIT 1` stops at the first row either way.
 */
const hasSomethingToTrigger = async (
  productId: number,
  environmentId: number,
): Promise<boolean> => {
  const [webhook] = await db
    .select({ id: productWebhooks.id })
    .from(productWebhooks)
    .where(
      and(
        eq(productWebhooks.productId, productId),
        eq(productWebhooks.environmentId, environmentId),
      ),
    )
    .limit(1)
  if (webhook) return true

  const [stack] = await db
    .select({ id: pipelineStacks.id })
    .from(pipelineStacks)
    .where(
      and(eq(pipelineStacks.productId, productId), eq(pipelineStacks.environmentId, environmentId)),
    )
    .limit(1)
  return stack !== undefined
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
    .select({ categoryId: products.categoryId, retiredAt: products.retiredAt })
    .from(products)
    .where(eq(products.id, productId))
    .limit(1)
  if (!product) return err(404, 'Product not found')

  // Retirement is the check now, not the absence of an offering (#251). Disabling
  // a product used to work by DELETING its product_environments rows, which made
  // it unorderable and also destroyed its pricing — so it could never be undone.
  // The offerings survive a withdrawal today, which means this is the only thing
  // standing between a disabled product and an order for it.
  if (product.retiredAt !== null) {
    return err(400, 'This product is no longer available to order')
  }

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

  /*
   * Is there anything that could actually provision this?
   *
   * A product is provisioned by a product webhook or a pipeline stack, per
   * environment. With neither, `provisionOrderElements` starts nothing, notices
   * that nothing started, deletes the element rows it had already inserted and
   * answers 502 "Could not start the deployment" — which reads as "the CI system
   * is down" when the truth is "nobody has configured a pipeline for this".
   *
   * That is the shape a Kubernetes product was found in: offered in the
   * catalogue with its parameters freshly imported, a whole order form filled
   * in, and a 502 at the till. #206 made that failure loud rather than leaving
   * the order stuck in 'provisioning' for ever, which was right — but loud and
   * misleading is only half the fix.
   *
   * Checked HERE, before the order row exists, so nothing has to be rolled back
   * and the message can name the actual missing thing and who has to add it.
   */
  const deployable = await hasSomethingToTrigger(productId, environmentId)
  if (!deployable) {
    return err(
      409,
      'This product has no pipeline configured for the selected environment, so there is nothing to provision it. ' +
        'An administrator has to add a pipeline stack or a webhook to the product before it can be ordered.',
    )
  }

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
  // `projectId` too: a parameter narrowed to specific projects applies only to
  // those, and the order is the point at which the project is finally known
  // (#275).
  const defs = await loadApplicableParameters(productId, product.categoryId, environmentId, projectId)
  // `priced.data.sizeCode` and not `input.sizeCode`: the former has been through
  // `resolveOfferingPrice`, so it is a size that actually exists and is active.
  const validated = validateAndApplyParameters(defs, input.parameters, priced.data.sizeCode)
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
    // So the snapshot records the definitions that ACTUALLY applied to this
    // order's project, not the wider set an unfiltered load would return.
    projectId,
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
    overrideBudget: input.overrideBudget,
    overridePolicy: input.overridePolicy,
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
        stateKeyNamespace: stateKeyNamespaceFor(orderId),
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
    let elementStateKeys: Record<string, string> = {}
    try {
      // The *Tracked variants, because a trigger that fails without throwing is
      // exactly the case that reported a half-deployed order as completed
      // (issue #134): the webhook 502s, the stack starts, and the order ends up
      // waiting on the stack alone.
      const webhooks = await triggerProductWebhooksTracked(productId, environmentId, triggerVars, onStarted)
      const stacks = await triggerPipelineStacksTracked(productId, environmentId, triggerVars, onStarted, parameters)
      // What each stack actually used, so retry and teardown address the state
      // this apply created rather than re-deriving it from a stack row that can
      // have moved since (#200).
      elementStateKeys = stacks.stateKeys ?? {}
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

    // The state keys are written even when nothing started: a trigger whose HTTP
    // call failed may still have started the pipeline, and a key nobody recorded
    // is a state with no teardown.
    if (elementPipelineIds.length > 0 || Object.keys(elementStateKeys).length > 0) {
      await db
        .update(infrastructureElements)
        .set({
          ...(elementPipelineIds.length > 0 ? { pipelineId: elementPipelineIds } : {}),
          ...(Object.keys(elementStateKeys).length > 0 ? { stateKeys: elementStateKeys } : {}),
        })
        .where(eq(infrastructureElements.id, element.id))
      pipelineIds.push(...elementPipelineIds)
    }
  }

  // Nothing at all started: the caller undoes its claim, exactly as it did when
  // one order meant one trigger. Measured on the pipelines rather than on a count
  // of failed elements, because a trigger can now fail without throwing — an
  // order whose only webhook 502s used to fall through here and sit in
  // 'provisioning' waiting on nothing (issue #134).
  //
  // And measured ONLY on the pipelines since #206. The condition used to also
  // require `failures.length > 0`, which let the quietest version of the same
  // fault through: a product with no webhook and no pipeline stack for this
  // environment starts nothing and fails at nothing, so both helpers return empty
  // and there was nothing for this branch to catch. The run then closed cleanly
  // with an empty id list, and `isSettled` refuses an empty list on purpose — a
  // run that started no pipeline has nothing to report success. The order sat in
  // 'provisioning' with nothing in existence that could ever move it, and no
  // error anywhere to say so.
  if (pipelineIds.length === 0) {
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
    // The two causes are different problems for whoever has to act on them, so
    // they get different sentences. "Could not start any pipeline: " with an
    // empty list after it told an operator nothing at all.
    throw (
      firstError ??
      new Error(
        failures.length > 0
          ? `Could not start any pipeline: ${failures.join('; ')}`
          : 'Nothing is configured to deploy this product into this environment: it has no product webhook and no pipeline stack, so the order has nothing to trigger. Add one in Admin → Products, then order again.',
      )
    )
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
  // row so its teardown derives the same one. Same function as the row above,
  // because the two must not drift.
  [STATE_KEY_NAMESPACE_VAR]: stateKeyNamespaceFor(input.orderId),
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
/**
 * How long a provisioning order must have gone without any update before root is
 * allowed to write it off.
 *
 * Not a guess at how long a pipeline takes — it is how long silence has to last
 * before "still running" stops being a possible explanation. The longest real
 * provisioning run measured on this platform is a few minutes; thirty is the
 * threshold at which an order is stuck rather than slow, with room to spare.
 */
export const STUCK_ORDER_SILENCE_MS = 30 * 60 * 1000

/**
 * Root writes off an order whose pipeline never reported back (#206, and the
 * order 37 that prompted this).
 *
 * An order goes to `provisioning` when CI is triggered and leaves it when the
 * callback arrives. If the callback never arrives — the pipeline finished and
 * nothing posted the result, the token was wrong, the URL was — the order stays
 * `provisioning` for ever, and every operator action is behind a status it will
 * never reach:
 *
 *   Retry         shown only when `orderStatus === 'failed'`
 *   Decommission  reachable, but leaves the order itself stuck
 *
 * So the platform had a terminal state it could enter and not leave. This is the
 * way out, and it is deliberately narrow:
 *
 *   - root only, enforced by the route AND here, because this writes a status
 *     nothing observed and the audit entry has to name a person
 *   - only from `provisioning`; every other status either resolves itself or has
 *     its own path out
 *   - only after `STUCK_ORDER_SILENCE_MS` of no update at all, so a pipeline that
 *     is merely slow cannot be written off out from under itself
 *
 * The reason goes in the AUDIT LOG rather than `rejectionNote`: that column
 * belongs to `status = 'rejected'` and to the approver who wrote it, and
 * borrowing it here would make a rejected order and a written-off one
 * indistinguishable to everything that reads it.
 *
 * The status it writes is `failed`, not `completed`: nobody observed a success,
 * and `failed` is also the status that opens Retry — which is what an operator
 * looking at a stuck order usually wants next.
 */
export const markOrderFailed = async (
  session: SessionUser,
  orderId: number,
  reason: string,
  now: Date = new Date(),
): Promise<Result<{ id: number; status: string }>> => {
  if (session.role !== 'root') return err(403, 'Forbidden')

  const trimmed = reason.trim()
  if (trimmed === '') return err(400, 'Say why the order is being written off — it goes in the audit log.')

  const [order] = await db
    .select({ id: orders.id, status: orders.status, updatedAt: orders.updatedAt })
    .from(orders)
    .where(eq(orders.id, orderId))
    .limit(1)

  if (!order) return err(404, 'Order not found')

  if (order.status !== 'provisioning') {
    return err(
      409,
      `Only an order stuck in provisioning can be written off; this one is ${order.status}.`,
    )
  }

  const silentFor = now.getTime() - order.updatedAt.getTime()
  if (silentFor < STUCK_ORDER_SILENCE_MS) {
    const minutes = Math.ceil((STUCK_ORDER_SILENCE_MS - silentFor) / 60_000)
    return err(
      409,
      `This order last reported ${Math.floor(silentFor / 60_000)} minutes ago and may still be running. Try again in ${minutes} minutes.`,
    )
  }

  const [updated] = await db
    .update(orders)
    .set({ status: 'failed', updatedAt: now })
    .where(and(eq(orders.id, orderId), eq(orders.status, 'provisioning')))
    .returning({ id: orders.id, status: orders.status })

  // The WHERE still carries the status, so a callback that landed between the
  // read and the write wins and this answers 409 rather than overwriting it.
  if (!updated) return err(409, 'The order changed while you were looking at it. Reload and check again.')

  await logAudit(
    session.id,
    'order.written_off',
    orderId,
    `Stuck in provisioning for ${Math.floor(silentFor / 60_000)} minutes with no callback; marked failed by ${session.email}: ${trimmed}`,
  )

  return ok(updated)
}

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
    sizeCode, quantity, overrideBudget, overridePolicy,
  } = prepared

  /*
   * The policy gate (#110), at the same single point the budget gate sits on and
   * for the same reason: the approval path reaches this function too, so a check
   * in the checkout handler alone would let an order approved next week run
   * against a policy that has changed since.
   *
   * BEFORE the transaction rather than inside it, unlike the budget. That
   * transaction takes a per-cost-centre advisory lock, and `evaluateOrderPolicy`
   * is a network call to someone else's engine — holding the lock across it is
   * how one slow policy engine becomes an outage on checkout, which is the same
   * argument the comment below makes about provisioning.
   *
   * A refusal returns without writing anything, so there is nothing to roll back
   * and the 409 stays an ordinary result rather than an exception. Root's escape
   * is `overridePolicy`, a separate right from `overrideBudget`: an approval says
   * "this order is wanted", an override says "this rule does not apply here".
   */
  const policy = await evaluateOrderPolicy(prepared, session)
  const policyOverridden = policy.outcome === 'deny' && session.role === 'root' && overridePolicy === true

  if (policy.outcome === 'deny' && !policyOverridden) {
    // The code is what lets a client offer root the escape above instead of
    // matching on this sentence (#509).
    return err(409, policy.message ?? 'This order is not permitted by policy.', 'policy_denied')
  }

  /*
   * `needs-approval` is the fourth answer, and the only one that changes WHO may
   * commit the order.
   *
   * Everything below turns on `isAdmin`: an admin's order is provisioned here,
   * everybody else's waits for an approval. So a rule that asks for a person has
   * to be able to take that away, or it does nothing at all for precisely the
   * role it was written about — an admin would place the order and policy would
   * have said nothing.
   *
   * It goes to the same place a project manager's order goes: `pending`, where
   * `approveOrder`'s self-approval guard means somebody ELSE has to approve it.
   * A verdict that only produced a note on the queue row would be satisfied by
   * the very person the rule wanted checked.
   *
   * `provisionNow` rather than clearing `isAdmin`: the role still decides what
   * the order looks like in every other way (who is mailed, which audit entry is
   * written), and only the commit is taken away.
   */
  const approvalRequired = policy.outcome === 'needs-approval'
  const provisionNow = isAdmin && !approvalRequired

  /*
   * The budget gate, at the single point both paths go through (#325), and the
   * check and the insert are ONE transaction, serialised per cost centre (#403).
   *
   * Here rather than in the route, because the approval path reaches this
   * function too: a check in the checkout handler alone would let an order
   * approved next week spend a budget that is already gone. `warn` deliberately
   * does not stop anything — it is the setting that says "tell me, do not
   * refuse me" — so only `block` returns early.
   *
   * They used to be two statements against the pool, and the gap between them
   * was the bug: two orders placed close together both read the same
   * `committed`, both found room, and both committed. If the first exhausted
   * the budget the second had already passed its `block` check.
   *
   * The advisory lock is taken before the read and released by Postgres at
   * commit or rollback. Everything inside runs through `tx` — the budget reads
   * take an executor for exactly this reason. Reaching for the module-level
   * `db` in here would check out a SECOND connection while this one is held,
   * and under load that is a pool deadlock: a worse failure than the bounded
   * overspend it is preventing.
   *
   * What is deliberately NOT in here: provisioning and email.
   * `provisionOrderElements` fires CI pipelines, and holding a lock — or a
   * connection — across a network call to someone else's GitLab is how one slow
   * runner becomes an outage on checkout. They run after the commit, below.
   *
   * The budget audit entries ARE in here, written through `tx`: they record why
   * an over-budget order was allowed, and that has to commit with the order it
   * describes rather than separately.
   */
  const placement = await db.transaction(async (tx) => {
    const budgetCostCentreId = await resolveBudgetCostCentre(projectId, resolvedCostCenterId, tx)
    if (budgetCostCentreId !== null) await lockCostCentreBudget(tx, budgetCostCentreId)

    /*
     * The order being placed is part of the question, not just the ones before it.
     *
     * Its line total comes from the snapshot captured for THIS order, which is
     * the same figure `loadBudgetState` reads back for it once it exists — so the
     * gate and the report cannot disagree about what it cost.
     */
    const budget = await checkBudget(
      budgetCostCentreId,
      new Date(),
      {
        price: productSnapshot?.price ?? null,
        currency: productSnapshot?.currency ?? null,
        quantity,
      },
      tx,
    )

    if (budget.outcome === 'block' && (session.role !== 'root' || !overrideBudget)) {
      // Nothing has been written, so there is nothing to roll back — returning
      // rather than throwing keeps the 409 an ordinary result instead of an
      // exception the caller has to unpick.
      return { kind: 'blocked' as const, message: budget.message ?? 'This cost centre is over budget.' }
    }

    const [order] = await tx
      .insert(orders)
      .values({
        projectId,
        productId,
        environmentId,
        userId: session.id,
        // The admin path provisions immediately; everyone else waits for an
        // approval — and an admin's order goes the same way when policy asked
        // for one (`provisionNow`, above). The only difference between the two
        // inserts, which is why they are one insert now.
        status: provisionNow ? 'provisioning' : 'pending',
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

    /*
     * The order and the record of WHY it was allowed commit together.
     *
     * `warn` means "tell me, do not refuse me", and an over-budget order that
     * passes silently is indistinguishable from one that was inside its budget.
     * A root override is a control being deliberately stepped around. Either
     * written outside this transaction could be lost while the order survived,
     * leaving spend over budget with nothing saying it was allowed — the same
     * reason `setCostCentreBudget` writes its own audit entry through `tx`.
     *
     * Through `logAuditWith(tx, …)` and not `logAudit`, which would take a
     * second connection while this one is held.
     */
    if (budget.outcome === 'block' || budget.outcome === 'warn') {
      await logAuditWith(
        tx,
        session.id,
        budget.outcome === 'block' ? 'order.budget_overridden' : 'order.budget_warning',
        order.id,
        `${session.email} placed an order against ${budget.state?.costCenterLabel} with the budget already spent`,
      )
    }

    /*
     * The policy outcome, written with the order it describes — the same
     * placement the budget entries above use, and for the same reason: an
     * override and its order have to commit or roll back together.
     *
     * A plain refusal writes nothing here (there is no order, and the budget gate
     * does not audit its own either); the two entries that matter are the
     * override, which is a privilege being exercised and names the rule that was
     * waived, and the warning, which is the only trace of an order the gate had
     * something to say about.
     */
    if (policyOverridden) {
      await logAuditWith(
        tx,
        session.id,
        'order.policy_overridden',
        order.id,
        `${session.email} placed an order refused by policy: ` +
          // The rule is already inside the composed sentence (`denyMessage`), so
          // it is not named twice here.
          `${policy.message ?? '(no message)'}`,
      )
    } else if (policy.outcome === 'warn') {
      await logAuditWith(
        tx,
        session.id,
        'order.policy_warning',
        order.id,
        `${session.email} placed an order policy allowed with a warning` +
          (policy.rule ? ` (rule: ${policy.rule})` : '') +
          `: ${policy.message ?? '(no message)'}`,
      )
    } else if (approvalRequired) {
      /*
       * An order policy held back is written with the order it describes, like
       * the two entries above and for the same reason: this is the record of why
       * an order that would have provisioned immediately did not. Without it the
       * queue row looks like any other request, and the question a month later —
       * "why was this admin's order waiting" — has no answer anywhere.
       */
      await logAuditWith(
        tx,
        session.id,
        'order.policy_needs_approval',
        order.id,
        `${session.email}'s order was held for approval, which policy required` +
          (policy.rule ? ` (rule: ${policy.rule})` : '') +
          `: ${policy.message ?? '(no message)'}`,
      )
    }

    return { kind: 'placed' as const, order, budget }
  })

  if (placement.kind === 'blocked') return err(409, placement.message, 'budget_blocked')
  const { order, budget } = placement

  /*
   * `budget.message` is returned on the created order below, so the person who
   * placed it is told at the moment they placed it. The approver is told
   * separately, on the queue row, because by the time this runs for an approval
   * the decision has already been taken.
   *
   * The notice on the way out is keyed on the MESSAGE, not on the outcome: an
   * order only reaches the returns below with a message when it went through
   * over budget, which is `warn` or a root override. A `block` that was not
   * overridden returned above. The audit entries for both were written inside
   * the transaction, with the order they describe.
   */

  if (provisionNow) {
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
      ...(budget.message ? { budgetWarning: budget.message } : {}),
      ...(policy.message ? { policyWarning: policy.message } : {}),
    })
  } else {
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

    return ok({
      ...(order as CreatedOrder),
      ...(budget.message ? { budgetWarning: budget.message } : {}),
      /*
       * A `needs-approval` verdict is not a warning: the order did not proceed
       * as it would have, it is waiting for somebody else. So it goes out on its
       * own field, which is what lets a caller — the cart, the form — say that
       * rather than style it as "your order was placed".
       *
       * Read off the OUTCOME, not off the message: only a needs-approval verdict
       * produces one, and a caller that had to tell the two apart by their
       * sentences would be broken by a policy that wrote a similar one.
       */
      ...(approvalRequired && policy.message ? { policyApprovalRequired: policy.message } : {}),
      ...(policy.outcome === 'warn' && policy.message ? { policyWarning: policy.message } : {}),
    })
  }
}
