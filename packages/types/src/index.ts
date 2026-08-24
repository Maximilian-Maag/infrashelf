// Roles and enums
export type Role = 'admin' | 'project_manager' | 'root'
export type OrderStatus = 'pending' | 'provisioning' | 'completed' | 'failed' | 'rejected'
export type InfraStatus = 'active' | 'decommissioning' | 'decommissioned'
export type CostCenterMode = 'project' | 'select' | 'overhead'
export type ParameterScope = 'global' | 'category' | 'product'
export type ParameterType = 'string' | 'number' | 'bool' | 'dropdown'
export type CiProvider = 'gitlab' | 'github' | 'bitbucket'
export type AiProviderType = 'claude' | 'openai' | 'azure_openai' | 'ollama' | 'localai'

// Auth
export interface SessionUser {
  id: number
  email: string
  name: string
  role: Role
}

export interface LoginRequest {
  email: string
  password: string
  /**
   * Extend the session to the "remember me" lifetime (30 days) instead of the
   * 8 h default. See the backend's `lib/auth/sessions.ts` (issue #37).
   *
   * On a two-step sign-in this is decided here, at the password step, and
   * travels inside the MFA challenge — so the second step cannot change it and
   * does not have to be told it again.
   */
  rememberMe?: boolean
  /**
   * Check the password and report whether a second factor is required, minting
   * nothing at all: no token, and no `sessions` row. This is what the two-step
   * sign-in asks first (issue #36); without it the password step of an account
   * WITHOUT a second factor would open a session the browser then throws away,
   * leaving a phantom row in the user's own session list (issue #37).
   */
  challengeOnly?: boolean
}

export interface LoginResponse {
  token: string
  user: SessionUser
}

/**
 * One server-side session record (issue #37).
 *
 * The token is never part of this — only its hash is stored, and not even that
 * leaves the backend. Dates are ISO strings, as everywhere else in this API.
 */
export interface SessionInfo {
  id: number
  userId: number
  /** Null when no trusted proxy supplied one; see TRUST_PROXY. */
  ip: string | null
  /** Null when the client sent no User-Agent. Truncated to 400 characters. */
  userAgent: string | null
  createdAt: string
  /** Advanced at most once every five minutes, not on every request. */
  lastSeenAt: string
  expiresAt: string
  /** True for the session the request asking for this list came from. */
  current: boolean
}

/** Result of revoking one session or a batch of them. */
export interface RevokeSessionsResponse {
  revoked: number
}

/**
 * What `POST /api/auth/login` returns when the account has a second factor
 * (issue #36): a challenge, and deliberately no session token. `token` is absent
 * rather than null so a client that forgets to check `mfaRequired` finds nothing
 * it could mistake for a session.
 */
export interface MfaChallengeResponse {
  mfaRequired: true
  mfaToken: string
  /** Seconds until the challenge expires. */
  expiresIn: number
}

export type LoginResult = LoginResponse | MfaChallengeResponse

/**
 * What `POST /api/auth/login` returns for `challengeOnly` when the account has
 * no second factor: the password was right, and nothing else — no token, and
 * (since #37) no `sessions` row either. The caller signs in normally afterwards.
 */
export interface PasswordAcceptedResponse {
  mfaRequired: false
}

export type PasswordCheckResult = MfaChallengeResponse | PasswordAcceptedResponse

export const isMfaChallenge = (
  r: LoginResult | PasswordCheckResult,
): r is MfaChallengeResponse => (r as MfaChallengeResponse).mfaRequired === true

export interface MfaLoginRequest {
  mfaToken: string
  /** A TOTP code or a one-time recovery code. */
  code: string
}

// Two-factor authentication (issue #36)
export interface TwoFactorStatusResponse {
  enabled: boolean
  confirmedAt: string | null
  pending: boolean
  recoveryCodesRemaining: number
  lockedUntil: string | null
}

export interface StartTotpEnrollmentRequest {
  password: string
  /** A current code or recovery code. Required only when re-enrolling. */
  code?: string
}

export interface StartTotpEnrollmentResponse {
  secret: string
  secretFormatted: string
  otpauthUrl: string
  /** A self-contained SVG of the enrollment QR code. */
  qrSvg: string
}

