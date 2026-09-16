import { createHash, randomInt } from 'node:crypto'
import { and, eq, isNull, lt, lte, or, sql } from 'drizzle-orm'
import { db } from '@/lib/db/client'
import { userRecoveryCodes, userTotp, users, webauthnCredentials } from '@/lib/db/schema'
import { logAudit } from '@/lib/audit'
import { ok, err, type Result } from '@/lib/services/result'
import {
  base32Encode,
  formatSecretForDisplay,
  generateTotpSecret,
  otpauthUrl,
  verifyTotp,
} from '@/lib/auth/totp'
import { decryptTotpSecret, encryptTotpSecret } from '@/lib/auth/totpSecret'
import { qrSvgFor } from '@/lib/auth/qr'

/**
 * Everything about the second factor: enrollment, verification, recovery codes,
 * the lockout, and the audit trail.
 *
 * The rules that matter, in one place so a reviewer can check them against the
 * issue without reading the routes:
 *
 *   0. Only a LOCAL administrative account — `root` or `admin`, signing in with a
 *      password — may enroll or hold a factor, and every one of them MUST (issue
 *      #197; #36 was root-only and opt-in). An SSO account is covered by its
 *      identity provider's MFA and is excluded from both halves.
 *      `loadTwoFactorAccount` is the single gate that enforces who may, and
 *      `secondFactorOutstanding` is the single answer to who still owes one. The
 *      one exception, spelled out at `requiresSecondFactor`, is the login check:
 *      a confirmed row is honoured whatever the role, so a demoted admin is asked
 *      for a code rather than quietly losing the protection or being locked out.
 *   1. A confirmed factor can never be switched off through the API. There is no
 *      `disable` function here, and nothing sets `secret` back to NULL. The only
 *      exits are a re-enrollment (which replaces it) and an operator deleting the
 *      row in the database — see docs/guides/root.md.
 *   2. Re-enrollment always costs a second factor: a current TOTP code, or a
 *      recovery code. Password alone is not enough, or a stolen session would be
 *      able to swap the factor out and lock the owner out of their own account.
 *   3. An accepted code's step is recorded, and anything at or below it is
 *      refused afterwards. A code is single-use, not "valid for 90 seconds".
 *   4. Failures are counted in the database and lock the factor. Six digits is a
 *      10^6 space; a few guesses per second gets through it in days.
 */

/**
 * Failures allowed before the second factor locks.
 *
 * Five, and then fifteen minutes. The arithmetic is the argument: 10^6 codes at
 * 5 per 15 minutes is 5.7 years of continuous guessing for a 50% chance, against
 * roughly two hours if the limit were 100 per 15 minutes. Five is also more than
 * a person mistypes in a row, so a legitimate user who fat-fingers a code twice
 * never meets it.
 *
 * The counter is CONSECUTIVE — a success clears it — so an occasional wrong code
 * over weeks of normal use never accumulates into a lockout.
 */
export const MFA_MAX_FAILED_ATTEMPTS = 5
export const MFA_LOCKOUT_MS = 15 * 60 * 1000

/**
 * How long a started-but-unconfirmed enrollment stays valid.
 *
 * A pending secret is a secret someone might have photographed off a screen and
 * then walked away from, so it does not sit in the database indefinitely waiting
 * to be confirmed by whoever finds the QR code later.
 */
export const PENDING_ENROLLMENT_TTL_MS = 15 * 60 * 1000

/** How many one-time recovery codes an enrollment issues. */
export const RECOVERY_CODE_COUNT = 10

/**
 * Characters in a recovery code, excluding the base32 alphabet's absent 0/1/8/9
 * so nothing can be misread between a screenshot and a keyboard.
 */
const RECOVERY_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'
/**
 * 20 characters from a 32-symbol alphabet is 100 bits.
 *
 * That number is the reason the hash below is a plain SHA-256 and not bcrypt: a
 * password KDF exists to make a *guessable* secret expensive to guess, and there
 * is nothing to guess here. 2^100 is unreachable whatever the hash costs, while
 * bcrypt at this codebase's cost factor of 12 takes about a second per
 * comparison — which for a set of ten codes would mean a ten-second login and a
 * free denial-of-service lever. SHA-256 also lets verification be a single
 * indexed lookup instead of a comparison per row, so the response time reveals
 * nothing about how many codes are left or which one matched.
 *
 * No salt, for the same reason: a salt defeats precomputation across a shared
 * search space, and a 100-bit random value has no search space to share.
 */
const RECOVERY_CODE_LENGTH = 20
const RECOVERY_CODE_GROUP = 5

export interface TwoFactorStatus {
  /** A confirmed factor is present, so login requires a code. */
  enabled: boolean
  confirmedAt: Date | null
  /** An enrollment has been started and not yet confirmed. */
  pending: boolean
  /** Unused recovery codes left. Zero with `enabled` true is a warning state. */
  recoveryCodesRemaining: number
  /** Set while the factor is locked out after repeated failures. */
  lockedUntil: Date | null
}

