import { db } from '@/lib/db/client'
import { ciSources, deploymentEnvironments } from '@/lib/db/schema'
import { eq } from 'drizzle-orm'
import { listProjects, listBranches, listFiles, getFileContent } from '@/lib/ci'
import { parseTerraformVariables } from '@/lib/tfparser'
import { ok, err, type Result } from '@/lib/services/result'
import {
  encryptSecret,
  isSecretEncryptionConfigured,
  secretEncryptionUnavailableReason,
} from '@/lib/crypto/secrets'
import { readAccessToken } from '@/lib/ci/token'
export { readAccessToken } from '@/lib/ci/token'
import { logAudit, logAuditWith, changedFields } from '@/lib/audit'
import { isEmptyUpdate, EMPTY_UPDATE_MESSAGE } from '@/lib/services/updates'
import type { CiProject, CiBranch, CiFile } from '@infrashelf/types'

export interface CiSourcePublic {
  id: number
  name: string
  url: string
  provider: string
}

export interface CreateCiSourceInput {
  name: string
  url: string
  accessToken: string
  provider: 'gitlab' | 'github' | 'bitbucket'
}

export interface UpdateCiSourceInput {
  name?: string
  url?: string
  accessToken?: string
  provider?: 'gitlab' | 'github' | 'bitbucket'
}

/**
 * Refuse to write a token when there is nowhere safe to put it.
 *
 * The same rule `createIntegration` applies, and for the reason the crypto
 * module states: storing plaintext "just for now" is the state #111 exists to
 * get out of, and afterwards it is indistinguishable from a correctly encrypted
 * column.
 *
 * READS are deliberately not gated on this. An existing deployment with no key
 * keeps working with the plaintext tokens it already has; only writing a new one
 * is refused, and the message tells the operator exactly what to set.
 */
const refuseUnlessEncryptable = (): Result<never> | null =>
  isSecretEncryptionConfigured()
    ? null
    : err(
        503,
        `Cannot store a CI source access token: ${secretEncryptionUnavailableReason()} ` +
          'Set SECRET_ENCRYPTION_KEY to 64 hex characters (openssl rand -hex 32) and restart the backend.',
      )

const safeColumns = {
  id: ciSources.id,
  name: ciSources.name,
  url: ciSources.url,
  provider: ciSources.provider,
}

/**
 * One CI source, with its access token DECRYPTED (#111).
 *
 * Decrypted here rather than at the four browse functions below, for the reason
 * `db/queries.ts` decrypts at its own edge: every caller wants a usable token
 * and none of them should have to remember. Written the other way round, the
 * browse endpoints handed a `v1:` envelope to GitLab as a PRIVATE-TOKEN header
 * and the failure came back as an authentication error against the wrong
 * component — which is what `ciSources.test.ts` caught.
 *
 * The row this returns therefore carries a plaintext secret. It is
 * service-internal: nothing below returns it to a caller, and the public shapes
 * go through `safeColumns`.
 */
const getSourceOrErr = async (id: number) => {
  const rows = await db
    .select()
    .from(ciSources)
    .where(eq(ciSources.id, id))
    .limit(1)
  const row = rows[0]
  if (!row) return null
  return { ...row, accessToken: readAccessToken(row.accessToken) }
}

export const listCiSources = async (): Promise<Result<CiSourcePublic[]>> => {
  const rows = await db
    .select(safeColumns)
    .from(ciSources)
    .orderBy(ciSources.name)

  return ok(rows as CiSourcePublic[])
}

export const createCiSource = async (
  input: CreateCiSourceInput,
  actorId?: number,
): Promise<Result<CiSourcePublic>> => {
  const refusal = refuseUnlessEncryptable()
  if (refusal) return refusal

  const [source] = await db
    .insert(ciSources)
    // Encrypted HERE and not in the route, so every caller gets it — the demo
    // seeder and any future importer included. `input` is not spread onward
    // anywhere below, so the plaintext ends at this statement.
    .values({ ...input, accessToken: encryptSecret(input.accessToken) })
    .returning(safeColumns)

  // Name and URL only. `input` also carries the access token, and an audit log an
  // admin can read must not become the place to find it.
  await logAudit(
    actorId ?? null,
    'ci_source.created',
    source.id,
    `Created ${input.provider} source ${input.name} at ${input.url}`,
  )

  return ok(source as CiSourcePublic)
}

