import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto'

/**
 * Symmetric encryption for secrets the portal has to be able to read back —
 * integration credentials (issue #111) and, when it lands, the Root account's
 * TOTP secret (issue #36).
 *
 * Not hashing: `ci_sources.access_token` has to be *sent* to GitLab and a TOTP
 * secret has to be *recomputed* from, so a one-way digest is not an option. What
 * is on offer is therefore "encrypted at rest with a key that lives outside the
 * database", which is what stops a dump of the database — a backup on a laptop,
 * a `pg_dump` in a ticket — from being a list of usable credentials.
 *
 * node's built-in `crypto` rather than libsodium/@aws-sdk/kms: no new dependency
 * (a stated constraint of #111), and AES-256-GCM is the same primitive those
 * libraries would wrap. The cost is that key *management* is the operator's
 * problem — see SECRET_ENCRYPTION_KEY in .env.example.
 */

const ALGORITHM = 'aes-256-gcm'

/** AES-256 key length in bytes; the env var carries it hex-encoded, so 64 chars. */
const KEY_BYTES = 32

/** GCM's canonical IV length. Anything else costs a rehash inside the cipher. */
const IV_BYTES = 12

/** GCM auth tag length, fixed by node's default. */
const TAG_BYTES = 16

/**
 * Envelope prefix. Present so a future key rotation or algorithm change can be
 * told apart from an existing value on read instead of guessing from length:
 * without it, migrating to `v2` would mean re-encrypting every row in the same
 * transaction as the deploy.
 */
const ENVELOPE_VERSION = 'v1'

export const SECRET_KEY_ENV = 'SECRET_ENCRYPTION_KEY'

/** Expected length of the env var: the key hex-encoded. */
export const SECRET_KEY_HEX_LENGTH = KEY_BYTES * 2

/**
 * Whether a string is a usable key, without touching `process.env`.
 *
 * Hex only, not "hex or base64". A 32-byte key is 44 base64 characters and 64
 * hex ones, so accepting both is unambiguous in principle — but it makes the
 * error message ("64 hex characters") a lie, and it silently accepts a
 * 48-character base64 string as a 36-byte key that AES-256 then rejects at the
 * first encrypt. One format, one message.
 */
export const isValidSecretKey = (raw: string): boolean =>
  new RegExp(`^[0-9a-fA-F]{${SECRET_KEY_HEX_LENGTH}}$`).test(raw)

/**
 * Why the key is not resolved once at module load: `next build` collects page
 * data in an environment that has no secrets, and a module-level throw there
 * fails the build rather than the request. Same reasoning as
 * `lib/auth/jwt.ts` — resolve lazily, fail closed at the call.
 *
 * The cache is keyed on the raw env string rather than being a plain boolean
 * latch, so a test that swaps SECRET_ENCRYPTION_KEY mid-run gets the new key
 * instead of a stale one. That is a real property, not a test affordance: a
 * cached key would also survive a config reload in a long-lived process.
 */
let cached: { raw: string; key: Buffer } | null = null

export class SecretEncryptionUnavailableError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'SecretEncryptionUnavailableError'
  }
}

const parseKey = (raw: string): Buffer => {
  if (!isValidSecretKey(raw)) {
    throw new SecretEncryptionUnavailableError(
      `${SECRET_KEY_ENV} must be exactly ${SECRET_KEY_HEX_LENGTH} hex characters ` +
        `(${KEY_BYTES} bytes). Generate one with: openssl rand -hex ${KEY_BYTES}`,
    )
  }
  return Buffer.from(raw, 'hex')
}

const getKey = (): Buffer => {
  const raw = process.env[SECRET_KEY_ENV] ?? ''
  if (raw === '') {
    throw new SecretEncryptionUnavailableError(
      `${SECRET_KEY_ENV} is not set, so secrets cannot be encrypted at rest. ` +
        `Set it to ${SECRET_KEY_HEX_LENGTH} hex characters (openssl rand -hex ${KEY_BYTES}).`,
    )
  }
  if (cached?.raw === raw) return cached.key
  const key = parseKey(raw)
  cached = { raw, key }
  return key
}

/**
 * Whether secret storage is available at all.
 *
 * Callers use this to refuse the operation with an explanation rather than
 * storing a plaintext fallback. Storing plaintext "just for now" is exactly the
 * state #111 exists to get out of, and it would be indistinguishable from a
 * correctly encrypted column afterwards.
 */
export const isSecretEncryptionConfigured = (): boolean => {
  try {
    getKey()
    return true
  } catch {
    return false
  }
}

