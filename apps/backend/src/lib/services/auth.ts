import bcrypt from 'bcryptjs'
import { recheckPassword } from '@/lib/auth/passwordRecheck'
import type { SessionUser } from '@infrashelf/types'
import { db } from '@/lib/db/client'
import { users } from '@/lib/db/schema'
import { eq } from 'drizzle-orm'
import { createSession } from '@/lib/auth/sessions'
import { peekMfaChallengeUserId, signMfaChallenge, verifyMfaChallenge } from '@/lib/auth/mfaChallenge'
import {
  countWebauthnCredentials,
  hasConfirmedTotp,
  requiresSecondFactor,
  secondFactorOutstanding,
  totpIssuer,
  verifySecondFactor,
} from '@/lib/services/twoFactor'
import {
  verifyAuthentication as verifyWebauthnAssertion,
  verifyPasswordlessAuthentication,
  type AuthenticationResponseJSON,
} from '@/lib/services/webauthn'
import { getBranding } from '@/lib/services/admin/branding'
import { logAudit } from '@/lib/audit'
import { ok, err, type Result } from '@/lib/services/result'
import { revokeAllSessionsOf } from '@/lib/services/sessions'

export interface UserProfile {
  id: number
  email: string
  name: string
  role: string
  active: boolean
  ssoSub: string | null
  createdAt: Date
}

const safeUserColumns = {
  id: users.id,
  email: users.email,
  name: users.name,
  role: users.role,
  active: users.active,
  ssoSub: users.ssoSub,
  createdAt: users.createdAt,
}

/** Where the login came from, recorded on the session row (issue #37). */
export interface LoginContext {
  ip?: string | null
  userAgent?: string | null
  rememberMe?: boolean
}

/**
 * What a successful password check earns.
 *
 * Either a session — or, when the account has a second factor, a *challenge*:
 * proof that the password was right, and nothing more. The two are a
 * discriminated union rather than "a token plus a flag" because the requirement
 * is that no usable token exists before the second factor, and a shape where the
 * token field is simply absent is the only version of that a caller cannot get
 * wrong by ignoring a boolean.
 */
/** Which second factors the account holds — see `MfaChallengeResponse.methods`. */
export type SecondFactorMethod = 'totp' | 'webauthn'

export type LoginOutcome =
  | {
      mfaRequired: false
      token: string
      user: SessionUser
      /**
       * Set when the account is an administrator that still owes an enrollment
       * (issue #197). The session is real — enrolling needs one — but every route
       * except the enrollment endpoints will refuse it. See `requireAuth`.
       */
      mustEnrollSecondFactor?: boolean
    }
  | { mfaRequired: true; mfaToken: string; methods: SecondFactorMethod[] }

/**
 * What the password step alone establishes — before any session exists.
 *
 * The no-second-factor arm carries the user and NOT a token, because at this
 * point in the flow no session has been opened. Whether one ever is depends on
 * the caller: `loginWithCredentials` opens it, `checkLoginPassword` deliberately
 * does not.
 */
export type PasswordOutcome =
  | { mfaRequired: true; mfaToken: string; methods: SecondFactorMethod[] }
  | { mfaRequired: false; user: SessionUser }

const sessionUserOf = (user: {
  id: number
  email: string
  name: string
  role: string
}): SessionUser => ({
  id: user.id,
  email: user.email,
  name: user.name,
  role: user.role as SessionUser['role'],
})

/**
 * Open a session, turning a misconfiguration into a 500 rather than a 401.
 *
 * Without this the JWT_SECRET check inside signToken throws, the route 500s with
 * no body, and NextAuth reports CredentialsSignin — so a misconfigured
 * deployment looks exactly like a wrong password, which is what an operator then
 * spends the afternoon debugging.
 *
 * Since #37 the same try also covers writing the session row: a token with no
 * row behind it is refused by every request, so failing to write the row is
 * failing to log in, and it should say so here rather than a moment later as a
 * 401 on the first page.
 *
 * Since #36 this is called from two places — the one-step login and the second
 * step of a two-step one — and `createSession` is still the only way either of
 * them gets a token, so a session opened after a TOTP code is as revocable as
 * any other.
 */
const issueSession = async (user: SessionUser, context: LoginContext): Promise<Result<string>> => {
  try {
    const { token } = await createSession({
      user,
      ip: context.ip ?? null,
      userAgent: context.userAgent ?? null,
      rememberMe: context.rememberMe ?? false,
    })
    return ok(token)
  } catch (e) {
    // The user id, because "which account cannot sign in" is the question support
    // is asked, and "all of them" and "this one" need different answers (#482).
    console.error(`[auth] Could not open a session for user #${user.id} — check JWT_SECRET and the database:`, e)
    return err(500, 'The server is misconfigured and cannot issue a session. See the server log.')
  }
}