export interface EnrollmentOffer {
  /** The base32 secret, for someone typing it in by hand. */
  secret: string
  /** The same secret, grouped in fours. */
  secretFormatted: string
  /** The `otpauth://` URI behind the QR code. */
  otpauthUrl: string
  /** A self-contained SVG of the QR code, ready to inline. */
  qrSvg: string
}

/**
 * The roles that must hold a second factor.
 *
 * #36 scoped TOTP to root. #197 widens it to every administrative role, on the
 * owner's instruction, and makes it mandatory rather than opt-in: `root` is the
 * webshop admin and `admin` is the IT admin, and both hold enough authority that
 * a password alone is not an acceptable amount of proof. `project_manager` is the
 * end-user role and stays opt-out — it is not administrative, and forcing
 * enrolment on every ordinary user is a different decision nobody has made.
 *
 * This set and the predicate below are the only places that say so; every entry
 * point goes through `loadTwoFactorAccount`, so widening it again is a change
 * here and nowhere else.
 */
const TWO_FACTOR_ROLES: ReadonlySet<string> = new Set(['root', 'admin'])

/** Whether an account with this role may enroll or hold a second factor. */
export const canHoldSecondFactor = (role: string | null | undefined): boolean =>
  typeof role === 'string' && TWO_FACTOR_ROLES.has(role)

/** The one place that decides what "2FA is on" means. */
const isConfirmed = (row: { secret: string | null; confirmedAt: Date | null } | undefined): boolean =>
  Boolean(row?.secret && row.confirmedAt)

const hashRecoveryCode = (code: string): string =>
  createHash('sha256').update(normalizeRecoveryCode(code), 'utf8').digest('hex')

/**
 * Recovery codes are shown grouped and in upper case; accept whatever the user
 * pastes back. Everything outside the alphabet is dropped rather than rejected,
 * because a trailing space or the dashes we printed ourselves are not an attack.
 */
export const normalizeRecoveryCode = (code: string): string =>
  code.toUpperCase().replace(/[^A-Z0-9]/g, '')

/** `'ABCDE-FGHJK-LMNPQ-RSTUV'` — grouped so it can be read off paper. */
const formatRecoveryCode = (raw: string): string =>
  (raw.match(new RegExp(`.{1,${RECOVERY_CODE_GROUP}}`, 'g')) ?? []).join('-')

/**
 * `randomInt` rather than `randomBytes(n) % 32`: the alphabet is 32 characters,
 * so a modulo would happen to be unbiased here — but the next person to change
 * the alphabet to 31 characters would not notice that it stopped being.
 */
const generateRecoveryCode = (): string =>
  Array.from({ length: RECOVERY_CODE_LENGTH }, () => RECOVERY_ALPHABET[randomInt(RECOVERY_ALPHABET.length)]).join('')

/**
 * Replace every recovery code this account has with a fresh set (#197 part 2).
 *
 * Shared by both enrollment paths, because recovery codes are shared: they are
 * the way back in when the FACTOR is gone, and which kind it was does not change
 * what they have to do. Confirming a TOTP secret and registering a first security
 * key both land here.
 *
 * Previous codes go, used or not. They were issued against a factor that is being
 * replaced, and leaving them live would mean an old backup code still walks past
 * the new one.
 *
 * Takes the transaction so a caller can make the codes and the factor a single
 * change — half-applied, this leaves a confirmed factor whose recovery codes
 * belong to the previous one.
 */
export const replaceRecoveryCodes = async (
  userId: number,
  tx: { delete: typeof db.delete; insert: typeof db.insert } = db,
): Promise<string[]> => {
  const codes = Array.from({ length: RECOVERY_CODE_COUNT }, generateRecoveryCode)
  await tx.delete(userRecoveryCodes).where(eq(userRecoveryCodes.userId, userId))
  await tx
    .insert(userRecoveryCodes)
    .values(codes.map((c) => ({ userId, codeHash: hashRecoveryCode(c) })))
  return codes.map(formatRecoveryCode)
}

const loadRow = async (userId: number) => {
  const rows = await db.select().from(userTotp).where(eq(userTotp.userId, userId)).limit(1)
  return rows[0]
}

/**
 * How many security keys this account holds (#197 part 2).
 *
 * Its own query rather than a join, because both callers already have the row
 * they need and only reach here when the TOTP answer was "no factor" — so on the
 * common path (an account with an authenticator) it never runs at all.
 */
export const countWebauthnCredentials = async (userId: number): Promise<number> => {
  const [row] = await db
    .select({ count: sql<number>`COUNT(*)::int` })
    .from(webauthnCredentials)
    .where(eq(webauthnCredentials.userId, userId))
  return row?.count ?? 0
}

