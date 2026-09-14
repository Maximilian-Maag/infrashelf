import { type NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import { loginWithPasswordlessWebauthn } from '@/lib/services/auth'
import type { AuthenticationResponseJSON } from '@/lib/services/webauthn'
import { getBranding } from '@/lib/services/admin/branding'
import { totpIssuer } from '@/lib/services/twoFactor'
import { clientIp, clientUserAgent } from '@/lib/auth/requestMeta'
import { createRateLimitBucket } from '@/lib/rateLimit'
import { toResponse } from '@/lib/http'

/**
 * Trade a passwordless assertion for a session (#241).
 *
 * This is the one endpoint in the WebAuthn set that mints a session on its own.
 * `/api/auth/login/mfa` has a password behind it and `/api/users/me/webauthn/*`
 * all require a session; this has neither, so everything it needs to be sure of
 * is checked inside `loginWithPasswordlessWebauthn` rather than here.
 *
 * The assertion is passed through unvalidated in shape beyond "an object with an
 * id": SimpleWebAuthn is what parses it, and a schema here would be a second,
 * weaker description of a format the library already owns. `id` is checked only
 * because it is what the credential lookup keys on.
 */
const VerifySchema = z.object({
  response: z.object({ id: z.string().min(1) }).passthrough(),
  rememberMe: z.boolean().optional(),
})

/*
 * Per-IP only — there is no account identifier until the assertion verifies, and
 * by then the expensive part is done.
 *
 * Deliberately modest. Forging an assertion is not a guessing game: without the
 * private key an attacker cannot produce one at any rate, so this is here to cap
 * the work a stranger can make the server do (a signature verification and a
 * credential lookup each), not to protect a secret.
 *
 * Same known limit as the login route: an in-process Map, so per backend
 * process, and no bucket at all without `TRUST_PROXY`.
 */
const verifyLimit = createRateLimitBucket(30, 15 * 60 * 1000)

export async function POST(req: NextRequest) {
  const body = await req.json().catch(() => null)
  const parsed = VerifySchema.safeParse(body)
  if (!parsed.success) {
    return NextResponse.json({ error: 'Invalid request' }, { status: 400 })
  }

  const addr = clientIp(req)
  if (addr !== null && verifyLimit.isRateLimited(`ip|${addr}`)) {
    return NextResponse.json(
      { error: 'Too many sign-in attempts. Wait a few minutes and try again.' },
      { status: 429 },
    )
  }

  const branding = await getBranding()
  const shopName = totpIssuer(branding.ok ? branding.data.shopName : null)

  return toResponse(
    await loginWithPasswordlessWebauthn(
      parsed.data.response as unknown as AuthenticationResponseJSON,
      shopName,
      {
        ip: clientIp(req),
        userAgent: clientUserAgent(req),
        rememberMe: parsed.data.rememberMe ?? false,
      },
    ),
  )
}
