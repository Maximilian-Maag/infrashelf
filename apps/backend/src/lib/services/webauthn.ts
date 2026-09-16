import { and, eq } from 'drizzle-orm'
import {
  generateRegistrationOptions,
  verifyRegistrationResponse,
  generateAuthenticationOptions,
  verifyAuthenticationResponse,
  type AuthenticationResponseJSON,
  type RegistrationResponseJSON,
  type AuthenticatorTransportFuture,
} from '@simplewebauthn/server'
import { db } from '@/lib/db/client'
import { webauthnChallenges, webauthnCredentials, webauthnLoginChallenges } from '@/lib/db/schema'
import { logAudit } from '@/lib/audit'
import { ok, err, type Result } from '@/lib/services/result'
import { resolveRp } from '@/lib/auth/webauthnConfig'
import { recheckPassword } from '@/lib/auth/passwordRecheck'
import {
  canHoldSecondFactor,
  countUnusedRecoveryCodes,
  hasConfirmedTotp,
  loadTwoFactorAccount,
  replaceRecoveryCodes,
} from '@/lib/services/twoFactor'

/**
 * WebAuthn/FIDO2 as a second factor (issue #197, part 2).
 *
 * What this buys over the TOTP in `twoFactor.ts` is not convenience. An assertion
 * is signed over the origin the browser was actually on, and the server checks
 * it — so a user who has been walked onto a lookalike domain cannot produce one
 * that verifies here. A six-digit code can be typed into anything that asks for
 * it, and #196 is a standing reminder that people do end up on the wrong host.
 *
 * The rules, in one place:
 *
 *   0. Same role gate as TOTP. `loadTwoFactorAccount` decides who may hold a
 *      factor, and this module calls it rather than re-deciding.
 *   1. A challenge is used exactly once. It lives in `webauthn_challenges` and is
 *      deleted when it is spent — see `consumeChallenge`.
 *   2. A registration challenge can never be redeemed as an authentication one.
 *      Registration happens inside an authenticated session; letting the two
 *      swap would mean a second factor proved by a session that never passed one.
 *   3. Recovery codes are shared with TOTP, and registering a FIRST factor of
 *      either kind issues them.
 *   4. A credential can be removed, unlike a confirmed TOTP secret — but never
 *      the last factor an account has. See `removeCredential`.
 */

/** Long enough to find the key in a drawer, short enough to be uninteresting. */
export const WEBAUTHN_CHALLENGE_TTL_MS = 5 * 60 * 1000

const REGISTER = 'register'
const AUTHENTICATE = 'authenticate'

/** Bounded so a label cannot be used to store something else. */
export const CREDENTIAL_LABEL_MAX = 64

// The option objects the library builds. Named from its own return types rather
// than re-declared, so a library upgrade that changes their shape is a
// compile error here instead of a lie in the signature.
export type PublicKeyCredentialCreationOptionsJSON = Awaited<ReturnType<typeof generateRegistrationOptions>>
export type PublicKeyCredentialRequestOptionsJSON = Awaited<ReturnType<typeof generateAuthenticationOptions>>

export interface CredentialSummary {
  id: number
  label: string
  createdAt: Date
  lastUsedAt: Date | null
  /** A synced passkey rather than one bound to a single device. */
  backedUp: boolean
}

/**
 * Did the authenticator store a discoverable credential (#241)?
 *
 * `credProps.rk` is the authenticator's own answer to the `credProps` extension
 * requested at registration. It is optional in every direction: an authenticator
 * may not implement the extension, and a browser may not surface it.
 *
 * Absent is read as NOT discoverable, deliberately. The cost of being wrong in
 * that direction is that a key which could have done passwordless is only
 * offered as a second factor; the cost the other way is a sign-in button that
 * fails at the authenticator with nothing to say why.
 */
const isDiscoverable = (response: RegistrationResponseJSON): boolean =>
  response.clientExtensionResults?.credProps?.rk === true

const asTransports = (value: unknown): AuthenticatorTransportFuture[] =>
  Array.isArray(value) ? (value.filter((t) => typeof t === 'string') as AuthenticatorTransportFuture[]) : []