export const getCiSourceById = async (id: number): Promise<Result<CiSourcePublic>> => {
  const rows = await db
    .select(safeColumns)
    .from(ciSources)
    .where(eq(ciSources.id, id))
    .limit(1)

  if (!rows.length) return err(404, 'Not found')
  return ok(rows[0] as CiSourcePublic)
}

export const updateCiSource = async (
  id: number,
  input: UpdateCiSourceInput,
  actorId?: number,
): Promise<Result<CiSourcePublic>> => {
  if (isEmptyUpdate(input)) return err(400, EMPTY_UPDATE_MESSAGE)

  /*
   * Only when a token is actually being written. An admin renaming a source on a
   * deployment with no key configured must still be able to rename it — the
   * refusal belongs to the secret, not to the row.
   */
  if (input.accessToken !== undefined) {
    const refusal = refuseUnlessEncryptable()
    if (refusal) return refusal
  }

  const [updated] = await db
    .update(ciSources)
    .set(
      input.accessToken === undefined
        ? input
        : { ...input, accessToken: encryptSecret(input.accessToken) },
    )
    .where(eq(ciSources.id, id))
    .returning(safeColumns)

  if (!updated) return err(404, 'Not found')

  // Field names only — `accessToken` is one of them, and rotating it is exactly
  // the event worth recording; its value is not.
  await logAudit(actorId ?? null, 'ci_source.updated', id, changedFields(input))

  return ok(updated as CiSourcePublic)
}

export const deleteCiSource = async (id: number, actorId?: number): Promise<Result<void>> => {
  // The deleteEnvironment shape: checks and DELETE in one transaction under a
  // FOR UPDATE lock on the row, so a concurrent insert of a referencing row
  // cannot land between the pre-check and the delete.
  return db.transaction(async (tx): Promise<Result<void>> => {
    const existing = await tx
      .select({ id: ciSources.id, name: ciSources.name })
      .from(ciSources)
      .where(eq(ciSources.id, id))
      .for('update')
      .limit(1)
    if (!existing.length) return err(404, 'Not found')

    // deployment_environments.ci_source_id is NOT NULL with no ON DELETE clause,
    // so the bare delete raised 23503 and escaped as an unhandled 500.
    const envRefs = await tx
      .select({ name: deploymentEnvironments.name })
      .from(deploymentEnvironments)
      .where(eq(deploymentEnvironments.ciSourceId, id))

    if (envRefs.length > 0) {
      return err(
        409,
        `Cannot delete CI source: ${envRefs.length} deployment environment(s) still use it (${envRefs.map((e) => e.name).join(', ')}). Point them at another source first.`,
      )
    }

    const deleted = await tx
      .delete(ciSources)
      .where(eq(ciSources.id, id))
      .returning({ id: ciSources.id })

    if (!deleted.length) return err(404, 'Not found')

    await logAuditWith(tx, actorId ?? null, 'ci_source.deleted', id, `Deleted CI source ${existing[0].name}`)

    return ok(undefined)
  })
}

export const listCiProjects = async (
  sourceId: number,
  search?: string,
): Promise<Result<CiProject[]>> => {
  const source = await getSourceOrErr(sourceId)
  if (!source) return err(404, 'CI source not found')

  const ciProjects = await listProjects(
    { url: source.url, accessToken: source.accessToken, provider: source.provider },
    search,
  )
  return ok(ciProjects)
}

export const listCiBranches = async (
  sourceId: number,
  projectId: string,
): Promise<Result<CiBranch[]>> => {
  const source = await getSourceOrErr(sourceId)
  if (!source) return err(404, 'CI source not found')

  const branches = await listBranches(
    { url: source.url, accessToken: source.accessToken, provider: source.provider },
    projectId,
  )
  return ok(branches)
}

export const listCiFiles = async (
  sourceId: number,
  projectId: string,
  branch: string,
  path?: string,
): Promise<Result<CiFile[]>> => {
  const source = await getSourceOrErr(sourceId)
  if (!source) return err(404, 'CI source not found')

  const files = await listFiles(
    { url: source.url, accessToken: source.accessToken, provider: source.provider },
    projectId,
    branch,
    path,
  )
  return ok(files)
}

export const importCiVars = async (
  sourceId: number,
  projectId: string,
  branch: string,
  filePath: string,
): Promise<Result<unknown>> => {
  const source = await getSourceOrErr(sourceId)
  if (!source) return err(404, 'CI source not found')

  const content = await getFileContent(
    { url: source.url, accessToken: source.accessToken, provider: source.provider },
    projectId,
    branch,
    filePath,
  )

  const parameters = parseTerraformVariables(content)
  return ok(parameters)
}
