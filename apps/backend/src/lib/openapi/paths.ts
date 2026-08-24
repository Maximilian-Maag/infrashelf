import { z } from 'zod'
import { extendZodWithOpenApi } from '@asteasolutions/zod-to-openapi'
import { registry } from './registry'
import { SIZE_CODE_MAX_LENGTH } from '@/lib/services/sizes'

extendZodWithOpenApi(z)

const bearerAuth = [{ BearerAuth: [] }]

/**
 * The language product names and descriptions come back in (issue #162).
 *
 * Documented on every endpoint that names a product, not only the catalogue's:
 * nine of them used to answer in English whatever was asked, which is precisely
 * the sort of thing a spec has to stop being able to say quietly.
 */
const langQuery = {
  lang: z.string().optional().openapi({
    description:
      'Language for product name/description. Falls back to English, then German, then any ' +
      'translation the product has. Defaults to en.',
  }),
}

// ─── Shared schemas ───────────────────────────────────────────────────────────

const userSchema = z.object({
  id: z.number(),
  email: z.string(),
  name: z.string().nullable(),
  role: z.string(),
  active: z.boolean(),
  ssoSub: z.string().nullable(),
  createdAt: z.string().nullable(),
})

const orderSchema = z.object({
  id: z.number(),
  projectId: z.number(),
  productId: z.number(),
  environmentId: z.number(),
  userId: z.number(),
  status: z.string(),
  parameters: z.record(z.string()).nullable(),
  costCenterId: z.number().nullable(),
  rejectionNote: z.string().nullable(),
  pipelineId: z.array(z.string()).nullable(),
  createdAt: z.string().nullable(),
  updatedAt: z.string().nullable(),
  isTrial: z.boolean().openapi({ description: 'Ordered as a time-boxed trial (issue #1).' }),
  sizeCode: z.string().nullable().openapi({
    description: 'The size that was ordered (issue #98). Null when the offering has none.',
  }),
  quantity: z.number().openapi({
    description:
      'How many infrastructure elements the order provisioned (issue #104). One order, N elements, one ' +
      'approval; teardown stays per element.',
  }),
  productSnapshot: z.unknown().nullable().openapi({
    description:
      'What the customer was offered when the order was placed (issue #38): product name and description, ' +
      'price, currency, cost-centre rules and the parameter DEFINITIONS that applied. Sensitive defaults ' +
      'are redacted. Null for orders placed before snapshots existed.',
  }),
  productName: z.string().nullable(),
  environmentName: z.string().nullable(),
  userName: z.string().nullable(),
})

const projectSchema = z.object({
  id: z.number(),
  name: z.string(),
  description: z.string().nullable(),
  ownerId: z.number(),
  costCenterId: z.number().nullable(),
  createdAt: z.string().nullable(),
  ownerName: z.string().nullable(),
  costCenterName: z.string().nullable(),
})

const categorySchema = z.object({
  id: z.number(),
  name: z.string(),
  displayOrder: z.number(),
})

const productSchema = z.object({
  id: z.number(),
  categoryId: z.number(),
  baseLanguage: z.string(),
  createdAt: z.string().nullable(),
  name: z.string().nullable(),
  description: z.string().nullable(),
})

const parameterSchema = z.object({
  id: z.number(),
  scope: z.string(),
  scopeId: z.number(),
  environmentId: z.number().nullable(),
  name: z.string(),
  type: z.string(),
  description: z.string(),
  defaultValue: z.string(),
  required: z.boolean(),
  sensitive: z.boolean(),
})

const environmentSchema = z.object({
  id: z.number(),
  name: z.string(),
  description: z.string(),
  ciSourceId: z.number(),
  webhookUrl: z.string(),
  // The outbound trigger token is never returned (issue #144) — only whether one
  // is set. Send a new value to PUT /admin/environments/{id} to replace it.
  webhookTokenSet: z.boolean(),
})

const costCenterSchema = z.object({
  id: z.number(),
  code: z.string(),
  name: z.string(),
  active: z.boolean(),
})

const ciSourceSchema = z.object({
  id: z.number(),
  name: z.string(),
  url: z.string(),
  provider: z.string(),
})

const integrationKinds = ['foreman', 'ansible', 'nexus', 'pulp', 'loki', 'grafana'] as const
const integrationAuthTypes = ['none', 'bearer', 'basic', 'token_header'] as const
const integrationFailureModes = ['blocking', 'best_effort'] as const

const integrationSchema = z.object({
  id: z.number(),
  kind: z.enum(integrationKinds),
  name: z.string(),
  baseUrl: z.string(),
  authType: z.enum(integrationAuthTypes),
  username: z.string(),
  hasCredential: z.boolean().openapi({
    description:
      'Whether a credential is stored. The credential itself is never returned by any endpoint — ' +
      'it is encrypted at rest and read only server-side.',
  }),
  environmentId: z.number().nullable().openapi({
    description: 'Deployment environment this instance serves; null means portal-wide.',
  }),
  enabled: z.boolean(),
  failureMode: z.enum(integrationFailureModes).openapi({
    description:
      'Whether a failed call to this integration aborts the operation that made it (blocking) ' +
      'or is logged and carried on from (best_effort).',
  }),
  lastContactedAt: z.string().nullable().openapi({
    description: 'Last time a probe reached this system. Set on success only; null means never.',
  }),
  lastError: z.string().nullable().openapi({
    description: 'Why the most recent probe failed. Cleared on the next success.',
  }),
  createdAt: z.string().nullable(),
  updatedAt: z.string().nullable(),
})

const integrationProbeSchema = z.object({
  ok: z.boolean(),
  status: z.number().nullable(),
  detail: z.string().optional(),
  error: z.string().optional(),
  lastContactedAt: z.string().nullable(),
  lastError: z.string().nullable(),
})

const infraSchema = z.object({
  id: z.number(),
  orderId: z.number(),
  projectId: z.number(),
  environmentId: z.number(),
  productId: z.number(),
  status: z.string(),
  parameters: z.record(z.string()).nullable(),
  pipelineId: z.array(z.string()).nullable(),
  outputs: z.record(z.string()).nullable(),
  deployedAt: z.string().nullable(),
  productName: z.string().nullable(),
  environmentName: z.string().nullable(),
  projectName: z.string().nullable(),
  scheduledDecommissionAt: z.string().nullable().openapi({
    description: 'When set, the element is torn down automatically at or after this instant. null = no schedule.',
  }),
  orderStatus: z.string().nullable().openapi({
    description:
      "Status of the order this element came from. The element's own status cannot express a failed " +
      'deployment (it is created active when provisioning starts), so a failed deployment is ' +
      "status: 'active' with orderStatus: 'failed'.",
  }),
})

const auditEntrySchema = z.object({
  id: z.number(),
  userId: z.number().nullable(),
  action: z.string().nullable(),
  entityId: z.number().nullable(),
  details: z.string().nullable(),
  createdAt: z.string().nullable(),
  userName: z.string().nullable(),
})

const webhookSchema = z.object({
  id: z.number(),
  productId: z.number(),
  environmentId: z.number(),
  name: z.string(),
  webhookUrl: z.string(),
  // As with the environment: whether a trigger token is set, never its value.
  webhookTokenSet: z.boolean(),
  execOrder: z.number(),
})

const offeringSizeSchema = z.object({
  id: z.number(),
  code: z.string().openapi({ description: 'Passed to CI as SIZE and stored on the order line.' }),
  label: z.string(),
  price: z.string(),
  currency: z.string(),
  sortOrder: z.number(),
  active: z.boolean(),
})

const productEnvironmentSchema = z.object({
  productId: z.number(),
  environmentId: z.number(),
  price: z.string(),
  currency: z.string(),
  costCenterMode: z.string(),
  forcedCostCenter: z.boolean(),
  overheadCostCenterId: z.number().nullable(),
  trialEnabled: z.boolean().openapi({
    description:
      'Whether this offering can be ordered as a time-boxed trial. Opt-in per offering: a trial ' +
      'provisions real infrastructure and asks the pipeline to grant elevated rights inside it.',
  }),
  trialDurationMinutes: z.number().openapi({ description: 'How long a trial lives. Default 30.' }),
  environmentName: z.string().nullable(),
  overheadCostCenterName: z.string().nullable().optional(),
  sizes: z.array(offeringSizeSchema).optional().openapi({
    description:
      'The sizes this offering can be ordered in (issue #98), in the order an admin arranged them. Empty ' +
      "for an offering that defines none, in which case the offering-level price applies and an order " +
      'must name no size. When it is non-empty an order MUST name one of these codes, and what it is ' +
      "charged is the size's price, not the offering's.",
  }),
})

const exchangeRateSchema = z.object({
  id: z.number(),
  currencyCode: z.string(),
  rateToEur: z.string(),
  updatedAt: z.string().nullable(),
})

// ─── System ───────────────────────────────────────────────────────────────────

registry.registerPath({
  method: 'get',
  path: '/health',
  summary: 'Health check',
  tags: ['System'],
  security: [],
  responses: {
    200: {
      description: 'Service is healthy',
      content: { 'application/json': { schema: z.object({ status: z.string() }) } },
    },
  },
})

registry.registerPath({
  method: 'get',
  path: '/docs',
  summary: 'Swagger UI',
  tags: ['System'],
  security: [],
  responses: {
    200: { description: 'HTML page with Swagger UI' },
  },
})

registry.registerPath({
  method: 'get',
  path: '/docs/spec',
  summary: 'OpenAPI specification (JSON)',
  tags: ['System'],
  security: [],
  responses: {
    200: { description: 'OpenAPI JSON document' },
  },
})

// ─── Auth ─────────────────────────────────────────────────────────────────────

registry.registerPath({
  method: 'post',
  path: '/auth/login',
  summary: 'Login with email and password',
  description:
    'Opens a server-side session (issue #37) and returns a token naming it. The token is only ' +
    'accepted while that session is live, so a revoked session stops working on the next request. ' +
    'When the account has a second factor (issue #36) NOTHING is opened here: the response is a ' +
    'challenge, and the session is created by POST /auth/login/mfa once a code has been verified.',
  tags: ['Auth'],
  security: [],
  request: {
    body: {
      content: {
        'application/json': {
          schema: z.object({
            email: z.string().email(),
            password: z.string().min(1),
            rememberMe: z.boolean().optional().openapi({
              description:
                'Extend the session from the 8 h default to 30 days. On a two-step login it is ' +
                'sealed into the challenge, so it is answered once, here.',
            }),
            challengeOnly: z.boolean().optional().openapi({
              description:
                'Check the password and report whether a second factor is required, opening no ' +
                'session and returning no token in either case. Answers {"mfaRequired":false} for ' +
                'an account without one.',
            }),
          }),
        },
      },
    },
  },
  responses: {
    200: {
      description:
        'Either a session (token + user) or, when the account has a second factor, an MFA ' +
        'challenge with NO token — see POST /auth/login/mfa.',
      content: {
        'application/json': {
          schema: z.union([
            z.object({
              token: z.string(),
              user: z.object({
                id: z.number(),
                email: z.string(),
                name: z.string().nullable(),
                role: z.string(),
              }),
            }),
            z.object({
              mfaRequired: z.literal(true),
              mfaToken: z.string(),
              expiresIn: z.number(),
            }),
            z.object({ mfaRequired: z.literal(false) }).openapi({
              description: 'challengeOnly, and no second factor is enrolled.',
            }),
          ]),
        },
      },
    },
    400: { description: 'Bad request' },
    401: { description: 'Invalid credentials' },
    429: { description: 'Too many login attempts' },
  },
})

registry.registerPath({
  method: 'post',
  path: '/auth/login/mfa',
  summary: 'Complete a two-step login by presenting the second factor',
  description:
    'Trades the challenge from POST /auth/login, plus a TOTP code or a one-time recovery code, for a ' +
    'session token. This is where the session row is created for a two-step login, through the same ' +
    'path as every other sign-in, so it is listed and revocable like any other (issue #37). The ' +
    'session lifetime comes from the "remember me" choice sealed into the challenge, not from this ' +
    'request. Failures are counted against the account and lock the factor for 15 minutes after ' +
    '5 consecutive failures (429).',
  tags: ['Auth'],
  security: [],
  request: {
    body: {
      content: {
        'application/json': {
          schema: z.object({
            mfaToken: z.string().min(1),
            code: z.string().min(1).max(64).openapi({
              description: 'A 6-digit TOTP code or a one-time recovery code.',
            }),
          }),
        },
      },
    },
  },
  responses: {
    200: {
      description: 'JWT token and user info',
      content: {
        'application/json': {
          schema: z.object({
            token: z.string(),
            user: z.object({
              id: z.number(),
              email: z.string(),
              name: z.string().nullable(),
              role: z.string(),
            }),
          }),
        },
      },
    },
    400: { description: 'Invalid or already-used code' },
    401: { description: 'Challenge expired, forged, or superseded by a password change' },
    429: { description: 'Second factor locked after repeated failures' },
  },
})

registry.registerPath({
  method: 'get',
  path: '/auth/callback',
  summary: 'OIDC / Entra ID callback — exchanges code for JWT and redirects',
  tags: ['Auth'],
  security: [],
  request: {
    query: z.object({ code: z.string() }),
  },
  responses: {
    302: { description: 'Redirect to frontend with JWT token' },
    400: { description: 'Missing or invalid code / claims' },
    500: { description: 'Entra ID not configured' },
    502: { description: 'Token exchange failed' },
  },
})

// ─── Costs ────────────────────────────────────────────────────────────────────

const costBucketSchema = z.object({
  id: z.number().nullable(),
  label: z.string(),
  totalEur: z.number(),
  orderCount: z.number(),
})

const costPeriodSchema = z.object({
  period: z.string().openapi({ description: 'Calendar month in UTC, YYYY-MM.', example: '2026-08' }),
  totalEur: z.number(),
  orderCount: z.number(),
  estimatedOrders: z.number(),
  partial: z.boolean().openapi({
    description: 'The month is not over, so the figure will still grow. Charts must say so rather than showing it as a fall in spend.',
  }),
})