/**
 * Check an email and password, and nothing else.
 *
 * Nothing here writes a `sessions` row or signs a session token, on either
 * branch — the second-factor branch by requirement (#36), the other one because
 * this is also what the two-step sign-in's first hop calls, and that hop throws
 * any token away (see the frontend's `app/api/login-challenge/route.ts`). Minting
 * one for it would leave a session in the user's own list that no browser holds.
 *
 * `rememberMe` is taken here rather than at the second step because this is where
 * the user actually made the choice; for a two-step sign-in it is sealed into the
 * challenge, so the second step cannot be talked into a 30-day session.
 */
export const checkLoginPassword = async (
  email: string,
  password: string,
  rememberMe = false,
): Promise<Result<PasswordOutcome>> => {
  const rows = await db
    .select()
    .from(users)
    .where(eq(users.email, email))
    .limit(1)

  const user = rows[0]
  if (!user || !user.passwordHash) {
    return err(401, 'Invalid credentials')
  }

  const valid = await bcrypt.compare(password, user.passwordHash)
  if (!valid) return err(401, 'Invalid credentials')

  /*
   * Deactivation is reported only AFTER the password verifies.
   *
   * It used to share the branch above, so a deactivated account failed as
   * "Invalid credentials" — and the operator went looking for a password
   * problem. On the dev instance that cost an afternoon: root had deactivated
   * its own account (#196), and every screen said the password was wrong.
   *
   * Told before the password is checked, this would be an account-enumeration
   * oracle: anyone could learn which addresses have accounts, and which of them
   * are switched off. Told after, it discloses nothing — whoever gets this
   * message already holds the credentials, and the only thing they learn is why
   * the credentials they have do not work.
   *
   * Deliberately after bcrypt rather than before, so the timing does not leak it
   * either.
   */
  if (!user.active) {
    return err(403, 'This account is deactivated. An administrator has to reactivate it.')
  }

  // The password was right. If a second factor is enrolled, that is ALL that has
  // been established — no session row is written and no session token is signed
  // on this path at all, so there is nothing here for a caller to accidentally
  // hand out, and nothing for a revocation check to have to catch later.
  if (await requiresSecondFactor(user.id)) {
    let mfaToken: string
    try {
      mfaToken = await signMfaChallenge(user.id, user.passwordHash, rememberMe)
    } catch (e) {
      console.error(`[auth] Could not sign an MFA challenge for user #${user.id} — check JWT_SECRET:`, e)
      return err(500, 'The server is misconfigured and cannot issue a session. See the server log.')
    }
    await logAudit(user.id, 'auth.2fa.challenged', user.id, 'Password accepted; second factor required')
    return ok({ mfaRequired: true, mfaToken, methods: await availableSecondFactors(user.id) })
  }

  return ok({ mfaRequired: false, user: sessionUserOf(user) })
}

export const loginWithCredentials = async (
  email: string,
  password: string,
  context: LoginContext = {},
): Promise<Result<LoginOutcome>> => {
  const outcome = await checkLoginPassword(email, password, context.rememberMe ?? false)
  if (!outcome.ok) return outcome
  if (outcome.data.mfaRequired) return ok(outcome.data)

  const sessionUser = outcome.data.user
  const token = await issueSession(sessionUser, context)
  if (!token.ok) return token

  // Asked once, here, rather than on every request the client then makes: this
  // is the moment the answer decides where the user is sent. `requireAuth` is
  // what actually holds the line, and it re-asks per request precisely so that
  // this flag being stale can never mean the gate is open.
  const mustEnroll = await secondFactorOutstanding(sessionUser.id)
  if (mustEnroll) {
    await logAudit(
      sessionUser.id,
      'auth.2fa.enrollment_required',
      sessionUser.id,
      'Signed in without a second factor; enrollment required before the account can be used',
    )
  }

  return ok({
    mfaRequired: false,
    token: token.data,
    user: sessionUser,
    ...(mustEnroll ? { mustEnrollSecondFactor: true } : {}),
  })
}