/** The credentials this account holds, newest last so the list reads as a history. */
export const listCredentials = async (userId: number): Promise<CredentialSummary[]> => {
  const rows = await db
    .select({
      id: webauthnCredentials.id,
      label: webauthnCredentials.label,
      createdAt: webauthnCredentials.createdAt,
      lastUsedAt: webauthnCredentials.lastUsedAt,
      backedUp: webauthnCredentials.backedUp,
    })
    .from(webauthnCredentials)
    .where(eq(webauthnCredentials.userId, userId))
    .orderBy(webauthnCredentials.createdAt)
  return rows
}

const storeChallenge = async (userId: number, challenge: string, kind: string): Promise<void> => {
  const expiresAt = new Date(Date.now() + WEBAUTHN_CHALLENGE_TTL_MS)
  await db
    .insert(webauthnChallenges)
    .values({ userId, challenge, kind, expiresAt })
    // Starting a ceremony replaces any other in flight for this account. Two
    // outstanding challenges is not a case worth supporting, and the replacement
    // invalidating the first is the safer half of that.
    .onConflictDoUpdate({
      target: webauthnChallenges.userId,
      set: { challenge, kind, expiresAt, createdAt: new Date() },
    })
}

/**
 * Take the challenge and destroy it in one statement.
 *
 * The DELETE is the claim: it returns the row only to whoever won it, so two
 * requests racing on one challenge cannot both proceed. Doing it as a SELECT then
 * a DELETE would leave exactly that window, and "usable once" is the property a
 * WebAuthn challenge has to have.
 *
 * `kind` is part of the WHERE rather than checked afterwards, so a registration
 * challenge presented to the authentication path matches nothing at all.
 */
const consumeChallenge = async (userId: number, kind: string): Promise<string | null> => {
  const [row] = await db
    .delete(webauthnChallenges)
    .where(and(eq(webauthnChallenges.userId, userId), eq(webauthnChallenges.kind, kind)))
    .returning({ challenge: webauthnChallenges.challenge, expiresAt: webauthnChallenges.expiresAt })
  if (!row) return null
  // Expired is the same as absent to the caller — but it still had to be deleted,
  // which the DELETE above has done.
  if (row.expiresAt.getTime() <= Date.now()) return null
  return row.challenge
}

// ---------------------------------------------------------------------------
// registration
// ---------------------------------------------------------------------------

/**
 * Start registering a key for an authenticated user.
 *
 * `excludeCredentials` is what stops the same authenticator being registered
 * twice: the browser refuses rather than creating a second credential the user
 * cannot tell apart from the first.
 *
 * No password is re-checked here, unlike `startEnrollment` for TOTP. The
 * difference is what the ceremony costs an attacker: registering a key requires
 * physically touching one, so a stolen session alone cannot add a factor and
 * then use it.
 *
 * That argument covers registration and NOT removal, which needs no hardware and
 * currently re-checks nothing either — see `removeCredential`, and issue #231.
 */