const costFilterQuery = z.object({
  range: z.enum(['currentMonth', 'last3Months', 'last12Months', 'all', 'custom']).optional().openapi({
    description: 'Preset window, resolved server-side so the report and its export cannot disagree.',
  }),
  from: z.string().optional().openapi({ description: 'Inclusive. A bare YYYY-MM-DD means the start of that day.' }),
  to: z.string().optional().openapi({ description: 'Inclusive. A bare YYYY-MM-DD means the END of that day.' }),
  projectId: z.string().optional(),
})

registry.registerPath({
  method: 'get',
  path: '/costs',
  summary: 'Spending overview per project, cost centre, product and environment',
  description:
    'Counts only orders that reached provisioning ("provisioning"/"completed") — a rejected, pending or ' +
    'failed order never delivered infrastructure. Prices come from each order\'s snapshot, so an admin ' +
    'editing a price cannot restate past spend; orders predating snapshots fall back to the live price and ' +
    'are counted in estimatedOrders. Totals are in EUR (the exchange-rate base) and the client converts to ' +
    'the viewer\'s currency; an amount whose currency has no stored rate appears in unconverted[] rather ' +
    'than being silently treated as EUR. These are sums of recorded prices, NOT a time-based projection — ' +
    'the catalogue stores no billing period. Scoped by role: a project manager sees the projects they own. ' +
    'series[] adds the same spend per calendar month (UTC), oldest first, with empty months in between filled ' +
    'in so a trend cannot draw a straight line through a gap; it is computed from the same de-duplicated rows ' +
    'as the breakdowns and therefore sums to totalEur. comparison holds the last two months of that series and ' +
    'is null when the window covers fewer than two — comparing against a month the filter excluded would read ' +
    'as "spend doubled".',
  tags: ['Costs'],
  security: bearerAuth,
  request: { query: costFilterQuery.extend(langQuery) },
  responses: {
    200: {
      description: 'Cost report',
      content: {
        'application/json': {
          schema: z.object({
            totalEur: z.number(),
            orderCount: z.number(),
            estimatedOrders: z.number(),
            series: z.array(costPeriodSchema),
            comparison: z
              .object({
                current: costPeriodSchema,
                previous: costPeriodSchema,
                changeEur: z.number(),
                changePct: z.number().nullable(),
              })
              .nullable(),
            byProject: z.array(costBucketSchema),
            byCostCenter: z.array(costBucketSchema),
            byProduct: z.array(costBucketSchema),
            byEnvironment: z.array(costBucketSchema),
            unconverted: z.array(z.object({ currency: z.string(), amount: z.number() })),
            global: z.boolean(),
          }),
        },
      },
    },
    400: { description: 'Invalid filter' },
    401: { description: 'Unauthorized' },
    403: { description: 'Not the caller\'s project' },
    404: { description: 'Project not found' },
  },
})

registry.registerPath({
  method: 'get',
  path: '/costs/export',
  summary: 'Export the cost breakdown as CSV or PDF',
  description:
    'One row per counted order rather than the aggregate, so a total can be reconciled. Uses the same ' +
    'filter parser as GET /costs, so the two always cover the same orders. priceEur is blank when the ' +
    'currency has no stored rate — 0 would read as "free".',
  tags: ['Costs'],
  security: bearerAuth,
  request: { query: costFilterQuery.extend({ format: z.enum(['csv', 'pdf']).optional(), ...langQuery }) },
  responses: {
    200: { description: 'CSV or PDF attachment' },
    400: { description: 'Invalid filter or format' },
    401: { description: 'Unauthorized' },
    403: { description: 'Not the caller\'s project' },
  },
})

// ─── Cart ─────────────────────────────────────────────────────────────────────

const cartItemSchema = z.object({
  id: z.number(),
  productId: z.number(),
  environmentId: z.number(),
  parameters: z.record(z.string()),
  createdAt: z.string().nullable(),
  productName: z.string().nullable(),
  environmentName: z.string().nullable(),
  sizeCode: z.string().nullable(),
  sizeLabel: z.string().nullable(),
  quantity: z.number().openapi({ description: 'Elements this line will provision (issue #104).' }),
  price: z.string().nullable().openapi({
    description:
      "UNIT price — the chosen size's, or the offering's for a line with no size. The line total is this " +
      'times quantity.',
  }),
  currency: z.string().nullable(),
  stillOffered: z.boolean().openapi({
    description:
      'False when the product is no longer offered in that environment, or when the size the line chose ' +
      'has been retired. The item stays in the cart and says so, rather than vanishing without ' +
      'explanation.',
  }),
})

registry.registerPath({
  method: 'get',
  path: '/cart',
  summary: "List the caller's cart",
  description: 'Oldest first. Items whose product has been deleted are pruned before listing.',
  tags: ['Cart'],
  security: bearerAuth,
  request: { query: z.object(langQuery) },
  responses: {
    200: { description: 'Cart items', content: { 'application/json': { schema: z.array(cartItemSchema) } } },
    401: { description: 'Unauthorized' },
  },
})

registry.registerPath({
  method: 'post',
  path: '/cart',
  summary: 'Add a product+environment to the cart',
  description:
    'Parameters are stored as a prefill and deliberately NOT validated here — a cart is a shopping list, ' +
    'and refusing to hold an incomplete item would defeat collecting first and filling in at checkout. The ' +
    'offering must exist, since an item that could never be ordered has no business in the cart.',
  tags: ['Cart'],
  security: bearerAuth,
  request: {
    query: z.object(langQuery),
    body: {
      content: {
        'application/json': {
          schema: z.object({
            productId: z.number().int().positive(),
            environmentId: z.number().int().positive(),
            parameters: z.record(z.string()).optional(),
            sizeCode: z.string().min(1).max(SIZE_CODE_MAX_LENGTH).nullable().optional().openapi({
              description:
                'Required when the offering defines sizes, refused when it does not (issue #98). Unlike ' +
                'the parameters this IS validated here: it is what the line is, not something filled in ' +
                'later at checkout.',
            }),
            quantity: z.number().int().positive().optional().openapi({
              description: 'Defaults to 1. Capped at 20 per line (issue #104).',
            }),
          }),
        },
      },
    },
  },
  responses: {
    201: { description: 'Item added', content: { 'application/json': { schema: cartItemSchema } } },
    400: { description: 'Not offered in that environment, or the cart is full' },
    401: { description: 'Unauthorized' },
  },
})

registry.registerPath({
  method: 'delete',
  path: '/cart',
  summary: "Empty the caller's cart",
  tags: ['Cart'],
  security: bearerAuth,
  responses: { 200: { description: 'Cart cleared' }, 401: { description: 'Unauthorized' } },
})

registry.registerPath({
  method: 'put',
  path: '/cart/{itemId}',
  summary: 'Update one cart line: parameter prefill, size or quantity',
  description:
    'A patch in all but name: an omitted field is left alone, so the quantity control in the cart does ' +
    'not have to resend the parameters it never touched.',
  tags: ['Cart'],
  security: bearerAuth,
  request: {
    params: z.object({ itemId: z.string() }),
    body: {
      content: {
        'application/json': {
          schema: z.object({
            parameters: z.record(z.string()).optional(),
            sizeCode: z.string().min(1).max(SIZE_CODE_MAX_LENGTH).nullable().optional(),
            quantity: z.number().int().positive().optional(),
          }),
        },
      },
    },
  },
  responses: {
    200: { description: 'Prefill saved' },
    400: { description: 'Invalid id or body' },
    401: { description: 'Unauthorized' },
    404: { description: "Not the caller's cart item" },
  },
})

registry.registerPath({
  method: 'delete',
  path: '/cart/{itemId}',
  summary: 'Remove one cart item (idempotent)',
  tags: ['Cart'],
  security: bearerAuth,
  request: { params: z.object({ itemId: z.string() }) },
  responses: {
    200: { description: 'Item removed' },
    400: { description: 'Invalid id' },
    401: { description: 'Unauthorized' },
  },
})

registry.registerPath({
  method: 'post',
  path: '/cart/checkout',
  summary: 'Order every cart item against one project',
  description:
    'Validates EVERY item first, through the same code path a single order uses, and creates nothing unless ' +
    'all of them pass — a cart of five with one bad item creates zero orders, not two. Full transactional ' +
    'atomicity is not available because order creation fires CI pipelines and a fired pipeline cannot be ' +
    'recalled; past the validation gate, failures are reported per item in failed[] and those items stay in ' +
    'the cart for a retry. Parameters submitted here win over the stored prefill.',
  tags: ['Cart'],
  security: bearerAuth,
  request: {
    body: {
      content: {
        'application/json': {
          schema: z.object({
            projectId: z.number().int().positive(),
            items: z.array(
              z.object({
                cartItemId: z.number().int().positive(),
                parameters: z.record(z.string()),
                costCenterId: z.number().int().positive().optional(),
                trial: z.boolean().optional(),
              }),
            ),
          }),
        },
      },
    },
  },
  responses: {
    201: {
      description: 'Orders created',
      content: {
        'application/json': {
          schema: z.object({
            orderIds: z.array(z.number()),
            failed: z.array(z.object({ cartItemId: z.number(), message: z.string() })),
          }),
        },
      },
    },
    400: { description: 'Validation failed for at least one item — nothing was created' },
    401: { description: 'Unauthorized' },
    502: { description: 'No order could be created' },
  },
})

// ─── Product versioning ───────────────────────────────────────────────────────

const productVersionSchema = z.object({
  id: z.number(),
  productId: z.number(),
  environmentId: z.number().nullable(),
  changelog: z.string(),
  summary: z.string(),
  snapshot: z.unknown().nullable(),
  createdBy: z.number().nullable(),
  createdAt: z.string().nullable(),
  authorName: z.string().nullable(),
  environmentName: z.string().nullable(),
})

registry.registerPath({
  method: 'get',
  path: '/admin/products/{id}/versions',
  summary: "[root] Timeline of catalogue changes to a product",
  description:
    'Newest first. One entry per change that affects what a customer would be offered. An entry scoped to ' +
    'an environment carries a configuration snapshot; a product-level change (rename, category) does not, ' +
    'since there is no single offering to capture.',
  tags: ['Admin'],
  security: bearerAuth,
  request: { params: z.object({ id: z.string() }) },
  responses: {
    200: {
      description: 'Version history',
      content: { 'application/json': { schema: z.array(productVersionSchema) } },
    },
    400: { description: 'Invalid product id' },
    401: { description: 'Unauthorized' },
    403: { description: 'Forbidden' },
    404: { description: 'Not found' },
  },
})

registry.registerPath({
  method: 'get',
  path: '/admin/products/{id}/versions/diff',
  summary: '[root] Compare two versions of a product',
  description:
    'Compares the fields that describe what a customer was offered. capturedAt and environmentName are ' +
    'deliberately excluded: a later capture of the same configuration is not a change, and every version of ' +
    'one offering names the same environment.',
  tags: ['Admin'],
  security: bearerAuth,
  request: {
    params: z.object({ id: z.string() }),
    query: z.object({ from: z.string(), to: z.string() }),
  },
  responses: {
    200: {
      description: 'Field and parameter changes between the two versions',
      content: {
        'application/json': {
          schema: z.object({
            fields: z.array(z.object({ field: z.string(), from: z.string(), to: z.string() })),
            parameters: z.array(z.unknown()),
            identical: z.boolean(),
            fromVersionId: z.number(),
            toVersionId: z.number(),
          }),
        },
      },
    },
    400: { description: 'Missing/malformed ids, or a version with no snapshot to compare' },
    401: { description: 'Unauthorized' },
    403: { description: 'Forbidden' },
    404: { description: 'A version id does not belong to this product' },
  },
})

// ─── Order comments ───────────────────────────────────────────────────────────

const orderCommentSchema = z.object({
  id: z.number(),
  orderId: z.number(),
  userId: z.number(),
  body: z.string(),
  internal: z.boolean().openapi({
    description: 'Visible to admin/root only. Filtered out in SQL for other callers, not hidden client-side.',
  }),
  createdAt: z.string().nullable(),
  updatedAt: z.string().nullable(),
  userName: z.string().nullable(),
  edited: z.boolean(),
})

registry.registerPath({
  method: 'get',
  path: '/orders/{id}/comments',
  summary: 'List the comment thread on an order',
  description:
    'Oldest first. An admin sees every comment; a project manager sees only their own orders, and never ' +
    'an internal note — those are excluded by the query, so they never reach the browser.',
  tags: ['Orders'],
  security: bearerAuth,
  request: { params: z.object({ id: z.string() }) },
  responses: {
    200: {
      description: 'Comments visible to the caller',
      content: { 'application/json': { schema: z.array(orderCommentSchema) } },
    },
    400: { description: 'Invalid order id' },
    401: { description: 'Unauthorized' },
    403: { description: 'Not the caller\'s order' },
    404: { description: 'Order not found' },
  },
})

registry.registerPath({
  method: 'post',
  path: '/orders/{id}/comments',
  summary: 'Add a comment to an order',
  description:
    'A public comment emails the orderer and the admins, never the author. An internal note (admin/root ' +
    'only) emails nobody — telling the orderer a note they cannot read exists would leak what the flag is for.',
  tags: ['Orders'],
  security: bearerAuth,
  request: {
    params: z.object({ id: z.string() }),
    body: {
      content: {
        'application/json': {
          schema: z.object({ body: z.string().min(1).max(4000), internal: z.boolean().optional() }),
        },
      },
    },
  },
  responses: {
    201: {
      description: 'Comment created',
      content: { 'application/json': { schema: orderCommentSchema } },
    },
    400: { description: 'Invalid or empty body' },
    401: { description: 'Unauthorized' },
    403: { description: 'Not the caller\'s order, or internal requested by a non-admin' },
    404: { description: 'Order not found' },
  },
})

