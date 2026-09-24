import bcrypt from 'bcryptjs'
import { createHash } from 'node:crypto'
import { db } from '@/lib/db/client'
import * as schema from '@/lib/db/schema'
import { createSession } from '@/lib/auth/sessions'
import { generateTotpSecret, totp } from '@/lib/auth/totp'
import { encryptTotpSecret } from '@/lib/auth/totpSecret'
import type { Role } from '@infrashelf/types'

/**
 * A user, with a confirmed second factor if their role requires one (#197).
 *
 * `root` and `admin` must hold a factor, and `requireAuth` refuses every request
 * from one that does not. So an administrative fixture WITHOUT a factor does not
 * represent an admin using the API — it represents an admin who cannot use it,
 * and a test built on one would be asserting against a 403 it never meant to ask
 * for. Enrolling by default is what makes these fixtures mean what they read as.
 *
 * Pass `secondFactor: false` for the tests that are *about* the un-enrolled
 * state. That is the only reason to, and it should look deliberate.
 *
 * `project_manager` is unaffected: it may not hold a factor at all.
 */
export const createUser = async (overrides?: {
  email?: string
  name?: string
  role?: Role
  active?: boolean
  password?: string
  /** Skip the automatic enrollment. Only for tests about an admin who owes one. */
  secondFactor?: boolean
}) => {
  const password = overrides?.password ?? 'password123'
  const passwordHash = await bcrypt.hash(password, 4)
  const email = overrides?.email ?? `user-${Math.random().toString(36).slice(2)}@test.dev`
  const role = overrides?.role ?? 'project_manager'

  const [user] = await db
    .insert(schema.users)
    .values({
      email,
      name: overrides?.name ?? 'Test User',
      role,
      active: overrides?.active ?? true,
      passwordHash,
    })
    .returning()

  const wantsFactor = overrides?.secondFactor ?? (role === 'root' || role === 'admin')
  if (wantsFactor) await enrollTotp(user.id)

  return user
}

export const createCategory = async (name = 'Test Category') => {
  const [cat] = await db.insert(schema.categories).values({ name }).returning()
  return cat
}

export const createProduct = async (categoryId: number, name = 'Test Product') => {
  const [product] = await db
    .insert(schema.products)
    .values({ categoryId, baseLanguage: 'en' })
    .returning()

  await db
    .insert(schema.productTranslations)
    .values({ productId: product.id, languageCode: 'en', name, description: '' })

  return product
}

/**
 * A picture in a product's gallery (`product_images`, migration 0021).
 *
 * `data` defaults to a real PNG signature so a test that only cares about
 * ordering or descriptions does not have to invent bytes, and the serving route's
 * content-type assertions still have something honest to read.
 */
export const createProductImage = async (
  productId: number,
  overrides?: { position?: number; data?: Buffer; mime?: string; alt?: string },
) => {
  const [image] = await db
    .insert(schema.productImages)
    .values({
      productId,
      position: overrides?.position ?? 0,
      data: overrides?.data ?? Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
      mime: overrides?.mime ?? 'image/png',
      alt: overrides?.alt ?? 'A test product picture',
    })
    .returning()

  return image
}

export const createCiSource = async (overrides?: { name?: string; url?: string }) => {
  const [src] = await db
    .insert(schema.ciSources)
    .values({
      name: overrides?.name ?? 'Test GitLab',
      url: overrides?.url ?? 'https://gitlab.example.com',
      accessToken: 'test-token',
      provider: 'gitlab',
    })
    .returning()
  return src
}

let envSeq = 0

export const createEnvironment = async (ciSourceId: number, webhookToken?: string, name?: string) => {
  // Default to a per-call unique token: callback_secret mirrors it (see below)
  // and is UNIQUE since migration 0006, so a shared default would collide for
  // any test that seeds more than one environment.
  const token = webhookToken ?? `wh-secret-${++envSeq}`
  const [env] = await db
    .insert(schema.deploymentEnvironments)
    .values({
      name: name ?? 'Test Env',
      ciSourceId,
      webhookUrl: 'https://gitlab.example.com/api/v4/projects/1/trigger/pipeline',
      webhookToken: token,
      // Mirror the migration 0004 backfill: legacy envs get callback_secret =
      // webhook_token. Tests that seed with a specific webhookToken and then
      // POST to /api/webhooks/gitlab/pipeline with that same value continue
      // to pass without special handling.
      callbackSecret: token,
    })
    .returning()
  return env
}