/**
 * Whether a confirmed TOTP secret exists (#197 part 2).
 *
 * Asked by the WebAuthn service (may this key be removed — is anything else left)
 * and by the login path (which factors can this account present). One definition,
 * because "2FA is on" has to mean the same thing in all three places.
 *
 * The comparison happens in SQL and the projection is a boolean, so the secret is
 * never selected. `requiresSecondFactor` above still names the column and is
 * allowlisted for it; there is no reason for a second read to be, when what the
 * caller wants is one bit.
 */
export const hasConfirmedTotp = async (userId: number): Promise<boolean> => {
  const [row] = await db
    .select({
      confirmed: sql<boolean>`${userTotp.secret} IS NOT NULL AND ${userTotp.confirmedAt} IS NOT NULL`,
    })
    .from(userTotp)
    .where(eq(userTotp.userId, userId))
    .limit(1)
  return row?.confirmed === true
}

export const countUnusedRecoveryCodes = async (userId: number): Promise<number> => {
  const [row] = await db
    .select({ count: sql<number>`COUNT(*)::int` })
    .from(userRecoveryCodes)
    .where(and(eq(userRecoveryCodes.userId, userId), isNull(userRecoveryCodes.usedAt)))
  return row?.count ?? 0
}

/**
 * Whether a login as this user has to pass a second factor.
 *
 * Called from the login path, so it is one indexed lookup joined to the row it
 * has to check the role against: a user with no row, or with a row that was
 * never confirmed, is not protected and logs in with a password alone. That is
 * the bootstrap case — the very first login after installation cannot require a
 * factor that has not been set up yet.
 *
 * A CONFIRMED row is honoured whatever the account's role is, and that is the
 * deliberate answer to "what about a non-root account that somehow has one".
 * Enrollment is root-only (`loadTwoFactorAccount`), so the only way such a row
 * exists is a root account demoted afterwards — and that user still holds the
 * authenticator and the recovery codes. Ignoring the row would silently drop a
 * protection they set up and still rely on; refusing the login outright would be
 * a lockout with no way back in. Asking for the code they already have is the
 * only outcome that is neither, so the role gate deliberately does NOT apply
 * here. The mismatch is logged so an operator can see it and clear the row on
 * purpose — the emergency reset in docs/guides/root.md.
 */
export const requiresSecondFactor = async (userId: number): Promise<boolean> => {
  const rows = await db
    .select({ secret: userTotp.secret, confirmedAt: userTotp.confirmedAt, role: users.role })
    .from(users)
    // LEFT since #197 part 2: an account may hold a security key and no TOTP row
    // at all, and an inner join would report it as having no second factor —
    // signing it in on a password alone, past a factor it actually has.
    .leftJoin(userTotp, eq(userTotp.userId, users.id))
    .where(eq(users.id, userId))
    .limit(1)

  const row = rows[0]
  if (!row) return false
  if (!isConfirmed(row) && (await countWebauthnCredentials(userId)) === 0) return false
  if (!canHoldSecondFactor(row.role)) {
    console.warn(
      `[2fa] user ${userId} has role "${row.role}" but a confirmed second factor; still requiring it at login. See "Emergency 2FA reset" in docs/guides/root.md.`,
    )
  }
  return true
}

/**
 * Whether this account must enroll a second factor before it can do anything else
 * (issue #197).
 *
 * The inverse of `requiresSecondFactor` in every sense that matters: that one
 * asks "does this login have a factor to pass", this one asks "does this account
 * owe us one". An administrative role with no confirmed row answers yes, and that
 * is the state the API refuses to serve — see `requireAuth`.
 *
 * Deliberately NOT cached and not carried in the session token. Two reasons, and
 * the second is the one that decides it:
 *
 *  - it has to become false the moment enrolment is confirmed, without the user
 *    signing in again, or the gate would trap the account it just released;
 *  - it has to become TRUE again the moment an operator clears the row by hand —
 *    the emergency reset in docs/guides/root.md. A flag on the session row would
 *    keep every existing session unblocked after exactly the event that should
 *    block them.
 *
 * The cost is one indexed lookup per authenticated request, and only for the two
 * administrative roles: `requireAuth` checks `canHoldSecondFactor` against the
 * role already in the token first, so a project manager's requests never reach
 * this query.
 *
 * SSO accounts are excluded. They have no local password, `loadTwoFactorAccount`
 * refuses to enroll them, and their second factor is the identity provider's —
 * so requiring one here would refuse them every route while refusing them the
 * screen that could satisfy it.
 */