registry.registerPath({
  method: 'put',
  path: '/orders/{id}/comments/{commentId}',
  summary: 'Edit your own comment',
  description:
    'Author-only, admins included — rewriting somebody else\'s words under their name is worse than a ' +
    'correction in the thread. The original text stays in the audit log.',
  tags: ['Orders'],
  security: bearerAuth,
  request: {
    params: z.object({ id: z.string(), commentId: z.string() }),
    body: { content: { 'application/json': { schema: z.object({ body: z.string().min(1).max(4000) }) } } },
  },
  responses: {
    200: {
      description: 'Comment updated',
      content: { 'application/json': { schema: orderCommentSchema } },
    },
    400: { description: 'Invalid id or empty body' },
    401: { description: 'Unauthorized' },
    403: { description: 'Not the author' },
    404: { description: 'Comment not found (also returned to a non-admin for an internal note)' },
  },
})

registry.registerPath({
  method: 'delete',
  path: '/orders/{id}/comments/{commentId}',
  summary: 'Delete your own comment',
  description:
    'Author-only. A hard delete: the immutable audit log holds the body, so no "deleted" placeholder is ' +
    'left announcing that something was withdrawn.',
  tags: ['Orders'],
  security: bearerAuth,
  request: { params: z.object({ id: z.string(), commentId: z.string() }) },
  responses: {
    200: { description: 'Comment deleted' },
    400: { description: 'Invalid id' },
    401: { description: 'Unauthorized' },
    403: { description: 'Not the author' },
    404: { description: 'Comment not found' },
  },
})

// ─── Favorites ────────────────────────────────────────────────────────────────

const favoriteSchema = z.object({
  productId: z.number(),
  categoryId: z.number(),
  name: z.string(),
  description: z.string(),
  createdAt: z.string().nullable(),
})

registry.registerPath({
  method: 'get',
  path: '/favorites',
  summary: "List the caller's favourited products",
  description:
    'Always scoped to the calling user — the user id comes from the session and is never read off ' +
    'the request. Names are translated with the same fallback chain as the catalogue.',
  tags: ['Favorites'],
  security: bearerAuth,
  request: { query: z.object({ lang: z.string().optional() }) },
  responses: {
    200: {
      description: 'Favourited products, most recently added first',
      content: { 'application/json': { schema: z.array(favoriteSchema) } },
    },
    401: { description: 'Unauthorized' },
  },
})

registry.registerPath({
  method: 'put',
  path: '/favorites/{productId}',
  summary: 'Favourite a product (idempotent)',
  tags: ['Favorites'],
  security: bearerAuth,
  request: { params: z.object({ productId: z.string() }) },
  responses: {
    200: { description: 'Favourited' },
    400: { description: 'Invalid product id' },
    401: { description: 'Unauthorized' },
    404: { description: 'Product not found' },
  },
})

registry.registerPath({
  method: 'delete',
  path: '/favorites/{productId}',
  summary: 'Un-favourite a product (idempotent)',
  tags: ['Favorites'],
  security: bearerAuth,
  request: { params: z.object({ productId: z.string() }) },
  responses: {
    200: { description: 'Removed' },
    400: { description: 'Invalid product id' },
    401: { description: 'Unauthorized' },
  },
})

// ─── Sessions ─────────────────────────────────────────────────────────────────

const sessionInfoSchema = z.object({
  id: z.number(),
  userId: z.number(),
  ip: z.string().nullable().openapi({
    description: 'Null unless a trusted proxy supplied one (TRUST_PROXY).',
  }),
  userAgent: z.string().nullable(),
  createdAt: z.string(),
  lastSeenAt: z.string().openapi({
    description: 'Advanced at most once every five minutes, so it lags real activity by up to that.',
  }),
  expiresAt: z.string(),
  current: z.boolean().openapi({ description: 'True for the session this request was made from.' }),
})

const revokeResponseSchema = z.object({ revoked: z.number() })

registry.registerPath({
  method: 'get',
  path: '/sessions',
  summary: 'List active sessions',
  description:
    "The caller's own sessions, or another user's with `userId` (root only). Revoked and expired " +
    'sessions are omitted — this is what is live, not the history. Every call is written to the ' +
    'audit log as `session.list`, including which user was looked at.',
  tags: ['Sessions'],
  security: bearerAuth,
  request: { query: z.object({ userId: z.string().optional() }) },
  responses: {
    200: {
      description: 'Active sessions, most recently seen first',
      content: { 'application/json': { schema: z.array(sessionInfoSchema) } },
    },
    400: { description: 'Invalid user id' },
    401: { description: 'Unauthorized' },
    403: { description: "Not root, and asked for someone else's sessions" },
  },
})

registry.registerPath({
  method: 'delete',
  path: '/sessions',
  summary: 'Sign out everywhere else',
  description:
    "Revokes every live session of the caller except the one making the request. With `userId` " +
    "(root only) it revokes ALL of that user's sessions — root's own session is not one of theirs, " +
    'so there is nothing to keep. Audited as `session.revoked_others`.',
  tags: ['Sessions'],
  security: bearerAuth,
  request: { query: z.object({ userId: z.string().optional() }) },
  responses: {
    200: {
      description: 'How many sessions were revoked',
      content: { 'application/json': { schema: revokeResponseSchema } },
    },
    400: { description: 'Invalid user id' },
    401: { description: 'Unauthorized' },
    403: { description: "Not root, and asked for someone else's sessions" },
  },
})

registry.registerPath({
  method: 'delete',
  path: '/sessions/{id}',
  summary: 'Revoke one session',
  description:
    'The caller\'s own session, or any session if the caller is root. Takes effect on the very next ' +
    'request made with that token: the session row is checked before anything else happens. ' +
    'Revoking a session that is already revoked reports `revoked: 0` rather than failing. ' +
    'Audited as `session.revoked`.',
  tags: ['Sessions'],
  security: bearerAuth,
  request: { params: z.object({ id: z.string() }) },
  responses: {
    200: {
      description: 'Revoked (or already revoked)',
      content: { 'application/json': { schema: revokeResponseSchema } },
    },
    400: { description: 'Invalid session id' },
    401: { description: 'Unauthorized' },
    404: { description: 'No such session, or not the caller\'s to revoke' },
  },
})

// ─── Catalog ──────────────────────────────────────────────────────────────────

registry.registerPath({
  method: 'get',
  path: '/catalog',
  summary: 'List catalog products',
  description:
    'Filtered and paged in the database. `search` matches the translated name and description that the ' +
    'row displays, so a hit is always explicable. `total` counts every match, not the page.',
  tags: ['Catalog'],
  security: bearerAuth,
  request: {
    query: z.object({
      lang: z.string().optional(),
      search: z.string().optional(),
      categoryId: z.string().optional(),
      limit: z.string().optional(),
      offset: z.string().optional(),
    }),
  },
  responses: {
    200: {
      description: 'One page of products, with the total number of matches',
      content: {
        'application/json': {
          schema: z.object({
            items: z.array(productSchema),
            total: z.number(),
            limit: z.number(),
            offset: z.number(),
          }),
        },
      },
    },
    400: { description: 'Invalid filter' },
    401: { description: 'Unauthorized' },
  },
})

registry.registerPath({
  method: 'get',
  path: '/catalog/{id}',
  summary: 'Get catalog product detail with environments and parameters',
  tags: ['Catalog'],
  security: bearerAuth,
  request: {
    params: z.object({ id: z.string() }),
    query: z.object({
      lang: z.string().optional(),
      environmentId: z.string().optional(),
    }),
  },
  responses: {
    200: {
      description: 'Product with environments and parameters',
      content: {
        'application/json': {
          schema: productSchema.extend({
            environments: z.array(productEnvironmentSchema),
            parameters: z.array(parameterSchema),
          }),
        },
      },
    },
    401: { description: 'Unauthorized' },
    404: { description: 'Product not found' },
  },
})

registry.registerPath({
  method: 'get',
  path: '/catalog/{id}/image',
  summary: 'Get catalog product image (binary)',
  tags: ['Catalog'],
  security: [],
  request: {
    params: z.object({ id: z.string() }),
  },
  responses: {
    200: {
      description: 'PNG image',
      content: { 'image/png': { schema: z.any() } },
    },
    404: { description: 'Image not found' },
  },
})

// ─── Orders ───────────────────────────────────────────────────────────────────

registry.registerPath({
  method: 'get',
  path: '/orders',
  summary: 'List orders (admins see all, project managers see own)',
  tags: ['Orders'],
  security: bearerAuth,
  request: { query: z.object(langQuery) },
  responses: {
    200: {
      description: 'List of orders',
      content: { 'application/json': { schema: z.array(orderSchema) } },
    },
    401: { description: 'Unauthorized' },
  },
})

registry.registerPath({
  method: 'post',
  path: '/orders',
  summary: 'Create a new order',
  tags: ['Orders'],
  security: bearerAuth,
  request: {
    body: {
      content: {
        'application/json': {
          schema: z.object({
            projectId: z.number().int().positive(),
            productId: z.number().int().positive(),
            environmentId: z.number().int().positive(),
            costCenterId: z.number().int().positive().optional(),
            parameters: z.record(z.string()),
            sizeCode: z.string().min(1).max(SIZE_CODE_MAX_LENGTH).nullable().optional().openapi({
              description:
                'The size to order (issue #98). Mandatory when the offering defines sizes and refused ' +
                "when it does not — what is charged is the size's price, and the order snapshot records it.",
            }),
            quantity: z.number().int().positive().optional().openapi({
              description:
                'How many infrastructure elements to provision (issue #104). Defaults to 1, capped at 20. ' +
                'One order with N elements: one approval covers all of them, the pipeline trigger fans out ' +
                'per element (each with its own ELEMENT_SEQUENCE and therefore its own Terraform state), ' +
                'and teardown stays per element.',
            }),
            trial: z.boolean().optional().openapi({
              description:
                'Order as a time-boxed trial (issue #1). Rejected unless the offering has trialEnabled. ' +
                'Does NOT bypass approval — a project manager\'s trial still needs an admin to approve it. ' +
                'The pipeline receives TRIAL=true and TRIAL_DURATION_MINUTES, and the element is scheduled ' +
                'for automatic decommissioning once provisioning starts.',
            }),
          }),
        },
      },
    },
  },
  responses: {
    201: {
      description: 'Order created',
      content: { 'application/json': { schema: orderSchema } },
    },
    400: { description: 'Bad request' },
    401: { description: 'Unauthorized' },
  },
})

registry.registerPath({
  method: 'get',
  path: '/orders/{id}',
  summary: 'Get order by ID',
  tags: ['Orders'],
  security: bearerAuth,
  request: {
    params: z.object({ id: z.string() }),
    query: z.object(langQuery),
  },
  responses: {
    200: {
      description: 'Order',
      content: { 'application/json': { schema: orderSchema } },
    },
    401: { description: 'Unauthorized' },
    403: { description: 'Forbidden' },
    404: { description: 'Order not found' },
  },
})

// ─── Approvals ────────────────────────────────────────────────────────────────

registry.registerPath({
  method: 'get',
  path: '/approvals',
  summary: '[admin] List pending orders awaiting approval',
  tags: ['Approvals'],
  security: bearerAuth,
  request: { query: z.object(langQuery) },
  responses: {
    200: {
      description: 'List of pending orders',
      content: {
        'application/json': {
          schema: z.array(
            orderSchema.extend({ projectName: z.string().nullable() }),
          ),
        },
      },
    },
    401: { description: 'Unauthorized' },
    403: { description: 'Forbidden' },
  },
})

registry.registerPath({
  method: 'post',
  path: '/approvals/{id}/approve',
  summary: '[admin] Approve an order and trigger provisioning',
  description:
    'Nobody approves their own order, delegation or not: the check compares the ACTOR with the ' +
    'orderer, and a delegation never changes who the actor is. A delegation held at the time of ' +
    'the decision is recorded in the audit log (`order.approved` and `approval_delegation.used`).',
  tags: ['Approvals'],
  security: bearerAuth,
  request: {
    params: z.object({ id: z.string() }),
  },
  responses: {
    200: {
      description: 'Order approved',
      content: {
        'application/json': {
          schema: z.object({
            success: z.boolean(),
            infraId: z.number(),
            pipelineIds: z.array(z.string()),
          }),
        },
      },
    },
    400: { description: 'Order is not pending' },
    401: { description: 'Unauthorized' },
    403: { description: 'Forbidden' },
    404: { description: 'Order not found' },
  },
})

registry.registerPath({
  method: 'post',
  path: '/approvals/{id}/reject',
  summary: '[admin] Reject an order',
  tags: ['Approvals'],
  security: bearerAuth,
  request: {
    params: z.object({ id: z.string() }),
    body: {
      content: {
        'application/json': {
          schema: z.object({ rejectionNote: z.string().min(1) }),
        },
      },
    },
  },
  responses: {
    200: {
      description: 'Order rejected',
      content: { 'application/json': { schema: z.object({ success: z.boolean() }) } },
    },
    400: { description: 'Bad request' },
    401: { description: 'Unauthorized' },
    403: { description: 'Forbidden' },
    404: { description: 'Order not found' },
  },
})

// ─── Approval delegations ─────────────────────────────────────────────────────

const delegationSchema = z.object({
  id: z.number(),
  fromUserId: z.number(),
  fromUserName: z.string(),
  fromUserEmail: z.string(),
  toUserId: z.number(),
  toUserName: z.string(),
  toUserEmail: z.string(),
  startsOn: z.string().openapi({ description: 'Calendar date, inclusive.', example: '2026-09-01' }),
  endsOn: z.string().openapi({
    description: 'Calendar date, inclusive — the last day the delegation is in force.',
    example: '2026-09-14',
  }),
  createdAt: z.string(),
  revokedAt: z.string().nullable(),
  active: z.boolean().openapi({
    description:
      'Computed at read time by date comparison (starts_on <= today <= ends_on and not revoked). ' +
      'Never stored, so a delegation cannot outlive its end date.',
  }),
})

