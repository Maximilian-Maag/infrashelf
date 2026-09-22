// Roles and enums
export type Role = 'admin' | 'project_manager' | 'root'
/*
 * `scheduled` sits between approval and provisioning (#330): an admin has
 * decided, but the environment respects deployment windows and none is open.
 *
 * It reached the database enum with #330 and not this type, so for a while the
 * contract the frontend compiles against said a scheduled order was impossible
 * — the badge fell through to rendering the raw lowercase word in default grey,
 * and every exhaustive switch silently had no branch for it.
 */
export type OrderStatus = 'pending' | 'scheduled' | 'provisioning' | 'completed' | 'failed' | 'rejected'
export type InfraStatus = 'active' | 'decommissioning' | 'decommissioned'
/**
 * What an element can be SHOWN as — the stored statuses plus the two that live
 * on its order. See `InfrastructureElement.displayStatus`.
 */
export type InfraDisplayStatus = InfraStatus | 'provisioning' | 'failed'
export type CostCenterMode = 'project' | 'select' | 'overhead'
export type ParameterScope = 'global' | 'category' | 'product'
/**
 * `size` is a T-shirt size: the variable is not typed in by the customer at
 * all, its value comes from the size they picked. See `Parameter.sizeValues`.
 */
export type ParameterType = 'string' | 'number' | 'bool' | 'dropdown' | 'size'
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
  /**
   * The account is an administrator with no confirmed second factor, and must
   * enroll one before the API will serve it anything else (issue #197).
   *
   * A real session token comes with it, deliberately: enrolling needs a working
   * session, so the alternative — refusing to sign them in — would be a lockout
   * with no way out. What the token cannot do is anything except enroll; the
   * backend refuses every other route with `second_factor_required`, and this
   * flag exists so the frontend can send the user straight there rather than
   * letting them walk into a 403.
   *
   * Absent, not `false`, when nothing is owed — the flag is the exception.
   */
  mustEnrollSecondFactor?: boolean
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
/** One registered security key or passkey (issue #197, part 2). */
export interface WebauthnCredential {
  id: number
  /** What the user called it — they will have more than one. */
  label: string
  createdAt: string
  lastUsedAt: string | null
  /** A synced passkey rather than one bound to a single device. */
  backedUp: boolean
}

export interface WebauthnCredentialsResponse {
  credentials: WebauthnCredential[]
}

/**
 * What finishing a registration returns.
 *
 * `recoveryCodes` is present only when this was the account's FIRST factor of any
 * kind, and that response is the only copy that will ever exist — they are stored
 * hashed. A second key does not reissue them, because that would silently
 * invalidate the set the user already wrote down.
 */
export interface WebauthnRegistrationResult {
  label: string
  recoveryCodes?: string[]
}

/** Which second factors an account actually holds (issue #197, part 2). */
export type SecondFactorMethod = 'totp' | 'webauthn'