export const startRegistration = async (
  userId: number,
  shopName: string,
): Promise<Result<PublicKeyCredentialCreationOptionsJSON>> => {
  const account = await loadTwoFactorAccount(userId)
  if (!account.ok) return account

  const rp = resolveRp(shopName)
  const existing = await db
    .select({ credentialId: webauthnCredentials.credentialId, transports: webauthnCredentials.transports })
    .from(webauthnCredentials)
    .where(eq(webauthnCredentials.userId, userId))

  const options = await generateRegistrationOptions({
    rpName: rp.rpName,
    rpID: rp.rpId,
    userName: account.data.email,
    userDisplayName: account.data.email,
    // The account this credential belongs to, as bytes the authenticator stores.
    // The database id and not the email: an email can be changed, and a resident
    // credential would then name an account that no longer exists under it.
    userID: new TextEncoder().encode(String(userId)),
    attestationType: 'none',
    excludeCredentials: existing.map((c) => ({
      id: c.credentialId,
      transports: asTransports(c.transports),
    })),
    authenticatorSelection: {
      // Still not REQUIRED, even though #241 wants discoverable credentials:
      // demanding a resident key rules out a lot of older hardware keys, and
      // those are perfectly good second factors. The authenticator decides, and
      // `credProps` below reports what it decided — so a modern passkey becomes
      // usable for passwordless sign-in automatically, and an older key keeps
      // working as the second factor it always was.
      residentKey: 'preferred',
      userVerification: 'preferred',
    },
    /*
     * Ask the authenticator to say whether it made the credential DISCOVERABLE
     * (#241). It is the only way to find out: the answer cannot be derived from
     * the credential afterwards, and `residentKey: 'preferred'` means it genuinely
     * varies by authenticator.
     *
     * Recorded on the row by `finishRegistration`, because a passwordless
     * ceremony offers no `allowCredentials` and a non-discoverable credential
     * simply will not appear in it — so the UI has to know which is which rather
     * than offering a button the key silently fails to answer.
     */
    extensions: { credProps: true },
    timeout: WEBAUTHN_CHALLENGE_TTL_MS,
  })

  await storeChallenge(userId, options.challenge, REGISTER)
  return ok(options)
}

/** What the browser produced, plus the name the user gave the key. */
export interface FinishRegistrationInput {
  response: RegistrationResponseJSON
  label: string
}

export const finishRegistration = async (
  userId: number,
  input: FinishRegistrationInput,
  shopName: string,
): Promise<Result<{ label: string; recoveryCodes?: string[] }>> => {
  const account = await loadTwoFactorAccount(userId)
  if (!account.ok) return account

  const label = input.label.trim()
  if (label === '' || label.length > CREDENTIAL_LABEL_MAX) {
    return err(400, `Give the key a name of up to ${CREDENTIAL_LABEL_MAX} characters.`)
  }

  const challenge = await consumeChallenge(userId, REGISTER)
  if (!challenge) return err(400, 'This registration has expired. Start again.')

  const rp = resolveRp(shopName)
  let verification
  try {
    verification = await verifyRegistrationResponse({
      response: input.response,
      expectedChallenge: challenge,
      expectedOrigin: rp.origins,
      expectedRPID: rp.rpId,
      requireUserVerification: false,
    })
  } catch (e) {
    // The library throws on a malformed or mismatched response. That is a failed
    // registration, not a server fault, so it is a 400 — but it is worth logging,
    // because an origin mismatch here is a configuration error that looks
    // identical to a user cancelling.
    console.error(`[webauthn] Registration verification failed for user #${userId}:`, e)
    await logAudit(userId, 'auth.webauthn.register_failed', userId, 'Registration response rejected')
    return err(400, 'That security key could not be registered. Check the browser and try again.')
  }

  if (!verification.verified || !verification.registrationInfo) {
    await logAudit(userId, 'auth.webauthn.register_failed', userId, 'Registration response not verified')
    return err(400, 'That security key could not be registered.')
  }

  const { credential, credentialBackedUp, credentialDeviceType } = verification.registrationInfo

  // A first factor of either kind issues recovery codes; a second one must not.
  // Reissuing here would silently invalidate the codes the user already wrote
  // down, which is the one piece of paper standing between them and an operator
  // with database access.
  const isFirstFactor =
    (await countWebauthnCredentialsFor(userId)) === 0 && !(await hasConfirmedTotp(userId))

  let recoveryCodes: string[] | undefined
  await db.transaction(async (tx) => {
    await tx.insert(webauthnCredentials).values({
      userId,
      credentialId: credential.id,
      publicKey: Buffer.from(credential.publicKey).toString('base64url'),
      counter: credential.counter,
      transports: input.response.response.transports ?? [],
      label,
      backedUp: credentialBackedUp,
      deviceType: credentialDeviceType,
      discoverable: isDiscoverable(input.response),
    })
    if (isFirstFactor) recoveryCodes = await replaceRecoveryCodes(userId, tx)
  })

  await logAudit(
    userId,
    'auth.webauthn.registered',
    userId,
    `Security key "${label}" registered${isFirstFactor ? '; recovery codes issued' : ''}`,
  )
  return ok({ label, ...(recoveryCodes ? { recoveryCodes } : {}) })
}

