import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import {
  getSmtpConfig,
  updateSmtpConfig,
  getAiConfig,
  updateAiConfig,
} from './config'
import { db } from '@/lib/db/client'
import { appConfig, auditLog } from '@/lib/db/schema'
import { sql, eq } from 'drizzle-orm'
import { readAppSecret } from '@/lib/crypto/appSecrets'
import { SECRET_KEY_ENV, decryptSecret, isEncryptedEnvelope } from '@/lib/crypto/secrets'

/** vitest.config.ts sets a key for the whole suite; restore it after meddling. */
const configuredKey = process.env[SECRET_KEY_ENV]

afterEach(() => {
  if (configuredKey === undefined) delete process.env[SECRET_KEY_ENV]
  else process.env[SECRET_KEY_ENV] = configuredKey
})

// The app_config row with id=1 is seeded once in beforeAll, but the table is
// not in the TRUNCATE list — so the row persists across tests. Reset it here
// to keep tests isolated.
beforeEach(async () => {
  await db.execute(sql`
    UPDATE app_config SET
      smtp_host = NULL, smtp_port = NULL, smtp_from = NULL,
      smtp_user = NULL, smtp_pass = NULL, smtp_tls = TRUE,
      ai_provider = NULL, ai_endpoint = NULL, ai_api_key = NULL, ai_model = NULL
    WHERE id = 1
  `)
})

describe('getSmtpConfig', () => {
  it('returns empty defaults when nothing configured', async () => {
    const result = await getSmtpConfig()
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.data.host).toBe('')
      expect(result.data.port).toBe(587)
      expect(result.data.from).toBe('')
      expect(result.data.user).toBe('')
      expect(result.data.tls).toBe(true)
    }
  })

  it('does not expose the password field', async () => {
    await updateSmtpConfig({
      host: 'smtp.example.com',
      port: 587,
      from: 'noreply@example.com',
      password: 'super-secret',
    })
    const result = await getSmtpConfig()
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect((result.data as unknown as { smtpPass?: string }).smtpPass).toBeUndefined()
      expect((result.data as unknown as { password?: string }).password).toBeUndefined()
    }
  })
})

describe('updateSmtpConfig', () => {
  it('persists to DB; getSmtpConfig reflects the change', async () => {
    await updateSmtpConfig({
      host: 'smtp.example.com',
      port: 25,
      from: 'no@example.com',
      user: 'u',
      password: 'p',
      tls: false,
    })

    const result = await getSmtpConfig()
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.data.host).toBe('smtp.example.com')
      expect(result.data.port).toBe(25)
      expect(result.data.from).toBe('no@example.com')
      expect(result.data.user).toBe('u')
      expect(result.data.tls).toBe(false)
    }
  })

  // NFA-06.3: omitting the credential field preserves the existing stored value
  it('preserves existing SMTP password when password is not provided (NFA-06.3)', async () => {
    // Seed with a password
    await updateSmtpConfig({
      host: 'smtp.example.com',
      port: 25,
      from: 'no@example.com',
      user: 'u',
      password: 'original-secret',
    })

    // Update without providing a password (as the frontend does when the field is blank)
    await updateSmtpConfig({
      host: 'smtp2.example.com',
      port: 587,
      from: 'other@example.com',
      user: 'u2',
    })

    const [row] = await db.select().from(appConfig)
    expect(row?.smtpHost).toBe('smtp2.example.com')
    expect(row?.smtpUser).toBe('u2')
    // The column holds an envelope since #556, and the value is still the one that
    // was set: NFA-06.3 is about preservation, not about the encoding.
    expect(isEncryptedEnvelope(row?.smtpPass as string)).toBe(true)
    expect(decryptSecret(row?.smtpPass as string)).toBe('original-secret')
  })
})

describe('getAiConfig', () => {
  it('returns empty defaults when nothing configured', async () => {
    const result = await getAiConfig()
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.data.provider).toBe('claude')
      expect(result.data.endpoint).toBe('')
      expect(result.data.model).toBe('')
    }
  })

  it('does not expose the apiKey field', async () => {
    await updateAiConfig({
      provider: 'openai',
      endpoint: 'https://api',
      apiKey: 'sk-secret',
      model: 'gpt-4',
    })
    const result = await getAiConfig()
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect((result.data as unknown as { aiApiKey?: string }).aiApiKey).toBeUndefined()
      expect((result.data as unknown as { apiKey?: string }).apiKey).toBeUndefined()
    }
  })
})