export const secondFactorOutstanding = async (userId: number): Promise<boolean> => {
  const rows = await db
    .select({
      secret: userTotp.secret,
      confirmedAt: userTotp.confirmedAt,
      role: users.role,
      passwordHash: users.passwordHash,
    })
    .from(users)
    // LEFT, not INNER: an account that has never started an enrolment has no
    // `user_totp` row at all, and that is precisely the case this must catch.
    // `requiresSecondFactor` can use an inner join because a missing row means
    // "no factor to ask for"; here it means "owes one".
    .leftJoin(userTotp, eq(userTotp.userId, users.id))
    .where(eq(users.id, userId))
    .limit(1)

  const row = rows[0]
  if (!row) return false
  if (!canHoldSecondFactor(row.role)) return false
  // An SSO account owes nothing, and demanding it would be a lockout with no way
  // out: `loadTwoFactorAccount` refuses to enroll an account with no local
  // password — its second factor belongs to the identity provider — so an SSO
  // administrator gated here would be refused every route AND refused the one
  // screen that could lift the gate. Entra ID's own MFA is what covers them.
  //
  // First, because it is the cheapest and the most decisive: an account that may
  // not enroll at all cannot owe an enrollment, whatever else is true of it.
  if (!row.passwordHash) return false
  // Either factor discharges the requirement. A key is a stronger second factor
  // than a TOTP code, so an account that registered one and never touched an
  // authenticator app owes nothing.
  if (isConfirmed(row)) return false
  return (await countWebauthnCredentials(userId)) === 0
}

export const getTwoFactorStatus = async (userId: number): Promise<Result<TwoFactorStatus>> => {
  const account = await loadTwoFactorAccount(userId)
  if (!account.ok) return account

  const row = await loadRow(userId)
  const pendingFresh =
    Boolean(row?.pendingSecret) &&
    row?.pendingCreatedAt !== null &&
    row?.pendingCreatedAt !== undefined &&
    Date.now() - row.pendingCreatedAt.getTime() < PENDING_ENROLLMENT_TTL_MS

  return ok({
    enabled: isConfirmed(row),
    confirmedAt: row?.confirmedAt ?? null,
    pending: pendingFresh,
    recoveryCodesRemaining: row ? await countUnusedRecoveryCodes(userId) : 0,
    // Only report a lock that is still in the future; a stale timestamp is not
    // a lock and showing one would just confuse whoever is reading the page.
    lockedUntil:
      row?.lockedUntil && row.lockedUntil.getTime() > Date.now() ? row.lockedUntil : null,
  })
}

/**
 * Start (or restart) an enrollment.
 *
 * The caller has already verified the password and, when a factor is already
 * confirmed, a second factor as well — see `beginEnrollment` in the route layer.
 * This function only mints the new secret and stores it as *pending*, so the
 * existing authenticator keeps working until a code proves the new one arrived.
 */
export const startEnrollment = async (
  userId: number,
  accountEmail: string,
  issuer: string,
  {
    /**
     * Set when the route skipped the code check because, at the moment it
     * looked, `requiresSecondFactor` was false — the ONLY branch a stolen
     * session and a phished password alone can reach. That answer is a read,
     * not a lock: if a confirmed factor lands in the gap between it and this
     * write — the real owner finishing their own first enrollment while this
     * call was in flight — writing anyway plants a pending secret nobody had
     * to prove they could replace, and a later `confirmEnrollment` with a code
     * from it would promote it over the owner's, silently taking the account
     * over. Same read-then-write shape `revokeSession` and `addToCart` were
     * fixed for (#195): the upsert below is conditioned on `confirmed_at IS
     * NULL` so that landing makes it a no-op instead of a write.
     */
    requireStillUnconfirmed = false,
  }: { requireStillUnconfirmed?: boolean } = {},
): Promise<Result<EnrollmentOffer>> => {
  // The route has already loaded the account to check the password; this second
  // primary-key lookup is what makes the gate hold for any other caller too.
  const account = await loadTwoFactorAccount(userId)
  if (!account.ok) return account

  const secret = generateTotpSecret()
  const envelope = encryptTotpSecret(secret, userId)
  const now = new Date()

  const written = await db
    .insert(userTotp)
    .values({ userId, pendingSecret: envelope, pendingCreatedAt: now, updatedAt: now })
    .onConflictDoUpdate({
      target: userTotp.userId,
      set: { pendingSecret: envelope, pendingCreatedAt: now, updatedAt: now },
      ...(requireStillUnconfirmed ? { setWhere: isNull(userTotp.confirmedAt) } : {}),
    })
    .returning({ userId: userTotp.userId })

  // A brand new row always writes (there is nothing confirmed to protect); an
  // existing one that failed the `setWhere` above is left untouched and comes
  // back empty here — that is the CAS actually firing, not an error.
  if (requireStillUnconfirmed && written.length === 0) {
    return err(
      409,
      'Two-factor authentication was confirmed on this account while this request was in flight. Refresh and provide the current code to re-enroll.',
    )
  }

  await logAudit(userId, 'auth.2fa.enroll_started', userId, 'TOTP enrollment started')

  const url = otpauthUrl({ issuer, account: accountEmail, secret })
  return ok({
    secret: base32Encode(secret).replace(/=+$/, ''),
    secretFormatted: formatSecretForDisplay(secret),
    otpauthUrl: url,
    qrSvg: qrSvgFor(url, { title: 'TOTP enrollment QR code' }),
  })
}