export interface MfaChallengeResponse {
  mfaRequired: true
  mfaToken: string
  /** Seconds until the challenge expires. */
  expiresIn: number
  /**
   * What this account can present, so the form offers the right thing.
   *
   * Told at the challenge and not guessed, because an account may hold a key and
   * no authenticator app, and a form that always asked for six digits would be
   * asking for something that does not exist. Disclosed to a caller who has
   * already proved the password, and it says which KINDS exist — never how many,
   * and never anything identifying.
   */
  methods: SecondFactorMethod[]
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
/**
 * One window onto a list the server refuses to send whole.
 *
 * The catalogue was paginated first (#91) and everything else was left
 * unbounded, so a dashboard for an installation with fifty thousand orders
 * tried to serialise all of them (#158). This is that same shape, named once,
 * so the next list to grow teeth has a contract to adopt rather than invent.
 *
 * `total` counts the rows MATCHING THE FILTERS and ignores the window — it is
 * what a "page 3 of 40" reads from, so counting the window instead would always
 * say one.
 */
export interface Page<T> {
  items: T[]
  /** Matches for the filters, ignoring the page window. */
  total: number
  limit: number
  offset: number
}

export interface CatalogPage extends Page<Product> {
  /**
   * Whether `total` is the real number of matches, or a floor.
   *
   * The catalogue search cannot use an index — a leading-wildcard `ILIKE` over
   * a COALESCE of per-language subqueries — so counting the matches costs a
   * full evaluation per row, and the count stops at a cap. False means "at
   * least `total`", and a UI printing a confident "of 500" for a result set of
   * 4,000 would be stating something untrue (#236).
   *
   * Optional so a client written before the cap keeps compiling; absent reads
   * as exact, which is what it was.
   */
  totalIsExact?: boolean
}
export type OrderPage = Page<Order>
export type InfrastructurePage = Page<InfrastructureElement>

/**
 * The landing page's counters and its five most recent orders.
 *
 * `GET /api/dashboard` exists so the dashboard stops answering "how many orders
 * do I have" by downloading every order, every infrastructure element and every
 * project and calling `.length` on the results (issue #158). Fixed size,
 * whatever the history behind it.
 */
export interface DashboardSummary {
  orders: { total: number; pending: number }
  infrastructure: { active: number }
  projects: { total: number }
  /** Newest first, capped at five — what the page renders. */
  recentOrders: DashboardOrder[]
}

/** One row of the dashboard's recent-orders list, with only what it renders. */
export interface DashboardOrder {
  id: number
  productId: number
  productName: string | null
  environmentName: string | null
  projectName: string | null
  status: OrderStatus
  createdAt: string
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
  /**
   * When the product was taken out of the catalogue, or null while it is live.
   *
   * Set and cleared deliberately since #251 — before that it was a side effect
   * of `deleteProduct` refusing to destroy order history, one-way, and hidden
   * from every admin screen, so a product withdrawn by pressing Delete could not
   * be brought back. The catalogue still filters on it; the ADMIN list shows it,
   * because that is the only place it can be reversed from.
   *
   * Optional on the wire: the catalogue's own payloads never carry it, since
   * they only ever contain live products.
   */
  retiredAt?: string | null
}

/** One picture of a product's gallery; the bytes come from the image routes. */
export interface ProductImageMeta {
  id: number
  /**
   * What the picture shows. Never blank — the column is NOT NULL and the upload
   * endpoint refuses an empty one (#105), so a gallery thumbnail always has a real
   * accessible name.
   */
  alt: string
}

export interface ProductDetail extends Product {
  environments: ProductEnvironment[]
  parameters: Parameter[]
  /** The gallery, in order. Empty on a product with no picture (issue #107). */
  images: ProductImageMeta[]
  /**
   * The long product story, shown only on the detail page. Empty string when
   * nobody wrote one; `description` stays the short text the tile uses.
   */
  longDescription: string
  /** Who runs it, and where its documentation is. Null when unset. */
  owner: string | null
  docsUrl: string | null
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
  /** Null or empty clears it (issue #107). */
  owner?: string | null
  /** Must start with http:// or https://; null or empty clears it. */
  docsUrl?: string | null
  /** Optional free text describing the change, recorded in the history (issue #38). */
  changelog?: string
}

export interface ProductTranslation {
  productId: number
  languageCode: string
  name: string
  /** The short text, shown on the catalogue tile and in search. */
  description: string
  /** The long text the detail page shows (issue #107); '' when unwritten. */
  longDescription: string
}

// Parameters
export interface Parameter {
  id: number
  scope: ParameterScope
  scopeId: number
  environmentId: number | null
  /**
   * Projects this parameter is narrowed to. Empty means every project (#275).
   *
   * Optional because it is assembled from `parameter_projects` by the admin
   * list rather than being a column, and the paths that read a bare row do not
   * fill it in. Absent reads the same as empty, which is what every parameter
   * was before narrowing existed.
   */
  projectIds?: number[]
  name: string
  label: string
  type: ParameterType
  description: string
  defaultValue: string
  required: boolean
  sensitive: boolean
  /**
   * For a `size` parameter: what each size code means for this variable.
   *
   *     { "S": "t3.micro", "M": "t3.large", "XL": "m6i.2xlarge" }
   *
   * Empty for every other type. One size can drive several variables — vSphere
   * moves `num_cpus`, `memory_mb` and `disk_size_gb` together — which is why the
   * map is on the VARIABLE rather than on the size.
   */
  sizeValues: Record<string, string>
}

export interface CreateParameterRequest {
  scope: ParameterScope
  scopeId: number
  environmentId?: number
  /** Projects this parameter is narrowed to; omitted means every project (#275). */
  projectIds?: number[]
  name: string
  label?: string
  type: ParameterType
  sizeValues?: Record<string, string>
  description?: string
  defaultValue?: string
  required?: boolean
  sensitive?: boolean
}

export interface UpdateParameterRequest {
  /**
   * Which environment this parameter applies to; `null` means all of them.
   *
   * The create request has carried this since the column existed, and the route
   * has always accepted it on update too — the type simply did not say so, so
   * nothing could send it and a parameter's environment could be chosen once
   * and never corrected (#275).
   */
  environmentId?: number | null
  /**
   * Projects this parameter is narrowed to (#275).
   *
   * Absent leaves the narrowing untouched; `[]` clears it back to "every
   * project". Those have to be different, or an update that says nothing about
   * projects would silently widen the parameter to all of them.
   */
  projectIds?: number[]
  name?: string
  label?: string
  type?: ParameterType
  description?: string
  defaultValue?: string
  required?: boolean
  sensitive?: boolean
  sizeValues?: Record<string, string>
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

/**
 * What Foreman has, against what this environment ordered (#111).
 *
 * Four buckets, and three of them are easy to read as each other: a ghost is not
 * proof a machine is gone, an orphan is not a fault, and an element with no host
 * name recorded is neither.
 */
export interface ForemanHostSummary {
  id: number
  name: string
  status: string | null
  lastReportAt: string | null
}

export interface ForemanOrderedHost {
  elementId: number
  orderId: number
  productId: number
  hostName: string
}

export interface ForemanReconciliation {
  integration: { id: number; name: string; baseUrl: string }
  environmentId: number
  checkedAt: string
  matched: { elementId: number; hostName: string; foremanHostId: number; status: string | null }[]
  /** Ordered, and Foreman has never heard of it. */
  ghosts: ForemanOrderedHost[]
  /** Present in Foreman, matching nothing the portal ordered. */
  orphans: ForemanHostSummary[]
  /** Active elements carrying no host name, so no comparison was possible. */
  unidentified: { elementId: number; orderId: number; productId: number }[]
}

// Integrations (issue #111)

/** The external systems the portal knows how to talk to. Mirrors INTEGRATION_KINDS. */
export type IntegrationKind = 'foreman' | 'ansible' | 'nexus' | 'pulp' | 'loki' | 'grafana' | 'opa'

export type IntegrationAuthType = 'none' | 'bearer' | 'basic' | 'token_header'

/**
 * Whether a failed call to this system blocks the operation that made it, or is
 * logged and carried on from. Stored per integration rather than decided at each
 * call site, which is how "best effort" becomes invisible.
 */
export type IntegrationFailureMode = 'blocking' | 'best_effort'

/**
 * An integration as every read path returns it: the credential is never in here.
 * `hasCredential` says whether one is stored without saying anything about it.
 */
export interface Integration {
  id: number
  kind: IntegrationKind
  name: string
  baseUrl: string
  authType: IntegrationAuthType
  username: string
  hasCredential: boolean
  /** NULL means portal-wide — one instance serving the whole installation. */
  environmentId: number | null
  enabled: boolean
  failureMode: IntegrationFailureMode
  /** Only ever set on a SUCCESSFUL probe: "when did this last work". */
  lastContactedAt: string | null
  /** Why the most recent probe failed, cleared on the next success. */
  lastError: string | null
  createdAt: string | null
  updatedAt: string | null
}

export interface CreateIntegrationRequest {
  kind: IntegrationKind
  name: string
  baseUrl: string
  authType: IntegrationAuthType
  username?: string
  credential?: string
  environmentId?: number | null
  enabled?: boolean
  /** Required, and deliberately not defaulted — somebody has to decide it. */
  failureMode: IntegrationFailureMode
}

/** `kind` is absent on purpose: a Foreman cannot become a Nexus. */
export interface UpdateIntegrationRequest {
  name?: string
  baseUrl?: string
  authType?: IntegrationAuthType
  username?: string
  /** Sending this rotates the credential; omitting it leaves the stored one. */
  credential?: string
  environmentId?: number | null
  enabled?: boolean
  failureMode?: IntegrationFailureMode
}

/**
 * What a probe answers. `ok: false` arrives with HTTP 200 — the admin asked
 * whether the system is reachable, and "no, because ..." answers that question.
 */
export interface IntegrationProbeResult {
  ok: boolean
  status: number | null
  detail?: string
  error?: string
  lastContactedAt: string | null
  lastError: string | null
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
  /**
   * Whether an approved order for this environment waits for a deployment
   * window (#330). Optional because responses predating the column omit it, and
   * `false` is the default that matters: honouring windows everywhere at
   * upgrade would strand every sandbox deploy after 18:00.
   */
  respectsDeploymentWindows?: boolean
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
  /** #330: whether approved orders here wait for a deployment window. */
  respectsDeploymentWindows?: boolean
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

/**
 * The same sizes, transposed: sizes down, environments across (issue #249).
 *
 * A size code is unique per (product, environment), never global, so the row axis
 * is the UNION of the codes across the product's offerings and a hole in the grid
 * is a legitimate state — the size is simply not offered there.
 */
export interface SizeMatrixCell {
  environmentId: number
  id: number
  price: string
  currency: string
  /** Retired cells stay in the payload: the price is what past orders were struck at. */
  active: boolean
}

export interface SizeMatrixRow {
  code: string
  /**
   * Stored per offering but the same property of the same size in all of them, so
   * the matrix treats it as the row's and writes it to every cell it touches.
   * Price and currency stay per cell — differing per environment is the point.
   */
  label: string
  sortOrder: number
  cells: SizeMatrixCell[]
}

export interface SizeMatrixEnvironment {
  environmentId: number
  name: string
  /** The offering's own currency, the default for a cell that has none yet. */
  currency: string
}

export interface SizeMatrix {
  /** Only the environments the product is offered in — the matrix's columns. */
  environments: SizeMatrixEnvironment[]
  rows: SizeMatrixRow[]
}

/**
 * The full desired state of one row.
 *
 * `cells` lists the environments the size IS offered in; one left out is retired
 * there rather than deleted, because an order that already names the code has to
 * keep resolving to something. Applied in one transaction, so a rejected cell
 * leaves none of the others written.
 */
export interface SaveSizeRowRequest {
  label?: string
  sortOrder?: number
  cells: { environmentId: number; price?: string; currency?: string }[]
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

/**
 * How a cost centre's budget is measured (#325).
 *
 * 'total' is one pot that never resets. 'monthly' counts orders PLACED in the
 * current calendar month — a price in this catalogue carries no billing period,
 * so a machine ordered in January and still running in June is counted once, in
 * January. That is a real limitation of monthly budgets here, and the screen
 * says so rather than implying a recurring-cost model the data cannot support.
 */
export type BudgetPeriod = 'total' | 'monthly'

/** What happens to an order once the budget is spent. */
export type BudgetBehaviour = 'warn' | 'block'

/** A cost centre's budget, together with what has been spent against it. */
export interface BudgetState {
  costCenterId: number
  costCenterLabel: string
  /** Null when this cost centre has no budget — every other field is then moot. */
  amount: number | null
  currency: string | null
  period: BudgetPeriod | null
  behaviour: BudgetBehaviour | null
  /** Committed spend in the budget's currency, over the budget's window. */
  committed: number
  /** What is left. Negative once the budget is overspent. */
  remaining: number
  /** True when `committed` already meets or exceeds `amount`. */
  exhausted: boolean
  /** Amounts no exchange rate could convert into the budget's currency. */
  unconverted: { currency: string; amount: number }[]
  /**
   * Committed orders with no recoverable price at all — no snapshot, and the
   * offering they were placed against has since been withdrawn (#189).
   *
   * Their spend is missing from `committed`, so this is what says the figure
   * beside it is incomplete. Not an amount, because there is no amount: the
   * price is unknown, not small.
   */
  unpriced: number
}

/** The body of `PUT /api/admin/cost-centers/:id/budget`. */
export interface SetCostCentreBudgetRequest {
  amount: number
  currency: string
  period: BudgetPeriod
  behaviour: BudgetBehaviour
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

/** One element an order provisioned, as the order detail page shows it. */
export interface OrderElement {
  id: number
  /** 1-based position within the order (issue #104). */
  sequence: number
  status: InfraStatus
  sizeCode: string | null
  /** Terraform outputs — the endpoint, the address, whatever the run produced. */
  outputs: Record<string, string>
}

export interface Order {
  id: number
  projectId: number
  productId: number
  environmentId: number
  userId: number
  status: OrderStatus
  /**
   * When the deployment window that will release this order opens (#330).
   *
   * Null unless the order is waiting, and deliberately NOT cleared when it is
   * released: it records which window let the order through, which is the
   * context that makes a later override legible. Detail view only.
   */
  scheduledFor?: string | null
  /** When root deployed it without waiting. Null unless somebody did. */
  windowOverrideAt?: string | null
  parameters: Record<string, string>
  costCenterId: number | null
  rejectionNote: string | null
  pipelineId: string[]
  /**
   * Per-pipeline outcome, keyed by pipeline id — `{ "pipe-a": "success" }`.
   *
   * Written by the webhook handler since #133 and only surfaced on the order from
   * here on: the detail page used to list `pipelineId` with nothing beside it,
   * which reads as a pipeline that never reported.
   */
  pipelineStatus?: Record<string, string>
  createdAt: string
  updatedAt: string
  /**
   * The infrastructure this order provisioned (issue #104). Present on the detail
   * endpoint only — `outputs` lives on the element, and this is the order's route
   * to it.
   */
  elements?: OrderElement[]
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
  /**
   * The budget of the cost centre this order is billed to (#325).
   *
   * Approvals queue only. The gate runs when the approval is granted, so a
   * `warn` cost centre would tell the approver nothing and a `block` one would
   * refuse them AFTER they clicked — the row is the last moment the decision
   * can be taken.
   */
  budget?: BudgetState | null
  /**
   * Set when the order went through with its cost centre's budget already spent
   * (#325) — either a `warn` budget, or a `block` one that root overrode.
   *
   * On the order that was just CREATED, not on one read back: it is what the
   * person who placed it is told at the moment they placed it.
   */
  budgetWarning?: string
  /**
   * Set when policy allowed the order but had something to say (#110) — the
   * policy's own message, or the reason a `best_effort` engine could not be
   * asked. Placed on the created order for the same reason `budgetWarning` is: a
   * warning nobody sees is indistinguishable from no warning.
   */
  policyWarning?: string
  /**
   * The cost centre as a person refers to it — `IT-4711 — Platform Networking`.
   *
   * The order carries `costCenterId` because that is what it is charged against,
   * and the detail page printed exactly that: `#3`. A cost centre is the one
   * field on that page a finance reader has to recognise, and an internal row id
   * is the one form in which they cannot.
   */
  costCenterCode?: string
  costCenterName?: string
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
  /**
   * Place the order even though the cost centre's budget is spent (#325), or
   * even though a policy refused it (#110). Two separate rights, both root-only:
   * an approval says "this order is wanted", an override says "this rule does not
   * apply here". The server checks the role — sending either sends a request to
   * waive something, never the waiver itself (#509).
   */
  overrideBudget?: boolean
  overridePolicy?: boolean
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
  /**
   * Orders counted in `orderCount` with no recoverable price at all — no snapshot
   * and no live offering (#189).
   *
   * They contribute nothing to `totalEur` because there is nothing to add. What
   * this field buys is that they do so out loud: an order reaches this state when
   * it predates snapshots and its offering has since been withdrawn, and before
   * this the money simply left the total with the order still in the count.
   */
  unpricedOrders: number
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
  /**
   * Orders that went through with their cost centre over budget (#325).
   *
   * Not failures — these orders exist. A `warn` budget says "tell me, do not
   * refuse me", and a warning the orderer never sees is the setting doing
   * nothing at all. One entry per order, because a cart can span two projects'
   * cost centres and "something was over budget" does not say which.
   */
  warnings?: { orderId: number; message: string }[]
  /**
   * Orders a policy held for somebody else's approval instead of building them
   * (#110).
   *
   * Not failures, and not warnings either: the orders exist and are in the
   * approvals queue. A list of its own because an admin's order provisions
   * immediately, so this is the one case where a shopper is owed an explanation
   * for something that did not happen as they expected.
   */
  approvalRequired?: { orderId: number; message: string }[]
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
  /**
   * What to SHOW as this element's status, derived by the server.
   *
   * The stored column cannot express either end of an element's life: the row
   * is inserted `active` when provisioning starts, so a machine still being
   * built and one whose pipeline failed both read as running (#287, #29).
   *
   * Prefer this over `status` anywhere a person will read it. `status` remains
   * the column, for the places that act on it rather than display it.
   */
  displayStatus?: InfraDisplayStatus
}

/**
 * One infrastructure element in full (GET /infrastructure/{id}).
 *
 * Everything the list carries, plus what only a detail view needs: the pipeline
 * status map, the cost centre the order is billed to, and which parameter values
 * were redacted — the names stay visible, the values do not.
 */
export interface InfrastructureDetail extends InfrastructureElement {
  /**
   * Why the LAST attempt to read the Terraform outputs did not produce any (#215).
   *
   * Null means the last attempt worked, or none has been made yet. Five distinct
   * failures — no CI source, an unsupported provider, an unlocatable project, an
   * unreadable log, a run that declared none — used to render as one blank card,
   * so "your CI token expired" and "this template has no outputs" were the same
   * screen.
   *
   * **This is not "why `outputs` is empty".** A failed read never erases outputs
   * an earlier one recorded — a token that expires between two clicks must not
   * destroy a correct answer — so a non-null `outputsError` alongside a populated
   * `outputs` is the normal shape for "these are from before; the latest attempt
   * failed", and the page shows both.
   */
  outputsError?: string | null
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
