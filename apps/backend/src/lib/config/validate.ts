/**
 * Configuration that must be right before the server can do its job.
 *
 * These are checked at bootstrap rather than at the point of use, because the
 * point of use is the wrong place to find out: an invalid JWT_SECRET makes
 * `signToken` throw during login, which reaches the browser as a failed sign-in
 * and reads as "wrong password". The operator then debugs the password.
 */
import { SECRET_KEY_ENV, SECRET_KEY_HEX_LENGTH, isValidSecretKey } from '@/lib/crypto/secrets'

/** Minimum length for an HS256 signing key — 256 bits of secret. */
export const MIN_JWT_SECRET_LENGTH = 32

/**
 * Only the variables this module reads, so a caller can pass a fixture.
 *
 * An index signature rather than a closed record: `process.env` is a
 * `ProcessEnv`, and a closed shape has "no properties in common" with it as far
 * as the compiler is concerned.
 */
export type ConfigEnv = { [key: string]: string | undefined }

/**
 * How much a finding matters.
 *
 * `error` is something that is already broken and will surface as a failure
 * somebody has to debug — a login that cannot succeed, a database that cannot be
 * reached. `warning` is a deployment that works today but is missing something
 * it will be asked for later, where the later failure is much harder to read
 * than the warning is.
 */
export type ConfigSeverity = 'error' | 'warning'

export interface ConfigProblem {
  variable: string
  message: string
  severity: ConfigSeverity
}

/** Every configuration problem found, in the order they should be fixed. */
export const configProblems = (env: ConfigEnv = process.env): ConfigProblem[] => {
  const problems: ConfigProblem[] = []

  const jwtSecret = env.JWT_SECRET ?? ''
  if (jwtSecret === '') {
    problems.push({
      variable: 'JWT_SECRET',
      message: 'is not set — every login will fail. Generate one with `openssl rand -base64 48`.',
      severity: 'error',
    })
  } else if (jwtSecret.length < MIN_JWT_SECRET_LENGTH) {
    problems.push({
      variable: 'JWT_SECRET',
      message:
        `is ${jwtSecret.length} characters; at least ${MIN_JWT_SECRET_LENGTH} are required, ` +
        'so every login will fail. Generate one with `openssl rand -base64 48`.',
      severity: 'error',
    })
  }

  if ((env.DATABASE_URL ?? '') === '') {
    problems.push({
      variable: 'DATABASE_URL',
      message: 'is not set — the server cannot reach its database.',
      severity: 'error',
    })
  }

  // SECRET_ENCRYPTION_KEY: set-but-unusable is an error, absent is a warning.
  //
  // Absence used to be reported nowhere, and that was right while the key bought
  // exactly one optional feature: without it the external-system integration
  // registry refused to store a credential, and a deployment that did not use
  // integrations was not missing anything. #413 (issue #111) changed the deal —
  // the key now also encrypts CI source access tokens, which every deployment
  // has. Creating or rotating one without a key answers 503.
  //
  // So the failure is real but arrives late and in disguise: the estate runs for
  // months, because `readAccessToken` deliberately tolerates the plaintext a
  // pre-#111 database holds, and then somebody rotates a token and gets a 503
  // they have no reason to connect to an environment variable nobody set. A line
  // at boot is how that becomes "we never set this" instead of an afternoon.
  //
  // A warning and not an error, because a deployment missing this key is not
  // broken — it provisions, it serves, it logs people in. Refusing to boot over
  // a column that was plaintext all along would take an estate offline to fix a
  // problem it does not yet have.
  const secretKey = env[SECRET_KEY_ENV]
  if (secretKey === undefined || secretKey === '') {
    problems.push({
      variable: SECRET_KEY_ENV,
      message:
        'is not set, so no CI source access token and no integration credential can ' +
        'be stored — those endpoints answer 503. Generate one with `openssl rand -hex 32` ' +
        'and restart. Each environment needs its own key, and a key cannot be ' +
        'changed later without re-entering every credential it wrote.',
      severity: 'warning',
    })
  } else if (!isValidSecretKey(secretKey)) {
    problems.push({
      variable: SECRET_KEY_ENV,
      message:
        `is set but is not ${SECRET_KEY_HEX_LENGTH} hex characters, so integration ` +
        'credentials cannot be encrypted or decrypted. Generate one with ' +
        '`openssl rand -hex 32`. Note that a key which is later CHANGED cannot ' +
        'decrypt what the previous key wrote.',
      severity: 'error',
    })
  }

  // A wrong-length key is a hard problem: enrolled TOTP secrets become
  // undecryptable and every 2FA login fails closed. An UNSET key is not reported
  // here at all, not even as the warning SECRET_ENCRYPTION_KEY now gets — the
  // two absences are not alike. This one has a working fallback (a key derived
  // from JWT_SECRET), so nothing is refused and nothing arrives late; the only
  // consequence is that rotating JWT_SECRET also invalidates every enrolled
  // authenticator, which lib/auth/totpSecret.ts says at the point it matters.
  const totpKey = (env.TOTP_ENCRYPTION_KEY ?? '').trim()
  if (totpKey !== '' && !isValidTotpKey(totpKey)) {
    problems.push({
      variable: 'TOTP_ENCRYPTION_KEY',
      message:
        'is set but is not 32 bytes — two-factor logins will fail for everyone enrolled. ' +
        'Generate one with `openssl rand -base64 32`.',
      severity: 'error',
    })
  }

  return problems
}

/** 32 bytes, as 64 hex characters or as base64. */
const isValidTotpKey = (value: string): boolean => {
  if (/^[0-9a-fA-F]{64}$/.test(value)) return true
  try {
    return Buffer.from(value, 'base64').length === 32
  } catch {
    return false
  }
}

/**
 * Report problems at startup, once — errors on stderr, warnings on stdout.
 *
 * Split by stream rather than by prefix alone so a log pipeline that alerts on
 * stderr does not page somebody about a key they have chosen not to set, while
 * an operator reading the boot log still sees both.
 *
 * Deliberately does NOT throw: a running server that refuses logins is easier to
 * diagnose than one that will not start, and the same code path runs during
 * `next build`, where none of this is configured.
 */
export const reportConfigProblems = (env: ConfigEnv = process.env): ConfigProblem[] => {
  const problems = configProblems(env)
  for (const problem of problems) {
    const line = `[config] ${problem.variable} ${problem.message}`
    if (problem.severity === 'warning') console.warn(line)
    else console.error(line)
  }
  return problems
}
