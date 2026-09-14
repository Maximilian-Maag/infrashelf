import { NextResponse } from 'next/server'
import { type LoginRequest, type PasswordCheckResult, isMfaChallenge } from '@infrashelf/types'

/**
 * Step one of a two-step sign-in (issue #36).
 *
 * Why this route exists at all: NextAuth's `authorize` can only say yes or no, so
 * a sign-in that needs a second factor comes back as `CredentialsSignin` —
 * indistinguishable from a wrong password. The form has to know which of the two
 * happened before it can ask for a code, and this is the only thing that tells
 * it.
 *
 * It asks with `challengeOnly`, so the backend checks the password and mints
 * NOTHING: no session token — which outside NextAuth would be a bearer token in
 * JavaScript's reach with no cookie, no expiry handling and no sign-out — and,
 * since #37, no `sessions` row either, which would otherwise show up in the
 * user's own session list as a device that does not exist. The form completes
 * through `signIn` as it always did.
 *
 * That costs one extra password check for accounts without a second factor, which
 * is a bcrypt compare — the account's rate-limit bucket is reset on success, so it
 * does not eat into the attempt allowance, and a FAILED sign-in never reaches the
 * second call at all.
 *
 * The only thing this route ever returns to the browser is "a code is needed" and
 * the challenge, which is useless without a code.
 */
const API_URL = process.env.API_URL ?? process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:3001'

export async function POST(req: Request) {
  const body = await req.json().catch(() => null)

  /*
   * Passwordless step one (#241): the WebAuthn options for a ceremony that names
   * nobody. No email, no password — the authenticator decides who is signing in.
   *
   * HERE rather than in a route of its own, for the three reasons the block
   * below already gives for folding the second-factor options in: a new frontend
   * /api route has to be exempted from the middleware matcher (an endpoint that
   * is part of signing in cannot require being signed in — #36) and taught to
   * both reverse-proxy configs, or it reaches the backend and 404s (#196).
   *
   * And NOT through `/api/proxy`, which is where this was originally written and
   * was wrong: that route checks the session and answers 401 to anyone without
   * one. The login form is unauthenticated by definition, so the button failed
   * for every user. It was invisible to the unit test, which stubs `fetch`, and
   * to e2e, which has no authenticator to click it with — it showed up the first
   * time the deployed page was asked for options.
   */
  if ((body as { passwordless?: unknown } | null)?.passwordless === true) {
    try {
      const opt = await fetch(`${API_URL}/api/auth/webauthn/options`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        cache: 'no-store',
      })
      if (!opt.ok) {
        return NextResponse.json({ ok: false, error: 'Sign-in failed' }, { status: opt.status })
      }
      // The options themselves: a random challenge and the RP id, and nothing
      // about any account. There is nothing here to withhold from a caller who
      // is not signed in — that is the point of the ceremony.
      return NextResponse.json(await opt.json())
    } catch {
      return NextResponse.json({ ok: false, error: 'The server could not be reached.' }, { status: 502 })
    }
  }

  const email = typeof (body as LoginRequest | null)?.email === 'string' ? (body as LoginRequest).email : ''
  const password =
    typeof (body as LoginRequest | null)?.password === 'string' ? (body as LoginRequest).password : ''
  // Passed straight through so the backend can seal it into the challenge; the
  // second step never gets to state it again (#37).
  const rememberMe = (body as LoginRequest | null)?.rememberMe === true
  if (!email || !password) {
    return NextResponse.json({ ok: false, error: 'Invalid request' }, { status: 400 })
  }

  let res: Response
  try {
    res = await fetch(`${API_URL}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password, rememberMe, challengeOnly: true } satisfies LoginRequest),
      cache: 'no-store',
    })
  } catch {
    return NextResponse.json({ ok: false, error: 'The server could not be reached.' }, { status: 502 })
  }

  if (!res.ok) {
    const detail = (await res.json().catch(() => null)) as { error?: string } | null
    // The status is passed through so the form can tell "wrong password" (401)
    // from "too many attempts" (429); the message is the backend's own, which is
    // already written for a user to read.
    return NextResponse.json({ ok: false, error: detail?.error ?? 'Sign-in failed' }, { status: res.status })
  }

  const data = (await res.json()) as PasswordCheckResult
  if (isMfaChallenge(data)) {
    // The WebAuthn request options ride along with the challenge rather than
    // costing a second pre-auth round trip (#197 part 2).
    //
    // The alternative was another frontend /api route, and that is three more
    // places to get right: the middleware matcher has to exempt it (an endpoint
    // that is part of signing in cannot require being signed in — #36), and both
    // reverse-proxy configs have to learn it, or it reaches the backend and 404s
    // (#196). Folding it in here costs one row per correct password on an account
    // that holds a key, which the next ceremony replaces anyway.
    //
    // Failing to build them is not a failed sign-in: the account may still have
    // an authenticator app, and `methods` is what the form reads to decide.
    let webauthnOptions: unknown = null
    if (data.methods?.includes('webauthn')) {
      try {
        const opt = await fetch(`${API_URL}/api/auth/login/webauthn/options`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ mfaToken: data.mfaToken }),
          cache: 'no-store',
        })
        if (opt.ok) webauthnOptions = await opt.json()
      } catch {
        // Left null; the form falls back to whatever else `methods` offers.
      }
    }
    return NextResponse.json({
      ok: true,
      mfaRequired: true,
      mfaToken: data.mfaToken,
      methods: data.methods ?? [],
      webauthnOptions,
    })
  }

  // Nothing to pass on and nothing to discard: `challengeOnly` opened no session.
  return NextResponse.json({ ok: true, mfaRequired: false })
}