/**
 * Reason secret storage is unavailable, or null when it is available. Separate
 * from the boolean above so a route can pass the operator the actual problem
 * ("64 hex characters" vs "not set") instead of a generic 503.
 */
export const secretEncryptionUnavailableReason = (): string | null => {
  try {
    getKey()
    return null
  } catch (e) {
    return e instanceof Error ? e.message : String(e)
  }
}

/**
 * Encrypt one secret into a self-contained envelope:
 *
 *   v1:base64( iv[12] || tag[16] || ciphertext )
 *
 * The IV is random per value and stored alongside — that is the point of storing
 * it rather than deriving it from, say, the row id: GCM catastrophically loses
 * confidentiality if an (key, IV) pair is ever reused, and any derivation from
 * row data reuses it the moment a value is re-encrypted in place.
 *
 * No additional authenticated data. The obvious candidate would be the row's id,
 * binding a ciphertext to its row so it cannot be copied to another, but a
 * BIGSERIAL id does not exist until after the INSERT that carries the ciphertext.
 * Adding it would mean encrypt-insert-update, and an update path that has to
 * re-encrypt on every move.
 */
export const encryptSecret = (plaintext: string): string => {
  const key = getKey()
  const iv = randomBytes(IV_BYTES)
  const cipher = createCipheriv(ALGORITHM, key, iv)
  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()])
  const tag = cipher.getAuthTag()
  return `${ENVELOPE_VERSION}:${Buffer.concat([iv, tag, ciphertext]).toString('base64')}`
}

/**
 * Decrypt an envelope produced by `encryptSecret`.
 *
 * Throws on a wrong key, a truncated envelope or a tampered ciphertext — GCM's
 * tag check makes those the same failure, which is the property worth having:
 * there is no way to get a silently wrong plaintext back out.
 */
export const decryptSecret = (envelope: string): string => {
  const key = getKey()

  const separator = envelope.indexOf(':')
  const version = separator === -1 ? '' : envelope.slice(0, separator)
  if (version !== ENVELOPE_VERSION) {
    // The rejected version prefix is deliberately not quoted back. This message
    // reaches `last_error`, which every read path returns; on a value that is
    // not an envelope at all — legacy plaintext, which the `ci_sources`
    // migration noted below would put in this column — the text before the
    // first ':' is half of a `user:pass` credential.
    throw new SecretEncryptionUnavailableError(
      `Unsupported secret envelope version; expected ${ENVELOPE_VERSION}`,
    )
  }

  const raw = Buffer.from(envelope.slice(separator + 1), 'base64')
  if (raw.length < IV_BYTES + TAG_BYTES) {
    throw new SecretEncryptionUnavailableError('Secret envelope is truncated')
  }

  const iv = raw.subarray(0, IV_BYTES)
  const tag = raw.subarray(IV_BYTES, IV_BYTES + TAG_BYTES)
  const ciphertext = raw.subarray(IV_BYTES + TAG_BYTES)

  const decipher = createDecipheriv(ALGORITHM, key, iv)
  decipher.setAuthTag(tag)
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8')
}

/**
 * True when `value` is structurally one of our envelopes.
 *
 * Used by tests asserting that ciphertext — not the plaintext — is what reached
 * the column, and by `lib/ci/token.ts` to tell an encrypted token from a legacy
 * plaintext one while `ci_sources` carries both (#111).
 *
 * That second caller is why this checks the SHAPE and not just the `v1:` prefix.
 * A stored value it misjudges is not a cosmetic error: a plaintext token read as
 * an envelope throws on decrypt, and the prefix alone is three characters that a
 * secret could begin with by coincidence. So the body has to be valid base64 and
 * long enough to hold the IV and the tag it claims to carry — which no
 * provider's token format does by accident.
 *
 * Still not proof: only `decryptSecret` can say whether it authenticates under
 * the key. This narrows "might be an envelope" to "is shaped like one", and the
 * decrypt is what decides.
 */
export const isEncryptedEnvelope = (value: string): boolean => {
  if (!value.startsWith(`${ENVELOPE_VERSION}:`)) return false
  const body = value.slice(ENVELOPE_VERSION.length + 1)
  // `base64` decoding in node is lenient — it skips characters it does not
  // recognise rather than failing — so a round trip is what actually rejects a
  // body that is not base64.
  const decoded = Buffer.from(body, 'base64')
  if (decoded.toString('base64').replace(/=+$/, '') !== body.replace(/=+$/, '')) return false
  return decoded.length >= IV_BYTES + TAG_BYTES
}