export interface ConfirmTotpEnrollmentRequest {
  code: string
}

export interface ConfirmTotpEnrollmentResponse {
  /** Shown exactly once — they are stored hashed and cannot be retrieved again. */
  recoveryCodes: string[]
}

// Users
export interface User {
  id: number
  email: string
  name: string
  role: Role
  active: boolean
  ssoSub: string | null
  createdAt: string
}

export interface CreateUserRequest {
  email: string
  name: string
  role: Role
  password: string
}

export interface UpdateUserRequest {
  name?: string
  role?: Role
  active?: boolean
}

export interface UpdateProfileRequest {
  name: string
}

export interface ChangePasswordRequest {
  currentPassword: string
  newPassword: string
}

// Categories
export interface Category {
  id: number
  name: string
  displayOrder: number
}

export interface CreateCategoryRequest {
  name: string
  displayOrder?: number
}

export interface UpdateCategoryRequest {
  name?: string
  displayOrder?: number
}

// Products
/**
 * One page of the catalogue.
 *
 * `GET /api/catalog` returns this rather than a bare array: the endpoint filters
 * and pages in the database now, so the caller needs to know how many matches
 * there are beyond the page it was given (issue #91).
 */
export interface CatalogPage {
  items: Product[]
  /** Matches for the filters, ignoring the page window. */
  total: number
  limit: number
  offset: number
}

export interface Product {
  id: number
  categoryId: number
  baseLanguage: string
  createdAt: string
  name: string
  description: string
  /**
   * What the product picture shows, for its `alt` attribute.
   *
   * Null when the product has no image. Required whenever one is uploaded, so a
   * component never has to invent a description or decide the picture is
   * decorative — which is what every one of them used to do differently.
   */
  imageAlt?: string | null
}

export interface ProductDetail extends Product {
  environments: ProductEnvironment[]
  parameters: Parameter[]
}

export interface CreateProductRequest {
  categoryId: number
  baseLanguage: string
  name: string
  description: string
}

export interface UpdateProductRequest {
  categoryId?: number
  baseLanguage?: string
  name?: string
  description?: string
  /** Optional free text describing the change, recorded in the history (issue #38). */
  changelog?: string
}

export interface ProductTranslation {
  productId: number
  languageCode: string
  name: string
  description: string
}

// Parameters
export interface Parameter {
  id: number
  scope: ParameterScope
  scopeId: number
  environmentId: number | null
  name: string
  label: string
  type: ParameterType
  description: string
  defaultValue: string
  required: boolean
  sensitive: boolean
}

export interface CreateParameterRequest {
  scope: ParameterScope
  scopeId: number
  environmentId?: number
  name: string
  label?: string
  type: ParameterType
  description?: string
  defaultValue?: string
  required?: boolean
  sensitive?: boolean
}

export interface UpdateParameterRequest {
  name?: string
  label?: string
  type?: ParameterType
  description?: string
  defaultValue?: string
  required?: boolean
  sensitive?: boolean
}

// CI Sources
export interface CiSource {
  id: number
  name: string
  url: string
  provider: CiProvider
}

export interface CreateCiSourceRequest {
  name: string
  url: string
  accessToken: string
  provider: CiProvider
}

export interface UpdateCiSourceRequest {
  name?: string
  url?: string
  accessToken?: string
  provider?: CiProvider
}

// Deployment Environments
export interface DeploymentEnvironment {
  id: number
  name: string
  description: string
  ciSourceId: number
  /**
   * Whether an outbound pipeline-trigger token is configured — never the token.
   *
   * webhook_token lets its holder fire arbitrary pipelines in the CI project, so no
   * read path returns it (issue #144); an operator replaces it by sending a new one
   * to PUT /api/admin/environments/:id. Optional because responses predating the
   * fix omit it.
   */
  webhookTokenSet?: boolean
}

// Response shape for GET/POST /api/admin/environments/:id/callback-secret.
// The portal-owned inbound webhook secret is returned in the clear here so
// the operator can copy it into GitLab (Settings → Webhooks → Secret token).
export interface CallbackSecretResponse {
  callbackSecret: string
}