/**
 * Sign in with a security key alone — no email, no password (#241).
 *
 * The assertion is checked by `verifyPasswordlessAuthentication`, which resolves
 * the account from the credential and enforces user verification. This function
 * decides whether that account may have a session, and opens one.
 *
 * ── Why this does not consult `requiresSecondFactor` ────────────────────────
 *
 * Because the ceremony it just passed IS two factors. A discoverable credential
 * asserted with `userVerification: 'required'` is something you have plus the
 * PIN or biometric that released it, and the owner's decision on #241 is that
 * this satisfies the mandatory-second-factor rule for administrators. Asking
 * `requiresSecondFactor` here would demand a TOTP code on top of a ceremony that
 * is already stronger than password-plus-code, and refuse the flow to exactly
 * the accounts it is most worth having.
 *
 * `secondFactorOutstanding` is a different question — "does this account owe us
 * an enrolment" — and is still asked below, exactly as the password path asks
 * it. It answers false here in practice, because an account that just signed in
 * with a key demonstrably holds one; it is asked rather than assumed so the two
 * paths cannot drift.
 *
 * ── What it still refuses ──────────────────────────────────────────────────
 *
 * A deactivated account, the same as the password path. Not an SSO account:
 * an SSO user cannot register a key in the first place (`loadTwoFactorAccount`
 * refuses an account with no local password), so an SSO account holding one is
 * a demotion artefact and the key is still theirs — the same reasoning
 * `requiresSecondFactor` applies to a demoted root.
 */
export const loginWithPasswordlessWebauthn = async (
  response: AuthenticationResponseJSON,
  shopName: string,
  context: LoginContext = {},
): Promise<Result<LoginOutcome>> => {
  const assertion = await verifyPasswordlessAuthentication(response, shopName)
  if (!assertion.ok) return assertion

  const [user] = await db.select().from(users).where(eq(users.id, assertion.data.userId)).limit(1)
  /*
   * A credential whose account has been deleted. The row cascades on delete, so
   * this is close to unreachable — and it answers 401 rather than 500 because
   * the caller is unauthenticated and the honest description of the situation
   * is that the key cannot sign anybody in.
   */
  if (!user) return err(401, 'That security key could not be used to sign in.')

  if (!user.active) {
    // Said plainly, as the password path says it. Whoever produced this assertion
    // physically holds the key for this account; telling them why it will not
    // work discloses nothing they could not already establish, and the
    // alternative is the afternoon #196 cost.
    await logAudit(user.id, 'auth.webauthn.login_failed', user.id, 'Passwordless sign-in to a deactivated account')
    return err(403, 'This account is deactivated. An administrator has to reactivate it.')
  }

  const sessionUser = sessionUserOf(user)
  const token = await issueSession(sessionUser, context)
  if (!token.ok) return token

  await logAudit(
    user.id,
    'auth.webauthn.login',
    user.id,
    `Signed in without a password using security key "${assertion.data.label}"`,
  )

  const mustEnroll = await secondFactorOutstanding(sessionUser.id)
  if (mustEnroll) {
    await logAudit(
      sessionUser.id,
      'auth.2fa.enrollment_required',
      sessionUser.id,
      'Signed in without a second factor; enrollment required before the account can be used',
    )
  }

  return ok({
    mfaRequired: false,
    token: token.data,
    user: sessionUser,
    ...(mustEnroll ? { mustEnrollSecondFactor: true } : {}),
  })
}

/**
 * Second half of a two-step login: redeem a challenge with a second factor.
 *
 * The challenge is verified against the account's *current* password hash, so a
 * challenge issued before a password change or an operator-forced reset stops
 * being redeemable — a five-minute expiry alone would leave a window where a
 * just-revoked credential still finishes a login.
 *
 * Only past the code check does `issueSession` run, so the `sessions` row and the
 * token that names it come into existence together, here, and nowhere earlier.
 */
/**
 * What the second step presents: a typed code, or an assertion from a key.
 *
 * A union rather than two optional fields, so "neither" and "both" are not
 * expressible. The two prove the same thing to different standards and the caller
 * has to have picked one.
 */
export type SecondFactorProof =
  | { kind: 'code'; code: string }
  | { kind: 'webauthn'; response: AuthenticationResponseJSON }