// ---------------------------------------------------------------------------
// authentication
// ---------------------------------------------------------------------------

/**
 * Options for the login step, for a user whose password has already been checked.
 *
 * `allowCredentials` names only this account's keys, so the browser prompts for
 * one the user actually has rather than offering everything it knows about.
 */
export const startAuthentication = async (
  userId: number,
  shopName: string,
): Promise<Result<PublicKeyCredentialRequestOptionsJSON>> => {
  const credentials = await db
    .select({ credentialId: webauthnCredentials.credentialId, transports: webauthnCredentials.transports })
    .from(webauthnCredentials)
    .where(eq(webauthnCredentials.userId, userId))
  if (credentials.length === 0) return err(400, 'This account has no security key registered.')

  const rp = resolveRp(shopName)
  const options = await generateAuthenticationOptions({
    rpID: rp.rpId,
    allowCredentials: credentials.map((c) => ({
      id: c.credentialId,
      transports: asTransports(c.transports),
    })),
    userVerification: 'preferred',
    timeout: WEBAUTHN_CHALLENGE_TTL_MS,
  })

  await storeChallenge(userId, options.challenge, AUTHENTICATE)
  return ok(options)
}

/**
 * Check an assertion. The caller opens the session; this only says yes or no.
 *
 * Returns the same `Result` shape the TOTP path does so `completeMfaLogin` can
 * treat the two identically.
 */
export const verifyAuthentication = async (
  userId: number,
  response: AuthenticationResponseJSON,
  shopName: string,
): Promise<Result<{ recoveryCodesRemaining: number }>> => {
  const challenge = await consumeChallenge(userId, AUTHENTICATE)
  if (!challenge) return err(401, 'This sign-in attempt has expired. Start again.')

  const [stored] = await db
    .select()
    .from(webauthnCredentials)
    .where(
      and(eq(webauthnCredentials.userId, userId), eq(webauthnCredentials.credentialId, response.id)),
    )
    .limit(1)
  // The credential must belong to THIS account. Without the user_id in the WHERE,
  // a valid assertion from anybody's key would satisfy a challenge issued for
  // somebody else's password.
  if (!stored) {
    await logAudit(userId, 'auth.webauthn.login_failed', userId, 'Assertion for an unknown credential')
    return err(401, 'That security key is not registered for this account.')
  }

  const rp = resolveRp(shopName)
  let verification
  try {
    verification = await verifyAuthenticationResponse({
      response,
      expectedChallenge: challenge,
      expectedOrigin: rp.origins,
      expectedRPID: rp.rpId,
      credential: {
        id: stored.credentialId,
        publicKey: new Uint8Array(Buffer.from(stored.publicKey, 'base64url')),
        counter: stored.counter,
        transports: asTransports(stored.transports),
      },
      requireUserVerification: false,
    })
  } catch (e) {
    console.error(`[webauthn] Authentication verification failed for user #${userId}:`, e)
    await logAudit(userId, 'auth.webauthn.login_failed', userId, 'Assertion rejected')
    return err(401, 'That security key could not be verified.')
  }

  if (!verification.verified) {
    await logAudit(userId, 'auth.webauthn.login_failed', userId, 'Assertion not verified')
    return err(401, 'That security key could not be verified.')
  }

  // The counter only ever goes up. A value at or below what we stored means two
  // authenticators are answering for one credential — a clone — EXCEPT when the
  // authenticator does not implement a counter at all and reports a constant 0,
  // which every passkey and much modern hardware does. So: enforce it when there
  // is a counter to enforce, and say nothing when there is not. Pretending
  // otherwise would either lock out most users or claim a guarantee we do not
  // have.
  const { newCounter } = verification.authenticationInfo
  if (stored.counter > 0 && newCounter <= stored.counter) {
    await logAudit(
      userId,
      'auth.webauthn.login_failed',
      userId,
      `Signature counter did not advance (stored ${stored.counter}, presented ${newCounter}) — possible cloned authenticator`,
    )
    return err(401, 'That security key could not be verified.')
  }

  await db
    .update(webauthnCredentials)
    .set({ counter: newCounter, lastUsedAt: new Date() })
    .where(eq(webauthnCredentials.id, stored.id))

  await logAudit(userId, 'auth.webauthn.login', userId, `Signed in with security key "${stored.label}"`)
  return ok({ recoveryCodesRemaining: await countUnusedRecoveryCodes(userId) })
}

