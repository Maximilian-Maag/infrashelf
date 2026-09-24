import { and, eq } from 'drizzle-orm'
import { db } from '@/lib/db/client'
import { appConfig } from '@/lib/db/schema'
import { ok, err, type Result } from '@/lib/services/result'
import {
  SECRET_KEY_ENV,
  decryptSecret,
  encryptSecret,
  isEncryptedEnvelope,
  isSecretEncryptionConfigured,
  secretEncryptionUnavailableReason,
} from '@/lib/crypto/secrets'

/**
 * The two secrets in `app_config`: the SMTP password and the AI API key (#556).
 *
 * `ci_sources` and `integrations` go through the encrypted credential store #111
 * built — and this table, next to them, kept writing its two secrets as plain text.
 * A dump, a backup or a support export was therefore a usable mail password and a
 * billable API key, which is exactly what the store exists to prevent.
 *
 * Read any secret here through `readAppSecret`, never off the row: a row written
 * before this change holds plaintext, and the reader is where the difference is
 * known.
 */
export type AppSecretField = 'smtpPass' | 'aiApiKey'

const FIELDS: readonly AppSecretField[] = ['smtpPass', 'aiApiKey']

/** What an operator calls each column. Used in the refusals, not in the audit log. */
const LABELS: Record<AppSecretField, string> = {
  smtpPass: 'SMTP password',
  aiApiKey: 'AI API key',
}

const readColumn = async (field: AppSecretField): Promise<string | null> => {
  const rows =
    field === 'smtpPass'
      ? await db
          .select({ value: appConfig.smtpPass })
          .from(appConfig)
          .where(eq(appConfig.id, 1))
          .limit(1)
      : await db
          .select({ value: appConfig.aiApiKey })
          .from(appConfig)
          .where(eq(appConfig.id, 1))
          .limit(1)

  return rows[0]?.value ?? null
}

/**
 * The secret as configured, or null when there is none.
 *
 * Three states reach here and all three have to work:
 *
 *   - an envelope — decrypt it;
 *   - plaintext, from a row written before this change — USE it, as it is. Refusing
 *     would stop every email and every translation over a value the server can read
 *     perfectly well, and this is not the place to convert it: `encryptLegacyAppSecrets`
 *     does that once at boot, with a compare-and-swap, so a read never writes;
 *   - null or blank — no secret, which is not an error. SMTP without a password is a
 *     normal arrangement and so is an AI provider that needs no key.
 *
 * A ciphertext that does not authenticate under the current key is NOT one of those
 * states, and it throws. "The key was replaced" and "this row predates encryption"
 * need different fixes from an operator, and handing the ciphertext to a mail server
 * as a password would surface as a login failure against the wrong component.
 */
export const readAppSecret = async (field: AppSecretField): Promise<string | null> => {
  const stored = await readColumn(field)
  if (stored === null || stored.trim() === '') return null

  if (isEncryptedEnvelope(stored)) return decryptSecret(stored)
  return stored
}

/**
 * The value to store for a secret being set, or a refusal.
 *
 * Refusal rather than a plaintext fallback, mirroring `requireEncryption` in
 * `services/admin/integrations.ts`: storing plaintext "just for now" is the state
 * this exists to leave, and a deployment that cannot encrypt a secret should say so
 * rather than write it down in the clear.
 *
 * A blank value is a CLEAR, not a secret: it returns null, which is what every
 * reader treats as "not configured".
 */
export const prepareAppSecret = (
  field: AppSecretField,
  plaintext: string,
): Result<string | null> => {
  if (plaintext.trim() === '') return ok(null)
  if (!isSecretEncryptionConfigured()) {
    return err(
      503,
      `Cannot store the ${LABELS[field]}: ${secretEncryptionUnavailableReason()} ` +
        `Until ${SECRET_KEY_ENV} is configured, this field can only be cleared.`,
    )
  }
  return ok(encryptSecret(plaintext))
}

/**
 * Replace a value that was read in plain text with its envelope, and say whether
 * this call is the one that wrote it.
 *
 * Exported so the guard below can be tested for what it is: a caller that holds a
 * value somebody else has since replaced must write nothing. The race itself cannot
 * be forced from outside, but its outcome can.
 *
 * Compare-and-swap on the value we read, not a bare update by id, for the reason
 * `swapLegacyToken` gives in `lib/bootstrap`: between the SELECT and this UPDATE an
 * administrator can save a new password — `updateSmtpConfig` writes a fresh
 * envelope — and during a rolling deploy a second backend instance is running this
 * same backfill. A bare `WHERE id = 1` would write the stale PLAINTEXT back over the
 * new secret, and the change would be silently lost. Guarding on the original value
 * makes the write a no-op in exactly that case: whoever got there first wins.
 */
export const swapLegacySecret = async (field: AppSecretField, previous: string): Promise<number> => {
  const envelope = encryptSecret(previous)
  const updated =
    field === 'smtpPass'
      ? await db
          .update(appConfig)
          .set({ smtpPass: envelope })
          .where(and(eq(appConfig.id, 1), eq(appConfig.smtpPass, previous)))
          .returning({ id: appConfig.id })
      : await db
          .update(appConfig)
          .set({ aiApiKey: envelope })
          .where(and(eq(appConfig.id, 1), eq(appConfig.aiApiKey, previous)))
          .returning({ id: appConfig.id })

  return updated.length
}

/**
 * Encrypt any `app_config` secret an older deployment left in the clear (#556).
 *
 * Called once at boot, next to `encryptLegacyCiTokens` and for the same reason: the
 * columns hold both states while a deployment is being upgraded, and a read path is
 * the wrong place to fix it. Returns the number of secrets actually converted, so
 * the boot log can say whether anything happened rather than reporting work it did
 * not do.
 */
export const encryptLegacyAppSecrets = async (): Promise<number> => {
  if (!isSecretEncryptionConfigured()) return 0

  const [row] = await db
    .select({ smtpPass: appConfig.smtpPass, aiApiKey: appConfig.aiApiKey })
    .from(appConfig)
    .where(eq(appConfig.id, 1))
    .limit(1)
  if (!row) return 0

  let converted = 0
  for (const field of FIELDS) {
    const previous = row[field]
    if (previous === null || previous.trim() === '' || isEncryptedEnvelope(previous)) continue
    converted += await swapLegacySecret(field, previous)
  }
  return converted
}
