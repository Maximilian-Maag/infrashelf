import NextAuth, { CredentialsSignin } from 'next-auth'
import Credentials from 'next-auth/providers/credentials'
import {
  type LoginRequest,
  type LoginResponse,
  type LoginResult,
  type MfaLoginRequest,
  type Role,
  isMfaChallenge,
} from '@infrashelf/types'
import { SESSION_COOKIE_MAX_AGE_SECONDS, apiTokenExpiry } from '@/lib/session'
import { MFA_LOCKED_OUT } from '@/lib/loginErrors'

/**
 * The second factor is locked after repeated failures, and the user has to wait
 * or use a recovery code.
 *
 * Thrown rather than returned as `null`, because `null` is how every other
 * failure leaves `authorize` and the form cannot tell them apart afterwards. The
 * `code` is what reaches the browser; the backend's own "try again in N minutes"
 * stays on the server, where it belongs — it is English-only and would land in a
 * URL. See lib/loginErrors.ts.
 */
class SecondFactorLockedOut extends CredentialsSignin {
  code = MFA_LOCKED_OUT
}

const API_URL = process.env.API_URL ?? 'http://localhost:3001'

/**
 * IMPORTANT: what this returns is what populates the `user` parameter in the
 * `jwt` callback below. Both sign-in paths — with and without a second factor —
 * end here, so the session looks identical either way.
 */
const toAuthUser = (data: LoginResponse) => ({
  id: String(data.user.id),
  email: data.user.email,
  name: data.user.name,
  role: data.user.role,
  apiToken: data.token,
  // Issue #197. Only ever true on the password-only path: an account that HAS a
  // factor cannot owe one, so the two-step branch never sets it.
  mustEnrollSecondFactor: data.mustEnrollSecondFactor === true,
})