/**
 * Confirm a pending enrollment with a code from the authenticator, and issue the
 * recovery codes.
 *
 * Recovery codes are minted here rather than at `startEnrollment` on purpose: an
 * abandoned enrollment must not invalidate the codes the user is currently
 * relying on, and a set of codes for a secret that never reached a phone is
 * worse than useless — it is a set of standing credentials nobody wrote down.
 */
export const confirmEnrollment = async (
  userId: number,
  code: string,
): Promise<Result<{ recoveryCodes: string[] }>> => {
  const account = await loadTwoFactorAccount(userId)
  if (!account.ok) return account

  const row = await loadRow(userId)
  if (!row?.pendingSecret || !row.pendingCreatedAt) {
    return err(400, 'No enrollment is in progress. Start again.')
  }
  // Bound to a local: the WHERE clauses below identify the enrollment THIS
  // request read, and one of them sits inside a closure where TypeScript would
  // otherwise widen the property back to `string | null`.
  const pendingEnvelope = row.pendingSecret
  if (Date.now() - row.pendingCreatedAt.getTime() >= PENDING_ENROLLMENT_TTL_MS) {
    // Clear it rather than leaving an expired secret in the row — but only the
    // secret this request read. An unconditional clear here erases whatever is
    // in the column at the time, which after a slow request is somebody else's
    // freshly stored enrollment. Zero rows updated is a no-op, and the caller
    // still hears that THEIR enrollment expired, which it did.
    await db
      .update(userTotp)
      .set({ pendingSecret: null, pendingCreatedAt: null, updatedAt: new Date() })
      .where(and(eq(userTotp.userId, userId), eq(userTotp.pendingSecret, pendingEnvelope)))
    return err(400, 'This enrollment has expired. Start again.')
  }

  // Same gate as the login path, for the same reason: this endpoint checks a
  // six-digit code too, and a lock that is read and then decided in JavaScript
  // is no lock at all against parallel requests (#195).
  const claim = await claimAttempt(userId)
  if (!claim) {
    const until = lockState(await loadRow(userId)).until
    await logAudit(
      userId,
      'auth.2fa.enroll_confirm_blocked',
      userId,
      `Confirmation attempted while locked out; lock expires ${until.toISOString()}`,
    )
    return err(429, lockMessage(until))
  }

  let pendingSecret: Buffer
  try {
    pendingSecret = decryptTotpSecret(row.pendingSecret, userId)
  } catch {
    // The stored envelope cannot be read — a rotated key, or a tampered row.
    // Fail, and say so plainly rather than letting the enrollment "succeed"
    // against a secret nobody can verify later.
    console.error(`[2fa] Could not decrypt the pending TOTP secret for user #${userId}; check TOTP_ENCRYPTION_KEY`)
    await logAudit(userId, 'auth.2fa.enroll_failed', userId, 'Pending secret could not be decrypted')
    return err(500, 'The stored enrollment could not be read. Start again.')
  }

  const verification = verifyTotp(pendingSecret, code, Math.floor(Date.now() / 1000))
  if (!verification.valid) {
    const failure = await recordFailure(userId, 'enroll_confirm', claim)
    return failureResult(failure, 'That code is not valid.')
  }

  const now = new Date()
  const codes = Array.from({ length: RECOVERY_CODE_COUNT }, generateRecoveryCode)

  // One transaction: promoting the secret and replacing the recovery codes are a
  // single change. Half of it applied would leave a confirmed factor whose
  // recovery codes belong to the previous one.
  //
  // The UPDATE claims the exact envelope this request read, the same conditional
  // shape verifyRecoveryCode and the replay guard use. Without it, a request that
  // verified a code against an enrollment that has since been replaced would
  // promote its own stale secret over the new one and reissue recovery codes
  // against it. Every envelope carries its own random nonce, so equality on the
  // column is equality on this enrollment; nothing else has to be compared.
  let claimed = false
  await db.transaction(async (tx) => {
    const [promoted] = await tx
      .update(userTotp)
      .set({
        secret: pendingEnvelope,
        pendingSecret: null,
        pendingCreatedAt: null,
        confirmedAt: now,
        // The confirming code is spent, like any other.
        lastUsedStep: verification.step,
        failedAttempts: 0,
        lockedUntil: null,
        updatedAt: now,
      })
      .where(and(eq(userTotp.userId, userId), eq(userTotp.pendingSecret, pendingEnvelope)))
      .returning({ userId: userTotp.userId })

    // Nothing claimed means the pending secret moved under us. Leave before the
    // delete below, so the recovery codes of whatever is now current survive.
    if (!promoted) return
    claimed = true

    // Previous codes go, used or not: they were issued against the old secret
    // and leaving them live would mean an old backup code still bypasses the new
    // factor.
    await tx.delete(userRecoveryCodes).where(eq(userRecoveryCodes.userId, userId))
    await tx
      .insert(userRecoveryCodes)
      .values(codes.map((c) => ({ userId, codeHash: hashRecoveryCode(c) })))
  })

  if (!claimed) {
    await logAudit(
      userId,
      'auth.2fa.enroll_superseded',
      userId,
      'Confirmation arrived for an enrollment that had already been replaced',
    )
    return err(409, 'This enrollment has been replaced by a newer one. Start again.')
  }

  await logAudit(
    userId,
    'auth.2fa.enabled',
    userId,
    `TOTP confirmed; ${RECOVERY_CODE_COUNT} recovery codes issued`,
  )

  return ok({ recoveryCodes: codes.map(formatRecoveryCode) })
}