registry.registerPath({
  method: 'get',
  path: '/approvals/delegations',
  summary: "[admin] The caller's approval delegations, and who they may nominate",
  description:
    'Approval delegation (issue #35): an admin nominates a substitute approver for a period. ' +
    'What is delegated is AUTHORITY, not identity — the substitute approves under their own name ' +
    'and every decision taken while a delegation is in force is audited against it. ' +
    '`mine` is the authority the caller has given away, `grantedToMe` the authority they hold. ' +
    'Root does not participate in the approval workflow and is neither listed nor nominable.',
  tags: ['Approvals'],
  security: bearerAuth,
  responses: {
    200: {
      description: 'Delegations and eligible substitutes',
      content: {
        'application/json': {
          schema: z.object({
            mine: z.array(delegationSchema),
            grantedToMe: z.array(delegationSchema),
            candidates: z.array(
              z.object({ id: z.number(), name: z.string(), email: z.string() }),
            ),
          }),
        },
      },
    },
    401: { description: 'Unauthorized' },
    403: { description: 'Forbidden' },
  },
})

registry.registerPath({
  method: 'post',
  path: '/approvals/delegations',
  summary: '[admin] Nominate a substitute approver for a period',
  description:
    'One live delegation per delegator, and a user may not appear on both sides of overlapping ' +
    'delegations — so A→B while B→C is refused and authority never travels more than one hop. ' +
    'A delegation cannot start in the past. Root can be neither delegator nor substitute.',
  tags: ['Approvals'],
  security: bearerAuth,
  request: {
    body: {
      content: {
        'application/json': {
          schema: z.object({
            toUserId: z.number(),
            startsOn: z.string().openapi({ example: '2026-09-01' }),
            endsOn: z.string().openapi({ example: '2026-09-14' }),
          }),
        },
      },
    },
  },
  responses: {
    201: {
      description: 'Delegation created',
      content: { 'application/json': { schema: delegationSchema } },
    },
    400: { description: 'Bad request — dates, or the substitute is not an active admin' },
    401: { description: 'Unauthorized' },
    403: { description: 'Forbidden — root does not participate in the approval workflow' },
    404: { description: 'Substitute not found' },
    409: { description: 'Overlaps an existing delegation, or would chain one' },
  },
})

registry.registerPath({
  method: 'delete',
  path: '/approvals/delegations/{delegationId}',
  summary: '[admin] Revoke a delegation you granted',
  description:
    'Delegator only. The row is stamped rather than deleted, so the audit entries for decisions ' +
    'taken while it was in force keep resolving.',
  tags: ['Approvals'],
  security: bearerAuth,
  request: {
    params: z.object({ delegationId: z.string() }),
  },
  responses: {
    200: {
      description: 'Delegation revoked',
      content: { 'application/json': { schema: z.object({ success: z.boolean() }) } },
    },
    400: { description: 'Already revoked' },
    401: { description: 'Unauthorized' },
    403: { description: 'Forbidden — only the delegator may revoke' },
    404: { description: 'Delegation not found' },
  },
})

// ─── Projects ─────────────────────────────────────────────────────────────────

registry.registerPath({
  method: 'get',
  path: '/projects',
  summary: 'List projects (admins see all, project managers see own)',
  tags: ['Projects'],
  security: bearerAuth,
  responses: {
    200: {
      description: 'List of projects',
      content: { 'application/json': { schema: z.array(projectSchema) } },
    },
    401: { description: 'Unauthorized' },
  },
})

registry.registerPath({
  method: 'post',
  path: '/projects',
  summary: 'Create a project',
  tags: ['Projects'],
  security: bearerAuth,
  request: {
    body: {
      content: {
        'application/json': {
          schema: z.object({
            name: z.string().min(1),
            description: z.string().optional(),
            costCenterId: z.number().int().positive().optional(),
          }),
        },
      },
    },
  },
  responses: {
    201: {
      description: 'Project created',
      content: { 'application/json': { schema: projectSchema } },
    },
    400: { description: 'Bad request' },
    401: { description: 'Unauthorized' },
  },
})

registry.registerPath({
  method: 'get',
  path: '/projects/{id}',
  summary: 'Get project by ID',
  tags: ['Projects'],
  security: bearerAuth,
  request: {
    params: z.object({ id: z.string() }),
  },
  responses: {
    200: {
      description: 'Project',
      content: { 'application/json': { schema: projectSchema } },
    },
    401: { description: 'Unauthorized' },
    403: { description: 'Forbidden' },
    404: { description: 'Project not found' },
  },
})

registry.registerPath({
  method: 'put',
  path: '/projects/{id}',
  summary: 'Update a project',
  tags: ['Projects'],
  security: bearerAuth,
  request: {
    params: z.object({ id: z.string() }),
    body: {
      content: {
        'application/json': {
          schema: z.object({
            name: z.string().min(1).optional(),
            description: z.string().optional(),
            costCenterId: z.number().int().positive().nullable().optional(),
          }),
        },
      },
    },
  },
  responses: {
    200: {
      description: 'Updated project',
      content: { 'application/json': { schema: projectSchema } },
    },
    400: { description: 'Bad request' },
    401: { description: 'Unauthorized' },
    403: { description: 'Forbidden' },
    404: { description: 'Project not found' },
  },
})

registry.registerPath({
  method: 'delete',
  path: '/projects/{id}',
  summary: '[admin] Delete a project',
  tags: ['Projects'],
  security: bearerAuth,
  request: {
    params: z.object({ id: z.string() }),
  },
  responses: {
    200: {
      description: 'Project deleted',
      content: { 'application/json': { schema: z.object({ success: z.boolean() }) } },
    },
    401: { description: 'Unauthorized' },
    403: { description: 'Forbidden' },
    404: { description: 'Project not found' },
  },
})

// ─── Infrastructure ───────────────────────────────────────────────────────────

registry.registerPath({
  method: 'get',
  path: '/infrastructure',
  summary: 'List infrastructure elements',
  tags: ['Infrastructure'],
  security: bearerAuth,
  request: {
    query: z.object({
      productId: z.string().optional(),
      projectId: z.string().optional(),
      environmentId: z.string().optional(),
      search: z.string().optional().openapi({
        description: 'Free text matched against product, environment and project name',
      }),
      status: z.enum(['active', 'decommissioning', 'decommissioned', 'failed', 'all']).optional(),
      deployedFrom: z.string().optional().openapi({
        description: 'Inclusive lower bound. A bare YYYY-MM-DD means the start of that day (UTC).',
      }),
      deployedTo: z.string().optional().openapi({
        description: 'Inclusive upper bound. A bare YYYY-MM-DD means the END of that day (UTC).',
      }),
      sort: z.enum(['date', 'name', 'status']).optional(),
      direction: z.enum(['asc', 'desc']).optional(),
      ...langQuery,
    }),
  },
  responses: {
    200: {
      description: 'List of infrastructure elements',
      content: { 'application/json': { schema: z.array(infraSchema) } },
    },
    400: { description: 'Invalid filter' },
    401: { description: 'Unauthorized' },
  },
})

registry.registerPath({
  method: 'get',
  path: '/infrastructure/facets',
  summary: 'Distinct environments, projects and products present in the visible infrastructure',
  description:
    'Option lists for the infrastructure list filters. Scoped exactly like GET /infrastructure, ' +
    'so a project manager only sees facets drawn from their own projects.',
  tags: ['Infrastructure'],
  security: bearerAuth,
  request: { query: z.object(langQuery) },
  responses: {
    200: {
      description: 'Facet values',
      content: {
        'application/json': {
          schema: z.object({
            environments: z.array(z.object({ id: z.number(), name: z.string() })),
            projects: z.array(z.object({ id: z.number(), name: z.string() })),
            products: z.array(z.object({ id: z.number(), name: z.string() })),
          }),
        },
      },
    },
    401: { description: 'Unauthorized' },
  },
})

registry.registerPath({
  method: 'get',
  path: '/infrastructure/export',
  summary: '[admin] Export the infrastructure inventory as CSV or PDF',
  description:
    'Accepts exactly the same filters as GET /infrastructure and applies them identically, so the ' +
    'file matches the list it was taken from. Parameter values are omitted unless includeParameters ' +
    'is set, and any parameter whose name is flagged sensitive anywhere in the catalogue is redacted.',
  tags: ['Infrastructure'],
  security: bearerAuth,
  request: {
    query: z.object({
      format: z.enum(['csv', 'pdf']).optional(),
      includeParameters: z.enum(['true', 'false']).optional(),
      productId: z.string().optional(),
      projectId: z.string().optional(),
      environmentId: z.string().optional(),
      search: z.string().optional(),
      status: z.enum(['active', 'decommissioning', 'decommissioned', 'failed', 'all']).optional(),
      deployedFrom: z.string().optional(),
      deployedTo: z.string().optional(),
      sort: z.enum(['date', 'name', 'status']).optional(),
      direction: z.enum(['asc', 'desc']).optional(),
      ...langQuery,
    }),
  },
  responses: {
    200: { description: 'CSV or PDF attachment' },
    400: { description: 'Invalid filter or format' },
    401: { description: 'Unauthorized' },
    403: { description: 'Forbidden' },
  },
})

registry.registerPath({
  method: 'post',
  path: '/infrastructure/{id}/retry',
  summary: '[admin] Re-fire provisioning for a failed deployment',
  description:
    'Retries the deployment using the parameters the order was placed with, so a retry cannot ' +
    'provision something different from what was approved. Only valid while the element\'s ORDER is ' +
    "'failed' — the element itself has no failed status. Returns 502 if no pipeline could be started " +
    '(the order is handed back to failed) or if only some could.',
  tags: ['Infrastructure'],
  security: bearerAuth,
  request: { params: z.object({ id: z.string() }) },
  responses: {
    200: {
      description: 'Retry started',
      content: { 'application/json': { schema: z.object({ pipelineIds: z.array(z.string()) }) } },
    },
    400: { description: 'Invalid id, or the deployment is not in a failed state' },
    401: { description: 'Unauthorized' },
    403: { description: 'Forbidden' },
    404: { description: 'Infrastructure element or order not found' },
    409: { description: 'A retry is already in progress' },
    502: { description: 'No pipeline, or only some pipelines, could be started' },
  },
})

registry.registerPath({
  method: 'post',
  path: '/infrastructure/{id}/schedule-decommission',
  summary: 'Set or clear automatic decommissioning for an element',
  description:
    'Pass null to clear. Same authorisation as the immediate decommission — scheduling a teardown is a ' +
    'deferred teardown. The element must be active and the time must be in the future. Nothing acts on ' +
    'the schedule until the sweep runs (POST /internal/decommission-sweep).',
  tags: ['Infrastructure'],
  security: bearerAuth,
  request: {
    params: z.object({ id: z.string() }),
    body: {
      content: {
        'application/json': {
          schema: z.object({ scheduledAt: z.string().datetime({ offset: true }).nullable() }),
        },
      },
    },
  },
  responses: {
    200: {
      description: 'Schedule stored or cleared',
      content: {
        'application/json': {
          schema: z.object({ scheduledDecommissionAt: z.string().nullable() }),
        },
      },
    },
    400: { description: 'Invalid id or timestamp, time not in the future, or the element is not active' },
    401: { description: 'Unauthorized' },
    403: { description: 'Forbidden' },
    404: { description: 'Infrastructure element not found' },
  },
})

registry.registerPath({
  method: 'post',
  path: '/internal/decommission-sweep',
  summary: '[scheduler] Tear down every element whose scheduled time has arrived',
  description:
    'Driven by an external scheduler (Kubernetes CronJob, cron), not a user: the backend has no worker ' +
    'process and is horizontally scaled, so an in-process timer would run once per replica. ' +
    'Authenticated with the DECOMMISSION_SWEEP_SECRET shared secret in an X-Sweep-Secret header rather ' +
    'than a session, and disabled entirely (503) while that is unset. Idempotent — the underlying ' +
    'active/decommissioning claim is atomic, so overlapping or replayed calls tear nothing down twice.',
  tags: ['Infrastructure'],
  security: [],
  request: {
    headers: z.object({ 'x-sweep-secret': z.string() }),
  },
  responses: {
    200: {
      description: 'All due elements torn down',
      content: {
        'application/json': {
          schema: z.object({
            decommissioned: z.array(z.number()),
            failed: z.array(z.object({ infraId: z.number(), message: z.string() })),
          }),
        },
      },
    },
    207: { description: 'Some teardowns could not be started — see failed[]' },
    401: { description: 'Missing or wrong sweep secret' },
    503: { description: 'DECOMMISSION_SWEEP_SECRET is not configured' },
  },
})

registry.registerPath({
  method: 'post',
  path: '/infrastructure/{id}/decommission',
  summary: 'Decommission an infrastructure element',
  tags: ['Infrastructure'],
  security: bearerAuth,
  request: {
    params: z.object({ id: z.string() }),
  },
  responses: {
    200: {
      description: 'Decommissioning initiated',
      content: {
        'application/json': {
          schema: z.object({ success: z.boolean(), pipelineIds: z.array(z.string()) }),
        },
      },
    },
    400: { description: 'Infrastructure element is not active' },
    401: { description: 'Unauthorized' },
    403: { description: 'Forbidden' },
    404: { description: 'Infrastructure element not found' },
  },
})

// ─── Users ────────────────────────────────────────────────────────────────────

registry.registerPath({
  method: 'get',
  path: '/users/me',
  summary: 'Get current user profile',
  tags: ['Users'],
  security: bearerAuth,
  responses: {
    200: {
      description: 'Current user',
      content: { 'application/json': { schema: userSchema } },
    },
    401: { description: 'Unauthorized' },
    404: { description: 'User not found' },
  },
})

registry.registerPath({
  method: 'put',
  path: '/users/me',
  summary: 'Update current user display name',
  tags: ['Users'],
  security: bearerAuth,
  request: {
    body: {
      content: {
        'application/json': {
          schema: z.object({ name: z.string().min(1) }),
        },
      },
    },
  },
  responses: {
    200: {
      description: 'Updated user',
      content: { 'application/json': { schema: userSchema } },
    },
    400: { description: 'Bad request' },
    401: { description: 'Unauthorized' },
  },
})

