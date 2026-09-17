import { db } from '@/lib/db/client'
import {
  integrations,
  type IntegrationAuthType,
  type IntegrationFailureMode,
  type IntegrationKind,
} from '@/lib/db/schema'
import { and, eq, isNull, sql } from 'drizzle-orm'
import { ok, err, type Result } from '@/lib/services/result'
import { logAudit } from '@/lib/audit'
import {
  encryptSecret,
  decryptSecret,
  isSecretEncryptionConfigured,
  secretEncryptionUnavailableReason,
  SECRET_KEY_ENV,
} from '@/lib/crypto/secrets'
import { probeIntegration as probe, type ProbeResult } from '@/lib/integrations/probe'
// A unique violation here is "one integration of a kind per environment"; a
// CHECK violation is `integrations_credential_check`, the rule
// `updateIntegration` also states in TypeScript and which two interleaved edits
// can still reach (#195, finding 9). Both answer with the reason rather than a
// bare 500, which an operator has no way to read.
import {
  pgErrorCode,
  UNIQUE_VIOLATION,
  FK_VIOLATION,
  CHECK_VIOLATION,
} from '@/lib/db/pgError'

/**
 * The registry of external systems that are not CI providers (issue #111):
 * Foreman (#112), Ansible (#113), Nexus and Pulp (#114), Loki (#116),
 * Grafana (#117).
 *
 * Three things here are the reason the issue exists rather than each of those
 * five discovering them separately:
 *
 * 1. The credential is encrypted at rest and NEVER leaves this module. There is
 *    no reveal endpoint and no `credential` field in any response shape; the one
 *    reader is `resolveIntegration`, which is for server-side consumers.
 * 2. `failureMode` is stored, not decided at the call site. Use
 *    `blocksProvisioning` rather than re-deciding.
 * 3. Every mutation is audited, and a credential change is audited a second time
 *    as a rotation — an operator asking "when was this token last changed" should
 *    not have to infer it from an `integration.updated` entry.
 */

/**
 * What the API returns. `credential` is absent by construction rather than
 * deleted on the way out: the column projection below never selects it, so no
 * future response shape can leak it by spreading the row.
 */
export interface IntegrationPublic {
  id: number
  kind: IntegrationKind
  name: string
  baseUrl: string
  authType: IntegrationAuthType
  username: string
  /** Whether a credential is stored, without saying anything about its value. */
  hasCredential: boolean
  environmentId: number | null
  enabled: boolean
  failureMode: IntegrationFailureMode
  lastContactedAt: Date | null
  lastError: string | null
  createdAt: Date | null
  updatedAt: Date | null
}

export interface CreateIntegrationInput {
  kind: IntegrationKind
  name: string
  baseUrl: string
  authType: IntegrationAuthType
  username?: string
  credential?: string
  environmentId?: number | null
  enabled?: boolean
  /** Required, not defaulted — see the schema comment on the column. */
  failureMode: IntegrationFailureMode
}

export interface UpdateIntegrationInput {
  name?: string
  baseUrl?: string
  authType?: IntegrationAuthType
  username?: string
  /** Present means rotate. Absent means leave alone — there is no way to say
   *  "set to empty", because a blank credential is what `authType: 'none'` is
   *  for and an accidental empty string would silently break every call. */
  credential?: string
  environmentId?: number | null
  enabled?: boolean
  failureMode?: IntegrationFailureMode
}

/**
 * Everything except the credential. `sql` for the boolean rather than selecting
 * the column and mapping in JS: the ciphertext should not travel out of Postgres
 * at all on a read path, so there is nothing in memory to accidentally log.
 */
const publicColumns = {
  id: integrations.id,
  kind: integrations.kind,
  name: integrations.name,
  baseUrl: integrations.baseUrl,
  authType: integrations.authType,
  username: integrations.username,
  hasCredential: sql<boolean>`(${integrations.credential} IS NOT NULL)`.as('has_credential'),
  environmentId: integrations.environmentId,
  enabled: integrations.enabled,
  failureMode: integrations.failureMode,
  lastContactedAt: integrations.lastContactedAt,
  lastError: integrations.lastError,
  createdAt: integrations.createdAt,
  updatedAt: integrations.updatedAt,
}

/**
 * Does a failed call to this integration abort the operation that made it?
 *
 * The point of #111's fifth bullet: one predicate over a stored column, so no
 * call site gets to decide. A DISABLED integration is never blocking — an
 * operator switching one off is saying "carry on without it", and the opposite
 * reading would let one toggle stop all provisioning.
 */