export const completeMfaLogin = async (
  mfaToken: string,
  proof: SecondFactorProof,
  context: LoginContext = {},
): Promise<Result<{ token: string; user: SessionUser }>> => {
  // Two passes over the token: the first only to learn which user to look up,
  // the second — inside verifyMfaChallenge — to check the signature against that
  // user's credential fingerprint. The first pass already verifies the signature,
  // so an attacker cannot smuggle an arbitrary id through it.
  const userId = await peekMfaChallengeUserId(mfaToken)
  if (userId === null) return err(401, 'This sign-in attempt has expired. Start again.')

  const rows = await db.select().from(users).where(eq(users.id, userId)).limit(1)
  const user = rows[0]
  if (!user || !user.active || !user.passwordHash) {
    return err(401, 'This sign-in attempt has expired. Start again.')
  }

  const challenge = await verifyMfaChallenge(mfaToken, user.passwordHash)
  if (!challenge || challenge.userId !== user.id) {
    return err(401, 'This sign-in attempt has expired. Start again.')
  }

  // Both paths end in the same place: a Result that says yes or no, and a
  // session opened only past it. The WebAuthn branch does not touch the TOTP
  // lockout counter — a key cannot be brute-forced the way six digits can, and
  // letting failed assertions lock the authenticator app would hand an attacker
  // a way to disable the other factor.
  const verified =
    proof.kind === 'code'
      ? await verifySecondFactor(user.id, proof.code, { stage: 'login' })
      : await verifyWebauthnAssertion(user.id, proof.response, await currentShopName())
  if (!verified.ok) return verified

  const sessionUser = sessionUserOf(user)
  // "Remember me" comes from the challenge, not from this request: the user
  // ticked the box at the password step, and a signed claim is the only version
  // of that answer the second step cannot be asked to change.
  const token = await issueSession(sessionUser, { ...context, rememberMe: challenge.rememberMe })
  if (!token.ok) return token

  await logAudit(
    user.id,
    'auth.login.mfa',
    user.id,
    `Signed in with a second factor (${proof.kind === 'webauthn' ? 'security key' : proof.kind})`,
  )
  return ok({ token: token.data, user: sessionUser })
}

/**
 * The factor kinds this account can actually present.
 *
 * Order is deliberate: a security key first, because it is the stronger of the
 * two and the form should lead with it where both exist.
 */
const availableSecondFactors = async (userId: number): Promise<SecondFactorMethod[]> => {
  const methods: SecondFactorMethod[] = []
  if ((await countWebauthnCredentials(userId)) > 0) methods.push('webauthn')
  if (await hasConfirmedTotp(userId)) methods.push('totp')
  return methods
}

/** Branding's shop name, or the default — what the authenticator was registered against. */
const currentShopName = async (): Promise<string> => {
  const branding = await getBranding()
  return totpIssuer(branding.ok ? branding.data.shopName : null)
}

export const getMe = async (userId: number): Promise<Result<UserProfile>> => {
  const rows = await db
    .select(safeUserColumns)
    .from(users)
    .where(eq(users.id, userId))
    .limit(1)

  if (!rows.length) return err(404, 'User not found')
  return ok(rows[0] as UserProfile)
}

export const updateMe = async (
  userId: number,
  input: { name: string },
): Promise<Result<UserProfile>> => {
  const [updated] = await db
    .update(users)
    .set({ name: input.name })
    .where(eq(users.id, userId))
    .returning(safeUserColumns)

  if (!updated) return err(404, 'User not found')
  return ok(updated as UserProfile)
}

/**
 * Change your own password, and end every other session while doing it (#184).
 *
 * Changing the password is the one remediation every user and every helpdesk
 * reaches for after a suspected compromise, and it used to do nothing to the
 * sessions: an attacker holding a stolen token kept it — up to thirty days with
 * "remember me". `updateUser` already revoked on deactivation and on a role
 * change, with a well-argued comment about exactly this; the password path was
 * simply missed.
 *
 * Everything EXCEPT the caller's own session. They just proved the old password
 * and are sitting in that tab; signing them out of it would make the remediation
 * feel like a failure and teach people not to do it.
 *
 * One transaction, for the reason `updateUser` gives: a hash that commits while
 * the revoke fails leaves a changed password and every old session alive, which
 * is the exact state this exists to prevent.
 */
export const changePassword = async (
  caller: { id: number; sessionId: number },
  currentPassword: string,
  newPassword: string,
): Promise<Result<void>> => {
  const rows = await db
    .select({ passwordHash: users.passwordHash })
    .from(users)
    .where(eq(users.id, caller.id))
    .limit(1)

  const user = rows[0]
  if (!user?.passwordHash) {
    return err(400, 'Password change not allowed for SSO accounts')
  }

  // Shared with 2FA enrolment and security-key removal, so an attacker cannot
  // spread guesses across the three doors. See `passwordRecheck.ts`.
  const recheck = await recheckPassword(caller.id, currentPassword, user.passwordHash)
  if (recheck === 'throttled') {
    return err(429, 'Too many attempts. Wait fifteen minutes and try again.')
  }
  if (recheck === 'wrong') return err(400, 'Current password is incorrect')

  const newHash = await bcrypt.hash(newPassword, 12)

  await db.transaction(async (tx) => {
    await tx.update(users).set({ passwordHash: newHash }).where(eq(users.id, caller.id))
    await revokeAllSessionsOf(caller.id, caller.id, 'Password changed', tx, caller.sessionId)
  })

  return ok(undefined)
}