registry.registerPath({
  method: 'put',
  path: '/users/me/password',
  summary: 'Change current user password',
  tags: ['Users'],
  security: bearerAuth,
  request: {
    body: {
      content: {
        'application/json': {
          schema: z.object({
            currentPassword: z.string().min(1),
            newPassword: z.string().min(8),
          }),
        },
      },
    },
  },
  responses: {
    200: {
      description: 'Password changed',
      content: { 'application/json': { schema: z.object({ success: z.boolean() }) } },
    },
    400: { description: 'Bad request or wrong current password' },
    401: { description: 'Unauthorized' },
  },
})

// ─── Two-factor authentication ────────────────────────────────────────────────

registry.registerPath({
  method: 'get',
  path: '/users/me/2fa',
  summary: 'Second-factor status for the signed-in user',
  description:
    'Root only — the feature is scoped to the root account, and every 2FA endpoint answers 403 for any ' +
    'other role. ' +
    'Status only — never the shared secret or the recovery codes. There is no endpoint that turns a ' +
    'confirmed factor off: DELETE answers 405 by design, and the only exits are a re-enrollment or an ' +
    'operator deleting the row (see the operator handbook).',
  tags: ['Two-factor'],
  security: bearerAuth,
  responses: {
    200: {
      description: 'Current status',
      content: {
        'application/json': {
          schema: z.object({
            enabled: z.boolean(),
            confirmedAt: z.string().nullable(),
            pending: z.boolean(),
            recoveryCodesRemaining: z.number(),
            lockedUntil: z.string().nullable(),
          }),
        },
      },
    },
    401: { description: 'Unauthorized' },
    403: { description: 'Not the root account' },
  },
})

registry.registerPath({
  method: 'delete',
  path: '/users/me/2fa',
  summary: 'Refused — two-factor authentication cannot be disabled once set up',
  tags: ['Two-factor'],
  security: bearerAuth,
  responses: {
    405: { description: 'Always. Enroll a new authenticator instead.' },
  },
})

registry.registerPath({
  method: 'post',
  path: '/users/me/2fa/enroll',
  summary: 'Start a TOTP enrollment and get the QR code',
  description:
    'Root only. Requires the current password. When a factor is already active it ALSO requires a current TOTP code ' +
    'or a recovery code, so a stolen session plus a phished password cannot replace the factor. The new ' +
    'secret is stored as pending, so the existing authenticator keeps working until it is confirmed.',
  tags: ['Two-factor'],
  security: bearerAuth,
  request: {
    body: {
      content: {
        'application/json': {
          schema: z.object({
            password: z.string().min(1),
            code: z.string().min(1).max(64).optional().openapi({
              description: 'A current TOTP or recovery code. Required only when re-enrolling.',
            }),
          }),
        },
      },
    },
  },
  responses: {
    200: {
      description: 'The enrollment offer. Shown once; not retrievable afterwards.',
      content: {
        'application/json': {
          schema: z.object({
            secret: z.string().openapi({ description: 'base32, for manual entry' }),
            secretFormatted: z.string(),
            otpauthUrl: z.string(),
            qrSvg: z.string().openapi({ description: 'A self-contained SVG of the QR code' }),
          }),
        },
      },
    },
    400: { description: 'Bad request, or an SSO account with no local password' },
    401: { description: 'Unauthorized' },
    403: { description: 'Not the root account, wrong password, or a current second factor is required' },
    429: { description: 'Second factor locked after repeated failures' },
  },
})

registry.registerPath({
  method: 'post',
  path: '/users/me/2fa/confirm',
  summary: 'Confirm a pending enrollment and receive the recovery codes',
  description:
    'Root only. A code from the new authenticator proves the secret actually arrived in an app. The recovery codes ' +
    'are returned here and nowhere else: they are stored hashed, so this response is the only copy.',
  tags: ['Two-factor'],
  security: bearerAuth,
  request: {
    body: {
      content: {
        'application/json': { schema: z.object({ code: z.string().min(1).max(64) }) },
      },
    },
  },
  responses: {
    200: {
      description: 'The factor is now active. Recovery codes, shown once.',
      content: {
        'application/json': { schema: z.object({ recoveryCodes: z.array(z.string()) }) },
      },
    },
    400: { description: 'No enrollment in progress, expired, or an invalid code' },
    401: { description: 'Unauthorized' },
    403: { description: 'Not the root account' },
    409: { description: 'A newer enrollment has replaced the one being confirmed' },
    429: { description: 'Second factor locked after repeated failures' },
  },
})

// ─── Audit ────────────────────────────────────────────────────────────────────

registry.registerPath({
  method: 'get',
  path: '/audit',
  summary: '[admin] List audit log entries with pagination',
  tags: ['Audit'],
  security: bearerAuth,
  request: {
    query: z.object({
      userId: z.string().optional(),
      action: z.string().optional(),
      from: z.string().optional(),
      to: z.string().optional(),
      page: z.string().optional(),
      pageSize: z.string().optional(),
    }),
  },
  responses: {
    200: {
      description: 'Paginated audit log',
      content: {
        'application/json': {
          schema: z.object({
            data: z.array(auditEntrySchema),
            total: z.number(),
            page: z.number(),
            pageSize: z.number(),
          }),
        },
      },
    },
    401: { description: 'Unauthorized' },
    403: { description: 'Forbidden' },
  },
})

registry.registerPath({
  method: 'get',
  path: '/audit/export',
  summary: '[admin] Export audit log as CSV or PDF',
  tags: ['Audit'],
  security: bearerAuth,
  request: {
    query: z.object({
      userId: z.string().optional(),
      action: z.string().optional(),
      from: z.string().optional(),
      to: z.string().optional(),
      format: z.enum(['csv', 'pdf']).optional(),
    }),
  },
  responses: {
    200: {
      description: 'CSV or PDF file',
      content: {
        'text/csv': { schema: z.any() },
        'application/pdf': { schema: z.any() },
      },
    },
    401: { description: 'Unauthorized' },
    403: { description: 'Forbidden' },
  },
})

// ─── Webhooks (public) ────────────────────────────────────────────────────────

registry.registerPath({
  method: 'post',
  path: '/webhooks/gitlab/pipeline',
  summary: 'GitLab pipeline webhook receiver',
  tags: ['Webhooks'],
  security: [],
  request: {
    body: {
      content: {
        'application/json': {
          schema: z.object({
            object_kind: z.string(),
            object_attributes: z.object({
              id: z.number(),
              status: z.string(),
            }),
          }),
        },
      },
    },
  },
  responses: {
    200: {
      description: 'Event received',
      content: { 'application/json': { schema: z.object({ received: z.boolean() }) } },
    },
    400: { description: 'Invalid payload' },
    401: { description: 'Invalid token' },
  },
})

registry.registerPath({
  method: 'post',
  path: '/webhooks/github/workflow',
  summary: 'GitHub Actions workflow webhook receiver',
  tags: ['Webhooks'],
  security: [],
  request: {
    body: {
      content: {
        'application/json': {
          schema: z.object({
            action: z.string(),
            workflow_run: z.object({
              id: z.number(),
              name: z.string(),
              status: z.string(),
              conclusion: z.string().nullable(),
            }),
          }),
        },
      },
    },
  },
  responses: {
    200: {
      description: 'Event received',
      content: { 'application/json': { schema: z.object({ received: z.boolean() }) } },
    },
    400: { description: 'Invalid JSON' },
    401: { description: 'Invalid signature' },
  },
})

registry.registerPath({
  method: 'post',
  path: '/webhooks/bitbucket/pipeline',
  summary: 'Bitbucket pipeline webhook receiver',
  tags: ['Webhooks'],
  security: [],
  request: {
    body: {
      content: {
        'application/json': {
          schema: z.object({
            data: z.object({
              uuid: z.string(),
              state: z.object({
                name: z.string(),
                result: z.object({ name: z.string() }).optional(),
              }),
            }),
          }),
        },
      },
    },
  },
  responses: {
    200: {
      description: 'Event received',
      content: { 'application/json': { schema: z.object({ received: z.boolean() }) } },
    },
    400: { description: 'Invalid JSON' },
    401: { description: 'Invalid signature' },
  },
})

// ─── Admin — Categories ───────────────────────────────────────────────────────

registry.registerPath({
  method: 'get',
  path: '/admin/categories',
  summary: '[root] List categories',
  tags: ['Admin'],
  security: bearerAuth,
  responses: {
    200: {
      description: 'List of categories',
      content: { 'application/json': { schema: z.array(categorySchema) } },
    },
    401: { description: 'Unauthorized' },
    403: { description: 'Forbidden' },
  },
})

registry.registerPath({
  method: 'post',
  path: '/admin/categories',
  summary: '[root] Create a category',
  tags: ['Admin'],
  security: bearerAuth,
  request: {
    body: {
      content: {
        'application/json': {
          schema: z.object({
            name: z.string().min(1),
            displayOrder: z.number().int().optional(),
          }),
        },
      },
    },
  },
  responses: {
    201: {
      description: 'Category created',
      content: { 'application/json': { schema: categorySchema } },
    },
    400: { description: 'Bad request' },
    401: { description: 'Unauthorized' },
    403: { description: 'Forbidden' },
  },
})

registry.registerPath({
  method: 'get',
  path: '/admin/categories/{id}',
  summary: '[root] Get category by ID',
  tags: ['Admin'],
  security: bearerAuth,
  request: {
    params: z.object({ id: z.string() }),
  },
  responses: {
    200: {
      description: 'Category',
      content: { 'application/json': { schema: categorySchema } },
    },
    401: { description: 'Unauthorized' },
    403: { description: 'Forbidden' },
    404: { description: 'Not found' },
  },
})

registry.registerPath({
  method: 'put',
  path: '/admin/categories/{id}',
  summary: '[root] Update a category',
  tags: ['Admin'],
  security: bearerAuth,
  request: {
    params: z.object({ id: z.string() }),
    body: {
      content: {
        'application/json': {
          schema: z.object({
            name: z.string().min(1).optional(),
            displayOrder: z.number().int().optional(),
          }),
        },
      },
    },
  },
  responses: {
    200: {
      description: 'Updated category',
      content: { 'application/json': { schema: categorySchema } },
    },
    400: { description: 'Bad request' },
    401: { description: 'Unauthorized' },
    403: { description: 'Forbidden' },
    404: { description: 'Not found' },
  },
})

registry.registerPath({
  method: 'delete',
  path: '/admin/categories/{id}',
  summary: '[root] Delete a category',
  tags: ['Admin'],
  security: bearerAuth,
  request: {
    params: z.object({ id: z.string() }),
  },
  responses: {
    200: {
      description: 'Category deleted',
      content: { 'application/json': { schema: z.object({ success: z.boolean() }) } },
    },
    401: { description: 'Unauthorized' },
    403: { description: 'Forbidden' },
    404: { description: 'Not found' },
  },
})

// ─── Admin — Products ─────────────────────────────────────────────────────────

const adminProductSchema = productSchema.extend({
  categoryName: z.string().nullable(),
})

registry.registerPath({
  method: 'get',
  path: '/admin/products',
  summary: '[root] List all products',
  tags: ['Admin'],
  security: bearerAuth,
  request: { query: z.object(langQuery) },
  responses: {
    200: {
      description: 'List of products',
      content: { 'application/json': { schema: z.array(adminProductSchema) } },
    },
    401: { description: 'Unauthorized' },
    403: { description: 'Forbidden' },
  },
})

registry.registerPath({
  method: 'post',
  path: '/admin/products',
  summary: '[root] Create a product',
  tags: ['Admin'],
  security: bearerAuth,
  request: {
    body: {
      content: {
        'application/json': {
          schema: z.object({
            categoryId: z.number().int().positive(),
            baseLanguage: z.string().optional(),
            name: z.string().min(1),
            description: z.string().optional(),
          }),
        },
      },
    },
  },
  responses: {
    201: {
      description: 'Product created',
      content: { 'application/json': { schema: adminProductSchema } },
    },
    400: { description: 'Bad request' },
    401: { description: 'Unauthorized' },
    403: { description: 'Forbidden' },
  },
})

registry.registerPath({
  method: 'get',
  path: '/admin/products/{id}',
  summary: '[root] Get product by ID',
  tags: ['Admin'],
  security: bearerAuth,
  request: {
    params: z.object({ id: z.string() }),
    query: z.object(langQuery),
  },
  responses: {
    200: {
      description: 'Product',
      content: { 'application/json': { schema: adminProductSchema } },
    },
    401: { description: 'Unauthorized' },
    403: { description: 'Forbidden' },
    404: { description: 'Not found' },
  },
})

registry.registerPath({
  method: 'put',
  path: '/admin/products/{id}',
  summary: '[root] Update a product',
  tags: ['Admin'],
  security: bearerAuth,
  request: {
    params: z.object({ id: z.string() }),
    body: {
      content: {
        'application/json': {
          schema: z.object({
            categoryId: z.number().int().positive().optional(),
            baseLanguage: z.string().optional(),
            name: z.string().min(1).optional(),
            description: z.string().optional(),
          }),
        },
      },
    },
  },
  responses: {
    200: {
      description: 'Updated product',
      content: { 'application/json': { schema: productSchema } },
    },
    400: { description: 'Bad request' },
    401: { description: 'Unauthorized' },
    403: { description: 'Forbidden' },
    404: { description: 'Not found' },
  },
})

registry.registerPath({
  method: 'delete',
  path: '/admin/products/{id}',
  summary: '[root] Delete a product',
  tags: ['Admin'],
  security: bearerAuth,
  request: {
    params: z.object({ id: z.string() }),
  },
  responses: {
    200: {
      description: 'Product deleted',
      content: { 'application/json': { schema: z.object({ success: z.boolean() }) } },
    },
    401: { description: 'Unauthorized' },
    403: { description: 'Forbidden' },
    404: { description: 'Not found' },
  },
})

registry.registerPath({
  method: 'get',
  path: '/admin/products/{id}/translations',
  summary: '[root] Get all translations for a product',
  tags: ['Admin'],
  security: bearerAuth,
  request: {
    params: z.object({ id: z.string() }),
  },
  responses: {
    200: {
      description: 'List of translations',
      content: {
        'application/json': {
          schema: z.array(
            z.object({
              productId: z.number(),
              languageCode: z.string(),
              name: z.string(),
              description: z.string(),
            }),
          ),
        },
      },
    },
    401: { description: 'Unauthorized' },
    403: { description: 'Forbidden' },
  },
})