export const blocksProvisioning = (integration: {
  enabled: boolean
  failureMode: IntegrationFailureMode
}): boolean => integration.enabled && integration.failureMode === 'blocking'

/**
 * Refuse a credential-carrying operation when there is nowhere safe to put the
 * credential.
 *
 * 503 rather than 500: the request was fine, the server is not configured. And
 * refusing is the whole point — the alternative an unconfigured deployment would
 * otherwise drift into is storing the token in plain text, which is the state
 * `ci_sources.access_token` is in and the state #111 exists to leave.
 */
const requireEncryption = (): Result<void> => {
  if (isSecretEncryptionConfigured()) return ok(undefined)
  return err(
    503,
    `Cannot store an integration credential: ${secretEncryptionUnavailableReason()} ` +
      `Until ${SECRET_KEY_ENV} is configured, only integrations with authType "none" ` +
      `can be created or edited.`,
  )
}

/**
 * A base URL with any userinfo taken out.
 *
 * `https://svc:hunter2@nexus.internal` is a URL an operator can paste into the
 * form and a password the audit log must not keep: NFA-04.3 makes that table
 * append-only, so anything written there can never be redacted (#195,
 * finding 10).
 *
 * A string that does not parse is not passed through on the chance that it is
 * harmless — the only reason to be looking at it is that it might not be.
 */
const withoutUserinfo = (baseUrl: string): string => {
  try {
    const url = new URL(baseUrl)
    if (!url.username && !url.password) return baseUrl
    url.username = ''
    url.password = ''
    return `${url.toString()} (credentials in the URL, not recorded)`
  } catch {
    return '(unparseable URL, not recorded)'
  }
}

/** Human-readable target for an audit entry, so the log survives a deletion. */
const auditLabel = (row: {
  kind: string
  name: string
  baseUrl: string
  environmentId: number | null
}): string =>
  `${row.kind} "${row.name}" at ${withoutUserinfo(row.baseUrl)}` +
  (row.environmentId === null ? ' (portal-wide)' : ` (environment #${row.environmentId})`)

export const listIntegrations = async (): Promise<Result<IntegrationPublic[]>> => {
  const rows = await db
    .select(publicColumns)
    .from(integrations)
    .orderBy(integrations.kind, integrations.name)

  return ok(rows as IntegrationPublic[])
}

export const getIntegrationById = async (id: number): Promise<Result<IntegrationPublic>> => {
  const rows = await db.select(publicColumns).from(integrations).where(eq(integrations.id, id)).limit(1)
  if (!rows.length) return err(404, 'Not found')
  return ok(rows[0] as IntegrationPublic)
}

const conflictMessage = (kind: string, environmentId: number | null): string =>
  environmentId === null
    ? `A portal-wide ${kind} integration already exists. Bind this one to an environment, or edit the existing one.`
    : `A ${kind} integration is already bound to environment #${environmentId}.`

export const createIntegration = async (
  actorUserId: number,
  input: CreateIntegrationInput,
): Promise<Result<IntegrationPublic>> => {
  const authType = input.authType
  const wantsCredential = authType !== 'none'

  if (wantsCredential) {
    if (!input.credential) {
      return err(400, `A credential is required for authType "${authType}".`)
    }
    const available = requireEncryption()
    if (!available.ok) return available
  }
  if (authType === 'basic' && !input.username) {
    return err(400, 'A username is required for authType "basic".')
  }

  const environmentId = input.environmentId ?? null

  let created: IntegrationPublic
  try {
    const [row] = await db
      .insert(integrations)
      .values({
        kind: input.kind,
        name: input.name,
        baseUrl: input.baseUrl,
        authType,
        username: input.username ?? '',
        // Encrypted here rather than in a DB trigger or a drizzle custom type:
        // the key lives in the process, not in Postgres, which is the only
        // arrangement where a database dump is not also a credential dump.
        //
        // A credential sent alongside authType 'none' is DROPPED rather than
        // rejected: a form that keeps the field populated when the operator
        // switches the auth dropdown would otherwise 400 on a request that is
        // unambiguous. Storing it would be the real mistake — an encrypted
        // secret nothing ever sends.
        credential: wantsCredential && input.credential ? encryptSecret(input.credential) : null,
        environmentId,
        enabled: input.enabled ?? true,
        failureMode: input.failureMode,
      })
      .returning(publicColumns)
    created = row as IntegrationPublic
  } catch (e) {
    const code = pgErrorCode(e)
    if (code === UNIQUE_VIOLATION) return err(409, conflictMessage(input.kind, environmentId))
    if (code === FK_VIOLATION) return err(400, `Environment #${environmentId} does not exist.`)
    throw e
  }

  await logAudit(
    actorUserId,
    'integration.created',
    created.id,
    `Created integration ${auditLabel(created)}, ${created.failureMode}` +
      (created.hasCredential ? ', with a credential' : ', without a credential'),
  )

  return ok(created)
}

