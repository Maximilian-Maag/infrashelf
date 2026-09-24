import { db } from '@/lib/db/client'
import { appConfig } from '@/lib/db/schema'
import { eq } from 'drizzle-orm'
import { ok, type Result } from '@/lib/services/result'
import { resetSmtpCache } from '@/lib/notification'
import { logAudit } from '@/lib/audit'

import { prepareAppSecret } from '@/lib/crypto/appSecrets'

export interface SmtpConfig {
  host: string
  port: number
  from: string
  user: string
  tls: boolean
}

export interface UpdateSmtpInput {
  host: string
  port: number
  from: string
  user?: string
  password?: string
  tls?: boolean
}

export interface AiConfig {
  provider: string
  endpoint: string
  model: string
}

export interface UpdateAiInput {
  provider: string
  endpoint: string
  apiKey?: string
  model: string
}

export const getSmtpConfig = async (): Promise<Result<SmtpConfig>> => {
  const rows = await db
    .select({
      smtpHost: appConfig.smtpHost,
      smtpPort: appConfig.smtpPort,
      smtpFrom: appConfig.smtpFrom,
      smtpUser: appConfig.smtpUser,
      smtpTls: appConfig.smtpTls,
    })
    .from(appConfig)
    .where(eq(appConfig.id, 1))
    .limit(1)

  if (!rows.length) {
    return ok({ host: '', port: 587, from: '', user: '', tls: true })
  }

  const row = rows[0]
  return ok({
    host: row.smtpHost ?? '',
    port: row.smtpPort ?? 587,
    from: row.smtpFrom ?? '',
    user: row.smtpUser ?? '',
    tls: row.smtpTls ?? true,
  })
}

/**
 * An empty string is not a value, it is the absence of one.
 *
 * These columns are nullable and every reader treats NULL as "not configured" —
 * `lib/notification` returns null for a missing host, `lib/ai` falls back to a
 * default model. Storing `''` instead would satisfy neither: `?? 'gpt-4o-mini'`
 * does not fire for an empty string, so a cleared model would be sent to the
 * provider as nothing at all rather than as the default (#317).
 */
const orNull = (value: string): string | null => (value.trim() === '' ? null : value)

export const updateSmtpConfig = async (
  input: UpdateSmtpInput,
  actorId?: number,
): Promise<Result<void>> => {
  const setValues: Partial<typeof appConfig.$inferInsert> = {
    smtpHost: orNull(input.host),
    smtpPort: input.port,
    smtpFrom: orNull(input.from),
    smtpUser: input.user ?? '',
    smtpTls: input.tls ?? true,
  }
  // Encrypted, not stored as given (#556): this column held plain text while the
  // integration credentials next door were already encrypted, so a database dump
  // was a usable mail password. A blank value clears it; see `prepareAppSecret`.
  const replacedPassword = input.password !== undefined ? input.password.trim() !== '' : false
  if (input.password !== undefined) {
    const prepared = prepareAppSecret('smtpPass', input.password)
    if (!prepared.ok) return prepared
    setValues.smtpPass = prepared.data
  }

  await db
    .insert(appConfig)
    .values({ id: 1, ...setValues })
    .onConflictDoUpdate({ target: appConfig.id, set: setValues })

  // Invalidate the cached transporter so the new settings take effect at once.
  resetSmtpCache()

  // Host and port are configuration an auditor needs to see; the password is not
  // recorded, only the fact that it was replaced. There is exactly one row here,
  // so the entry carries no entity id.
  await logAudit(
    actorId ?? null,
    'config.smtp_updated',
    undefined,
    orNull(input.host) === null
      ? 'SMTP turned off'
      : `SMTP set to ${input.host}:${input.port} (tls ${input.tls ?? true})${input.password === undefined ? '' : replacedPassword ? ', password replaced' : ', password cleared'}`,
  )

  return ok(undefined)
}

export const getAiConfig = async (): Promise<Result<AiConfig>> => {
  const rows = await db
    .select({
      aiProvider: appConfig.aiProvider,
      aiEndpoint: appConfig.aiEndpoint,
      aiModel: appConfig.aiModel,
    })
    .from(appConfig)
    .where(eq(appConfig.id, 1))
    .limit(1)

  if (!rows.length) {
    return ok({ provider: 'claude', endpoint: '', model: '' })
  }

  const row = rows[0]
  return ok({
    provider: row.aiProvider || 'claude',
    endpoint: row.aiEndpoint ?? '',
    model: row.aiModel ?? '',
  })
}

export const updateAiConfig = async (
  input: UpdateAiInput,
  actorId?: number,
): Promise<Result<void>> => {
  const setValues: Partial<typeof appConfig.$inferInsert> = {
    aiProvider: input.provider,
    aiEndpoint: input.endpoint,
    aiModel: orNull(input.model),
  }
  const replacedApiKey = input.apiKey !== undefined ? input.apiKey.trim() !== '' : false
  if (input.apiKey !== undefined) {
    const prepared = prepareAppSecret('aiApiKey', input.apiKey)
    if (!prepared.ok) return prepared
    setValues.aiApiKey = prepared.data
  }

  await db
    .insert(appConfig)
    .values({ id: 1, ...setValues })
    .onConflictDoUpdate({ target: appConfig.id, set: setValues })

  // Provider, endpoint and model, never the API key — only that it was replaced.
  await logAudit(
    actorId ?? null,
    'config.ai_updated',
    undefined,
    `AI set to ${input.provider} ${input.model} at ${input.endpoint}${input.apiKey === undefined ? '' : replacedApiKey ? ', API key replaced' : ', API key cleared'}`,
  )

  return ok(undefined)
}