// ---------------------------------------------------------------------------
// passwordless (#241)
// ---------------------------------------------------------------------------

/**
 * Options for a sign-in that names nobody.
 *
 * The difference from `startAuthentication` is the whole feature: no
 * `allowCredentials`, so the browser offers whatever discoverable credential it
 * holds for this RP ID and the authenticator decides which account answers.
 *
 * `userVerification: 'required'`, and this is what makes the ceremony two
 * factors rather than one. There is no password in front of it, so the PIN or
 * biometric the authenticator collects IS the second factor — something you
 * have, plus something you know or are. `verifyPasswordlessAuthentication`
 * enforces the same thing on the way back in, because an option is a request
 * and only the verify is a check.
 *
 * Takes no user and so needs no account to exist. It deliberately does not say
 * whether any discoverable credential is registered: answering that for an
 * unauthenticated caller would turn this into an oracle for which accounts have
 * keys.
 */
export const startPasswordlessAuthentication = async (
  shopName: string,
): Promise<Result<PublicKeyCredentialRequestOptionsJSON>> => {
  const rp = resolveRp(shopName)
  const options = await generateAuthenticationOptions({
    rpID: rp.rpId,
    // No allowCredentials at all — not an empty array, which some authenticators
    // treat as "nothing is acceptable" rather than "anything is".
    userVerification: 'required',
    timeout: WEBAUTHN_CHALLENGE_TTL_MS,
  })

  await db.insert(webauthnLoginChallenges).values({
    challenge: options.challenge,
    expiresAt: new Date(Date.now() + WEBAUTHN_CHALLENGE_TTL_MS),
  })

  return ok(options)
}

/**
 * Claim a passwordless challenge and destroy it, in one statement.
 *
 * The same claim `consumeChallenge` makes for the keyed table, for the same
 * reason: the DELETE returns the row only to whoever won it, so two requests
 * replaying one assertion cannot both proceed.
 */
const consumeLoginChallenge = async (challenge: string): Promise<boolean> => {
  const [row] = await db
    .delete(webauthnLoginChallenges)
    .where(eq(webauthnLoginChallenges.challenge, challenge))
    .returning({ expiresAt: webauthnLoginChallenges.expiresAt })
  if (!row) return false
  return row.expiresAt.getTime() > Date.now()
}

/**
 * The challenge the browser actually signed over, read out of the client data.
 *
 * Needed because the challenge is the key to the store, and unlike every other
 * ceremony here there is no user id to look it up by. Parsed rather than trusted:
 * nothing is decided on this value except WHICH row to claim, and
 * `verifyAuthenticationResponse` re-checks that the claimed challenge is the one
 * signed over. A forged value simply matches no row.
 */
const challengeFromClientData = (clientDataJSON: string): string | null => {
  try {
    const parsed: unknown = JSON.parse(Buffer.from(clientDataJSON, 'base64url').toString('utf8'))
    const challenge = (parsed as { challenge?: unknown }).challenge
    return typeof challenge === 'string' && challenge.length > 0 ? challenge : null
  } catch {
    return null
  }
}

/** The account an assertion resolved to. The caller opens the session. */
export interface PasswordlessAssertion {
  userId: number
  label: string
}