registry.registerPath({
  method: 'put',
  path: '/admin/products/{id}/translations/{lang}',
  summary: '[root] Upsert a product translation',
  tags: ['Admin'],
  security: bearerAuth,
  request: {
    params: z.object({ id: z.string(), lang: z.string() }),
    body: {
      content: {
        'application/json': {
          schema: z.object({
            name: z.string().min(1),
            description: z.string().optional(),
          }),
        },
      },
    },
  },
  responses: {
    200: {
      description: 'Upserted translation',
      content: {
        'application/json': {
          schema: z.object({
            productId: z.number(),
            languageCode: z.string(),
            name: z.string(),
            description: z.string(),
          }),
        },
      },
    },
    400: { description: 'Bad request' },
    401: { description: 'Unauthorized' },
    403: { description: 'Forbidden' },
  },
})

registry.registerPath({
  method: 'post',
  path: '/admin/products/{id}/translate',
  summary: '[root] Auto-translate product using AI',
  tags: ['Admin'],
  security: bearerAuth,
  request: {
    params: z.object({ id: z.string() }),
  },
  responses: {
    200: {
      description: 'Translation result',
      content: {
        'application/json': {
          schema: z.object({ success: z.boolean(), languages: z.array(z.string()) }),
        },
      },
    },
    401: { description: 'Unauthorized' },
    403: { description: 'Forbidden' },
    404: { description: 'Product or base translation not found' },
  },
})

registry.registerPath({
  method: 'put',
  path: '/admin/products/{id}/image',
  summary: '[root] Upload product image (multipart)',
  tags: ['Admin'],
  security: bearerAuth,
  request: {
    params: z.object({ id: z.string() }),
    body: {
      content: {
        'multipart/form-data': {
          schema: z.object({ image: z.any() }),
        },
      },
    },
  },
  responses: {
    200: {
      description: 'Image uploaded',
      content: { 'application/json': { schema: z.object({ success: z.boolean() }) } },
    },
    400: { description: 'No image provided' },
    401: { description: 'Unauthorized' },
    403: { description: 'Forbidden' },
  },
})

registry.registerPath({
  method: 'get',
  path: '/admin/products/{id}/environments',
  summary: '[root] Get product-environment associations',
  tags: ['Admin'],
  security: bearerAuth,
  request: {
    params: z.object({ id: z.string() }),
  },
  responses: {
    200: {
      description: 'List of product environments',
      content: { 'application/json': { schema: z.array(productEnvironmentSchema) } },
    },
    401: { description: 'Unauthorized' },
    403: { description: 'Forbidden' },
  },
})

registry.registerPath({
  method: 'post',
  path: '/admin/products/{id}/environments',
  summary: '[root] Add or update a product-environment association',
  tags: ['Admin'],
  security: bearerAuth,
  request: {
    params: z.object({ id: z.string() }),
    body: {
      content: {
        'application/json': {
          schema: z.object({
            environmentId: z.number().int().positive(),
            price: z.string().optional(),
            currency: z.string().optional(),
            costCenterMode: z.enum(['project', 'select', 'overhead']).optional(),
            forcedCostCenter: z.boolean().optional(),
            overheadCostCenterId: z.number().nullable().optional(),
            trialEnabled: z.boolean().optional(),
            trialDurationMinutes: z.number().int().positive().optional(),
            changelog: z.string().max(2000).optional().openapi({
              description: 'Optional free text describing the change; recorded in the product history (issue #38).',
            }),
          }),
        },
      },
    },
  },
  responses: {
    201: {
      description: 'Product environment created / updated',
      content: { 'application/json': { schema: productEnvironmentSchema } },
    },
    400: { description: 'Bad request' },
    401: { description: 'Unauthorized' },
    403: { description: 'Forbidden' },
  },
})

registry.registerPath({
  method: 'put',
  path: '/admin/products/{id}/environments/{envId}',
  summary: '[root] Update a product-environment association',
  tags: ['Admin'],
  security: bearerAuth,
  request: {
    params: z.object({ id: z.string(), envId: z.string() }),
    body: {
      content: {
        'application/json': {
          schema: z.object({
            price: z.string().optional(),
            currency: z.string().optional(),
            costCenterMode: z.enum(['project', 'select', 'overhead']).optional(),
            forcedCostCenter: z.boolean().optional(),
            overheadCostCenterId: z.number().nullable().optional(),
            trialEnabled: z.boolean().optional(),
            trialDurationMinutes: z.number().int().positive().optional(),
            changelog: z.string().max(2000).optional().openapi({
              description: 'Optional free text describing the change; recorded in the product history (issue #38).',
            }),
          }),
        },
      },
    },
  },
  responses: {
    200: {
      description: 'Updated product environment',
      content: { 'application/json': { schema: productEnvironmentSchema } },
    },
    400: { description: 'Bad request' },
    401: { description: 'Unauthorized' },
    403: { description: 'Forbidden' },
    404: { description: 'Not found' },
  },
})

registry.registerPath({
  method: 'delete',
  path: '/admin/products/{id}/environments/{envId}',
  summary: '[root] Remove a product-environment association',
  tags: ['Admin'],
  security: bearerAuth,
  request: {
    params: z.object({ id: z.string(), envId: z.string() }),
  },
  responses: {
    200: {
      description: 'Association deleted',
      content: { 'application/json': { schema: z.object({ success: z.boolean() }) } },
    },
    401: { description: 'Unauthorized' },
    403: { description: 'Forbidden' },
    404: { description: 'Not found' },
    409: { description: 'Infrastructure is still deployed in this environment' },
  },
})

registry.registerPath({
  method: 'get',
  path: '/admin/products/{id}/environments/{envId}/sizes',
  summary: '[root] List the sizes of one offering',
  description:
    'Every size, retired ones included — this is the admin view (issue #98). The catalogue endpoint ' +
    'returns only the active ones.',
  tags: ['Admin'],
  security: bearerAuth,
  request: { params: z.object({ id: z.string(), envId: z.string() }) },
  responses: {
    200: {
      description: 'Sizes of the offering',
      content: { 'application/json': { schema: z.array(offeringSizeSchema) } },
    },
    400: { description: 'Invalid id' },
    401: { description: 'Unauthorized' },
    403: { description: 'Forbidden' },
    404: { description: 'The product is not offered in that environment' },
  },
})

registry.registerPath({
  method: 'post',
  path: '/admin/products/{id}/environments/{envId}/sizes',
  summary: '[root] Add or update one size of an offering',
  description:
    'Upserts on the CODE, not on an id: the code is the natural key an admin edits by, so re-posting XL ' +
    'corrects XL instead of creating a second one. Price moves from the offering to the size (issue #98), ' +
    'so this is where a price change happens — and it is recorded in the product history (issue #38), ' +
    'because it changes what customers are offered. Existing orders are unaffected: they carry the price ' +
    'they were charged in their own snapshot.',
  tags: ['Admin'],
  security: bearerAuth,
  request: {
    params: z.object({ id: z.string(), envId: z.string() }),
    body: {
      content: {
        'application/json': {
          schema: z.object({
            code: z.string().min(1).max(SIZE_CODE_MAX_LENGTH).openapi({
              description: 'Letters, digits, dot, dash and underscore only — it reaches CI as SIZE.',
            }),
            label: z.string().max(120).optional(),
            price: z.string().max(20).optional().openapi({
              description: 'Non-negative, at most two decimals.',
            }),
            currency: z.string().length(3).optional(),
            sortOrder: z.number().int().min(0).max(10000).optional(),
            active: z.boolean().optional().openapi({
              description:
                'Retire a size by setting this false rather than deleting it: existing orders reference ' +
                'the code, and a retired size stops being orderable while staying readable.',
            }),
            changelog: z.string().max(2000).optional(),
          }),
        },
      },
    },
  },
  responses: {
    201: {
      description: 'Size created or updated',
      content: { 'application/json': { schema: offeringSizeSchema } },
    },
    400: { description: 'Invalid code, price or currency' },
    401: { description: 'Unauthorized' },
    403: { description: 'Forbidden' },
    404: { description: 'The product is not offered in that environment' },
  },
})

registry.registerPath({
  method: 'delete',
  path: '/admin/products/{id}/environments/{envId}/sizes/{sizeId}',
  summary: '[root] Remove one size of an offering',
  description:
    'Existing orders are unaffected — they store the code as text and their own price. A cart line naming ' +
    'the deleted size reports itself unavailable instead of failing at checkout. Prefer active: false.',
  tags: ['Admin'],
  security: bearerAuth,
  request: { params: z.object({ id: z.string(), envId: z.string(), sizeId: z.string() }) },
  responses: {
    200: { description: 'Size removed' },
    400: { description: 'Invalid id' },
    401: { description: 'Unauthorized' },
    403: { description: 'Forbidden' },
    404: { description: 'Size not found' },
  },
})

registry.registerPath({
  method: 'get',
  path: '/admin/products/{id}/webhooks',
  summary: '[root] List webhooks for a product',
  tags: ['Admin'],
  security: bearerAuth,
  request: {
    params: z.object({ id: z.string() }),
  },
  responses: {
    200: {
      description: 'List of webhooks',
      content: { 'application/json': { schema: z.array(webhookSchema) } },
    },
    401: { description: 'Unauthorized' },
    403: { description: 'Forbidden' },
  },
})

registry.registerPath({
  method: 'post',
  path: '/admin/products/{id}/webhooks',
  summary: '[root] Add a webhook to a product',
  tags: ['Admin'],
  security: bearerAuth,
  request: {
    params: z.object({ id: z.string() }),
    body: {
      content: {
        'application/json': {
          schema: z.object({
            environmentId: z.number().int().positive(),
            name: z.string().min(1),
            webhookUrl: z.string().url(),
            webhookToken: z.string().min(1),
            execOrder: z.number().int().optional(),
          }),
        },
      },
    },
  },
  responses: {
    201: {
      description: 'Webhook created',
      content: { 'application/json': { schema: webhookSchema } },
    },
    400: { description: 'Bad request' },
    401: { description: 'Unauthorized' },
    403: { description: 'Forbidden' },
  },
})

registry.registerPath({
  method: 'put',
  path: '/admin/products/{id}/webhooks/{whId}',
  summary: '[root] Update a product webhook',
  tags: ['Admin'],
  security: bearerAuth,
  request: {
    params: z.object({ id: z.string(), whId: z.string() }),
    body: {
      content: {
        'application/json': {
          schema: z.object({
            environmentId: z.number().int().positive().optional(),
            name: z.string().min(1).optional(),
            webhookUrl: z.string().url().optional(),
            webhookToken: z.string().min(1).optional(),
            execOrder: z.number().int().optional(),
          }),
        },
      },
    },
  },
  responses: {
    200: {
      description: 'Updated webhook',
      content: { 'application/json': { schema: webhookSchema } },
    },
    400: { description: 'Bad request' },
    401: { description: 'Unauthorized' },
    403: { description: 'Forbidden' },
    404: { description: 'Not found' },
  },
})

registry.registerPath({
  method: 'delete',
  path: '/admin/products/{id}/webhooks/{whId}',
  summary: '[root] Delete a product webhook',
  tags: ['Admin'],
  security: bearerAuth,
  request: {
    params: z.object({ id: z.string(), whId: z.string() }),
  },
  responses: {
    200: {
      description: 'Webhook deleted',
      content: { 'application/json': { schema: z.object({ success: z.boolean() }) } },
    },
    401: { description: 'Unauthorized' },
    403: { description: 'Forbidden' },
    404: { description: 'Not found' },
  },
})

// ─── Admin — Parameters ───────────────────────────────────────────────────────

registry.registerPath({
  method: 'get',
  path: '/admin/parameters',
  summary: '[admin] List parameters',
  tags: ['Admin'],
  security: bearerAuth,
  request: {
    query: z.object({
      scope: z.enum(['global', 'category', 'product']).optional(),
      scopeId: z.string().optional(),
      environmentId: z.string().optional(),
    }),
  },
  responses: {
    200: {
      description: 'List of parameters',
      content: { 'application/json': { schema: z.array(parameterSchema) } },
    },
    401: { description: 'Unauthorized' },
    403: { description: 'Forbidden' },
  },
})

registry.registerPath({
  method: 'post',
  path: '/admin/parameters',
  summary: '[admin] Create a parameter',
  tags: ['Admin'],
  security: bearerAuth,
  request: {
    body: {
      content: {
        'application/json': {
          schema: z.object({
            scope: z.enum(['global', 'category', 'product']),
            scopeId: z.number().int().optional(),
            environmentId: z.number().int().positive().nullable().optional(),
            name: z.string().min(1),
            type: z.enum(['string', 'number', 'bool', 'dropdown']),
            description: z.string().optional(),
            defaultValue: z.string().optional(),
            required: z.boolean().optional(),
            sensitive: z.boolean().optional(),
          }),
        },
      },
    },
  },
  responses: {
    201: {
      description: 'Parameter created',
      content: { 'application/json': { schema: parameterSchema } },
    },
    400: { description: 'Bad request' },
    401: { description: 'Unauthorized' },
    403: { description: 'Forbidden' },
  },
})

registry.registerPath({
  method: 'put',
  path: '/admin/parameters/{id}',
  summary: '[admin] Update a parameter',
  tags: ['Admin'],
  security: bearerAuth,
  request: {
    params: z.object({ id: z.string() }),
    body: {
      content: {
        'application/json': {
          schema: z.object({
            name: z.string().min(1).optional(),
            type: z.enum(['string', 'number', 'bool', 'dropdown']).optional(),
            description: z.string().optional(),
            defaultValue: z.string().optional(),
            required: z.boolean().optional(),
            sensitive: z.boolean().optional(),
            environmentId: z.number().int().positive().nullable().optional(),
          }),
        },
      },
    },
  },
  responses: {
    200: {
      description: 'Updated parameter',
      content: { 'application/json': { schema: parameterSchema } },
    },
    400: { description: 'Bad request' },
    401: { description: 'Unauthorized' },
    403: { description: 'Forbidden' },
    404: { description: 'Not found' },
  },
})