export interface CreateEnvironmentRequest {
  name: string
  description?: string
  ciSourceId: number
  webhookUrl: string
  webhookToken: string
}

export interface UpdateEnvironmentRequest {
  name?: string
  description?: string
  ciSourceId?: number
  webhookUrl?: string
  webhookToken?: string
}

/**
 * One size an offering can be ordered in (issue #98).
 *
 * Price lives here rather than on the offering: the size is what the customer
 * chooses and what they pay for. An offering with NO sizes keeps using its own
 * `price` — that is every offering that predates sizing.
 */
export interface OfferingSize {
  id: number
  /** Reaches the pipeline as SIZE and is stored on the order line. */
  code: string
  label: string
  price: string
  currency: string
  sortOrder: number
  /** Retired sizes stay readable for existing orders but cannot be ordered. */
  active: boolean
}

export interface UpsertSizeRequest {
  code: string
  label?: string
  price?: string
  currency?: string
  sortOrder?: number
  active?: boolean
  changelog?: string
}

// Product Environments
export interface ProductEnvironment {
  productId: number
  environmentId: number
  price: string
  currency: string
  costCenterMode: CostCenterMode
  forcedCostCenter: boolean
  /**
   * The fixed shared cost centre used by `overhead` mode (FA-10.4). null for
   * the other two modes, and for an `overhead` offering that has not had an
   * account chosen yet.
   */
  overheadCostCenterId: number | null
  /**
   * Whether this offering can be ordered as a time-boxed trial (issue #1).
   * Opt-in per offering: a trial provisions real infrastructure and asks the
   * pipeline to grant elevated rights inside it.
   */
  trialEnabled: boolean
  /** How long a trial of this offering lives. Defaults to 30 minutes. */
  trialDurationMinutes: number
  environmentName?: string
  /** Resolved name of `overheadCostCenterId`, for display in the order form. */
  overheadCostCenterName?: string | null
  /**
   * The sizes this offering can be ordered in (issue #98), in the order an admin
   * arranged them. Empty (or absent, on an endpoint that does not resolve them)
   * means the offering has none and its own `price` applies; when it is non-empty
   * an order MUST name one of these codes and is charged that size's price.
   */
  sizes?: OfferingSize[]
}

export interface UpsertProductEnvironmentRequest {
  price: string
  currency: string
  costCenterMode: CostCenterMode
  forcedCostCenter: boolean
  overheadCostCenterId?: number | null
  trialEnabled?: boolean
  trialDurationMinutes?: number
  /** Optional free text describing the change, recorded in the history (issue #38). */
  changelog?: string
}

// Product Webhooks
export interface ProductWebhook {
  id: number
  productId: number
  environmentId: number
  name: string
  webhookUrl: string
  execOrder: number
  /**
   * Whether a trigger token is configured — never the token itself (issue #144).
   * Optional because responses predating the fix omit it.
   */
  webhookTokenSet?: boolean
}

export interface CreateProductWebhookRequest {
  environmentId: number
  name: string
  webhookUrl: string
  webhookToken: string
  execOrder?: number
}

// Pipeline Stacks
export interface UpstreamRef {
  // CI variable name exposed to the child template (uppercase convention).
  // The base pipeline promotes this to TF_VAR_<lowercase> for Terraform.
  varName: string
  // stateSuffix of an earlier step whose state this ref points to.
  suffix: string
}

export interface StackStep {
  template: string
  stateSuffix: string
  // execOrder groups: steps with the same value run in parallel; groups run
  // sequentially from lowest to highest. Defaults to 0.
  execOrder?: number
  // Zero or more upstream state references (replaces the single upstreamSuffix).
  upstreamRefs?: UpstreamRef[]
  fixedParams?: Record<string, string>
}

export interface PipelineStack {
  id: number
  productId: number
  environmentId: number
  name: string
  stateKeyParam: string
  steps: StackStep[]
}

// Stacks inherit the deployment environment's webhook_url + webhook_token —
// having them on the stack itself let the two tokens diverge and broke the
// outbound trigger while the inbound callback still validated the env token.
export interface CreatePipelineStackRequest {
  environmentId: number
  name: string
  stateKeyParam?: string
  steps: StackStep[]
}