/**
 * Check an assertion that named no account, and say whose it was.
 *
 * The account comes from the credential, which is unique across the table, and
 * is then cross-checked against the user handle the authenticator returned. Both
 * have to agree. The handle is the user id as `startRegistration` wrote it —
 * the database id and not the email, precisely so a resident credential cannot
 * come to name an account that no longer exists under it.
 *
 * Every refusal below answers the same way, and says nothing about whether the
 * credential, the account or the state was the problem. An unauthenticated
 * caller learning "that key is registered but the account is deactivated" is an
 * account oracle, and this endpoint takes no password to rate-limit against.
 */
export const verifyPasswordlessAuthentication = async (
  response: AuthenticationResponseJSON,
  shopName: string,
): Promise<Result<PasswordlessAssertion>> => {
  const refused = () => err(401, 'That security key could not be used to sign in.')

  const presented = challengeFromClientData(response.response.clientDataJSON)
  if (!presented) return refused()
  if (!(await consumeLoginChallenge(presented))) return refused()

  const [stored] = await db
    .select()
    .from(webauthnCredentials)
    .where(eq(webauthnCredentials.credentialId, response.id))
    .limit(1)
  if (!stored) return refused()

  /*
   * The user handle has to agree with the credential.
   *
   * The credential id already identifies the account — it is unique across the
   * table — so this is belt and braces. It is cheap, and it is the check that
   * would catch a credential row whose user_id had been changed underneath a
   * handle the authenticator still holds.
   *
   * Absent is allowed: `userHandle` is optional on an assertion, and a
   * credential registered before this feature may not carry one.
   */
  const handle = response.response.userHandle
  if (handle !== undefined && handle !== null && handle !== '') {
    const decoded = Buffer.from(handle, 'base64url').toString('utf8')
    if (decoded !== String(stored.userId)) {
      await logAudit(
        stored.userId,
        'auth.webauthn.login_failed',
        stored.userId,
        'Passwordless assertion whose user handle did not match its credential',
      )
      return refused()
    }
  }

  const rp = resolveRp(shopName)
  let verification
  try {
    verification = await verifyAuthenticationResponse({
      response,
      expectedChallenge: presented,
      expectedOrigin: rp.origins,
      expectedRPID: rp.rpId,
      credential: {
        id: stored.credentialId,
        publicKey: new Uint8Array(Buffer.from(stored.publicKey, 'base64url')),
        counter: stored.counter,
        transports: asTransports(stored.transports),
      },
      /*
       * REQUIRED here, unlike the second-factor path, and this is the decision
       * that makes passwordless defensible: with no password in front of it the
       * authenticator's PIN or biometric is the only other factor there is. The
       * second-factor path can afford `false` because a password was already
       * checked.
       */
      requireUserVerification: true,
    })
  } catch (e) {
    console.error(`[webauthn] Passwordless verification failed for user #${stored.userId}:`, e)
    await logAudit(stored.userId, 'auth.webauthn.login_failed', stored.userId, 'Passwordless assertion rejected')
    return refused()
  }

  if (!verification.verified) {
    await logAudit(stored.userId, 'auth.webauthn.login_failed', stored.userId, 'Passwordless assertion not verified')
    return refused()
  }

  // Same clone check as the second-factor path, and for the same reason: enforce
  // the counter where there is one, say nothing where the authenticator reports
  // a constant 0, which every passkey does.
  const { newCounter } = verification.authenticationInfo
  if (stored.counter > 0 && newCounter <= stored.counter) {
    await logAudit(
      stored.userId,
      'auth.webauthn.login_failed',
      stored.userId,
      `Signature counter did not advance (stored ${stored.counter}, presented ${newCounter}) — possible cloned authenticator`,
    )
    return refused()
  }

  await db
    .update(webauthnCredentials)
    .set({
      counter: newCounter,
      lastUsedAt: new Date(),
      // Proof, not inference: it just answered a ceremony with no
      // `allowCredentials`, so it is discoverable whatever `credProps` said (or
      // failed to say) when it was registered. This is how a key registered
      // before #241 earns its flag.
      discoverable: true,
    })
    .where(eq(webauthnCredentials.id, stored.id))

  return ok({ userId: stored.userId, label: stored.label })
}

// ---------------------------------------------------------------------------
// removal
// ---------------------------------------------------------------------------