registry.registerPath({
  method: 'delete',
  path: '/admin/parameters/{id}',
  summary: '[admin] Delete a parameter',
  tags: ['Admin'],
  security: bearerAuth,
  request: {
    params: z.object({ id: z.string() }),
  },
  responses: {
    200: {
      description: 'Parameter deleted',
      content: { 'application/json': { schema: z.object({ success: z.boolean() }) } },
    },
    401: { description: 'Unauthorized' },
    403: { description: 'Forbidden' },
    404: { description: 'Not found' },
  },
})

// ─── Admin — CI Sources ───────────────────────────────────────────────────────

registry.registerPath({
  method: 'get',
  path: '/admin/ci-sources',
  summary: '[root] List CI sources',
  tags: ['Admin'],
  security: bearerAuth,
  responses: {
    200: {
      description: 'List of CI sources',
      content: { 'application/json': { schema: z.array(ciSourceSchema) } },
    },
    401: { description: 'Unauthorized' },
    403: { description: 'Forbidden' },
  },
})

registry.registerPath({
  method: 'post',
  path: '/admin/ci-sources',
  summary: '[root] Create a CI source',
  tags: ['Admin'],
  security: bearerAuth,
  request: {
    body: {
      content: {
        'application/json': {
          schema: z.object({
            name: z.string().min(1),
            url: z.string().url(),
            accessToken: z.string().min(1),
            provider: z.enum(['gitlab', 'github', 'bitbucket']),
          }),
        },
      },
    },
  },
  responses: {
    201: {
      description: 'CI source created',
      content: { 'application/json': { schema: ciSourceSchema } },
    },
    400: { description: 'Bad request' },
    401: { description: 'Unauthorized' },
    403: { description: 'Forbidden' },
  },
})

registry.registerPath({
  method: 'get',
  path: '/admin/ci-sources/{id}',
  summary: '[root] Get CI source by ID',
  tags: ['Admin'],
  security: bearerAuth,
  request: {
    params: z.object({ id: z.string() }),
  },
  responses: {
    200: {
      description: 'CI source',
      content: { 'application/json': { schema: ciSourceSchema } },
    },
    401: { description: 'Unauthorized' },
    403: { description: 'Forbidden' },
    404: { description: 'Not found' },
  },
})

registry.registerPath({
  method: 'put',
  path: '/admin/ci-sources/{id}',
  summary: '[root] Update a CI source',
  tags: ['Admin'],
  security: bearerAuth,
  request: {
    params: z.object({ id: z.string() }),
    body: {
      content: {
        'application/json': {
          schema: z.object({
            name: z.string().min(1).optional(),
            url: z.string().url().optional(),
            accessToken: z.string().min(1).optional(),
            provider: z.enum(['gitlab', 'github', 'bitbucket']).optional(),
          }),
        },
      },
    },
  },
  responses: {
    200: {
      description: 'Updated CI source',
      content: { 'application/json': { schema: ciSourceSchema } },
    },
    400: { description: 'Bad request' },
    401: { description: 'Unauthorized' },
    403: { description: 'Forbidden' },
    404: { description: 'Not found' },
  },
})

registry.registerPath({
  method: 'delete',
  path: '/admin/ci-sources/{id}',
  summary: '[root] Delete a CI source',
  tags: ['Admin'],
  security: bearerAuth,
  request: {
    params: z.object({ id: z.string() }),
  },
  responses: {
    200: {
      description: 'CI source deleted',
      content: { 'application/json': { schema: z.object({ success: z.boolean() }) } },
    },
    401: { description: 'Unauthorized' },
    403: { description: 'Forbidden' },
    404: { description: 'Not found' },
  },
})

// ─── Admin — Integrations ─────────────────────────────────────────────────────
//
// The registry of external systems that are not CI providers (issue #111).
// Root-only throughout: these rows hold credentials to systems that can
// provision and destroy infrastructure.

registry.registerPath({
  method: 'get',
  path: '/admin/integrations',
  summary: '[root] List integrations',
  description:
    'Every registered external system. Credentials are never included — only `hasCredential`.',
  tags: ['Admin'],
  security: bearerAuth,
  responses: {
    200: {
      description: 'List of integrations',
      content: { 'application/json': { schema: z.array(integrationSchema) } },
    },
    401: { description: 'Unauthorized' },
    403: { description: 'Forbidden' },
  },
})

registry.registerPath({
  method: 'post',
  path: '/admin/integrations',
  summary: '[root] Register an integration',
  description:
    'The credential is encrypted at rest (AES-256-GCM) with the key in SECRET_ENCRYPTION_KEY. ' +
    'Without that key configured, any request carrying a credential is refused with 503 rather ' +
    'than stored in plain text. `failureMode` is required: whether a failed call to this system ' +
    'blocks the operation that made it is a decision the registry records, not a default.',
  tags: ['Admin'],
  security: bearerAuth,
  request: {
    body: {
      content: {
        'application/json': {
          schema: z.object({
            kind: z.enum(integrationKinds),
            name: z.string().min(1),
            baseUrl: z.string().url(),
            authType: z.enum(integrationAuthTypes),
            username: z.string().optional().openapi({ description: 'Required for authType "basic".' }),
            credential: z.string().min(1).optional().openapi({
              description: 'Token or password. Required unless authType is "none". Never returned.',
            }),
            environmentId: z.number().int().positive().nullable().optional().openapi({
              description: 'Bind to one environment, or null/omitted for portal-wide.',
            }),
            enabled: z.boolean().optional(),
            failureMode: z.enum(integrationFailureModes),
          }),
        },
      },
    },
  },
  responses: {
    201: {
      description: 'Integration created',
      content: { 'application/json': { schema: integrationSchema } },
    },
    400: { description: 'Bad request, or a credential/username missing for the chosen authType' },
    401: { description: 'Unauthorized' },
    403: { description: 'Forbidden' },
    409: { description: 'An integration of this kind is already bound to that environment' },
    503: { description: 'SECRET_ENCRYPTION_KEY is not configured, so a credential cannot be stored' },
  },
})

registry.registerPath({
  method: 'get',
  path: '/admin/integrations/{id}',
  summary: '[root] Get an integration by ID',
  tags: ['Admin'],
  security: bearerAuth,
  request: { params: z.object({ id: z.string() }) },
  responses: {
    200: {
      description: 'Integration',
      content: { 'application/json': { schema: integrationSchema } },
    },
    400: { description: 'Invalid id' },
    401: { description: 'Unauthorized' },
    403: { description: 'Forbidden' },
    404: { description: 'Not found' },
  },
})

registry.registerPath({
  method: 'put',
  path: '/admin/integrations/{id}',
  summary: '[root] Update an integration',
  description:
    'Sending `credential` rotates it and is audited as a rotation in its own right; omitting it ' +
    'leaves the stored one alone. `kind` cannot be changed — delete and recreate instead, so a ' +
    "row's credential, health record and audit history keep belonging to one system. Changing " +
    '`baseUrl` or the credential clears the health record, because it described the old target.',
  tags: ['Admin'],
  security: bearerAuth,
  request: {
    params: z.object({ id: z.string() }),
    body: {
      content: {
        'application/json': {
          schema: z.object({
            name: z.string().min(1).optional(),
            baseUrl: z.string().url().optional(),
            authType: z.enum(integrationAuthTypes).optional(),
            username: z.string().optional(),
            credential: z.string().min(1).optional(),
            environmentId: z.number().int().positive().nullable().optional(),
            enabled: z.boolean().optional(),
            failureMode: z.enum(integrationFailureModes).optional(),
          }),
        },
      },
    },
  },
  responses: {
    200: {
      description: 'Updated integration',
      content: { 'application/json': { schema: integrationSchema } },
    },
    400: { description: 'Bad request' },
    401: { description: 'Unauthorized' },
    403: { description: 'Forbidden' },
    404: { description: 'Not found' },
    409: { description: 'An integration of this kind is already bound to that environment' },
    503: { description: 'SECRET_ENCRYPTION_KEY is not configured, so a credential cannot be rotated' },
  },
})

registry.registerPath({
  method: 'delete',
  path: '/admin/integrations/{id}',
  summary: '[root] Delete an integration',
  tags: ['Admin'],
  security: bearerAuth,
  request: { params: z.object({ id: z.string() }) },
  responses: {
    200: {
      description: 'Integration deleted',
      content: { 'application/json': { schema: z.object({ success: z.boolean() }) } },
    },
    400: { description: 'Invalid id' },
    401: { description: 'Unauthorized' },
    403: { description: 'Forbidden' },
    404: { description: 'Not found' },
  },
})

registry.registerPath({
  method: 'post',
  path: '/admin/integrations/{id}/probe',
  summary: '[root] Probe an integration for reachability',
  description:
    "Contacts the system's health endpoint now and records the outcome on the row. An " +
    'unreachable system is a 200 with `ok: false` and a reason — the admin asked whether it ' +
    'works, and "no, because …" answers that. POST because it makes an outbound call and writes ' +
    '`lastContactedAt` / `lastError`.',
  tags: ['Admin'],
  security: bearerAuth,
  request: { params: z.object({ id: z.string() }) },
  responses: {
    200: {
      description: 'Probe outcome, successful or not',
      content: { 'application/json': { schema: integrationProbeSchema } },
    },
    400: { description: 'Invalid id' },
    401: { description: 'Unauthorized' },
    403: { description: 'Forbidden' },
    404: { description: 'Not found' },
    409: { description: 'Integration is disabled' },
  },
})

// ─── Admin — CI Browser ───────────────────────────────────────────────────────

registry.registerPath({
  method: 'get',
  path: '/admin/ci/{sourceId}/projects',
  summary: '[root] List projects in a CI source',
  tags: ['Admin'],
  security: bearerAuth,
  request: {
    params: z.object({ sourceId: z.string() }),
    query: z.object({ search: z.string().optional() }),
  },
  responses: {
    200: {
      description: 'List of CI projects',
      content: {
        'application/json': {
          schema: z.array(z.object({ id: z.string(), name: z.string(), url: z.string().optional() })),
        },
      },
    },
    401: { description: 'Unauthorized' },
    403: { description: 'Forbidden' },
    404: { description: 'CI source not found' },
  },
})

registry.registerPath({
  method: 'get',
  path: '/admin/ci/{sourceId}/projects/{projectId}/branches',
  summary: '[root] List branches of a CI project',
  tags: ['Admin'],
  security: bearerAuth,
  request: {
    params: z.object({ sourceId: z.string(), projectId: z.string() }),
  },
  responses: {
    200: {
      description: 'List of branches',
      content: {
        'application/json': {
          schema: z.array(z.object({ name: z.string() })),
        },
      },
    },
    401: { description: 'Unauthorized' },
    403: { description: 'Forbidden' },
    404: { description: 'CI source not found' },
  },
})

registry.registerPath({
  method: 'get',
  path: '/admin/ci/{sourceId}/projects/{projectId}/files',
  summary: '[root] List files in a CI project repository',
  tags: ['Admin'],
  security: bearerAuth,
  request: {
    params: z.object({ sourceId: z.string(), projectId: z.string() }),
    query: z.object({
      branch: z.string().optional(),
      path: z.string().optional(),
    }),
  },
  responses: {
    200: {
      description: 'List of files',
      content: {
        'application/json': {
          schema: z.array(z.object({ name: z.string(), path: z.string(), type: z.string() })),
        },
      },
    },
    401: { description: 'Unauthorized' },
    403: { description: 'Forbidden' },
    404: { description: 'CI source not found' },
  },
})

registry.registerPath({
  method: 'post',
  path: '/admin/ci/{sourceId}/projects/{projectId}/import-vars',
  summary: '[root] Import Terraform variables from a file in a CI project',
  tags: ['Admin'],
  security: bearerAuth,
  request: {
    params: z.object({ sourceId: z.string(), projectId: z.string() }),
    body: {
      content: {
        'application/json': {
          schema: z.object({
            branch: z.string().min(1),
            filePath: z.string().min(1),
          }),
        },
      },
    },
  },
  responses: {
    200: {
      description: 'Parsed Terraform variables',
      content: {
        'application/json': {
          schema: z.array(
            z.object({
              name: z.string(),
              type: z.string(),
              description: z.string().optional(),
              default: z.string().optional(),
            }),
          ),
        },
      },
    },
    400: { description: 'Bad request' },
    401: { description: 'Unauthorized' },
    403: { description: 'Forbidden' },
    404: { description: 'CI source not found' },
  },
})

// ─── Admin — Environments ─────────────────────────────────────────────────────

registry.registerPath({
  method: 'get',
  path: '/admin/environments',
  summary: '[admin] List deployment environments',
  tags: ['Admin'],
  security: bearerAuth,
  responses: {
    200: {
      description: 'List of environments',
      content: {
        'application/json': {
          schema: z.array(
            environmentSchema.extend({ ciSourceName: z.string().nullable() }),
          ),
        },
      },
    },
    401: { description: 'Unauthorized' },
    403: { description: 'Forbidden' },
  },
})

registry.registerPath({
  method: 'post',
  path: '/admin/environments',
  summary: '[admin] Create a deployment environment',
  tags: ['Admin'],
  security: bearerAuth,
  request: {
    body: {
      content: {
        'application/json': {
          schema: z.object({
            name: z.string().min(1),
            description: z.string().optional(),
            ciSourceId: z.number().int().positive(),
            webhookUrl: z.string().url(),
            webhookToken: z.string().min(1),
          }),
        },
      },
    },
  },
  responses: {
    201: {
      description: 'Environment created',
      content: { 'application/json': { schema: environmentSchema } },
    },
    400: { description: 'Bad request' },
    401: { description: 'Unauthorized' },
    403: { description: 'Forbidden' },
  },
})