export const linkProductEnvironment = async (
  productId: number,
  environmentId: number,
  overrides?: {
    price?: string
    currency?: string
    costCenterMode?: 'project' | 'select' | 'overhead'
    forcedCostCenter?: boolean
    overheadCostCenterId?: number | null
    trialEnabled?: boolean
    trialDurationMinutes?: number
    /**
     * Also give the product a webhook here, so it can actually be ordered.
     *
     * Default true, because that is what an offering means in production: a
     * product offered in an environment with no webhook and no pipeline stack
     * has nothing to provision it, and `prepareOrder` refuses it outright rather
     * than letting it fail at the till with a 502 (which is how an imported
     * Kubernetes product came to be unorderable).
     *
     * Pass false to build exactly that broken state on purpose.
     */
    deployable?: boolean
  },
) => {
  const [row] = await db
    .insert(schema.productEnvironments)
    .values({
      productId,
      environmentId,
      price: overrides?.price ?? '0',
      currency: overrides?.currency ?? 'EUR',
      ...(overrides?.costCenterMode ? { costCenterMode: overrides.costCenterMode } : {}),
      ...(overrides?.forcedCostCenter !== undefined ? { forcedCostCenter: overrides.forcedCostCenter } : {}),
      ...(overrides?.overheadCostCenterId !== undefined ? { overheadCostCenterId: overrides.overheadCostCenterId } : {}),
      ...(overrides?.trialEnabled !== undefined ? { trialEnabled: overrides.trialEnabled } : {}),
      ...(overrides?.trialDurationMinutes !== undefined ? { trialDurationMinutes: overrides.trialDurationMinutes } : {}),
    })
    .onConflictDoNothing()
    .returning()

  if (overrides?.deployable !== false) {
    await db
      .insert(schema.productWebhooks)
      .values({
        productId,
        environmentId,
        name: 'test webhook',
        webhookUrl: 'https://ci.test.invalid/trigger',
        webhookToken: 'test-token',
      })
      .onConflictDoNothing()
  }

  return row
}

/**
 * Add one size to an offering (issue #98).
 *
 * Note what this does to the offering it is added to: once it has ANY size, an
 * order against it must name one, and its price comes from the size rather than
 * from `product_environments.price`.
 */
export const createSize = async (
  productId: number,
  environmentId: number,
  overrides?: {
    code?: string
    label?: string
    price?: string
    currency?: string
    sortOrder?: number
    active?: boolean
  },
) => {
  const [row] = await db
    .insert(schema.productEnvironmentSizes)
    .values({
      productId,
      environmentId,
      code: overrides?.code ?? 'M',
      label: overrides?.label ?? 'Medium',
      price: overrides?.price ?? '10.00',
      currency: overrides?.currency ?? 'EUR',
      sortOrder: overrides?.sortOrder ?? 0,
      active: overrides?.active ?? true,
    })
    .returning()
  return row
}

export const createProject = async (ownerId: number, name?: string) => {
  const [project] = await db
    .insert(schema.projects)
    .values({ name: name ?? 'Test Project', ownerId })
    .returning()
  return project
}

export const createOrder = async (
  projectId: number,
  productId: number,
  environmentId: number,
  userId: number,
  overrides?: {
    status?: string
    pipelineId?: string[]
    /**
     * The per-pipeline map, as the webhook handler merges into it.
     *
     * It has to be settable at creation: a fixture that seeds an order with
     * `pipelineId: ['pipe-1', 'pipe-2']` but no statuses starts from an EMPTY
     * map, so the first event's merge produces a one-key map and any
     * multi-pipeline case is silently reduced to the single-pipeline one.
     */
    pipelineStatus?: Record<string, string>
    isTrial?: boolean
    sizeCode?: string | null
    quantity?: number
    productSnapshot?: schema.Order['productSnapshot']
    /**
     * What policy said about the order when it was placed (#526).
     *
     * Settable at creation because the column is written by `createPreparedOrder`,
     * not by this helper, and the surfaces that read it back — the approvals row,
     * the detail view — are tested against orders that were placed by a gate
     * rather than by a fixture.
     */
    policyWarning?: string | null
  },
) => {
  const [order] = await db
    .insert(schema.orders)
    .values({
      projectId,
      productId,
      environmentId,
      userId,
      status: (overrides?.status ?? 'pending') as schema.Order['status'],
      pipelineId: overrides?.pipelineId ?? [],
      ...(overrides?.pipelineStatus !== undefined ? { pipelineStatus: overrides.pipelineStatus } : {}),
      ...(overrides?.isTrial !== undefined ? { isTrial: overrides.isTrial } : {}),
      ...(overrides?.sizeCode !== undefined ? { sizeCode: overrides.sizeCode } : {}),
      ...(overrides?.quantity !== undefined ? { quantity: overrides.quantity } : {}),
      ...(overrides?.productSnapshot !== undefined ? { productSnapshot: overrides.productSnapshot } : {}),
      ...(overrides?.policyWarning !== undefined ? { policyWarning: overrides.policyWarning } : {}),
    })
    .returning()
  return order
}