describe('updateAiConfig', () => {
  it('persists to DB; getAiConfig reflects the change', async () => {
    await updateAiConfig({
      provider: 'openai',
      endpoint: 'https://api.openai.com',
      apiKey: 'k',
      model: 'gpt-4o',
    })

    const result = await getAiConfig()
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.data.provider).toBe('openai')
      expect(result.data.endpoint).toBe('https://api.openai.com')
      expect(result.data.model).toBe('gpt-4o')
    }

    // Sanity check: DB row also has the apiKey persisted — as an envelope, not as
    // the key itself (#556).
    const rows = await db.select().from(appConfig)
    expect(isEncryptedEnvelope(rows[0]?.aiApiKey as string)).toBe(true)
    expect(decryptSecret(rows[0]?.aiApiKey as string)).toBe('k')
  })

  // NFA-06.3: omitting the credential field preserves the existing stored value
  it('preserves existing AI API key when apiKey is not provided (NFA-06.3)', async () => {
    // Seed with an apiKey
    await updateAiConfig({
      provider: 'openai',
      endpoint: 'https://api.openai.com',
      apiKey: 'sk-original',
      model: 'gpt-4o',
    })

    // Update without providing apiKey (frontend omits it when the input is blank)
    await updateAiConfig({
      provider: 'claude',
      endpoint: 'https://api.anthropic.com',
      model: 'claude-sonnet-4-6',
    })

    const [row] = await db.select().from(appConfig)
    expect(row?.aiProvider).toBe('claude')
    expect(row?.aiEndpoint).toBe('https://api.anthropic.com')
    expect(row?.aiModel).toBe('claude-sonnet-4-6')
    expect(isEncryptedEnvelope(row?.aiApiKey as string)).toBe(true)
    expect(decryptSecret(row?.aiApiKey as string)).toBe('sk-original')
  })
})

/*
 * Clearing has to reach the column as NULL, not as ''.
 *
 * Every reader means NULL by "not configured": `lib/notification` returns null
 * for a missing host, `lib/ai` does `cfg?.aiModel ?? 'gpt-4o-mini'`. `?? ` does
 * not fire for an empty string, so storing '' would send the provider an empty
 * model instead of the default — a cleared setting that is worse than the one
 * it replaced (#317).
 */
describe('clearing a configuration', () => {
  it('stores NULL for an emptied SMTP host and from address', async () => {
    await updateSmtpConfig({ host: 'smtp.example.com', port: 587, from: 'a@b.c', user: '', tls: true })

    await updateSmtpConfig({ host: '', port: 587, from: '', user: '', tls: true })

    const [row] = await db.execute(
      sql`SELECT smtp_host, smtp_from FROM app_config WHERE id = 1`,
    )
    expect(row).toMatchObject({ smtp_host: null, smtp_from: null })
  })

  it('stores NULL for an emptied AI model', async () => {
    await updateAiConfig({ provider: 'claude', endpoint: 'https://api.example.com', model: 'claude-opus-4-5' })

    await updateAiConfig({ provider: 'claude', endpoint: 'https://api.example.com', model: '' })

    const [row] = await db.execute(sql`SELECT ai_model FROM app_config WHERE id = 1`)
    expect(row).toMatchObject({ ai_model: null })
  })

  it('says so in the audit log rather than quoting an empty host', async () => {
    await updateSmtpConfig({ host: '', port: 587, from: '', user: '', tls: true })

    const [entry] = await db
      .select()
      .from(auditLog)
      .where(eq(auditLog.action, 'config.smtp_updated'))
    expect(entry.details).toBe('SMTP turned off')
  })
})

/*
 * #556. `smtp_pass` and `ai_api_key` were written as plain text while the
 * integration credentials next door went through the encrypted store #111 built,
 * so a database dump or a support export was a usable mail password and a
 * billable API key.
 *
 * The value is never returned by `getSmtpConfig` / `getAiConfig` — that part was
 * already right — so what these assert is what reached the COLUMN.
 */