/**
 * Remove one key.
 *
 * Unlike a confirmed TOTP secret, a credential CAN be removed — it has to be,
 * because a lost key that stays registered is an `allowCredentials` entry
 * prompting for something the user no longer has.
 *
 * What cannot happen is removing the last factor. #197 makes a second factor
 * mandatory for administrators, so an account that removed its only key would
 * sign in and immediately be refused everything — the "enrol" state, reached by
 * deleting rather than by never having enrolled. Refusing here says so while the
 * user can still act on it.
 *
 * **A session is all this asks for.** Unlike registration, removal needs no
 * hardware, so a stolen session can strip a victim's spare keys down to the last
 * one the guard above protects — and for a role that `canHoldSecondFactor`
 * excludes, down to none. Re-checking the password here is the fix; it changes
 * the request shape, so it is issue #231 rather than a quiet edit inside #197.
 */
/**
 * Remove one security key, on proof of the account password (#231).
 *
 * `startRegistration` deliberately does NOT re-check the password, and gives a
 * good reason: registering a key requires physically touching one, so a stolen
 * session alone cannot add a factor and then use it. That argument covers
 * registration. It does not cover REMOVAL, which needs no hardware — so a stolen
 * session could strip a victim's spare keys one at a time, leaving the
 * recommended primary-plus-backup setup with no backup, and the owner finding out
 * only when they reached for it.
 *
 * Note the direction it was wrong in: a confirmed TOTP secret cannot be removed
 * at all, so the weaker factor was the better-protected one.
 *
 * The check lives here rather than in the route, like `startEnrollment`'s: it is
 * what makes the gate hold for any other caller. SSO accounts never reach it —
 * `loadTwoFactorAccount` refuses them, because their second factor is the
 * identity provider's to manage and there is no local password to prove.
 */
export const removeCredential = async (
  userId: number,
  credentialRowId: number,
  password: string,
): Promise<Result<{ removed: number }>> => {
  const account = await loadTwoFactorAccount(userId)
  if (!account.ok) return account

  /*
   * The counter this shares with 2FA enrolment and `changePassword`.
   *
   * It had its own until this branch, which was a budget of five HERE and five
   * at each of the others — fifteen to anyone willing to alternate between the
   * doors, and the attacker picks the door. The account is what is under
   * attack, so the account is what holds the budget. See
   * `lib/auth/passwordRecheck.ts`.
   */
  const recheck = await recheckPassword(userId, password, account.data.passwordHash)

  if (recheck === 'throttled') {
    await logAudit(
      userId,
      'auth.webauthn.remove_denied',
      userId,
      'Security key removal refused: too many wrong passwords',
    )
    return err(429, 'Too many attempts. Wait fifteen minutes and try again.')
  }

  if (recheck === 'wrong') {
    await logAudit(
      userId,
      'auth.webauthn.remove_denied',
      userId,
      'Security key removal refused: wrong password',
    )
    return err(403, 'Current password is incorrect')
  }

  const remaining = (await countWebauthnCredentialsFor(userId)) - 1
  if (remaining === 0 && !(await hasConfirmedTotp(userId)) && canHoldSecondFactor(account.data.role)) {
    return err(
      409,
      'This is the only second factor on the account, and administrators must have one. ' +
        'Register another key or set up an authenticator app first.',
    )
  }

  const [removed] = await db
    .delete(webauthnCredentials)
    .where(and(eq(webauthnCredentials.userId, userId), eq(webauthnCredentials.id, credentialRowId)))
    .returning({ label: webauthnCredentials.label })
  if (!removed) return err(404, 'No such security key on this account.')

  await logAudit(userId, 'auth.webauthn.removed', userId, `Security key "${removed.label}" removed`)
  return ok({ removed: credentialRowId })
}

// ---------------------------------------------------------------------------

const countWebauthnCredentialsFor = async (userId: number): Promise<number> =>
  (await listCredentials(userId)).length

/** Re-exported so route handlers do not have to reach into the library. */
export type { RegistrationResponseJSON, AuthenticationResponseJSON }