export interface UpdatePipelineStackRequest {
  name?: string
  stateKeyParam?: string
  steps?: StackStep[]
}

// Cost Centers
export interface CostCenter {
  id: number
  code: string
  name: string
  active: boolean
}

export interface CreateCostCenterRequest {
  code: string
  name: string
  active?: boolean
}

export interface UpdateCostCenterRequest {
  code?: string
  name?: string
  active?: boolean
}

// Projects
export interface Project {
  id: number
  name: string
  description: string
  ownerId: number
  costCenterId: number | null
  createdAt: string
  ownerName?: string
  costCenterName?: string
}

export interface CreateProjectRequest {
  name: string
  description?: string
  costCenterId?: number
}

export interface UpdateProjectRequest {
  name?: string
  description?: string
  costCenterId?: number
}

// Orders
export interface Order {
  id: number
  projectId: number
  productId: number
  environmentId: number
  userId: number
  status: OrderStatus
  parameters: Record<string, string>
  costCenterId: number | null
  rejectionNote: string | null
  pipelineId: string[]
  createdAt: string
  updatedAt: string
  /** Ordered as a time-boxed trial (issue #1). */
  isTrial?: boolean
  /** The size that was ordered (issue #98). Null when the offering has none. */
  sizeCode?: string | null
  /**
   * How many infrastructure elements the order provisioned (issue #104).
   *
   * One order, N elements: one approval covers all of them and the order's price is
   * the unit price times this. Teardown stays per element.
   */
  quantity?: number
  /**
   * What the customer was offered when the order was placed (issue #38). Null for
   * orders placed before snapshots existed — the order detail page falls back to
   * the live product for those, and says so.
   */
  productSnapshot?: ProductSnapshot | null
  productName?: string
  environmentName?: string
  projectName?: string
  userName?: string
}

export interface CreateOrderRequest {
  projectId: number
  productId: number
  environmentId: number
  costCenterId?: number
  parameters: Record<string, string>
  /**
   * The size to order (issue #98). Mandatory when the offering defines sizes and
   * refused when it does not — the server decides, because the picker is simply
   * absent in the browser for an offering with none.
   */
  sizeCode?: string | null
  /** How many elements to provision (issue #104). Defaults to 1, capped at 20. */
  quantity?: number
  /**
   * Order as a time-boxed trial (issue #1). Only accepted for an offering with
   * `trialEnabled`; it does NOT bypass approval — a project manager's trial still
   * needs an admin to approve it.
   */
  trial?: boolean
}

// ─── Costs (issue #32) ────────────────────────────────────────────────────────

export type CostRange = 'currentMonth' | 'last3Months' | 'last12Months' | 'all' | 'custom'

export interface CostBucket {
  id: number | null
  label: string
  /** EUR, the exchange-rate base. Convert client-side for display. */
  totalEur: number
  orderCount: number
}

/**
 * One calendar month of the report's window (issue #106).
 *
 * Monthly rather than weekly because every range preset is month-aligned, so those
 * are the only buckets that line up with the window the user picked — and "this
 * month vs last" is the question the comparison answers.
 */
export interface CostPeriod {
  /** Calendar month in UTC, `YYYY-MM`. */
  period: string
  totalEur: number
  orderCount: number
  /** Orders in this month priced from the live offering rather than a snapshot. */
  estimatedOrders: number
  /** The month is not over, so the figure will still grow. Charts must say so. */
  partial: boolean
}

/** The last two months of the series, so the client does no date arithmetic. */
export interface CostComparison {
  current: CostPeriod
  previous: CostPeriod
  /** current − previous, EUR. */
  changeEur: number
  /** Percentage change, or null when the previous month was zero. */
  changePct: number | null
}