interface LockState {
  locked: boolean
  until: Date
}

const lockState = (row: { lockedUntil: Date | null } | undefined): LockState => {
  const until = row?.lockedUntil ?? new Date(0)
  return { locked: until.getTime() > Date.now(), until }
}

const lockMessage = (until: Date | null): string => {
  const minutes = until ? Math.max(1, Math.ceil((until.getTime() - Date.now()) / 60000)) : 15
  return `Too many incorrect codes. Try again in ${minutes} minute${minutes === 1 ? '' : 's'}.`
}

/**
 * Turn a counted failure into a response.
 *
 * The attempt that trips the limit answers 429, not 400: it IS a rate-limit
 * response, and a caller that only looks at the status would otherwise retry
 * straight into a locked door and log it as a bad password.
 */
const failureResult = (
  failure: { locked: boolean; lockedUntil: Date | null },
  message: string,
): Result<never> =>
  failure.locked ? err(429, lockMessage(failure.lockedUntil)) : err(400, message)

/**
 * Take one attempt slot, atomically, BEFORE the submitted code is looked at.
 *
 * Returns null when the factor is locked, and that is the whole point. The gate
 * used to be `SELECT`, evaluate `locked_until` in JavaScript, check the code,
 * and only then count the attempt — so N requests arriving together all read
 * `locked_until = NULL`, all passed the gate, and all had their codes checked.
 * The lock engaged afterwards, against attempts that had already happened.
 *
 * That collapses the bound this file's own arithmetic rests on. Five attempts
 * per fifteen minutes puts a 10^6 code space at 5.7 years; the limit an attacker
 * actually meets is their own parallelism, and there is no other rate limit on
 * the path — `completeMfaLogin` has none, and the MFA challenge token is not
 * single-use, so one phished password buys a window to drive it from (#195).
 *
 * Charging first has three consequences worth stating:
 *
 *  - A CORRECT code still works on the fifth attempt: it is counted, then
 *    checked, and success clears the counter.
 *  - An attempt that dies on a server error (an unreadable secret) is charged.
 *    That is deliberate — fail closed — and five such errors lock the factor,
 *    which is the right outcome for a key that cannot be read.
 *  - An expired lock resets the counter rather than leaving it at five, or the
 *    first attempt after the fifteen minutes would re-lock immediately.
 */
const lockExpired = sql`${userTotp.lockedUntil} IS NOT NULL AND ${userTotp.lockedUntil} <= NOW()`

const claimAttempt = async (
  userId: number,
): Promise<{ attempts: number; locked: boolean; lockedUntil: Date | null } | null> => {
  // The count this attempt lands on: 1 if the previous lock has just expired,
  // otherwise one more than the last.
  const nextCount = sql`CASE WHEN ${lockExpired} THEN 1 ELSE ${userTotp.failedAttempts} + 1 END`

  const [claimed] = await db
    .update(userTotp)
    .set({
      failedAttempts: nextCount,
      lockedUntil: sql`CASE WHEN ${nextCount} >= ${MFA_MAX_FAILED_ATTEMPTS}
        THEN NOW() + ${sql.raw(`INTERVAL '${MFA_LOCKOUT_MS} milliseconds'`)}
        ELSE NULL END`,
      updatedAt: new Date(),
    })
    // The lock is enforced HERE, in the same statement that charges the attempt.
    // Zero rows means locked, and no two callers can both see an unlocked row.
    .where(
      and(
        eq(userTotp.userId, userId),
        or(isNull(userTotp.lockedUntil), lte(userTotp.lockedUntil, sql`NOW()`)),
      ),
    )
    .returning({ failedAttempts: userTotp.failedAttempts, lockedUntil: userTotp.lockedUntil })

  if (!claimed) return null
  return {
    attempts: claimed.failedAttempts,
    locked: Boolean(claimed.lockedUntil && claimed.lockedUntil.getTime() > Date.now()),
    lockedUntil: claimed.lockedUntil,
  }
}

/**
 * Write the audit entry for an attempt that has already been counted.
 *
 * The increment moved to `claimAttempt`, which runs before the code is checked.
 * This is what is left: naming the outcome, which "one wrong code" and "the
 * fifth wrong code in a row, factor now locked" need to be distinguishable by.
 */