export const updateIntegration = async (
  actorUserId: number,
  id: number,
  input: UpdateIntegrationInput,
): Promise<Result<IntegrationPublic>> => {
  const before = await getIntegrationById(id)
  if (!before.ok) return before

  // The effective auth type after this update, which is what the invariants have
  // to hold against — not the one that happens to be stored now.
  const authType = input.authType ?? before.data.authType
  const username = input.username ?? before.data.username

  // An empty string is not a rotation. The route schema already rejects it
  // (`min(1)`), but a direct caller passing '' would otherwise satisfy the
  // "will have a credential" check below while storing nothing — leaving an
  // integration that claims bearer auth and sends an empty token.
  //
  // Neither is a credential sent alongside authType 'none', which is dropped
  // below exactly as createIntegration drops it. Counting it as a rotation made
  // the write claim things it never did: a `credential_rotated` audit entry for
  // a column that stayed null, a cleared health record, and a 503 when no
  // encryption key is configured despite there being nothing to encrypt.
  const nextCredential =
    authType !== 'none' && input.credential !== undefined && input.credential !== ''
      ? input.credential
      : null
  const rotating = nextCredential !== null
  if (rotating) {
    const available = requireEncryption()
    if (!available.ok) return available
  }
  const willHaveCredential = rotating || before.data.hasCredential

  if (authType !== 'none' && !willHaveCredential) {
    return err(400, `A credential is required for authType "${authType}".`)
  }
  if (authType === 'basic' && !username) {
    return err(400, 'A username is required for authType "basic".')
  }

  const environmentId =
    input.environmentId === undefined ? before.data.environmentId : input.environmentId

  let updated: IntegrationPublic
  try {
    const [row] = await db
      .update(integrations)
      .set({
        ...(input.name !== undefined ? { name: input.name } : {}),
        ...(input.baseUrl !== undefined ? { baseUrl: input.baseUrl } : {}),
        ...(input.authType !== undefined ? { authType: input.authType } : {}),
        ...(input.username !== undefined ? { username: input.username } : {}),
        // Switching to `none` drops the stored credential instead of leaving it
        // behind: keeping a token nobody sends is a secret held for no reason.
        ...(authType === 'none'
          ? { credential: null }
          : nextCredential !== null
            ? { credential: encryptSecret(nextCredential) }
            : {}),
        ...(input.environmentId !== undefined ? { environmentId: input.environmentId } : {}),
        ...(input.enabled !== undefined ? { enabled: input.enabled } : {}),
        ...(input.failureMode !== undefined ? { failureMode: input.failureMode } : {}),
        // A changed URL or credential invalidates the health record: the stored
        // "last contacted" belongs to the OLD target, and leaving it would show a
        // green integration that has never been reached at its new address.
        ...(input.baseUrl !== undefined || rotating
          ? { lastContactedAt: null, lastError: null }
          : {}),
        updatedAt: new Date(),
      })
      .where(eq(integrations.id, id))
      .returning(publicColumns)
    if (!row) return err(404, 'Not found')
    updated = row as IntegrationPublic
  } catch (e) {
    const code = pgErrorCode(e)
    if (code === UNIQUE_VIOLATION) return err(409, conflictMessage(before.data.kind, environmentId))
    if (code === FK_VIOLATION) return err(400, `Environment #${environmentId} does not exist.`)
    if (code === CHECK_VIOLATION) {
      return err(409, 'The credential was removed while this edit was in flight. Re-open the integration and set one.')
    }
    throw e
  }

  await logAudit(
    actorUserId,
    'integration.updated',
    id,
    `Updated integration ${auditLabel(updated)}: ${describeChanges(before.data, updated)}`,
  )

  // A second entry on purpose. "When was this token last changed" is a question
  // an auditor asks directly, and answering it by grepping update entries for a
  // field that is deliberately not in the diff does not work.
  if (rotating) {
    await logAudit(
      actorUserId,
      'integration.credential_rotated',
      id,
      `Credential rotated for integration ${auditLabel(updated)}`,
    )
  }

  return ok(updated)
}