export interface CostReport {
  totalEur: number
  orderCount: number
  /**
   * Orders whose price came from the live offering because they predate snapshots.
   * Non-zero means the total is partly inferred rather than exact.
   */
  estimatedOrders: number
  /**
   * Spend per calendar month, oldest first, empty months in between filled in.
   * Sums to `totalEur`, so a trend and a total cannot disagree.
   */
  series: CostPeriod[]
  /** Null when the window covers fewer than two months. */
  comparison: CostComparison | null
  byProject: CostBucket[]
  byCostCenter: CostBucket[]
  byProduct: CostBucket[]
  byEnvironment: CostBucket[]
  /** Amounts with no stored exchange rate, reported rather than silently dropped. */
  unconverted: { currency: string; amount: number }[]
  /** True when the caller sees every project's spend. */
  global: boolean
}

// ─── Cart (issue #28) ─────────────────────────────────────────────────────────

export interface CartItem {
  id: number
  productId: number
  environmentId: number
  /** Prefill only — validated at checkout, not when added. */
  parameters: Record<string, string>
  createdAt: string
  productName: string | null
  environmentName: string | null
  /** The chosen size (issue #98), null when the offering has none. */
  sizeCode?: string | null
  /** How the size reads today. Display only — the code is what the line stores. */
  sizeLabel?: string | null
  /** How many elements this line will provision (issue #104). */
  quantity?: number
  /**
   * UNIT price — the chosen size's, or the offering's for a line with no size. The
   * line total is this times `quantity`.
   */
  price: string | null
  currency: string | null
  /** Description of the product picture, for its `alt` attribute. */
  imageAlt?: string | null
  /**
   * False when the product is no longer offered in that environment, or when the
   * size the line chose has been retired.
   */
  stillOffered: boolean
}

export interface AddToCartRequest {
  productId: number
  environmentId: number
  parameters?: Record<string, string>
  /** Required when the offering defines sizes, refused when it does not (#98). */
  sizeCode?: string | null
  /** Defaults to 1, capped at 20 (issue #104). */
  quantity?: number
}

/**
 * Patch one cart line. An omitted field is left alone, so the quantity control
 * does not have to resend the parameters it never touched.
 */
export interface UpdateCartItemRequest {
  parameters?: Record<string, string>
  sizeCode?: string | null
  quantity?: number
}

export interface CheckoutItem {
  cartItemId: number
  parameters: Record<string, string>
  costCenterId?: number
  trial?: boolean
}

export interface CheckoutRequest {
  projectId: number
  items: CheckoutItem[]
}

export interface CheckoutResponse {
  orderIds: number[]
  /**
   * Items whose orders could not be created after validation passed. These stay in
   * the cart — a fired pipeline cannot be recalled, so partial failure is reported
   * rather than hidden.
   */
  failed: { cartItemId: number; message: string }[]
}

/**
 * What a sensitive parameter value is replaced with on every read path (#131).
 *
 * A runtime constant in the shared package rather than a literal on each side:
 * the backend refuses this exact string on the way back in, and the order form
 * drops it from a prefill. If the two ever disagreed, a reorder would store the
 * placeholder as the real secret again — which is the bug this sentinel exists
 * to prevent.
 */
export const REDACTED_PARAMETER_VALUE = '[redacted]'

// ─── Product versioning (issue #38) ───────────────────────────────────────────

/** One parameter definition as it stood when a snapshot was taken. */
export interface ParameterSnapshot {
  name: string
  label: string
  type: string
  description: string
  /** `REDACTED_PARAMETER_VALUE` when the parameter is flagged sensitive. */
  defaultValue: string
  required: boolean
  sensitive: boolean
}

/**
 * Point-in-time capture of what a customer was offered.
 *
 * Stored on the order so a later price change or removed parameter cannot rewrite
 * what the order detail page reports as approved.
 */