const recordFailure = async (
  userId: number,
  stage: string,
  claim: { attempts: number; locked: boolean; lockedUntil: Date | null },
): Promise<{ attempts: number; locked: boolean; lockedUntil: Date | null }> => {
  const { attempts, locked } = claim

  // The audit entry names the count and whether the lock engaged: "one wrong
  // code" and "the fifth wrong code in a row, factor now locked" are the same
  // event to a user and completely different events to whoever reads this log.
  await logAudit(
    userId,
    locked ? 'auth.2fa.locked' : 'auth.2fa.failed',
    userId,
    locked
      ? `Second factor locked after ${attempts} consecutive failures (${stage}); locked until ${claim.lockedUntil?.toISOString() ?? 'unknown'}`
      : `Invalid second factor (${stage}); ${attempts} of ${MFA_MAX_FAILED_ATTEMPTS} consecutive failures`,
  )

  return claim
}

const clearFailures = async (userId: number, extra: Record<string, unknown> = {}): Promise<void> => {
  await db
    .update(userTotp)
    .set({ failedAttempts: 0, lockedUntil: null, updatedAt: new Date(), ...extra })
    .where(eq(userTotp.userId, userId))
}

export type SecondFactorKind = 'totp' | 'recovery_code'

export interface SecondFactorSuccess {
  kind: SecondFactorKind
  /** Unused recovery codes left afterwards, so the UI can warn when it is low. */
  recoveryCodesRemaining: number
}

/**
 * Verify a second factor: a TOTP code, or one of the recovery codes.
 *
 * Both are accepted through the same door because the caller cannot know which
 * the user has to hand — the whole point of a recovery code is that the
 * authenticator is gone. A recovery code is distinguishable by shape (letters
 * and 20 characters against six digits), so there is no ambiguity to resolve.
 */
export const verifySecondFactor = async (
  userId: number,
  submitted: string,
  { stage = 'login' }: { stage?: string } = {},
): Promise<Result<SecondFactorSuccess>> => {
  const row = await loadRow(userId)
  if (!isConfirmed(row) || !row?.secret) {
    // Nothing to verify against. This is a caller bug, not a user error, and
    // must not be reported as "wrong code" — that would let a login proceed on
    // the assumption that a factor exists when it does not.
    return err(400, 'No second factor is set up for this account.')
  }

  // The slot is taken before the code is read, so parallel guesses are counted
  // rather than merely raced (#195). Recovery codes go through the same gate:
  // they are the same brute-force surface, entered at the same prompt.
  const claim = await claimAttempt(userId)
  if (!claim) {
    // A blocked attempt is logged too. Without it the log shows five failures
    // and then silence, and the operator cannot tell whether the attacker gave
    // up or simply kept hammering a locked door.
    const until = lockState(await loadRow(userId)).until
    await logAudit(
      userId,
      'auth.2fa.blocked',
      userId,
      `Attempt while locked out (${stage}); lock expires ${until.toISOString()}`,
    )
    return err(429, lockMessage(until))
  }

  const normalized = normalizeRecoveryCode(submitted)

  // Recovery code first, by shape: a 20-character alphanumeric is never a TOTP
  // code, so this cannot shadow one.
  if (normalized.length === RECOVERY_CODE_LENGTH) {
    return verifyRecoveryCode(userId, normalized, stage, claim)
  }

  let secret: Buffer
  try {
    secret = decryptTotpSecret(row.secret, userId)
  } catch {
    // Fail CLOSED. A secret we cannot read means we cannot check the factor, and
    // the one thing that must not happen is treating an unreadable factor as
    // absent and letting the login through.
    console.error(`[2fa] Could not decrypt the stored TOTP secret for user #${userId}; check TOTP_ENCRYPTION_KEY`)
    await logAudit(userId, 'auth.2fa.error', userId, 'Stored secret could not be decrypted')
    return err(500, 'The second factor could not be verified. See the server log.')
  }

  const verification = verifyTotp(secret, submitted, Math.floor(Date.now() / 1000))
  if (!verification.valid || verification.step === null) {
    const failure = await recordFailure(userId, stage, claim)
    return failureResult(failure, 'That code is not valid.')
  }

  // Replay guard. The ±1 window means a code stays arithmetically valid for 90
  // seconds; single use is what makes it useless to anyone who saw it after the
  // fact.
  //
  // One conditional UPDATE claims the step, for the same reason verifyRecoveryCode
  // spends a code in one statement: SELECT-then-UPDATE lets two simultaneous
  // requests carrying the SAME code both read the old `last_used_step`, both pass
  // the comparison, and both write — which makes "each code is usable once" true
  // only when nobody is trying. `lt` rather than `<>` so a code from an earlier
  // step in the window cannot be used after a later one.
  const [claimed] = await db
    .update(userTotp)
    .set({ failedAttempts: 0, lockedUntil: null, updatedAt: new Date(), lastUsedStep: verification.step })
    .where(
      and(
        eq(userTotp.userId, userId),
        or(isNull(userTotp.lastUsedStep), lt(userTotp.lastUsedStep, verification.step)),
      ),
    )
    .returning({ userId: userTotp.userId })

  if (!claimed) {
    const failure = await recordFailure(userId, `${stage}:replay`, claim)
    return failureResult(failure, 'That code has already been used. Wait for the next one.')
  }
  await logAudit(userId, 'auth.2fa.verified', userId, `Second factor accepted (${stage}, TOTP)`)

  return ok({ kind: 'totp', recoveryCodesRemaining: await countUnusedRecoveryCodes(userId) })
}