registry.registerPath({
  method: 'get',
  path: '/admin/environments/{id}',
  summary: '[admin] Get deployment environment by ID',
  tags: ['Admin'],
  security: bearerAuth,
  request: {
    params: z.object({ id: z.string() }),
  },
  responses: {
    200: {
      description: 'Environment',
      content: { 'application/json': { schema: environmentSchema } },
    },
    401: { description: 'Unauthorized' },
    403: { description: 'Forbidden' },
    404: { description: 'Not found' },
  },
})

registry.registerPath({
  method: 'put',
  path: '/admin/environments/{id}',
  summary: '[admin] Update a deployment environment',
  tags: ['Admin'],
  security: bearerAuth,
  request: {
    params: z.object({ id: z.string() }),
    body: {
      content: {
        'application/json': {
          schema: z.object({
            name: z.string().min(1).optional(),
            description: z.string().optional(),
            ciSourceId: z.number().int().positive().optional(),
            webhookUrl: z.string().url().optional(),
            webhookToken: z.string().min(1).optional(),
          }),
        },
      },
    },
  },
  responses: {
    200: {
      description: 'Updated environment',
      content: { 'application/json': { schema: environmentSchema } },
    },
    400: { description: 'Bad request' },
    401: { description: 'Unauthorized' },
    403: { description: 'Forbidden' },
    404: { description: 'Not found' },
  },
})

registry.registerPath({
  method: 'delete',
  path: '/admin/environments/{id}',
  summary: '[admin] Delete a deployment environment',
  tags: ['Admin'],
  security: bearerAuth,
  request: {
    params: z.object({ id: z.string() }),
  },
  responses: {
    200: {
      description: 'Environment deleted',
      content: { 'application/json': { schema: z.object({ success: z.boolean() }) } },
    },
    401: { description: 'Unauthorized' },
    403: { description: 'Forbidden' },
    404: { description: 'Not found' },
  },
})

// ─── Admin — Cost Centers ─────────────────────────────────────────────────────

registry.registerPath({
  method: 'get',
  path: '/admin/cost-centers',
  summary: '[admin] List cost centers',
  tags: ['Admin'],
  security: bearerAuth,
  responses: {
    200: {
      description: 'List of cost centers',
      content: { 'application/json': { schema: z.array(costCenterSchema) } },
    },
    401: { description: 'Unauthorized' },
    403: { description: 'Forbidden' },
  },
})

registry.registerPath({
  method: 'post',
  path: '/admin/cost-centers',
  summary: '[admin] Create a cost center',
  tags: ['Admin'],
  security: bearerAuth,
  request: {
    body: {
      content: {
        'application/json': {
          schema: z.object({
            code: z.string().min(1),
            name: z.string().min(1),
            active: z.boolean().optional(),
          }),
        },
      },
    },
  },
  responses: {
    201: {
      description: 'Cost center created',
      content: { 'application/json': { schema: costCenterSchema } },
    },
    400: { description: 'Bad request' },
    401: { description: 'Unauthorized' },
    403: { description: 'Forbidden' },
  },
})

registry.registerPath({
  method: 'get',
  path: '/admin/cost-centers/{id}',
  summary: '[admin] Get cost center by ID',
  tags: ['Admin'],
  security: bearerAuth,
  request: {
    params: z.object({ id: z.string() }),
  },
  responses: {
    200: {
      description: 'Cost center',
      content: { 'application/json': { schema: costCenterSchema } },
    },
    401: { description: 'Unauthorized' },
    403: { description: 'Forbidden' },
    404: { description: 'Not found' },
  },
})

registry.registerPath({
  method: 'put',
  path: '/admin/cost-centers/{id}',
  summary: '[admin] Update a cost center',
  tags: ['Admin'],
  security: bearerAuth,
  request: {
    params: z.object({ id: z.string() }),
    body: {
      content: {
        'application/json': {
          schema: z.object({
            code: z.string().min(1).optional(),
            name: z.string().min(1).optional(),
            active: z.boolean().optional(),
          }),
        },
      },
    },
  },
  responses: {
    200: {
      description: 'Updated cost center',
      content: { 'application/json': { schema: costCenterSchema } },
    },
    400: { description: 'Bad request' },
    401: { description: 'Unauthorized' },
    403: { description: 'Forbidden' },
    404: { description: 'Not found' },
  },
})

registry.registerPath({
  method: 'delete',
  path: '/admin/cost-centers/{id}',
  summary: '[admin] Delete a cost center',
  tags: ['Admin'],
  security: bearerAuth,
  request: {
    params: z.object({ id: z.string() }),
  },
  responses: {
    200: {
      description: 'Cost center deleted',
      content: { 'application/json': { schema: z.object({ success: z.boolean() }) } },
    },
    401: { description: 'Unauthorized' },
    403: { description: 'Forbidden' },
    404: { description: 'Not found' },
  },
})

// ─── Admin — Users ────────────────────────────────────────────────────────────

registry.registerPath({
  method: 'get',
  path: '/admin/users',
  summary: '[root] List all users',
  tags: ['Admin'],
  security: bearerAuth,
  responses: {
    200: {
      description: 'List of users',
      content: { 'application/json': { schema: z.array(userSchema) } },
    },
    401: { description: 'Unauthorized' },
    403: { description: 'Forbidden' },
  },
})

registry.registerPath({
  method: 'post',
  path: '/admin/users',
  summary: '[root] Create a user',
  tags: ['Admin'],
  security: bearerAuth,
  request: {
    body: {
      content: {
        'application/json': {
          schema: z.object({
            email: z.string().email(),
            name: z.string().min(1),
            role: z.enum(['admin', 'project_manager', 'root']),
            password: z.string().min(8),
            active: z.boolean().optional(),
          }),
        },
      },
    },
  },
  responses: {
    201: {
      description: 'User created',
      content: { 'application/json': { schema: userSchema } },
    },
    400: { description: 'Bad request' },
    401: { description: 'Unauthorized' },
    403: { description: 'Forbidden' },
  },
})

registry.registerPath({
  method: 'get',
  path: '/admin/users/{id}',
  summary: '[root] Get user by ID',
  tags: ['Admin'],
  security: bearerAuth,
  request: {
    params: z.object({ id: z.string() }),
  },
  responses: {
    200: {
      description: 'User',
      content: { 'application/json': { schema: userSchema } },
    },
    401: { description: 'Unauthorized' },
    403: { description: 'Forbidden' },
    404: { description: 'Not found' },
  },
})

registry.registerPath({
  method: 'put',
  path: '/admin/users/{id}',
  summary: '[root] Update a user',
  description:
    'Setting `active: false` also revokes every live session of that account (issue #37) — `active` ' +
    'is only read at login, so without that the user would stay signed in until their token ran out.',
  tags: ['Admin'],
  security: bearerAuth,
  request: {
    params: z.object({ id: z.string() }),
    body: {
      content: {
        'application/json': {
          schema: z.object({
            name: z.string().min(1).optional(),
            role: z.enum(['admin', 'project_manager', 'root']).optional(),
            active: z.boolean().optional(),
            password: z.string().min(8).optional(),
          }),
        },
      },
    },
  },
  responses: {
    200: {
      description: 'Updated user',
      content: { 'application/json': { schema: userSchema } },
    },
    400: { description: 'Bad request' },
    401: { description: 'Unauthorized' },
    403: { description: 'Forbidden' },
    404: { description: 'Not found' },
  },
})

registry.registerPath({
  method: 'delete',
  path: '/admin/users/{id}',
  summary: '[root] Delete a user',
  tags: ['Admin'],
  security: bearerAuth,
  request: {
    params: z.object({ id: z.string() }),
  },
  responses: {
    200: {
      description: 'User deleted',
      content: { 'application/json': { schema: z.object({ success: z.boolean() }) } },
    },
    400: { description: 'Cannot delete own account' },
    401: { description: 'Unauthorized' },
    403: { description: 'Forbidden' },
    404: { description: 'Not found' },
  },
})

// ─── Admin — Config: SMTP ─────────────────────────────────────────────────────

registry.registerPath({
  method: 'get',
  path: '/admin/config/smtp',
  summary: '[root] Get SMTP configuration',
  tags: ['Admin'],
  security: bearerAuth,
  responses: {
    200: {
      description: 'SMTP config (password never returned)',
      content: {
        'application/json': {
          schema: z.object({
            smtpHost: z.string().nullable(),
            smtpPort: z.number().nullable(),
            smtpFrom: z.string().nullable(),
            smtpUser: z.string().nullable(),
            smtpTls: z.boolean(),
          }),
        },
      },
    },
    401: { description: 'Unauthorized' },
    403: { description: 'Forbidden' },
  },
})

registry.registerPath({
  method: 'put',
  path: '/admin/config/smtp',
  summary: '[root] Update SMTP configuration',
  tags: ['Admin'],
  security: bearerAuth,
  request: {
    body: {
      content: {
        'application/json': {
          schema: z.object({
            host: z.string().min(1),
            port: z.number().int().positive(),
            from: z.string().min(1),
            user: z.string().optional(),
            password: z.string().optional(),
            tls: z.boolean().optional(),
          }),
        },
      },
    },
  },
  responses: {
    200: {
      description: 'SMTP config updated',
      content: { 'application/json': { schema: z.object({ success: z.boolean() }) } },
    },
    400: { description: 'Bad request' },
    401: { description: 'Unauthorized' },
    403: { description: 'Forbidden' },
  },
})

// ─── Admin — Config: AI ───────────────────────────────────────────────────────

registry.registerPath({
  method: 'get',
  path: '/admin/config/ai',
  summary: '[root] Get AI configuration',
  tags: ['Admin'],
  security: bearerAuth,
  responses: {
    200: {
      description: 'AI config (API key never returned)',
      content: {
        'application/json': {
          schema: z.object({
            aiProvider: z.string().nullable(),
            aiEndpoint: z.string().nullable(),
            aiModel: z.string().nullable(),
          }),
        },
      },
    },
    401: { description: 'Unauthorized' },
    403: { description: 'Forbidden' },
  },
})

registry.registerPath({
  method: 'put',
  path: '/admin/config/ai',
  summary: '[root] Update AI configuration',
  tags: ['Admin'],
  security: bearerAuth,
  request: {
    body: {
      content: {
        'application/json': {
          schema: z.object({
            provider: z.enum(['claude', 'openai', 'azure_openai', 'ollama', 'localai']),
            endpoint: z.string().min(1),
            apiKey: z.string().optional(),
            model: z.string().min(1),
          }),
        },
      },
    },
  },
  responses: {
    200: {
      description: 'AI config updated',
      content: { 'application/json': { schema: z.object({ success: z.boolean() }) } },
    },
    400: { description: 'Bad request' },
    401: { description: 'Unauthorized' },
    403: { description: 'Forbidden' },
  },
})

// ─── Admin — Branding ─────────────────────────────────────────────────────────

const brandingSchema = z.object({
  id: z.number().optional(),
  primaryColor: z.string().nullable(),
  secondaryColor: z.string().nullable(),
  shopName: z.string().nullable(),
  shopSubtitle: z.string().nullable(),
  imprintText: z.string().nullable(),
  logoMime: z.string().nullable(),
})

registry.registerPath({
  method: 'get',
  path: '/admin/branding',
  summary: '[root] Get branding settings',
  tags: ['Admin'],
  security: bearerAuth,
  responses: {
    200: {
      description: 'Branding settings',
      content: { 'application/json': { schema: brandingSchema } },
    },
    401: { description: 'Unauthorized' },
    403: { description: 'Forbidden' },
  },
})

registry.registerPath({
  method: 'put',
  path: '/admin/branding',
  summary: '[root] Update branding settings',
  tags: ['Admin'],
  security: bearerAuth,
  request: {
    body: {
      content: {
        'application/json': {
          schema: z.object({
            primaryColor: z.string().optional(),
            secondaryColor: z.string().optional(),
            shopName: z.string().optional(),
            shopSubtitle: z.string().optional(),
            imprintText: z.string().optional(),
          }),
        },
      },
    },
  },
  responses: {
    200: {
      description: 'Updated branding',
      content: { 'application/json': { schema: brandingSchema } },
    },
    400: { description: 'Bad request' },
    401: { description: 'Unauthorized' },
    403: { description: 'Forbidden' },
  },
})

registry.registerPath({
  method: 'get',
  path: '/admin/branding/logo',
  summary: 'Get branding logo (binary)',
  tags: ['Admin'],
  security: [],
  responses: {
    200: {
      description: 'Logo image',
      content: { 'image/*': { schema: z.any() } },
    },
    404: { description: 'No logo set' },
  },
})

registry.registerPath({
  method: 'put',
  path: '/admin/branding/logo',
  summary: '[root] Upload branding logo (multipart)',
  tags: ['Admin'],
  security: bearerAuth,
  request: {
    body: {
      content: {
        'multipart/form-data': {
          schema: z.object({ logo: z.any() }),
        },
      },
    },
  },
  responses: {
    200: {
      description: 'Logo uploaded',
      content: { 'application/json': { schema: z.object({ success: z.boolean() }) } },
    },
    400: { description: 'No logo provided' },
    401: { description: 'Unauthorized' },
    403: { description: 'Forbidden' },
  },
})

// ─── Admin — Exchange Rates ───────────────────────────────────────────────────

registry.registerPath({
  method: 'get',
  path: '/admin/exchange-rates',
  summary: 'List exchange rates',
  tags: ['Admin'],
  security: bearerAuth,
  responses: {
    200: {
      description: 'List of exchange rates',
      content: { 'application/json': { schema: z.array(exchangeRateSchema) } },
    },
    401: { description: 'Unauthorized' },
  },
})

registry.registerPath({
  method: 'post',
  path: '/admin/exchange-rates/refresh',
  summary: '[root] Refresh exchange rates from external source',
  tags: ['Admin'],
  security: bearerAuth,
  responses: {
    200: {
      description: 'Updated exchange rates',
      content: { 'application/json': { schema: z.array(exchangeRateSchema) } },
    },
    401: { description: 'Unauthorized' },
    403: { description: 'Forbidden' },
  },
})
