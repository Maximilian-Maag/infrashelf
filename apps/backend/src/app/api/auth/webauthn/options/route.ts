import { type NextRequest, NextResponse } from 'next/server'
import { startPasswordlessAuthentication } from '@/lib/services/webauthn'
import { getBranding } from '@/lib/services/admin/branding'
import { totpIssuer } from '@/lib/services/twoFactor'
import { clientIp } from '@/lib/auth/requestMeta'
import { createRateLimitBucket } from '@/lib/rateLimit'
import { toResponse } from '@/lib/http'

/**
 * Start a sign-in that names nobody (#241).
 *
 * Unlike `/api/auth/login/webauthn/options`, this takes no `mfaToken` and no
 * account of any kind: it is the FIRST step, not the middle one. The browser
 * answers with whatever discoverable credential it holds for this RP ID, and
 * `POST /api/auth/webauthn/verify` trades the assertion for a session.
 *
 * It discloses nothing. There is no account to disclose — the response is a
 * random challenge and the RP id, identical for a deployment with one user and
 * one with none.
 */

/*
 * Per-IP only, because there is no account to key on before an assertion exists.
 *
 * The point is not brute force — the response gives an attacker nothing to
 * guess against — it is that every call WRITES a row to
 * `webauthn_login_challenges`, so an unauthenticated endpoint that inserts is
 * worth a cap. Thirty in fifteen minutes is far above a person failing to find
 * their key and far below anything that fills a table.
 *
 * Same known limit as the login route: the counter is an in-process Map, so the
 * cap is per backend process, and without `TRUST_PROXY` there is no trustworthy
 * client address and no bucket at all.
 */
const optionsLimit = createRateLimitBucket(30, 15 * 60 * 1000)

export async function POST(req: NextRequest) {
  const addr = clientIp(req)
  if (addr !== null && optionsLimit.isRateLimited(`ip|${addr}`)) {
    return NextResponse.json(
      { error: 'Too many sign-in attempts. Wait a few minutes and try again.' },
      { status: 429 },
    )
  }

  const branding = await getBranding()
  const shopName = totpIssuer(branding.ok ? branding.data.shopName : null)
  return toResponse(await startPasswordlessAuthentication(shopName))
}