/**
 * Which fields changed, for the audit entry. Names, never values.
 *
 * This used to write `username "old" → "new"`, on the reasoning that the
 * credential is not in either snapshot so nothing secret could appear. Two of
 * the seven fields make that wrong (#195, finding 10): `username` is half of a
 * stored basic-auth credential, and `baseUrl` may carry userinfo — an operator
 * pasting `https://svc:hunter2@nexus.internal` puts a password in a table
 * NFA-04.3 makes append-only, where it can never be redacted.
 *
 * Diffing values here and names everywhere else was also the only exception in
 * the admin surface, so nobody reading one entry could tell which convention
 * they were looking at.
 */
const describeChanges = (before: IntegrationPublic, after: IntegrationPublic): string => {
  const fields = ['name', 'baseUrl', 'authType', 'username', 'environmentId', 'enabled', 'failureMode'] as const
  const changed = fields.filter((f) => before[f] !== after[f])
  return changed.length > 0 ? `Changed: ${changed.join(', ')}` : 'No fields changed'
}

export const deleteIntegration = async (
  actorUserId: number,
  id: number,
): Promise<Result<void>> => {
  // Read first so the audit entry can say WHAT was deleted. A trail of
  // "deleted integration #7" is not a trail.
  const existing = await getIntegrationById(id)
  if (!existing.ok) return existing

  const deleted = await db
    .delete(integrations)
    .where(eq(integrations.id, id))
    .returning({ id: integrations.id })

  if (!deleted.length) return err(404, 'Not found')

  await logAudit(
    actorUserId,
    'integration.deleted',
    id,
    `Deleted integration ${auditLabel(existing.data)}`,
  )

  return ok(undefined)
}

export interface ProbeOutcome {
  ok: boolean
  status: number | null
  detail?: string
  error?: string
  /** The refreshed health fields, so a caller does not have to re-read the row. */
  lastContactedAt: Date | null
  lastError: string | null
}

/**
 * Contact one integration and record the result.
 *
 * Returns `ok(...)` even when the probe FAILED: the operation the admin asked for
 * — find out whether this works — succeeded, and the answer is in the payload.
 * Returning an `err` would make a reachable-but-broken Foreman
 * indistinguishable from a bad request at the HTTP layer, and the frontend would
 * have to parse the message to tell them apart.
 */
export const probeIntegrationById = async (
  actorUserId: number,
  id: number,
): Promise<Result<ProbeOutcome>> => {
  const rows = await db
    .select({
      kind: integrations.kind,
      // Selected for the audit entry, not for the probe: an entry naming only an
      // id is useless once the integration is deleted.
      name: integrations.name,
      environmentId: integrations.environmentId,
      baseUrl: integrations.baseUrl,
      authType: integrations.authType,
      username: integrations.username,
      credential: integrations.credential,
      enabled: integrations.enabled,
    })
    .from(integrations)
    .where(eq(integrations.id, id))
    .limit(1)

  if (!rows.length) return err(404, 'Not found')
  const row = rows[0]

  if (!row.enabled) {
    return err(409, 'Integration is disabled. Enable it before probing.')
  }

  /*
   * Audited like every other mutation in this file, which is what it is: root
   * only, it writes `last_contacted_at`/`last_error`, and it spends a decrypted
   * credential on a call to a system outside this one. It was the only unaudited
   * one (#195, finding 10), so "who made this portal talk to Nexus, and when"
   * had no answer.
   *
   * The outcome is in the entry because a probe that fails is the interesting
   * one. The text is the probe's own — a status line or a connection error,
   * never anything decrypted.
   */
  const auditProbe = (outcome: string) =>
    logAudit(actorUserId, 'integration.probed', id, `Probed integration ${auditLabel(row)}: ${outcome}`)

  let credential: string | null = null
  if (row.credential !== null) {
    try {
      credential = decryptSecret(row.credential)
    } catch (e) {
      // A wrong or rotated SECRET_ENCRYPTION_KEY lands here. Recorded on the row
      // as well as returned, because the operator's next move is to look at the
      // integration list and this is the only place that would explain it.
      //
      // The health fields come back from recordProbe rather than being written
      // out here: an earlier successful contact must survive this failure, and
      // hard-coding `lastContactedAt: null` would have reported "never reached"
      // in the response while the row still said otherwise.
      const message = `Stored credential could not be decrypted: ${e instanceof Error ? e.message : String(e)}`
      const health = await recordProbe(id, { ok: false, status: null, error: message })
      await auditProbe('not attempted — the stored credential could not be decrypted')
      return ok({ ok: false, status: null, error: message, ...health })
    }
  }

  const result = await probe({
    kind: row.kind,
    baseUrl: row.baseUrl,
    authType: row.authType,
    username: row.username,
    credential,
  })

  const health = await recordProbe(id, result)
  await auditProbe(
    result.ok ? `reachable (${result.status ?? 'no status'})` : `unreachable — ${result.error}`,
  )

  return ok({ ...result, ...health })
}