export interface ProductSnapshot {
  version: 1
  capturedAt: string
  productName: string
  productDescription: string
  /**
   * Every name the product had when the order was placed, keyed by language code
   * (issue #162).
   *
   * ABSENT on snapshots taken before it existed — a reader falls back to
   * `productName`, it does not conclude the product had no translations. History is
   * never retranslated: this is what the names read as at capture time, so a
   * reader picks their language and still sees what was ordered.
   */
  productNames?: Record<string, string>
  environmentName: string
  /**
   * The UNIT price that applied — the chosen size's, or the offering's when the
   * order named no size (issue #98). The line total is this times the order's
   * `quantity`, which lives on the order rather than here: quantity is a fact about
   * the order, not about what the catalogue offered.
   */
  price: string
  currency: string
  /**
   * The size that was ordered, and its label as it read at the time (issue #98).
   *
   * ABSENT means the snapshot predates sizing; NULL means the offering had no sizes
   * when the order was placed. Text rather than an id, because an admin may retire
   * or re-price a size and this record has to survive that.
   */
  sizeCode?: string | null
  sizeLabel?: string | null
  costCenterMode: CostCenterMode
  forcedCostCenter: boolean
  /**
   * The overhead account the offering bills to, as a label (issue #22).
   *
   * Optional: snapshots taken before it was captured do not carry it, so absent
   * means "unknown" rather than "none" — a diff must not report every older
   * version as a change.
   */
  overheadCostCenter?: string | null
  trialEnabled: boolean
  trialDurationMinutes: number
  parameters: ParameterSnapshot[]
}

/** One entry in a product's change history. */
export interface ProductVersion {
  id: number
  productId: number
  /** Null for a change to the product itself rather than to one offering. */
  environmentId: number | null
  changelog: string
  summary: string
  snapshot: ProductSnapshot | null
  createdBy: number | null
  createdAt: string
  authorName: string | null
  environmentName: string | null
}

export interface SnapshotFieldChange {
  field: string
  from: string
  to: string
}

export type SnapshotParameterChange =
  | { kind: 'added'; name: string; to: ParameterSnapshot }
  | { kind: 'removed'; name: string; from: ParameterSnapshot }
  | { kind: 'changed'; name: string; fields: SnapshotFieldChange[] }

export interface ProductVersionDiff {
  fields: SnapshotFieldChange[]
  parameters: SnapshotParameterChange[]
  identical: boolean
  fromVersionId: number
  toVersionId: number
}

/**
 * A comment on an order (issue #34).
 *
 * An `internal` comment is only ever returned to admin/root — the API filters
 * them out for other callers rather than relying on the client to hide them.
 */
export interface OrderComment {
  id: number
  orderId: number
  userId: number
  body: string
  internal: boolean
  createdAt: string
  updatedAt: string
  userName: string | null
  /** True when the comment was edited after posting. */
  edited: boolean
}

export interface CreateOrderCommentRequest {
  body: string
  /** Admin/root only; rejected with 403 otherwise. */
  internal?: boolean
}

export interface UpdateOrderCommentRequest {
  body: string
}

export interface RejectOrderRequest {
  rejectionNote: string
}

// Approval delegation (issue #35)
//
// An admin's approval AUTHORITY, held by a substitute for a period. The
// substitute approves under their own name — nothing here impersonates the
// delegator — and every decision taken while a delegation is in force is audited
// against it.
export interface ApprovalDelegation {
  id: number
  fromUserId: number
  fromUserName: string
  fromUserEmail: string
  toUserId: number
  toUserName: string
  toUserEmail: string
  /** Calendar date (YYYY-MM-DD), inclusive. */
  startsOn: string
  /** Calendar date (YYYY-MM-DD), inclusive — the last day it is in force. */
  endsOn: string
  createdAt: string
  revokedAt: string | null
  /**
   * Computed by the server at read time from `starts_on <= today <= ends_on` and
   * `revoked_at IS NULL`. Never stored, so a delegation cannot outlive its end
   * date and no job has to expire it.
   */
  active: boolean
}

export interface ApprovalDelegationsResponse {
  /** Authority the caller has given away. */
  mine: ApprovalDelegation[]
  /** Authority the caller holds on behalf of others. */
  grantedToMe: ApprovalDelegation[]
  /** Active admins the caller may nominate. Root is excluded. */
  candidates: { id: number; name: string; email: string }[]
}

export interface CreateApprovalDelegationRequest {
  toUserId: number
  startsOn: string
  endsOn: string
}