/**
 * Spend a recovery code.
 *
 * A single conditional UPDATE does the lookup and the spending together, so two
 * simultaneous requests with the same code cannot both succeed: the second finds
 * `used_at` already set and matches nothing. Doing it as SELECT-then-UPDATE would
 * make "each code is usable once" true only when nobody is trying.
 */
const verifyRecoveryCode = async (
  userId: number,
  normalized: string,
  stage: string,
  /** The attempt already charged by `claimAttempt`, so this only reports it. */
  claim: { attempts: number; locked: boolean; lockedUntil: Date | null },
): Promise<Result<SecondFactorSuccess>> => {
  const now = new Date()
  const [spent] = await db
    .update(userRecoveryCodes)
    .set({ usedAt: now })
    .where(
      and(
        eq(userRecoveryCodes.userId, userId),
        eq(userRecoveryCodes.codeHash, hashRecoveryCode(normalized)),
        isNull(userRecoveryCodes.usedAt),
      ),
    )
    .returning({ id: userRecoveryCodes.id })

  if (!spent) {
    const failure = await recordFailure(userId, `${stage}:recovery_code`, claim)
    return failureResult(failure, 'That recovery code is not valid.')
  }

  await clearFailures(userId)
  const remaining = await countUnusedRecoveryCodes(userId)
  await logAudit(
    userId,
    'auth.2fa.recovery_code_used',
    userId,
    `Recovery code spent (${stage}); ${remaining} of ${RECOVERY_CODE_COUNT} remaining`,
  )

  return ok({ kind: 'recovery_code', recoveryCodesRemaining: remaining })
}

/**
 * The issuer shown in the authenticator app.
 *
 * Taken from the configured shop name where possible so the entry says what the
 * user recognises rather than the product's internal name. The colon is stripped
 * because it is the `otpauth` label separator, and a shop called "Acme: Cloud"
 * would otherwise produce an entry attributed to "Acme".
 */
export const totpIssuer = (shopName: string | null | undefined): string => {
  const cleaned = (shopName ?? '').replace(/:/g, ' ').trim()
  return cleaned.length > 0 ? cleaned : 'InfraShelf'
}

export interface TwoFactorAccount {
  id: number
  email: string
  /** The hash the caller needs to re-check the password. */
  passwordHash: string
  role: string
}

/**
 * The single gate every 2FA entry point passes through.
 *
 * Three rules live here rather than in the route handlers, because a rule
 * repeated in four handlers is a rule the fifth one forgets:
 *
 *   1. The account exists and is active.
 *   2. It signs in with a local password. An SSO user has no password to
 *      re-authenticate with and their MFA is Entra ID's job (issue #36); saying
 *      so beats returning "wrong password" for an account that has none.
 *   3. It is an administrative account. #36 scoped this to root; #197 widened it
 *      to `root` and `admin` and made it mandatory for both. `project_manager`
 *      stays out: it is the end-user role, and letting it enroll would send an
 *      ordinary user through a two-step login built for administrators.
 *
 * Order only decides what a caller is told when more than one rule applies: an
 * SSO admin hears about the SSO, which is the more useful of the two answers —
 * and it is why rule 2 sitting above rule 3 matters more since #197. An SSO
 * administrator is refused here, so `secondFactorOutstanding` must not require a
 * factor of them; a gate they could never satisfy is a lockout, not a policy.
 *
 * 403 for the role, not 404: the caller is authenticated as this very account,
 * so there is nothing to hide from them, and a 401 would sign them out.
 */
export const loadTwoFactorAccount = async (
  userId: number,
): Promise<Result<TwoFactorAccount>> => {
  const rows = await db
    .select({
      id: users.id,
      email: users.email,
      passwordHash: users.passwordHash,
      role: users.role,
      active: users.active,
    })
    .from(users)
    .where(eq(users.id, userId))
    .limit(1)

  const user = rows[0]
  if (!user || !user.active) return err(404, 'User not found')
  if (!user.passwordHash) {
    return err(
      400,
      'This account signs in through single sign-on; its second factor is managed by the identity provider.',
    )
  }
  if (!canHoldSecondFactor(user.role)) {
    return err(403, 'Two-factor authentication is available to administrator accounts only.')
  }
  return ok({ id: user.id, email: user.email, passwordHash: user.passwordHash, role: user.role })
}