/**
 * Give a product something to deploy with, in one environment.
 *
 * Needed by any fixture that expects an order to reach 'provisioning': since #206
 * a product with no webhook and no pipeline stack for the environment is refused
 * at order time rather than left in a provisioning state nothing can complete.
 */
export const createProductWebhook = async (
  productId: number,
  environmentId: number,
  overrides?: { name?: string; webhookUrl?: string; webhookToken?: string; execOrder?: number },
) => {
  const [hook] = await db
    .insert(schema.productWebhooks)
    .values({
      productId,
      environmentId,
      name: overrides?.name ?? 'Deploy',
      webhookUrl: overrides?.webhookUrl ?? 'https://gitlab.example.com/api/v4/projects/1/trigger/pipeline',
      webhookToken: overrides?.webhookToken ?? 'trigger-token',
      ...(overrides?.execOrder !== undefined ? { execOrder: overrides.execOrder } : {}),
    })
    .returning()
  return hook
}

export const createInfraElement = async (
  orderId: number,
  projectId: number,
  environmentId: number,
  productId: number,
  overrides?: {
    status?: string
    pipelineId?: string[]
    pipelineStatus?: Record<string, string>
    parameters?: Record<string, string>
    deployedAt?: Date
    sizeCode?: string | null
    sequence?: number
    /** Terraform outputs, as the webhook settler writes them. */
    outputs?: Record<string, string>
    /**
     * Left unset by default, which is what every element provisioned before
     * issue #183 has: the row then derives its Terraform state key from the raw
     * parameter value, the way its apply did.
     */
    stateKeyNamespace?: string | null
    /** `{ "<stackId>": "<stateKeyName>" }`, recorded at provisioning by #200. */
    stateKeys?: Record<string, string>
    /** What the last drift report said (#108), as the sweep writes it. */
    lastRefreshOutcome?: string
    /**
     * When that report reached this element.
     *
     * Settable because the metrics endpoint (#548) reads the timestamp and the
     * outcome as a pair, and a fixture that can set one but not the other can
     * only test the shape where the report is half-written.
     */
    lastRefreshedAt?: Date
    driftDetectedAt?: Date
    driftSummary?: schema.DriftSummary
    /** A stored policy verdict (#110 slice 6), as the sweep writes it. */
    policyCheckedAt?: Date
    policyOutcome?: string
    policyRule?: string | null
    policyMessage?: string | null
  },
) => {
  const [el] = await db
    .insert(schema.infrastructureElements)
    .values({
      orderId,
      projectId,
      environmentId,
      productId,
      status: (overrides?.status ?? 'active') as schema.InfrastructureElement['status'],
      pipelineId: overrides?.pipelineId ?? [],
      pipelineStatus: overrides?.pipelineStatus ?? {},
      ...(overrides?.sizeCode !== undefined ? { sizeCode: overrides.sizeCode } : {}),
      ...(overrides?.sequence !== undefined ? { sequence: overrides.sequence } : {}),
      ...(overrides?.stateKeyNamespace !== undefined ? { stateKeyNamespace: overrides.stateKeyNamespace } : {}),
      ...(overrides?.stateKeys ? { stateKeys: overrides.stateKeys } : {}),
      ...(overrides?.parameters ? { parameters: overrides.parameters } : {}),
      ...(overrides?.deployedAt ? { deployedAt: overrides.deployedAt } : {}),
      ...(overrides?.outputs ? { outputs: overrides.outputs } : {}),
      ...(overrides?.lastRefreshOutcome !== undefined
        ? { lastRefreshOutcome: overrides.lastRefreshOutcome as schema.InfrastructureElement['lastRefreshOutcome'] }
        : {}),
      ...(overrides?.lastRefreshedAt ? { lastRefreshedAt: overrides.lastRefreshedAt } : {}),
      ...(overrides?.driftDetectedAt ? { driftDetectedAt: overrides.driftDetectedAt } : {}),
      ...(overrides?.driftSummary ? { driftSummary: overrides.driftSummary } : {}),
      ...(overrides?.policyCheckedAt ? { policyCheckedAt: overrides.policyCheckedAt } : {}),
      ...(overrides?.policyOutcome !== undefined
        ? { policyOutcome: overrides.policyOutcome as schema.InfrastructureElement['policyOutcome'] }
        : {}),
      ...(overrides?.policyRule !== undefined ? { policyRule: overrides.policyRule } : {}),
      ...(overrides?.policyMessage !== undefined ? { policyMessage: overrides.policyMessage } : {}),
    })
    .returning()
  return el
}