// Infrastructure
export interface InfrastructureElement {
  id: number
  orderId: number
  projectId: number
  environmentId: number
  productId: number
  status: InfraStatus
  parameters: Record<string, string>
  pipelineId: string[]
  outputs: Record<string, string>
  deployedAt: string | null
  /**
   * When set, the element is torn down automatically at or after this instant
   * (issue #30). null = no schedule.
   */
  scheduledDecommissionAt?: string | null
  /** The size this element runs at (issue #98); null when it has none. */
  sizeCode?: string | null
  /**
   * Which of its order's elements this is, 1-based (issue #104). Also what the
   * element's Terraform state key is derived from, so it is stable for its life.
   */
  sequence?: number
  /** How many elements the order asked for, so a row can read "3 of 20". */
  orderQuantity?: number | null
  productName?: string
  environmentName?: string
  projectName?: string
  /**
   * Status of the order this element came from. The element's own status cannot
   * express a failed deployment — it is created `active` when provisioning starts
   * and stays there if the pipeline fails — so a failed deployment is
   * `status: 'active'` with `orderStatus: 'failed'`.
   */
  orderStatus?: OrderStatus | null
}

/**
 * One infrastructure element in full (GET /infrastructure/{id}).
 *
 * Everything the list carries, plus what only a detail view needs: the pipeline
 * status map, the cost centre the order is billed to, and which parameter values
 * were redacted — the names stay visible, the values do not.
 */
export interface InfrastructureDetail extends InfrastructureElement {
  /** Status per id in `pipelineId`, from the run named by `pipelinePhase`. */
  pipelineStatus: Record<string, string>
  /**
   * Which run `pipelineId` describes: provisioning while the element is active,
   * teardown once decommissioning started (a teardown rewrites the id list).
   */
  pipelinePhase: 'provisioning' | 'teardown'
  costCenter: string | null
  orderCreatedAt: string | null
  isTrial: boolean
  redactedParameters: string[]
}

/** Option lists for the infrastructure list filters (GET /infrastructure/facets). */
export interface InfraFacets {
  environments: { id: number; name: string }[]
  projects: { id: number; name: string }[]
  products: { id: number; name: string }[]
}

export type InfraSortField = 'date' | 'name' | 'status'

/** A product the current user has favourited (GET /favorites). */
export interface FavoriteProduct {
  productId: number
  categoryId: number
  name: string
  description: string
  /** Same meaning as on `Product` — carried so the favourites shelf can render a card. */
  imageAlt?: string | null
  createdAt: string
}

// Exchange Rates
export interface ExchangeRate {
  currencyCode: string
  rate: string
  updatedAt: string
}

// Audit
export interface AuditEntry {
  id: number
  userId: number | null
  action: string
  entityId: number | null
  details: string
  createdAt: string
  userName?: string
}

export interface AuditFilter {
  userId?: number
  action?: string
  from?: string
  to?: string
  page?: number
  pageSize?: number
}

// Branding
export interface Branding {
  primaryColor: string
  secondaryColor: string
  shopName: string
  shopSubtitle: string
  imprintText: string
  logoMime?: string
}

export interface UpdateBrandingRequest {
  primaryColor?: string
  secondaryColor?: string
  shopName?: string
  shopSubtitle?: string
  imprintText?: string
}

// App Config
export interface SmtpConfig {
  host: string
  port: number
  from: string
  user: string
  tls: boolean
}

export interface UpdateSmtpRequest {
  host: string
  port: number
  from: string
  user: string
  password?: string
  tls: boolean
}

export interface AiConfig {
  provider: AiProviderType
  endpoint: string
  model: string
}

export interface UpdateAiConfigRequest {
  provider: AiProviderType
  endpoint: string
  apiKey?: string
  model: string
}

// Pagination
export interface PaginatedResponse<T> {
  data: T[]
  total: number
  page: number
  pageSize: number
}

// API error
export interface ApiError {
  error: string
  details?: unknown
}

// Pipeline webhook events (normalized across providers)
export interface PipelineEvent {
  provider: CiProvider
  pipelineId: string
  status: 'success' | 'failed' | 'running' | 'pending' | 'canceled'
}

// CI repository browser
export interface CiProject {
  id: string
  name: string
  fullPath: string
}

export interface CiBranch {
  name: string
}

export interface CiFile {
  name: string
  path: string
  type: 'blob' | 'tree'
}