/**
 * Write the probe outcome to the row.
 *
 * `last_contacted_at` is touched only on success and `last_error` only cleared
 * on success, so the pair keeps reading as "worked at T, broken since" instead of
 * collapsing into "last attempted".
 *
 * `updated_at` is deliberately NOT bumped: it means "when was this integration's
 * configuration last changed", and a health poller running every minute would
 * turn it into a duplicate of `last_contacted_at` and destroy the only record of
 * when somebody last touched the settings.
 */
const recordProbe = async (
  id: number,
  result: ProbeResult,
): Promise<{ lastContactedAt: Date | null; lastError: string | null }> => {
  const [row] = await db
    .update(integrations)
    .set(
      result.ok
        ? { lastContactedAt: new Date(), lastError: null }
        : { lastError: result.error ?? 'Unknown error' },
    )
    .where(eq(integrations.id, id))
    .returning({
      lastContactedAt: integrations.lastContactedAt,
      lastError: integrations.lastError,
    })

  return row ?? { lastContactedAt: null, lastError: null }
}

/** An integration with its credential decrypted, for a server-side consumer. */
export interface ResolvedIntegration {
  id: number
  kind: IntegrationKind
  name: string
  baseUrl: string
  authType: IntegrationAuthType
  username: string
  credential: string | null
  failureMode: IntegrationFailureMode
  /** True when a failed call to it must abort the caller's operation. */
  blocking: boolean
}

/**
 * Find the integration of `kind` that serves `environmentId`, with its
 * credential decrypted — the entry point every one of #112–#117 uses.
 *
 * Resolution order is environment-specific first, then portal-wide. That
 * fallback is why the two partial unique indexes exist: with a plain
 * UNIQUE (kind, environment_id) this would have to pick one of several
 * portal-wide rows arbitrarily, and "which Foreman are we reconciling against"
 * would be answered differently on different requests.
 *
 * Returns null when there is none, when it is disabled, or when its credential
 * cannot be decrypted. All three mean the same thing to a caller: not usable
 * right now.
 *
 * A KNOWN LIMIT of #111's fifth bullet, worth stating rather than discovering:
 * `null` carries no failure mode, because the failure mode is stored on the row.
 * So a consumer still decides for itself what an ABSENT integration means — and
 * should, since "Foreman was never configured" is a different situation from
 * "Foreman is down". What the column removes is the far more common case: a
 * configured integration whose failure semantics were being guessed at each call
 * site. Once resolution succeeds, `blocking` is the answer, not a judgement call.
 */
export const resolveIntegration = async (
  kind: IntegrationKind,
  environmentId: number | null,
): Promise<ResolvedIntegration | null> => {
  const rows = await db
    .select({
      id: integrations.id,
      kind: integrations.kind,
      name: integrations.name,
      baseUrl: integrations.baseUrl,
      authType: integrations.authType,
      username: integrations.username,
      credential: integrations.credential,
      failureMode: integrations.failureMode,
      environmentId: integrations.environmentId,
      enabled: integrations.enabled,
    })
    .from(integrations)
    .where(
      and(
        eq(integrations.kind, kind),
        eq(integrations.enabled, true),
        environmentId === null
          ? isNull(integrations.environmentId)
          : sql`(${integrations.environmentId} = ${environmentId} OR ${integrations.environmentId} IS NULL)`,
      ),
    )
    // NULLS LAST puts the environment-specific row first, so the fallback is a
    // property of the query rather than of the loop that reads it.
    .orderBy(sql`${integrations.environmentId} ASC NULLS LAST`)
    .limit(1)

  const row = rows[0]
  if (!row) return null

  let credential: string | null = null
  if (row.credential !== null) {
    try {
      credential = decryptSecret(row.credential)
    } catch {
      // Deliberately not thrown: a consumer asking "is Foreman available" gets
      // "no", and the reason is already recorded on the row by a probe (and is
      // the same reason for every integration at once — a wrong key). Throwing
      // here would turn an undecryptable credential into a 500 in whatever
      // request happened to touch it.
      return null
    }
  }

  return {
    id: row.id,
    kind: row.kind,
    name: row.name,
    baseUrl: row.baseUrl,
    authType: row.authType,
    username: row.username,
    credential,
    failureMode: row.failureMode,
    blocking: blocksProvisioning(row),
  }
}