/**
 * Seed an approval delegation directly (issue #35).
 *
 * Dates are offsets in DAYS from today so a fixture reads as "in force now" or
 * "already over" rather than as literal dates that would silently start failing
 * the moment they went past. Bypasses `createDelegation` on purpose: the service
 * refuses backdated and chained delegations, and a test for expiry needs exactly
 * those.
 */
export const createDelegation = async (
  fromUserId: number,
  toUserId: number,
  overrides?: { startsInDays?: number; endsInDays?: number; revokedAt?: Date },
) => {
  const day = (offset: number) => {
    const d = new Date()
    d.setUTCDate(d.getUTCDate() + offset)
    return d.toISOString().slice(0, 10)
  }
  const [row] = await db
    .insert(schema.approvalDelegations)
    .values({
      fromUserId,
      toUserId,
      startsOn: day(overrides?.startsInDays ?? 0),
      endsOn: day(overrides?.endsInDays ?? 0),
      ...(overrides?.revokedAt ? { revokedAt: overrides.revokedAt } : {}),
    })
    .returning()
  return row
}

/**
 * Give a user a confirmed TOTP factor and return the raw secret, so a test can
 * generate the codes an authenticator app would show.
 *
 * Deliberately goes through the same encryption helper the service uses rather
 * than writing a secret straight into the column: a test that set up a plaintext
 * secret would pass while the production path was broken.
 */
export const enrollTotp = async (
  userId: number,
  overrides?: { confirmed?: boolean; recoveryCodes?: string[] },
): Promise<Buffer> => {
  const secret = generateTotpSecret()
  const envelope = encryptTotpSecret(secret, userId)
  const confirmed = overrides?.confirmed ?? true

  await db
    .insert(schema.userTotp)
    .values(
      confirmed
        ? { userId, secret: envelope, confirmedAt: new Date() }
        : { userId, pendingSecret: envelope, pendingCreatedAt: new Date() },
    )
    .onConflictDoUpdate({
      target: schema.userTotp.userId,
      set: confirmed
        ? { secret: envelope, confirmedAt: new Date(), pendingSecret: null, pendingCreatedAt: null }
        : { pendingSecret: envelope, pendingCreatedAt: new Date() },
    })

  if (overrides?.recoveryCodes?.length) {
    await db.insert(schema.userRecoveryCodes).values(
      overrides.recoveryCodes.map((code) => ({
        userId,
        codeHash: createHash('sha256')
          .update(code.toUpperCase().replace(/[^A-Z0-9]/g, ''), 'utf8')
          .digest('hex'),
      })),
    )
  }

  return secret
}

/** The code an authenticator app would be showing right now for `secret`. */
export const currentTotpCode = (secret: Buffer, offsetSteps = 0): string =>
  totp(secret, Math.floor(Date.now() / 1000) + offsetSteps * 30)

interface SessionOverrides {
  ip?: string | null
  userAgent?: string | null
  rememberMe?: boolean
}

/**
 * A real session for this user: the row, the token, and the header.
 *
 * Since #37 a token without a live `sessions` row is refused by every
 * authenticated request, so every authenticated test now goes through here —
 * which is also what makes the suite an honest test of that check rather than a
 * test of the signature alone.
 */
export const makeSession = async (
  user: schema.User,
  overrides?: SessionOverrides,
): Promise<{ auth: string; token: string; sessionId: number; expiresAt: Date }> => {
  const created = await createSession({
    user: {
      id: user.id,
      email: user.email,
      name: user.name,
      role: user.role as Role,
    },
    ip: overrides?.ip ?? '203.0.113.7',
    userAgent: overrides?.userAgent ?? 'vitest',
    rememberMe: overrides?.rememberMe,
  })
  return { auth: `Bearer ${created.token}`, ...created }
}

/** Just the header, for the many tests that never look at the row. */
export const makeAuthHeader = async (
  user: schema.User,
  overrides?: SessionOverrides,
): Promise<string> => (await makeSession(user, overrides)).auth

let ccSeq = 0

export const createCostCenter = async (overrides?: { code?: string; name?: string; active?: boolean }) => {
  const [cc] = await db
    .insert(schema.costCenters)
    .values({
      code: overrides?.code ?? `CC-${++ccSeq}`,
      name: overrides?.name ?? 'Test Cost Center',
      active: overrides?.active ?? true,
    })
    .returning()
  return cc
}