describe('the stored secrets of app_config (#556)', () => {
  it('stores the SMTP password as an envelope, not as the password', async () => {
    await updateSmtpConfig({
      host: 'smtp.example.com',
      port: 587,
      from: 'no@example.com',
      password: 'hunter2',
    })

    const [row] = await db.select().from(appConfig)
    expect(row?.smtpPass).not.toBe('hunter2')
    expect(isEncryptedEnvelope(row?.smtpPass as string)).toBe(true)
    expect(decryptSecret(row?.smtpPass as string)).toBe('hunter2')
  })

  it('stores the AI key as an envelope', async () => {
    await updateAiConfig({
      provider: 'openai',
      endpoint: 'https://api.openai.com',
      apiKey: 'sk-live-123',
      model: 'gpt-4o',
    })

    const [row] = await db.select().from(appConfig)
    expect(row?.aiApiKey).not.toBe('sk-live-123')
    expect(decryptSecret(row?.aiApiKey as string)).toBe('sk-live-123')
  })

  it('refuses to store a secret when there is no key, leaving the column alone', async () => {
    await updateSmtpConfig({
      host: 'smtp.example.com',
      port: 587,
      from: 'no@example.com',
      password: 'first',
    })
    const [before] = await db.select().from(appConfig)

    delete process.env[SECRET_KEY_ENV]

    const result = await updateSmtpConfig({
      host: 'smtp.example.com',
      port: 587,
      from: 'no@example.com',
      password: 'second',
    })

    // 503, not 400: the form was fine and the server cannot store what it was
    // given. Refusing is the point — the alternative is a plaintext fallback
    // indistinguishable from an encrypted column afterwards (#111).
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.status).toBe(503)
      expect(result.message).toContain(SECRET_KEY_ENV)
    }
    // And nothing was written: the refusal happens before the upsert.
    const [after] = await db.select().from(appConfig)
    expect(after?.smtpPass).toBe(before?.smtpPass)
  })

  it('refuses to store an AI key when there is no key', async () => {
    delete process.env[SECRET_KEY_ENV]

    const result = await updateAiConfig({
      provider: 'openai',
      endpoint: 'https://api.openai.com',
      apiKey: 'sk-live-123',
      model: 'gpt-4o',
    })

    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.status).toBe(503)
    const [row] = await db.select().from(appConfig)
    // Not written as plaintext, and not written as an envelope either: the key
    // arrived as an update to a form the deployment cannot serve.
    expect(row?.aiApiKey).toBeNull()
  })

  it('clears the password when an empty string is sent', async () => {
    await updateSmtpConfig({
      host: 'smtp.example.com',
      port: 587,
      from: 'no@example.com',
      password: 'hunter2',
    })

    await updateSmtpConfig({
      host: 'smtp.example.com',
      port: 587,
      from: 'no@example.com',
      password: '',
    })

    // NULL, not an empty envelope: every reader means "not configured" by NULL,
    // and an envelope of nothing would read back as a stored secret of ''.
    const [row] = await db.select().from(appConfig)
    expect(row?.smtpPass).toBeNull()
    expect(await readAppSecret('smtpPass')).toBeNull()
  })

  it('clears the AI key when an empty string is sent', async () => {
    await updateAiConfig({
      provider: 'openai',
      endpoint: 'https://api.openai.com',
      apiKey: 'sk-live-123',
      model: 'gpt-4o',
    })

    await updateAiConfig({
      provider: 'openai',
      endpoint: 'https://api.openai.com',
      apiKey: '   ',
      model: 'gpt-4o',
    })

    const [row] = await db.select().from(appConfig)
    expect(row?.aiApiKey).toBeNull()
    expect(await readAppSecret('aiApiKey')).toBeNull()
  })

  it('says in the audit log that a secret was cleared rather than replaced', async () => {
    await updateSmtpConfig({
      host: 'smtp.example.com',
      port: 587,
      from: 'no@example.com',
      password: 'hunter2',
    })
    await updateSmtpConfig({
      host: 'smtp.example.com',
      port: 587,
      from: 'no@example.com',
      password: '',
    })

    const entries = await db
      .select()
      .from(auditLog)
      .where(eq(auditLog.action, 'config.smtp_updated'))
    // Appended in order: the first says it was replaced, the second that it was
    // cleared. Neither carries the password, which is the other half of the rule.
    expect(entries.map((e) => e.details)).toEqual([
      'SMTP set to smtp.example.com:587 (tls true), password replaced',
      'SMTP set to smtp.example.com:587 (tls true), password cleared',
    ])
  })
})