export const { handlers, signIn, signOut, auth } = NextAuth({
  trustHost: true,
  providers: [
    Credentials({
      credentials: {
        email: { type: 'email' },
        password: { type: 'password' },
        // Arrives as the string 'true' from signIn(), because credentials are
        // form fields. Anything else means no. Not sent on the second step of a
        // two-step sign-in: the choice was made at the password step and rides
        // inside the challenge, where this request cannot change it (#36, #37).
        rememberMe: { type: 'text' },
        // Second factor (issue #36). Present only on the second call of a
        // two-step sign-in: `mfaToken` is the challenge the backend issued after
        // the password check, and `code` is the TOTP or recovery code.
        mfaToken: { type: 'text' },
        code: { type: 'text' },
        // A WebAuthn assertion, JSON-encoded because NextAuth credentials are
        // form fields and cannot carry an object (#197 part 2). Sent WITH an
        // `mfaToken` as a second factor, and WITHOUT one for a passwordless
        // sign-in (#241) — the absence is what tells the two apart.
        webauthn: { type: 'text' },
      },
      async authorize(credentials) {
        const mfaToken = String(credentials.mfaToken ?? '')
        const code = String(credentials.code ?? '')
        const webauthn = String(credentials.webauthn ?? '')

        // Redeeming a challenge with a security key. Same challenge, same
        // endpoint, different proof — the backend's `SecondFactorProof` is a union
        // so exactly one of the two arrives.
        if (mfaToken && webauthn) {
          let parsed: unknown
          try {
            parsed = JSON.parse(webauthn)
          } catch {
            return null
          }
          const res = await fetch(`${API_URL}/api/auth/login/mfa`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ mfaToken, webauthn: parsed }),
          })
          if (!res.ok) return null
          return toAuthUser(await res.json())
        }

        /*
         * Passwordless (#241): an assertion with NO challenge in front of it.
         *
         * Distinguished from the branch above by the ABSENCE of `mfaToken`,
         * which is the whole difference — there was no password step, so there
         * is no challenge proving one happened. The backend resolves the
         * account from the credential itself and mints the session.
         *
         * `email` is not sent and not needed. Requiring one would defeat the
         * point: the authenticator is what says who is signing in.
         */
        if (webauthn && !mfaToken) {
          let parsed: unknown
          try {
            parsed = JSON.parse(webauthn)
          } catch {
            return null
          }
          const res = await fetch(`${API_URL}/api/auth/webauthn/verify`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              response: parsed,
              rememberMe: String(credentials.rememberMe ?? '') === 'true',
            }),
          })
          if (!res.ok) return null
          return toAuthUser(await res.json())
        }

        // Redeeming a challenge. The password is NOT re-checked here — the
        // challenge is what proves it, and it is bound to the account's current
        // password hash on the backend, so a stale one cannot be redeemed.
        if (mfaToken && code) {
          const res = await fetch(`${API_URL}/api/auth/login/mfa`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ mfaToken, code } satisfies MfaLoginRequest),
          })
          // 429 is the account's second-factor lockout, not a wrong code: the
          // user has to wait or reach for a recovery code, and being told
          // "invalid credentials" would have them do neither.
          if (res.status === 429) throw new SecondFactorLockedOut()
          if (!res.ok) return null
          return toAuthUser(await res.json())
        }

        const res = await fetch(`${API_URL}/api/auth/login`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            email: String(credentials.email ?? ''),
            password: String(credentials.password ?? ''),
            rememberMe: String(credentials.rememberMe ?? '') === 'true',
          } satisfies LoginRequest),
        })

        if (!res.ok) return null
        const data: LoginResult = await res.json()

        // A challenge is not a session. The backend sends no token on this path,
        // so there is nothing to sign in with — refuse, and let the form redeem
        // the challenge on its second call. Getting here means a client skipped
        // the second step, which must not produce a session.
        if (isMfaChallenge(data)) return null

        return toAuthUser(data)
      },
    }),
  ],
  callbacks: {
    // The 'jwt' callback is called first.
    // The 'user' object is only passed on the first call after sign-in.
    jwt({ token, user, trigger, session }) {
      if (user) {
        // Persist the user role and apiToken from the 'authorize' function into the JWT token.
        const u = user as { role: Role; apiToken: string; mustEnrollSecondFactor?: boolean }
        token.role = u.role
        token.apiToken = u.apiToken
        // Carried so the middleware can end the session before making a request
        // that is certain to come back 401 (#103).
        token.apiTokenExp = apiTokenExpiry(u.apiToken)
        // Issue #197: what the middleware redirects on. The backend re-checks it
        // per request, so this being wrong can only ever cost a redirect — never
        // access.
        token.mustEnrollSecondFactor = u.mustEnrollSecondFactor === true
      }

      // Cleared by the enrollment screen calling `update()` once a factor is
      // confirmed. Without this the token would keep saying "outstanding" until
      // the next sign-in, and the middleware would bounce the user back to the
      // screen they just finished. Only ever cleared, never set: nothing the
      // client says can put the flag ON, so this cannot be used to claim an
      // enrollment that did not happen — and the backend would refuse anyway.
      if (trigger === 'update' && (session as { mustEnrollSecondFactor?: boolean } | null)?.mustEnrollSecondFactor === false) {
        token.mustEnrollSecondFactor = false
      }
      return token
    },

    // The 'session' callback is called next.
    // It uses the data from the JWT token to build the final session object passed to the client.
    session({ session, token }) {
      // Ensure the user object exists on the session before modifying it.
      if (session.user) {
        session.user.role = token.role as Role | undefined
        /*
         * NextAuth does not put the user id on the session by itself under the
         * JWT strategy — it lives on the token as `sub`, and `session.user.id`
         * is left undefined unless something copies it.
         *
         * Two pages read it, and both got `undefined`:
         *
         *  - The order comment thread gates Edit and Delete on
         *    `comment.userId === currentUserId`, where `currentUserId` is
         *    `Number(session.user.id)`. `Number(undefined)` is NaN, and NaN
         *    equals nothing — so NOBODY could ever edit or delete their own
         *    comment. The controls simply were not rendered.
         *  - The approvals page decides `ownOrder` the same way, so it offered
         *    Approve on the viewer's own order. The backend refuses that with
         *    403 (`approvals.ts:152`), so it was a broken button rather than a
         *    hole — but a button that cannot work is still a defect.
         *
         * Found by an e2e test that had never run: it skipped for want of data
         * until the database was seeded (#152).
         */
        session.user.id = token.sub ?? ''
      }
      session.apiToken = token.apiToken as string | undefined
      session.apiTokenExp = (token.apiTokenExp as number | null | undefined) ?? undefined
      session.mustEnrollSecondFactor = token.mustEnrollSecondFactor === true
      return session
    },
  },
  // Sized to the LONGEST session the backend will issue, not to a fixed one.
  //
  // #103's bug was a 30-day cookie wrapped around a 24 h token: "signed in" with
  // nothing behind it. #37 makes the lifetime per-session (8 h, or 30 days with
  // "remember me"), so a single number can no longer be the lifetime — it can
  // only be the ceiling. What actually ends a session is the token's own `exp`,
  // carried as `apiTokenExp` and checked by the middleware and the dashboard
  // layout on every request, plus the 401 handling in lib/api.ts for a session
  // that ends early because it was revoked. See lib/session.ts.
  session: { maxAge: SESSION_COOKIE_MAX_AGE_SECONDS },
  pages: { signIn: '/login' },
  secret: process.env.NEXTAUTH_SECRET,
})

