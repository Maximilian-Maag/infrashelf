import {
  pgTable,
  bigserial,
  bigint,
  text,
  integer,
  boolean,
  timestamp,
  numeric,
  jsonb,
  date,
  primaryKey,
  foreignKey,
  unique,
  customType,
  uniqueIndex,
  index,
  check,
} from 'drizzle-orm/pg-core'
import { sql } from 'drizzle-orm'
import type { StackStep } from '@infrashelf/types'
import type { ProductSnapshot } from '@/lib/services/snapshot'

const bytea = customType<{ data: Buffer }>({
  dataType() { return 'bytea' },
})

export const users = pgTable('users', {
  id: bigserial({ mode: 'number' }).primaryKey(),
  email: text().notNull().unique(),
  name: text().notNull(),
  role: text({ enum: ['admin', 'project_manager', 'root'] }).notNull(),
  active: boolean().notNull().default(true),
  ssoSub: text('sso_sub').unique(),
  passwordHash: text('password_hash'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
})

// Server-side session records (issue #37).
//
// Sessions used to be nothing but a signed JWT: no way to see them, and no way to
// end one short of rotating JWT_SECRET, which signs everybody out. A row per
// session makes both possible - the JWT carries this row's id as its `sid` claim
// and every authenticated request checks the row before it does anything else.
//
// The token itself is never stored, only its SHA-256. A leaked database dump must
// not hand out working session tokens, and the hash is enough for what the check
// needs: proving the presented token is the one this row was issued for.
export const sessions = pgTable('sessions', {
  id: bigserial({ mode: 'number' }).primaryKey(),
  userId: bigint('user_id', { mode: 'number' }).notNull().references(() => users.id, { onDelete: 'cascade' }),
  tokenHash: text('token_hash').notNull(),
  // Both nullable: without a trusted proxy there is no reliable client address
  // (see TRUST_PROXY in lib/auth/requestMeta.ts), and a scripted client sends no
  // User-Agent. NULL says "not recorded", which is honest; '-' would be a value
  // every reader then has to special-case anyway.
  ip: text('ip'),
  userAgent: text('user_agent'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  // Advanced at most once per SESSION_TOUCH_INTERVAL_MS, not on every request -
  // see lib/auth/sessions.ts. "Last active, to within five minutes" is what the
  // session list needs; a write per request is not.
  lastSeenAt: timestamp('last_seen_at', { withTimezone: true }).notNull().defaultNow(),
  // Mirrors the JWT's own `exp`. Duplicated deliberately: the list has to show a
  // lifetime without decoding a token it does not hold, and the request check
  // must reject an expired row even when the signature still verifies.
  expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
  // Set, never deleted: a revoked session is evidence, and the audit entry that
  // records the revocation points at a row that has to still be there.
  revokedAt: timestamp('revoked_at', { withTimezone: true }),
}, (t) => [
  // The session list: this user's live sessions, newest activity first. Partial
  // on `revoked_at IS NULL` because revoked rows are kept forever as evidence and
  // would otherwise grow the index without ever being read through it.
  //
  // `nullsFirst()` is not cosmetic: a bare `DESC` in SQL means NULLS FIRST, but
  // drizzle defaults a `.desc()` index column to NULLS LAST, which is a different
  // index from the one migration 0019 built. Both columns are NOT NULL so nothing
  // observable changes — but a snapshot that disagrees with the database is how
  // #141 started.
  index('sessions_user_live_idx')
    .on(t.userId, t.lastSeenAt.desc().nullsFirst())
    .where(sql`revoked_at IS NULL`),
])

// Second factor for a local password account (issue #36). One row per user, so
// the user id IS the primary key: a user has one authenticator, and expressing
// that in the key removes the "which of these two secrets is live" question
// entirely.
//
// Separate table rather than columns on `users`: every read of `users` goes
// through a column whitelist to keep the password hash out of responses, and
// adding four more secret-bearing columns to the table everything selects from
// is how one of them eventually leaks. Nothing joins this table into a user
// payload.
export const userTotp = pgTable('user_totp', {
  userId: bigint('user_id', { mode: 'number' }).primaryKey().references(() => users.id, { onDelete: 'cascade' }),
  // AES-256-GCM envelope, never the raw secret — see lib/auth/totpSecret.ts.
  // NULL until the first enrollment is confirmed.
  secret: text('secret'),
  // An enrollment in flight. Kept apart from `secret` so starting a
  // re-enrollment cannot break the working authenticator: until a code proves
  // the new secret actually reached an app, the old one keeps letting you in.
  pendingSecret: text('pending_secret'),
  pendingCreatedAt: timestamp('pending_created_at', { withTimezone: true }),
  // Set when a code from `secret` was first accepted. `secret IS NOT NULL AND
  // confirmed_at IS NOT NULL` is the one condition that means "2FA is on", and
  // there is deliberately no column that can turn it off — the issue requires
  // that 2FA cannot be disabled once set up, only re-enrolled.
  confirmedAt: timestamp('confirmed_at', { withTimezone: true }),
  // The RFC 6238 step of the last accepted code. Anything at or below it is
  // refused, which is what stops a code read over a shoulder (or off a phished
  // page) from being replayed for the remaining ~60 s of its window. In the
  // database rather than in memory because the guard has to hold across a
  // restart and across instances.
  lastUsedStep: bigint('last_used_step', { mode: 'number' }),
  // Consecutive failures and the resulting lock. Also persisted rather than
  // in-memory: a six-digit code is a 10^6 space, and an attacker who can restart
  // the process — or simply reach a second replica — would otherwise get an
  // unlimited guess loop.
  failedAttempts: integer('failed_attempts').notNull().default(0),
  lockedUntil: timestamp('locked_until', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
})

// One-time backup codes, issued as a set when 2FA is confirmed (issue #36).
//
// HASHED, not encrypted: unlike the TOTP secret, verification only ever needs to
// answer "did the user present this exact string", so there is no reason for the
// server to be able to read them back. `codeHash` is SHA-256 of the code — see
// lib/services/twoFactor.ts for why a password KDF is the wrong tool for a
// 128-bit random value.
export const userRecoveryCodes = pgTable('user_recovery_codes', {
  id: bigserial({ mode: 'number' }).primaryKey(),
  userId: bigint('user_id', { mode: 'number' }).notNull().references(() => users.id, { onDelete: 'cascade' }),
  codeHash: text('code_hash').notNull(),
  // Kept after use instead of deleted, so the audit trail can show that a
  // recovery code was spent and when. A used row can never match again.
  usedAt: timestamp('used_at', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  // A unique INDEX rather than a `unique()` constraint because that is what
  // migration 0018 creates. The two enforce the same rule but are different
  // objects to Postgres, and declaring the constraint here made `db:push` try to
  // ADD CONSTRAINT over an index of that name (#141).
  uniqueIndex('user_recovery_codes_user_id_code_hash_unique').on(t.userId, t.codeHash),
])

/**
 * A registered WebAuthn/FIDO2 credential — a hardware key or a passkey (#197).
 *
 * One row per credential, not per user: one key is a single point of failure, and
 * an account that holds only the key it just lost is the case recovery codes
 * exist for. Those stay in `userRecoveryCodes` and are shared across factor
 * types, because a recovery code answers "the factor is gone", whichever it was.
 *
 * Nothing here is secret. A WebAuthn registration leaves the private key on the
 * authenticator and hands the server only the public half, so a dump of this
 * table authenticates nobody — which is the sharpest difference from
 * `userTotp.secret`, where the server holds material that a code can be computed
 * from and has to encrypt it.
 */
export const webauthnCredentials = pgTable('webauthn_credentials', {
  id: bigserial({ mode: 'number' }).primaryKey(),
  userId: bigint('user_id', { mode: 'number' }).notNull().references(() => users.id, { onDelete: 'cascade' }),
  /** base64url, as the browser reports it. Unique across the table — see the migration. */
  credentialId: text('credential_id').notNull().unique(),
  /** The COSE public key, base64url. */
  publicKey: text('public_key').notNull(),
  /**
   * The authenticator's signature counter, allowed only to increase.
   *
   * A value that goes backwards means two authenticators are answering for one
   * credential, which is a clone. Many authenticators — every passkey — report a
   * constant 0 instead, so this detects a clone where it can and says nothing
   * where it cannot; see lib/services/webauthn.ts.
   */
  counter: bigint({ mode: 'number' }).notNull().default(0),
  /** `['usb','nfc',…]`, fed back so the browser prompts for the right thing. */
  transports: jsonb().notNull().default([]),
  /** What the user called it. They will have more than one. */
  label: text().notNull(),
  /** Synced to a provider (a passkey) rather than bound to one device. */
  backedUp: boolean('backed_up').notNull().default(false),
  deviceType: text('device_type').notNull().default('singleDevice'),
  /**
   * Whether the authenticator stored this as a DISCOVERABLE credential, and so
   * whether it can answer a passwordless ceremony (#241).
   *
   * Registration asks for `residentKey: 'preferred'` and the authenticator
   * decides: a passkey makes one, an older hardware key does not. Both are
   * perfectly good second factors; only a discoverable one can be offered with
   * no `allowCredentials`, because only it can produce the user handle without
   * being told who is signing in.
   *
   * Reported by the `credProps` extension at registration and recorded here,
   * because it cannot be derived from the credential afterwards. Credentials
   * registered before #241 default to false — they were never asked, so what
   * they are is unknown, and claiming otherwise would offer a button their key
   * silently fails to answer.
   */
  discoverable: boolean().notNull().default(false),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  lastUsedAt: timestamp('last_used_at', { withTimezone: true }),
}, (t) => [
  // Every read is "the credentials belonging to this user" — the login ceremony
  // and the settings list both start there.
  index('webauthn_credentials_user_idx').on(t.userId),
])

/**
 * The in-flight WebAuthn ceremony challenge (#197).
 *
 * In the database rather than in a signed token, unlike `lib/auth/mfaChallenge`,
 * for one reason: a WebAuthn challenge must be usable exactly once, and a
 * stateless token can be replayed for as long as it is valid. The row is created
 * when a ceremony starts and deleted when it finishes, so "used" and "gone" are
 * the same state.
 *
 * One row per user: starting a second ceremony replaces the first, which is the
 * behaviour worth having — two outstanding challenges for one account is not a
 * case anybody needs.
 */
export const webauthnChallenges = pgTable('webauthn_challenges', {
  userId: bigint('user_id', { mode: 'number' }).primaryKey().references(() => users.id, { onDelete: 'cascade' }),
  challenge: text().notNull(),
  /**
   * `'register'` or `'authenticate'`.
   *
   * They prove different things and must not be interchangeable: a registration
   * ceremony runs inside an already-authenticated session, so a registration
   * challenge redeemed as an authentication one would be a second factor proved
   * by a session that had not passed one.
   */
  kind: text().notNull(),
  expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
})

/**
 * A WebAuthn challenge issued to NOBODY (#241).
 *
 * `webauthn_challenges` above is keyed by `user_id`, because every ceremony
 * before passwordless ran either inside a session or after a password had named
 * the account. A passwordless ceremony has no user at the moment the challenge
 * is issued — the authenticator is what decides which account answers — so the
 * challenge itself is the key.
 *
 * Single-use comes from that primary key and the same DELETE ... RETURNING claim
 * the keyed table uses: the row is returned only to whoever won it, so two
 * requests racing on one challenge cannot both proceed.
 */
export const webauthnLoginChallenges = pgTable('webauthn_login_challenges', {
  challenge: text().primaryKey(),
  expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  // For sweeping what was never claimed; the DELETE is what makes it single-use.
  index('webauthn_login_challenges_expires_idx').on(t.expiresAt),
])

export const categories = pgTable('categories', {
  id: bigserial({ mode: 'number' }).primaryKey(),
  name: text().notNull(),
  displayOrder: integer('display_order').notNull().default(0),
  /**
   * When the category was retired, or null while it is live.
   *
   * The same rule as `products.retiredAt`, one level up: `products.category_id` is
   * ON DELETE CASCADE, so deleting a category deleted its products and cascaded
   * their orders away with them. A category holding an ordered product is retired
   * along with that product, so it survives as the `category_id` the retired rows
   * point at.
   */
  retiredAt: timestamp('retired_at', { withTimezone: true }),
}, (t) => [
  // The catalogue only ever shows live categories, and after #142 retired rows
  // accumulate rather than being deleted. Partial on `retired_at IS NULL` so the
  // filter every read applies is answered from the index.
  index('categories_live_idx').on(t.id).where(sql`retired_at IS NULL`),
])

export const products = pgTable('products', {
  id: bigserial({ mode: 'number' }).primaryKey(),
  categoryId: bigint('category_id', { mode: 'number' }).notNull().references(() => categories.id, { onDelete: 'cascade' }),
  baseLanguage: text('base_language').notNull().default('de'),
  /**
   * Who runs this product, as a shopper would name them — a team, usually, which
   * is why this is free text and not a reference to `users`. Null when nobody has
   * said; the product page then leaves the row out rather than guessing.
   */
  owner: text(),
  /** Link to the product's documentation. Validated as http(s) in the service. */
  docsUrl: text('docs_url'),
  /**
   * When the product was retired from the catalogue, or null while it is live.
   *
   * A product that has been ordered cannot be deleted: `orders.product_id` is ON
   * DELETE CASCADE, so the delete took the order history — and its
   * `product_snapshot` — with it (issue #142). Retiring keeps the row as the
   * referent its orders need; `deleteProduct` withdraws every environment offering
   * at the same time, and cart-add and order creation both require an offering, so
   * nothing can be ordered from a retired product. Products that were never
   * ordered are still deleted outright.
   */
  retiredAt: timestamp('retired_at', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  // The catalogue's category filter, which seq-scanned `products` (issue #159).
  // Migration 0032; declared here too, or `db:push` would drop it again.
  index('products_category_idx').on(t.categoryId),
  // Same rule as `categories_live_idx`: the catalogue reads live products only.
  // Migration 0024 (#141).
  index('products_live_idx').on(t.id).where(sql`retired_at IS NULL`),
])

/**
 * A product's pictures, in gallery order (issue #107).
 *
 * This replaced the single `image`/`image_mime`/`image_alt` triple on `products`;
 * migration 0021 moved the existing picture here as position 0 and dropped the
 * columns, so this table is the only place a product picture lives.
 */
export const productImages = pgTable('product_images', {
  id: bigserial({ mode: 'number' }).primaryKey(),
  productId: bigint('product_id', { mode: 'number' }).notNull().references(() => products.id, { onDelete: 'cascade' }),
  /** 0-based gallery order. Reads order by (position, id) — see 0021 for why it is not unique. */
  position: integer().notNull().default(0),
  data: bytea('data').notNull(),
  mime: text().notNull(),
  /**
   * What the picture shows, for the `alt` attribute (WCAG 1.1.1).
   *
   * NOT NULL because a row here only exists when there is an image (#105). The
   * service additionally rejects a blank or whitespace-only description, which the
   * column cannot express.
   */
  alt: text().notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  // Gallery order for one product — the order every read applies.
  index('product_images_product_position_idx').on(t.productId, t.position),
])

export const productTranslations = pgTable('product_translations', {
  productId: bigint('product_id', { mode: 'number' }).notNull().references(() => products.id, { onDelete: 'cascade' }),
  languageCode: text('language_code').notNull(),
  name: text().notNull(),
  /** The short one, shown on the catalogue tile and in search. */
  description: text().notNull().default(''),
  /**
   * The product story, shown only on the detail page (issue #107). Separate from
   * `description` because that one has to stay short enough for a card, which left
   * no room to explain what the thing actually is.
   */
  longDescription: text('long_description').notNull().default(''),
}, (t) => [primaryKey({ columns: [t.productId, t.languageCode] })])

/**
 * The narrowing fingerprint of a parameter that is narrowed to nothing (#404).
 *
 * sha256 of the empty string. Spelled out rather than computed, because it is a
 * column DEFAULT: the same literal has to appear in the migration, and a value
 * the two could disagree about is not a default worth having.
 */
export const EMPTY_NARROWING_KEY =
  'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855'

export const parameters = pgTable('parameters', {
  id: bigserial({ mode: 'number' }).primaryKey(),
  scope: text({ enum: ['global', 'category', 'product'] }).notNull(),
  scopeId: bigint('scope_id', { mode: 'number' }).notNull().default(0),
  environmentId: bigint('environment_id', { mode: 'number' }),
  name: text().notNull(),
  label: text().notNull().default(''),
  /**
   * How the ordering user supplies this variable — or, for `size`, how the
   * platform supplies it for them.
   *
   * `size` is a T-shirt size (#251-adjacent): the variable is not typed in at
   * all, its value is decided by which size the customer picked. `instance_type`
   * on an AWS VM is one of these; vSphere needs three (`num_cpus`, `memory_mb`,
   * `disk_size_gb`), which is exactly why the mapping belongs on the VARIABLE
   * rather than on the size — one size can drive as many variables as the
   * template needs.
   *
   * Combined with `environmentId` below, "different values in different
   * environments" costs nothing extra: `instance_type` for the AWS offering and
   * `instance_type` for the Linode one are two rows with two maps, and the
   * existing scope resolution already prefers the environment-specific one.
   */
  type: text({ enum: ['string', 'number', 'bool', 'dropdown', 'size'] }).notNull(),
  description: text().notNull().default(''),
  defaultValue: text('default_value').notNull().default(''),
  required: boolean().notNull().default(false),
  sensitive: boolean().notNull().default(false),
  /**
   * For a `size` parameter: what each size code means for this variable.
   *
   *     { "S": "t3.micro", "M": "t3.large", "XL": "m6i.2xlarge" }
   *
   * Keys are `product_environment_sizes.code` values. Empty for every other
   * type, and there is deliberately no foreign key: a size that is retired must
   * not silently drop the mapping that explains what an existing order was.
   *
   * A column rather than the comma-separated encoding `dropdown` uses in
   * `default_value`. That trick is already the reason `orders.ts` says of
   * dropdowns "no stored option list in the schema, so there is no allowed-value
   * constraint to enforce" — and this one decides what hardware gets
   * provisioned, next to the price charged for it. Not a place to keep guessing
   * at a string's shape.
   */
  sizeValues: jsonb('size_values').$type<Record<string, string>>().notNull().default({}),
  /**
   * Fingerprint of the projects this parameter is narrowed to (#404).
   *
   * sha256 of the ids sorted ascending, de-duplicated and joined with commas —
   * so `[7, 4]`, `[4, 7]` and `[4, 4, 7]` are one value, because the order the
   * ids arrive in is the order a form serialised them and nobody meant it. The
   * default is sha256 of the empty string: narrowed to nothing, which every row
   * is until `parameter_projects` says otherwise.
   *
   * It exists to make "one definition per name, per place, NARROWING INCLUDED"
   * expressible as a unique index. The set itself lives in `parameter_projects`,
   * and an index predicate cannot contain a subquery, so without a column on the
   * row the only enforcement available is the check-then-insert in
   * `services/admin/parameters.ts` — which races with itself (#477).
   *
   * Hashed rather than the list itself: a parameter narrowed to a few hundred
   * projects would put kilobytes into a btree tuple, and 2704 bytes is where
   * that stops working. Nothing reads it back for meaning; `parameter_projects`
   * is the truth, and this is derived from it.
   *
   * Maintained by the service, in the same transaction that writes the
   * narrowing, rather than by a trigger on `parameter_projects`. A trigger is
   * invisible to drizzle — neither created nor dropped by `db:push` — so a local
   * database built that way would silently not have it, which is the class of
   * divergence #141 is about.
   */
  narrowingKey: text('narrowing_key').notNull().default(EMPTY_NARROWING_KEY),
}, (t) => [
  // One definition per name, per place, narrowing included (#404).
  //
  // A pair, because `environment_id` is nullable and `NULL` is distinct from
  // every other `NULL` in a unique index — a single index over all five columns
  // would let any number of all-environments duplicates through. Same shape as
  // the `integrations` pair above, and for the same reason.
  //
  // This is what the application guard in `services/admin/parameters.ts` cannot
  // be: that one is a check-then-insert, and two simultaneous creates both pass
  // it. The guard stays, because it answers 409 naming the definition that is in
  // the way, which a constraint violation cannot do.
  uniqueIndex('parameters_definition_env_key')
    .on(t.scope, t.scopeId, t.name, t.environmentId, t.narrowingKey)
    .where(sql`environment_id IS NOT NULL`),
  uniqueIndex('parameters_definition_all_envs_key')
    .on(t.scope, t.scopeId, t.name, t.narrowingKey)
    .where(sql`environment_id IS NULL`),
])

/**
 * Which projects a parameter is narrowed to. No rows means every project.
 *
 * A join table rather than a `project_id` column, because the requirement is
 * "one or several projects" and a column can only ever say one (#275).
 *
 * Empty means unrestricted, which is what every parameter is today — so this
 * table starts empty and changes nothing until somebody uses it. That is also
 * why there is no "all projects" sentinel row: absence is the default, and a
 * sentinel would need writing for every existing parameter and would break the
 * moment one was missed.
 *
 * `onDelete: 'cascade'` both ways. A deleted parameter's narrowing is
 * meaningless, and a deleted project must not leave a parameter narrowed to a
 * project that no longer exists — which would silently make it apply nowhere,
 * the worst of the available failures.
 */
export const parameterProjects = pgTable(
  'parameter_projects',
  {
    parameterId: bigint('parameter_id', { mode: 'number' })
      .notNull()
      .references(() => parameters.id, { onDelete: 'cascade' }),
    projectId: bigint('project_id', { mode: 'number' })
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
  },
  (table) => [
    primaryKey({ columns: [table.parameterId, table.projectId] }),
    // The read is always "which parameters apply to THIS project", so the
    // project side needs its own index — the composite primary key can only
    // serve a lookup that leads with the parameter.
    index('parameter_projects_project_idx').on(table.projectId),
  ],
)

export const ciSources = pgTable('ci_sources', {
  id: bigserial({ mode: 'number' }).primaryKey(),
  name: text().notNull(),
  url: text().notNull(),
  accessToken: text('access_token').notNull(),
  provider: text({ enum: ['gitlab', 'github', 'bitbucket'] }).notNull().default('gitlab'),
})

/**
 * Every external system the registry below can hold.
 *
 * `opa` is #110's engine: the policy evaluation the portal calls at order time.
 * It is a registry row rather than a `POLICY_ENGINE_URL` env var for the reasons
 * #111 exists — one place for the credential, the per-environment binding, the
 * health and the failure semantics — and because a policy gate whose endpoint
 * cannot be named in the admin UI cannot be switched off in an emergency.
 */
export const INTEGRATION_KINDS = ['foreman', 'ansible', 'nexus', 'pulp', 'loki', 'grafana', 'opa'] as const

/** How the portal authenticates to an integration. */
export const INTEGRATION_AUTH_TYPES = ['none', 'bearer', 'basic', 'token_header'] as const

/** What a failed call to an integration means for the operation that made it. */
export const INTEGRATION_FAILURE_MODES = ['blocking', 'best_effort'] as const

/**
 * Registry of external systems the portal talks to that are NOT CI providers
 * (issue #111): Foreman (#112), Ansible/AWX (#113), Nexus and Pulp (#114),
 * Loki (#116) and Grafana (#117).
 *
 * DELIBERATELY BESIDE `ci_sources`, NOT THROUGH IT. None of the six is a CI
 * provider, so widening the `provider` enum would leave a column that no longer
 * means anything and six rows that half-fit. Migrating `ci_sources` onto this
 * table is a decision that was TAKEN AND DEFERRED, not overlooked: `ci_sources`
 * is referenced by `deployment_environments.ci_source_id`, read by the whole
 * `lib/ci` client layer and exposed by the CI-browser endpoints, so folding it
 * in is a migration with a blast radius, and it is out of scope for #111. What
 * this table does establish is the substrate that migration would land on —
 * encrypted credentials, health, failure semantics — so the eventual move is a
 * data migration rather than a redesign.
 */
export const integrations = pgTable('integrations', {
  id: bigserial({ mode: 'number' }).primaryKey(),
  kind: text({ enum: INTEGRATION_KINDS }).notNull(),
  /** Operator-facing label. Shown in errors, so it should say which instance. */
  name: text().notNull(),
  baseUrl: text('base_url').notNull(),
  authType: text('auth_type', { enum: INTEGRATION_AUTH_TYPES }).notNull().default('bearer'),
  /**
   * Username for `basic` auth. Plain text on purpose — it is not a secret, and
   * keeping it readable means the admin UI can show *which* account is
   * configured without a decrypt round trip.
   */
  username: text().notNull().default(''),
  /**
   * The token or password, AES-256-GCM encrypted (see lib/crypto/secrets.ts for
   * the envelope). Never selected by the list/get paths and never returned by
   * the API — the only reader is `resolveIntegration`, which hands it to the
   * probe or to a future client.
   *
   * Nullable so `auth_type = 'none'` (an unauthenticated Loki, a public Grafana
   * health endpoint) does not have to store an empty ciphertext. NOT so a row
   * can outlive a revoked credential, which is what this said before #195: an
   * integration that claims bearer auth with nothing to send is not a row in a
   * waiting state, it is a row that sends `Authorization: Bearer ` and blocks
   * whatever it gates. `integrations_credential_check` below forbids it.
   */
  credential: text(),
  /**
   * Which deployment environment this instance serves. NULL means portal-wide —
   * one Loki or one Grafana for the whole installation is the normal case, while
   * Foreman and Nexus are usually per-environment.
   *
   * CASCADE: an integration bound to a deleted environment has nothing left to
   * serve, and `deleteEnvironment` refuses on any non-cascading reference, so a
   * plain FK here would make environments undeletable once one was configured.
   */
  environmentId: bigint('environment_id', { mode: 'number' }).references(() => deploymentEnvironments.id, { onDelete: 'cascade' }),
  /**
   * Off without being deleted. A misbehaving integration has to be switchable
   * off in one field: deleting it loses the URL and the credential, and every
   * consumer would then have to treat "absent" and "deliberately disabled" as
   * the same thing — which is how a blocking integration silently becomes
   * best-effort.
   */
  enabled: boolean().notNull().default(true),
  /**
   * Whether a failed call to this integration blocks the operation that made it
   * (`blocking`) or is logged and carried on from (`best_effort`) — issue #111's
   * fifth bullet, in the data model rather than re-decided at each call site.
   *
   * The DB default is `best_effort` because that is the only safe answer for a
   * row written by a migration that cannot know the intent. The API does NOT
   * default it: create requires the field, so nobody gets best-effort by not
   * thinking about it, which is precisely how the trial and webhook paths ended
   * up swallowing failures invisibly.
   */
  failureMode: text('failure_mode', { enum: INTEGRATION_FAILURE_MODES }).notNull().default('best_effort'),
  /**
   * Last time a probe reached this system. Only ever set on SUCCESS: "when did
   * this last work" is the question an operator has, and overwriting it on a
   * failed attempt would answer a different one. NULL = never contacted.
   */
  lastContactedAt: timestamp('last_contacted_at', { withTimezone: true }),
  /**
   * Why the most recent probe failed, cleared on the next success. Kept
   * alongside `last_contacted_at` rather than replacing it so the pair reads as
   * "worked at T, broken since" — an integration that is silently unreachable is
   * worse than none.
   */
  lastError: text('last_error'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  // At most one integration of a kind per environment, and at most one
  // portal-wide one per kind. Two partial indexes rather than one
  // UNIQUE (kind, environment_id): Postgres treats NULLs as distinct, so the
  // plain constraint would happily accept five portal-wide Foremans and leave
  // "which Foreman does this environment reconcile against" (#112) unanswerable.
  //
  // The cost is real and deliberate: this forbids two Nexus instances in one
  // environment. That is the trade for `resolveIntegration(kind, envId)` having
  // exactly one answer instead of an arbitrary first row.
  uniqueIndex('integrations_kind_env_key')
    .on(t.kind, t.environmentId)
    .where(sql`environment_id IS NOT NULL`),
  uniqueIndex('integrations_kind_global_key')
    .on(t.kind)
    .where(sql`environment_id IS NULL`),
  // Every read is a resolve: "the <kind> for this environment, else the global
  // one, if enabled".
  index('integrations_kind_enabled_idx').on(t.kind, t.enabled),
  // `text({ enum: [...] })` is a TypeScript type and nothing more — it emits a
  // plain `text` column. Migration 0023 backs each of the three with a CHECK, so
  // a row written by something that is not this ORM still cannot hold a value the
  // readers do not handle. Declared here because `db:push` drops what schema.ts
  // does not (#141).
  check('integrations_kind_check', sql`kind IN ('foreman','ansible','nexus','pulp','loki','grafana','opa')`),
  check('integrations_auth_type_check', sql`auth_type IN ('none','bearer','basic','token_header')`),
  check('integrations_failure_mode_check', sql`failure_mode IN ('blocking','best_effort')`),
  /*
   * An integration that claims authentication must have something to send.
   *
   * `updateIntegration` checks this in TypeScript and returns 400, but it reads
   * the current row outside any transaction, so two concurrent updates walk
   * straight through it (#195, finding 9): A switches to `none` and nulls the
   * credential, B — holding a snapshot from before A — switches to `bearer` and
   * passes the check because the credential still existed when it looked. B's
   * SET carries `auth_type` and no `credential`, lands second, and leaves
   * exactly the state the service says cannot exist. `probe.ts` then sends
   * `Authorization: Bearer ` for ever, and a `failure_mode='blocking'`
   * integration blocks every operation it gates.
   *
   * A constraint cannot be raced: it is evaluated against the row as committed,
   * not against a snapshot someone read a moment ago. Which is why this is the
   * fix rather than a transaction with a row lock — the lock would work, but it
   * would have to be remembered at every future write site, and this does not.
   */
  check('integrations_credential_check', sql`auth_type = 'none' OR credential IS NOT NULL`),
])

export const deploymentEnvironments = pgTable('deployment_environments', {
  id: bigserial({ mode: 'number' }).primaryKey(),
  name: text().notNull(),
  description: text().notNull().default(''),
  ciSourceId: bigint('ci_source_id', { mode: 'number' }).notNull().references(() => ciSources.id),
  webhookUrl: text('webhook_url').notNull(),
  webhookToken: text('webhook_token').notNull(),
  // Portal-generated secret sent by GitLab as X-Gitlab-Token on the pipeline
  // event callback. Kept separate from webhook_token (the outbound trigger
  // token) so operators can rotate the two independently.
  //
  // UNIQUE: the secret is what identifies the calling environment on an inbound
  // callback (see the webhook routes). If two environments shared it the route
  // could only pick one arbitrarily and would mis-scope valid events — the
  // legacy 0004 backfill from webhook_token made that possible, so migration
  // 0006 rotates duplicates and enforces uniqueness.
  callbackSecret: text('callback_secret').notNull().unique(),
  // Whether deployment windows bind this environment (#330). Default FALSE, and
  // that is the load-bearing part: switching windows on globally at upgrade
  // would stop every sandbox deploy after 18:00 for a deployment that never
  // asked for them. Production opts in; dev and test carry on.
  respectsDeploymentWindows: boolean('respects_deployment_windows').notNull().default(false),
})

export const productEnvironments = pgTable('product_environments', {
  productId: bigint('product_id', { mode: 'number' }).notNull().references(() => products.id, { onDelete: 'cascade' }),
  environmentId: bigint('environment_id', { mode: 'number' }).notNull().references(() => deploymentEnvironments.id),
  price: numeric({ precision: 12, scale: 2 }).notNull().default('0'),
  currency: text().notNull().default('EUR'),
  costCenterMode: text('cost_center_mode', { enum: ['project', 'select', 'overhead'] }).notNull().default('project'),
  forcedCostCenter: boolean('forced_cost_center').notNull().default(false),
  // The fixed shared cost centre used by `overhead` mode (FA-10.4). Without it
  // `overhead` had no cost centre to point at and fell through to the same
  // behaviour as `select` — the user picked, which is the opposite of a fixed
  // overhead account. Nullable because the other two modes never use it, and
  // because an offering may be switched to `overhead` before one is chosen.
  overheadCostCenterId: bigint('overhead_cost_center_id', { mode: 'number' }).references(() => costCenters.id, { onDelete: 'set null' }),
  // Time-boxed trial of this offering (issue #1). Opt-in per offering rather than
  // catalogue-wide: a trial provisions real infrastructure with elevated rights
  // inside it, which is not something every product should hand out.
  trialEnabled: boolean('trial_enabled').notNull().default(false),
  // Configurable so a heavier app can get longer than the 30 minutes the issue
  // names; 30 is the default, not a constant.
  trialDurationMinutes: integer('trial_duration_minutes').notNull().default(30),
}, (t) => [primaryKey({ columns: [t.productId, t.environmentId] })])

// The sizes an offering is available in — "an XL server in Linode" (issue #98).
//
// A table rather than more columns on `product_environments`: the number of sizes
// is a per-offering editorial decision (XS…2XL for one product, one size for the
// next), and columns cannot express that without either a fixed ceiling or a
// column per size. Price lives HERE, on the size, because that is what the
// customer actually chooses and pays for.
//
// `product_environments.price` is NOT dropped: an offering with no size rows keeps
// using it, which is what every row that existed before this table did. See
// `resolveOfferingPrice` for the one place that decides between the two.
export const productEnvironmentSizes = pgTable('product_environment_sizes', {
  id: bigserial({ mode: 'number' }).primaryKey(),
  productId: bigint('product_id', { mode: 'number' }).notNull(),
  environmentId: bigint('environment_id', { mode: 'number' }).notNull(),
  // What the pipeline receives as SIZE and what an order line stores. Short and
  // stable ('XL'), unlike the label, which is prose an admin may rewrite.
  code: text().notNull(),
  label: text().notNull().default(''),
  price: numeric({ precision: 12, scale: 2 }).notNull().default('0'),
  currency: text().notNull().default('EUR'),
  sortOrder: integer('sort_order').notNull().default(0),
  // Retired rather than deleted: a size that has been ordered is referenced by
  // existing orders, and withdrawing it must not make those orders unreadable.
  active: boolean().notNull().default(true),
}, (t) => [
  // Composite FK to the offering, not two separate ones to products and
  // environments: a size for a (product, environment) pair that is not offered at
  // all is not a thing, and the cascade removes the sizes with the offering.
  foreignKey({
    columns: [t.productId, t.environmentId],
    foreignColumns: [productEnvironments.productId, productEnvironments.environmentId],
  }).onDelete('cascade'),
  // The code is what an order line stores, so two rows sharing one within an
  // offering would make a stored line ambiguous.
  unique('product_environment_sizes_offering_code_unique').on(t.productId, t.environmentId, t.code),
  // The size picker reads one offering's sizes in display order.
  index('product_environment_sizes_offering_idx').on(t.productId, t.environmentId, t.sortOrder),
])

export const productWebhooks = pgTable('product_webhooks', {
  id: bigserial({ mode: 'number' }).primaryKey(),
  productId: bigint('product_id', { mode: 'number' }).notNull().references(() => products.id, { onDelete: 'cascade' }),
  environmentId: bigint('environment_id', { mode: 'number' }).notNull().references(() => deploymentEnvironments.id),
  name: text().notNull(),
  webhookUrl: text('webhook_url').notNull(),
  webhookToken: text('webhook_token').notNull(),
  execOrder: integer('exec_order').notNull().default(0),
})

export const pipelineStacks = pgTable('pipeline_stacks', {
  id: bigserial({ mode: 'number' }).primaryKey(),
  productId: bigint('product_id', { mode: 'number' }).notNull().references(() => products.id, { onDelete: 'cascade' }),
  environmentId: bigint('environment_id', { mode: 'number' }).notNull().references(() => deploymentEnvironments.id, { onDelete: 'cascade' }),
  name: text().notNull(),
  stateKeyParam: text('state_key_param').notNull().default('hostname'),
  steps: jsonb().$type<StackStep[]>().notNull().default([]),
})

// Per-user product bookmarks. Composite primary key rather than a surrogate id:
// a user can favourite a product once, and the uniqueness that expresses is the
// same thing the lookup needs — no separate index, no way to store a duplicate.
export const productFavorites = pgTable('product_favorites', {
  userId: bigint('user_id', { mode: 'number' }).notNull().references(() => users.id, { onDelete: 'cascade' }),
  productId: bigint('product_id', { mode: 'number' }).notNull().references(() => products.id, { onDelete: 'cascade' }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => [primaryKey({ columns: [t.userId, t.productId] })])

// Timeline of catalogue changes to a product (issue #38). One row per change that
// affects what a customer would be offered, so the history explains what an
// existing order's snapshot differs FROM.
export const productVersions = pgTable('product_versions', {
  id: bigserial({ mode: 'number' }).primaryKey(),
  productId: bigint('product_id', { mode: 'number' }).notNull().references(() => products.id, { onDelete: 'cascade' }),
  // Which offering the snapshot describes. Null for a change to the product itself
  // (name, description, category) which is not specific to one environment.
  environmentId: bigint('environment_id', { mode: 'number' }).references(() => deploymentEnvironments.id, { onDelete: 'set null' }),
  // Optional free text from whoever made the change. The issue calls it optional;
  // an empty string is the "no note" case rather than a null, so readers do not
  // have to handle both.
  changelog: text().notNull().default(''),
  /** What changed, so the row is meaningful without diffing. */
  summary: text().notNull().default(''),
  snapshot: jsonb().$type<ProductSnapshot>(),
  // No ON DELETE on the author: a version entry that loses its attribution stops
  // being a history.
  createdBy: bigint('created_by', { mode: 'number' }).references(() => users.id),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  // The history panel: one product's versions, newest first.
  index('product_versions_product_idx').on(t.productId, t.createdAt.desc().nullsFirst()),
])

export const costCenters = pgTable('cost_centers', {
  id: bigserial({ mode: 'number' }).primaryKey(),
  code: text().notNull().unique(),
  name: text().notNull(),
  active: boolean().notNull().default(true),
  /**
   * The budget, or nothing at all (#325).
   *
   * Four nullable columns rather than a table of their own: a cost centre has
   * at most one budget, and `budget_amount IS NULL` is what "no budget" looks
   * like — a row untouched by #325 behaves exactly as it did before it.
   *
   * A database CHECK keeps them all-or-nothing. An amount with no behaviour
   * leaves the enforcement path guessing, and that is the kind of
   * half-configured row that turns into "why did that order go through".
   */
  budgetAmount: numeric('budget_amount', { precision: 12, scale: 2 }),
  budgetCurrency: text('budget_currency'),
  /** 'total' is a pot that never resets; 'monthly' resets each calendar month. */
  budgetPeriod: text('budget_period', { enum: ['total', 'monthly'] }),
  /** 'warn' lets the order through and says so; 'block' refuses it. */
  budgetBehaviour: text('budget_behaviour', { enum: ['warn', 'block'] }),
}, (t) => [
  // All four together or none of them. A budget with no amount is not a budget,
  // and an amount with no behaviour leaves the enforcement path guessing.
  check(
    'cost_centers_budget_complete',
    sql`(${t.budgetAmount} IS NULL AND ${t.budgetCurrency} IS NULL AND ${t.budgetPeriod} IS NULL AND ${t.budgetBehaviour} IS NULL) OR (${t.budgetAmount} IS NOT NULL AND ${t.budgetCurrency} IS NOT NULL AND ${t.budgetPeriod} IS NOT NULL AND ${t.budgetBehaviour} IS NOT NULL)`,
  ),
  // The TypeScript enums above are compile-time only; these are what hold for a
  // row written by anything other than this codebase.
  check('cost_centers_budget_period', sql`${t.budgetPeriod} IS NULL OR ${t.budgetPeriod} IN ('total','monthly')`),
  check('cost_centers_budget_behaviour', sql`${t.budgetBehaviour} IS NULL OR ${t.budgetBehaviour} IN ('warn','block')`),
  // A negative pot would refuse everything for a reason nobody chose; zero is
  // how new spend is stopped deliberately, so zero is allowed and negative is not.
  check('cost_centers_budget_amount_positive', sql`${t.budgetAmount} IS NULL OR ${t.budgetAmount} >= 0`),
])

export const projects = pgTable('projects', {
  id: bigserial({ mode: 'number' }).primaryKey(),
  name: text().notNull(),
  description: text().notNull().default(''),
  ownerId: bigint('owner_id', { mode: 'number' }).notNull().references(() => users.id),
  costCenterId: bigint('cost_center_id', { mode: 'number' }).references(() => costCenters.id),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  /**
   * When the project was retired, or null while it is live.
   *
   * The same rule as `products.retiredAt` and `categories.retiredAt`, and this is
   * the one that needed it most: `orders.project_id` is ON DELETE CASCADE, so
   * deleting a project deleted every order placed inside it — and with them
   * `orders.product_snapshot`, the column that exists precisely so a later
   * catalogue change cannot rewrite what a customer was charged. Proved on a real
   * Postgres: one project delete took orders, order_comments and
   * infrastructure_elements to zero (issue #187).
   *
   * A project that holds orders is retired instead. One that never held any has
   * no history to keep and is still deleted outright, so the table does not fill
   * with tombstones.
   */
  retiredAt: timestamp('retired_at', { withTimezone: true }),
}, (t) => [
  // Every read filters on this, and after #187 retired rows accumulate rather
  // than being deleted. Partial, so the filter is answered from the index.
  index('projects_live_idx').on(t.id).where(sql`retired_at IS NULL`),
])

export const orders = pgTable('orders', {
  id: bigserial({ mode: 'number' }).primaryKey(),
  projectId: bigint('project_id', { mode: 'number' }).notNull().references(() => projects.id, { onDelete: 'cascade' }),
  productId: bigint('product_id', { mode: 'number' }).notNull().references(() => products.id, { onDelete: 'cascade' }),
  environmentId: bigint('environment_id', { mode: 'number' }).notNull().references(() => deploymentEnvironments.id),
  userId: bigint('user_id', { mode: 'number' }).notNull().references(() => users.id),
  /*
   * 'scheduled' sits between approval and provisioning (#330): an admin has
   * decided, but the environment respects deployment windows and none is open.
   * A lifecycle state, not a property — which is why it belongs here and drift
   * did not (see `lastRefreshOutcome`).
   */
  status: text({ enum: ['pending', 'scheduled', 'provisioning', 'completed', 'failed', 'rejected'] }).notNull().default('pending'),
  /** When the window that will release it opens. NULL unless it is waiting. */
  scheduledFor: timestamp('scheduled_for', { withTimezone: true }),
  /** Root deployed it before its window. Who, and when — both or neither. */
  windowOverrideBy: bigint('window_override_by', { mode: 'number' }).references(() => users.id),
  windowOverrideAt: timestamp('window_override_at', { withTimezone: true }),
  parameters: jsonb().$type<Record<string, string>>().notNull().default({}),
  costCenterId: bigint('cost_center_id', { mode: 'number' }).references(() => costCenters.id),
  // Ordered as a time-boxed trial (issue #1). Recorded on the ORDER rather than
  // only acted on at creation time: a project manager's order is provisioned at
  // approval, which is where the trial clock has to start and where the trial
  // variables have to be passed to CI.
  isTrial: boolean('is_trial').notNull().default(false),
  // The chosen size (issue #98) as a `product_environment_sizes.code`, and how
  // many infrastructure elements the order asks for (issue #104).
  //
  // NULL size means "this offering has no sizes", which is every order placed
  // before they existed and every offering that never defined any — those read
  // their price from `product_environments`. Deliberately a code and not a foreign
  // key: an admin may retire a size, and an order must stay readable when they do.
  // The price that actually applied is in the snapshot, not looked up again.
  sizeCode: text('size_code'),
  // One order, N infrastructure elements. Default 1, which is exactly what every
  // order placed before quantity existed asked for.
  quantity: integer().notNull().default(1),
  // What the customer was actually offered when the order was placed (issue #38).
  // Orders reference the product by id, so without this a later price change or a
  // removed parameter silently rewrites history and the order detail page shows
  // today's configuration as the one that was approved. Nullable: orders placed
  // before this existed have no snapshot, and inventing one would be a lie.
  productSnapshot: jsonb('product_snapshot').$type<ProductSnapshot>(),
  rejectionNote: text('rejection_note'),
  pipelineId: jsonb('pipeline_id').$type<string[]>().notNull().default([]),
  // Per-pipeline terminal status keyed by pipeline id, e.g.
  // { "pipe-a": "success", "pipe-b": "failed" }. Lets a multi-pipeline order
  // wait for ALL its pipelines to succeed before completing (and fail fast if
  // any one fails/cancels) instead of completing on the first success event.
  pipelineStatus: jsonb('pipeline_status').$type<Record<string, string>>().notNull().default({}),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  // Issue #159. Each of these is a filter plus the sort that follows it, in one
  // index, so the planner never has to sort the matched rows separately.
  // Migration 0032; declared here too, or `db:push` would drop them again.
  //
  // `nullsFirst()` on every `.desc()` because that is what the migration's bare
  // SQL `DESC` means, while drizzle defaults a descending index column to NULLS
  // LAST. It matters most on `infrastructure_elements.deployed_at`, which is
  // nullable — there the two are genuinely different indexes (#141).
  //
  // A project manager's own order list.
  index('orders_user_created_at_idx').on(t.userId, t.createdAt.desc().nullsFirst()),
  // The approval queue: pending orders, oldest first, which is the order they
  // are worked in. Also the dashboard's pending count.
  index('orders_status_created_at_idx').on(t.status, t.createdAt),
  // The cost report's project + date-range filter.
  index('orders_project_created_at_idx').on(t.projectId, t.createdAt.desc().nullsFirst()),
  /*
   * The sweep asks one question every time it runs: which scheduled orders are
   * due? Partial, because 'scheduled' is a handful of rows out of every order
   * ever placed — and migration 0040, declared here too for the reason the
   * indexes above give.
   */
  index('orders_scheduled_for_idx').on(t.scheduledFor).where(sql`${t.status} = 'scheduled'`),
  /*
   * Only a scheduled order has a time to be released at, and only a released one
   * has an overrider. A row carrying either without the other is a bug that
   * surfaces as an order the sweep picks up for ever — see 0040. It is
   * load-bearing in the tests too: a `pending` order with a `scheduled_for`
   * cannot be constructed at all, which is the point.
   */
  check(
    'orders_scheduled_consistency',
    sql`(${t.scheduledFor} IS NULL OR ${t.status} IN ('scheduled', 'provisioning', 'completed', 'failed'))
        AND (${t.windowOverrideBy} IS NULL) = (${t.windowOverrideAt} IS NULL)`,
  ),
])

// Items a user has collected but not yet ordered (issue #28).
//
// Not an order in a 'draft' state: a cart item has no project, no validated
// parameters and no cost centre, so putting it in `orders` would mean every query
// over orders had to exclude drafts, and a draft would appear in approval queues
// and audit exports the moment someone forgot a WHERE clause.
export const cartItems = pgTable('cart_items', {
  id: bigserial({ mode: 'number' }).primaryKey(),
  userId: bigint('user_id', { mode: 'number' }).notNull().references(() => users.id, { onDelete: 'cascade' }),
  productId: bigint('product_id', { mode: 'number' }).notNull().references(() => products.id, { onDelete: 'cascade' }),
  environmentId: bigint('environment_id', { mode: 'number' }).notNull().references(() => deploymentEnvironments.id, { onDelete: 'cascade' }),
  // Whatever the user had typed when they added the item. Deliberately NOT
  // validated on the way in — a cart is a shopping list, and refusing to hold an
  // incomplete item would defeat the point of collecting first and filling in at
  // checkout. Validation happens at checkout, against the same rules a single
  // order goes through.
  parameters: jsonb().$type<Record<string, string>>().notNull().default({}),
  // A cart line is product × environment × size × quantity (issues #98/#104).
  // NULL size = the offering has none; the line then prices off the offering.
  sizeCode: text('size_code'),
  quantity: integer().notNull().default(1),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  // The cart is always read whole, for one user, in the order things were added.
  index('cart_items_user_idx').on(t.userId, t.createdAt),
])

// Free-text discussion on an order (issue #34). The rejection note already proved
// a note can be stored per order; this generalises it into a thread.
export const orderComments = pgTable('order_comments', {
  id: bigserial({ mode: 'number' }).primaryKey(),
  orderId: bigint('order_id', { mode: 'number' }).notNull().references(() => orders.id, { onDelete: 'cascade' }),
  // No ON DELETE: a comment must not lose its author. Deactivating a user is how
  // they are retired, and the audit trail depends on attribution surviving.
  userId: bigint('user_id', { mode: 'number' }).notNull().references(() => users.id),
  body: text().notNull(),
  // Visible to admin/root only. The orderer must never see one, so every read
  // path filters on this rather than relying on the UI to hide it.
  internal: boolean().notNull().default(false),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  // Distinct from createdAt so an edited comment can be shown as edited rather
  // than silently rewritten under a reader who already replied to it.
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  // The thread on one order, oldest first.
  index('order_comments_order_idx').on(t.orderId, t.createdAt),
])

export const infrastructureElements = pgTable('infrastructure_elements', {
  id: bigserial({ mode: 'number' }).primaryKey(),
  orderId: bigint('order_id', { mode: 'number' }).notNull().references(() => orders.id),
  projectId: bigint('project_id', { mode: 'number' }).notNull().references(() => projects.id, { onDelete: 'cascade' }),
  environmentId: bigint('environment_id', { mode: 'number' }).notNull().references(() => deploymentEnvironments.id),
  productId: bigint('product_id', { mode: 'number' }).notNull().references(() => products.id, { onDelete: 'cascade' }),
  status: text({ enum: ['active', 'decommissioning', 'decommissioned'] }).notNull().default('active'),
  // Copied from the order rather than joined: the element IS the thing that has a
  // size, and a teardown or retry needs it without reaching for the order.
  sizeCode: text('size_code'),
  // Which of the order's N elements this is, 1-based (issue #104). It is what
  // makes the Terraform state key of element 3 differ from element 1's — see
  // `elementStateSuffix` — so it must be stable for the life of the element:
  // provisioning, retry and teardown all derive the same key from it. Legacy rows
  // are 1, which reproduces the state name they were provisioned with exactly.
  sequence: integer().notNull().default(1),
  // What namespaces this element's Terraform state key, so the value a customer
  // types into the stack's `stateKeyParam` cannot name another order's state
  // (issue #183). The server-generated order id, as a string, written once at
  // provisioning and never recomputed. NULL means the element was provisioned
  // before #183: its state exists under the raw parameter value, so its teardown
  // and its retries have to keep deriving the key that way.
  stateKeyNamespace: text('state_key_namespace'),
  /**
   * The Terraform state key this element was actually provisioned under, per
   * pipeline stack: `{ "<stackId>": "web-01-o42" }`.
   *
   * RECORDED, not recomputed (#200). The key used to be derived afresh at every
   * trigger from `variables[stack.stateKeyParam]` and the stack row as it is
   * NOW — so an admin editing `stateKeyParam` moved the key of every element
   * already running under it. Their destroy then addressed a state that was
   * never created, reported success, and left the infrastructure up with the
   * portal showing it torn down. Refusing that edit while elements live narrowed
   * it; a rule that freezes an input is weaker than a recorded result, because
   * it has to hold at every path that could change the input.
   *
   * Written before the trigger fires, not after it succeeds: a trigger whose
   * HTTP call fails may still have started the pipeline, and a key that was not
   * recorded is a state with no teardown.
   *
   * An EMPTY map means the element predates this column, and every path falls
   * back to deriving as before — the only way their teardown keeps pointing at
   * the state their own apply created.
   *
   * A stack absent from a non-empty map was added after this element was
   * provisioned, so nothing applied it here and its destroy is skipped rather
   * than fired at a state that never existed.
   */
  stateKeys: jsonb('state_keys').$type<Record<string, string>>().notNull().default({}),
  parameters: jsonb().$type<Record<string, string>>().notNull().default({}),
  pipelineId: jsonb('pipeline_id').$type<string[]>().notNull().default([]),
  // Per-pipeline terminal status for the current decommission run, keyed by
  // pipeline id (mirrors orders.pipeline_status). A teardown may fan out to
  // several pipelines (product webhooks + pipeline stacks); the element only
  // becomes 'decommissioned' once EVERY id in pipeline_id succeeded.
  pipelineStatus: jsonb('pipeline_status').$type<Record<string, string>>().notNull().default({}),
  outputs: jsonb().$type<Record<string, string>>().notNull().default({}),
  /*
   * What the scheduled drift report last said about this element (#108).
   *
   * All nullable, and that is the point: NULL means "never heard", which is a
   * different thing from "checked and clean". An element whose reports stopped
   * arriving must not read as healthy — that is the same confusion #108 opens
   * with, where `active` means "we once started a pipeline for this".
   *
   * There is no outbound pipeline tracking here because the portal does not
   * trigger the refresh. A single scheduled pipeline POSTs what it found.
   */
  lastRefreshedAt: timestamp('last_refreshed_at', { withTimezone: true }),
  lastRefreshOutcome: text('last_refresh_outcome', { enum: ['clean', 'drifted', 'locked', 'error'] }),
  /** Set when drift is found and CLEARED when a later report is clean, so it describes current drift. */
  driftDetectedAt: timestamp('drift_detected_at', { withTimezone: true }),
  driftSummary: jsonb('drift_summary').$type<DriftSummary>(),
  /**
   * Why the LAST attempt to read the Terraform outputs did not produce any (#215).
   *
   * NULL means the last attempt worked, or none has been made yet. Cleared on
   * every successful read, so a fixed token and a re-run leave no stale complaint
   * behind.
   *
   * NOT "why `outputs` is empty": a failed read deliberately leaves `outputs`
   * alone rather than erasing what an earlier one found, so this column being set
   * while `outputs` holds values is the ordinary shape for "these are from
   * before; the latest attempt failed".
   *
   * Written for an operator to read on the element page. The log line keeps the
   * detail that does not belong there — the pipeline id, the underlying error.
   */
  outputsError: text('outputs_error'),
  deployedAt: timestamp('deployed_at', { withTimezone: true }).defaultNow(),
  // When set, the element is torn down automatically at or after this instant
  // (issue #30). Temporary environments — test, demo, PoC — are otherwise
  // forgotten and keep accruing cost. NULL means "no schedule", which is the
  // only way to express "never": a sentinel far-future date would eventually
  // arrive.
  scheduledDecommissionAt: timestamp('scheduled_decommission_at', { withTimezone: true }),
}, (t) => [
  // Issue #159. Single-column on purpose: the infrastructure list combines
  // project, product, environment and status filters freely and sorts by any of
  // four columns, so no one composite serves it — separate indexes let the
  // planner bitmap-AND whichever filters were actually supplied.
  // Migration 0032; declared here too, or `db:push` would drop them again.
  index('infrastructure_elements_project_idx').on(t.projectId),
  index('infrastructure_elements_order_idx').on(t.orderId),
  index('infrastructure_elements_deployed_at_idx').on(t.deployedAt.desc().nullsFirst()),
  // Migration 0010's partial index, which #159 left to this branch (#141). The
  // sweep in `lib/services/decommission.ts` asks, on every tick, for the active
  // elements whose schedule has come due. Partial on exactly that predicate so
  // the answer is a bounded scan rather than a full table scan — almost every row
  // is either unscheduled or already decommissioned.
  index('infrastructure_elements_due_decommission_idx')
    .on(t.scheduledDecommissionAt)
    .where(sql`scheduled_decommission_at IS NOT NULL AND status = 'active'`),
])

export const exchangeRates = pgTable('exchange_rates', {
  currencyCode: text('currency_code').primaryKey(),
  rate: numeric({ precision: 18, scale: 6 }).notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
})

export const auditLog = pgTable('audit_log', {
  id: bigserial({ mode: 'number' }).primaryKey(),
  userId: bigint('user_id', { mode: 'number' }).references(() => users.id),
  action: text().notNull(),
  entityId: bigint('entity_id', { mode: 'number' }),
  details: text().notNull().default(''),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  // The one table guaranteed to grow forever — a row per order action, and
  // nothing ever deletes one — and it had no index at all (issue #159). Every
  // read is "newest first, one page at a time", plus a COUNT(*) over the same
  // predicate, so without these the audit page sorted the whole table twice per
  // request. Migration 0032; declared here too, or `db:push` would drop them.
  index('audit_log_created_at_idx').on(t.createdAt.desc().nullsFirst()),
  index('audit_log_user_created_at_idx').on(t.userId, t.createdAt.desc().nullsFirst()),
])

/**
 * An admin's approval authority, held by a substitute for a period (issue #35).
 *
 * What is delegated is AUTHORITY, not identity: the substitute approves as
 * themselves and every decision they take while a delegation is in force is
 * audited with the delegation that was in force. Nothing here lets one user act
 * under another's name.
 *
 * Expiry is a date comparison at read time (`starts_on <= today <= ends_on`,
 * both inclusive) — there is deliberately no job to run and no `active` column
 * to fall out of sync with the calendar.
 */
export const approvalDelegations = pgTable('approval_delegations', {
  id: bigserial({ mode: 'number' }).primaryKey(),
  fromUserId: bigint('from_user_id', { mode: 'number' }).notNull().references(() => users.id),
  toUserId: bigint('to_user_id', { mode: 'number' }).notNull().references(() => users.id),
  // `date` in mode 'string' so a period stays the calendar days the admin typed
  // instead of being shifted by the server's timezone on the way in and out.
  startsOn: date('starts_on', { mode: 'string' }).notNull(),
  endsOn: date('ends_on', { mode: 'string' }).notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  // Cancelled early. Kept rather than deleted so the audit entries that name this
  // delegation keep resolving.
  revokedAt: timestamp('revoked_at', { withTimezone: true }),
}, (t) => [
  // Both directions are looked up on every approval: "who did this admin hand
  // authority to" and "whose authority am I holding today", each bounded by the
  // period.
  index('approval_delegations_from_idx').on(t.fromUserId, t.startsOn, t.endsOn),
  index('approval_delegations_to_idx').on(t.toUserId, t.startsOn, t.endsOn),
  // Migration 0022's two CHECKs. A delegation that ends before it starts is never
  // in force, and one to yourself delegates nothing — neither is a state any
  // reader handles, and neither can be expressed in a column type.
  check('approval_delegations_period_check', sql`ends_on >= starts_on`),
  check('approval_delegations_not_self_check', sql`from_user_id <> to_user_id`),
])

export const branding = pgTable('branding', {
  id: integer().primaryKey().default(1),
  logoData: bytea('logo_data'),
  logoMime: text('logo_mime'),
  primaryColor: text('primary_color').notNull().default('#131921'),
  secondaryColor: text('secondary_color').notNull().default('#febd69'),
  shopName: text('shop_name').notNull().default('InfraShelf'),
  shopSubtitle: text('shop_subtitle').notNull().default(''),
  imprintText: text('imprint_text').notNull().default(''),
})

/**
 * When provisioning may run (#330).
 *
 * `startMinute` is minutes past local midnight in the zone
 * `app_config.deploymentTimeZone` names — 08:00 is 480. A number rather than a
 * `time` on purpose: it is arithmetic, not an instant, and a `time` column
 * invites a reader to think it carries a zone when the whole difficulty is that
 * it does not.
 */
export const deploymentWindows = pgTable('deployment_windows', {
  id: bigserial({ mode: 'number' }).primaryKey(),
  startMinute: integer('start_minute').notNull(),
  durationMinutes: integer('duration_minutes').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  // `validateWindows` says the same thing in TypeScript, and says it better —
  // it can also refuse an overlap, which one row cannot see. This is here for
  // what TypeScript cannot promise: a row written by a migration, a fixture or
  // a hand at psql is still a window that fits inside one day.
  check('deployment_windows_within_day', sql`${t.startMinute} >= 0 AND ${t.startMinute} <= 1439 AND ${t.durationMinutes} > 0 AND ${t.startMinute} + ${t.durationMinutes} <= 1440`),
])

/**
 * Non-working days, cached from the configured feed.
 *
 * Cached rather than fetched when an order is decided: whether a deployment may
 * run must not depend on a third party answering. `source` is what makes a
 * refresh safe — 'feed' rows are replaced wholesale, 'manual' rows survive it,
 * so a company shutdown no public feed knows about and a public holiday the
 * company works through are both expressible.
 */
export const holidays = pgTable('holidays', {
  /** A local date in the deployment zone, not an instant. */
  date: date().primaryKey(),
  name: text().notNull(),
  source: text({ enum: ['feed', 'manual'] }).notNull().default('feed'),
  observed: boolean().notNull().default(true),
}, (t) => [
  // The Drizzle `enum` is a TypeScript type, not a database one; a refresh that
  // wrote any other word would be accepted and then never matched again.
  check('holidays_source', sql`${t.source} IN ('feed', 'manual')`),
])

/** What the holiday feed last did, so the admin UI can say how old the answer is. */
export const holidayFeedState = pgTable('holiday_feed_state', {
  id: integer().primaryKey().default(1),
  url: text(),
  lastSuccessAt: timestamp('last_success_at', { withTimezone: true }),
  lastError: text('last_error'),
  lastErrorAt: timestamp('last_error_at', { withTimezone: true }),
}, (t) => [
  // One feed, so one row. Same shape as `branding` and `app_config`.
  check('holiday_feed_state_singleton', sql`${t.id} = 1`),
])

/** One drifted resource, as the reporting pipeline saw it. */
export interface DriftedResource {
  /** Terraform address, e.g. `module.vm.linode_instance.this`. */
  address: string
  /** `update`, `delete`, `create` — what a plan would do to reconcile it. */
  action: string
}

export interface DriftSummary {
  resources: DriftedResource[]
}

/**
 * Terraform states in the backend that no element claims (#108).
 *
 * NOT #109. That is about resources created outside Terraform altogether, which
 * no state file mentions and which finding would need the modules to tag —
 * `infra-templates` currently filters ORDER_ID and INFRA_ID out of the TF_VAR
 * export, so nothing provisioned today carries either.
 *
 * This is the narrower case that IS detectable: a state file the reporting
 * pipeline can see and the portal cannot account for — an element deleted from
 * the portal while its infrastructure stayed up, or a stack renamed.
 */
export const unclaimedStates = pgTable('unclaimed_states', {
  stateKey: text('state_key').primaryKey(),
  firstSeenAt: timestamp('first_seen_at', { withTimezone: true }).notNull().defaultNow(),
  lastSeenAt: timestamp('last_seen_at', { withTimezone: true }).notNull().defaultNow(),
  outcome: text({ enum: ['clean', 'drifted', 'locked', 'error'] }),
  summary: jsonb().$type<DriftSummary>(),
})

/**
 * When the portal last heard from the reporting pipeline at all.
 *
 * Per-element timestamps cannot answer this: if the pipeline stops, every
 * element simply stops being updated and nothing says why. One row.
 */
export const driftReportState = pgTable('drift_report_state', {
  id: integer().primaryKey().default(1),
  lastReportAt: timestamp('last_report_at', { withTimezone: true }),
  elementsReported: integer('elements_reported').notNull().default(0),
  unclaimedReported: integer('unclaimed_reported').notNull().default(0),
}, (t) => [
  check('drift_report_state_singleton', sql`${t.id} = 1`),
])

export const appConfig = pgTable('app_config', {
  id: integer().primaryKey().default(1),
  smtpHost: text('smtp_host'),
  smtpPort: integer('smtp_port'),
  smtpFrom: text('smtp_from'),
  smtpUser: text('smtp_user'),
  smtpPass: text('smtp_pass'),
  smtpTls: boolean('smtp_tls').default(true),
  aiProvider: text('ai_provider'),
  aiEndpoint: text('ai_endpoint'),
  aiApiKey: text('ai_api_key'),
  aiModel: text('ai_model'),
  // The zone `deployment_windows.start_minute` is read in. UTC until an
  // operator says otherwise — a window means nothing without a zone, and no
  // other default is defensible.
  deploymentTimeZone: text('deployment_time_zone').notNull().default('UTC'),
})

export type User = typeof users.$inferSelect
export type NewUser = typeof users.$inferInsert
export type Session = typeof sessions.$inferSelect
export type NewSession = typeof sessions.$inferInsert
export type UserTotp = typeof userTotp.$inferSelect
export type UserRecoveryCode = typeof userRecoveryCodes.$inferSelect
export type Category = typeof categories.$inferSelect
export type Product = typeof products.$inferSelect
export type ProductTranslation = typeof productTranslations.$inferSelect
export type ProductImageRow = typeof productImages.$inferSelect
export type Parameter = typeof parameters.$inferSelect
export type CiSource = typeof ciSources.$inferSelect
export type Integration = typeof integrations.$inferSelect
export type NewIntegration = typeof integrations.$inferInsert
export type IntegrationKind = (typeof INTEGRATION_KINDS)[number]
export type IntegrationAuthType = (typeof INTEGRATION_AUTH_TYPES)[number]
export type IntegrationFailureMode = (typeof INTEGRATION_FAILURE_MODES)[number]
export type DeploymentEnvironment = typeof deploymentEnvironments.$inferSelect
export type ProductEnvironment = typeof productEnvironments.$inferSelect
export type ProductEnvironmentSize = typeof productEnvironmentSizes.$inferSelect
export type ProductWebhook = typeof productWebhooks.$inferSelect
export type PipelineStack = typeof pipelineStacks.$inferSelect
export type ProductFavorite = typeof productFavorites.$inferSelect
export type ProductVersion = typeof productVersions.$inferSelect
export type CostCenter = typeof costCenters.$inferSelect
export type Project = typeof projects.$inferSelect
export type Order = typeof orders.$inferSelect
export type CartItem = typeof cartItems.$inferSelect
export type OrderComment = typeof orderComments.$inferSelect
export type InfrastructureElement = typeof infrastructureElements.$inferSelect
export type ExchangeRate = typeof exchangeRates.$inferSelect
export type AuditEntry = typeof auditLog.$inferSelect
export type ApprovalDelegation = typeof approvalDelegations.$inferSelect
export type Branding = typeof branding.$inferSelect
export type AppConfig = typeof appConfig.$inferSelect
