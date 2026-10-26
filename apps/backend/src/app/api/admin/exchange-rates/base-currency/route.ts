import { type NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import { requireRole, isAuth } from '@/lib/auth/middleware'
import { toResponse } from '@/lib/http'
import { getCurrencySettings, setBaseCurrency } from '@/lib/services/admin/exchangeRates'

/**
 * The base currency (FA-11.3). Root only, both verbs.
 *
 * Reading is root-only as well as writing, like the deployment windows: the base
 * currency decides what every stored price MEANS, and this is money rather than
 * catalogue data. A project manager has no business reading it, and the values
 * they actually see are already converted for them by the catalog and cart.
 */

const BaseCurrencySchema = z.object({
  // Shape only — the service refuses a code whose rate is missing, which is the
  // check that matters (a three-letter code with no rate cannot anchor anything).
  baseCurrency: z.string().min(1).max(8),
})

export async function GET(req: NextRequest) {
  const session = await requireRole('root')(req)
  if (!isAuth(session)) return session

  return toResponse(await getCurrencySettings())
}

export async function PUT(req: NextRequest) {
  const session = await requireRole('root')(req)
  if (!isAuth(session)) return session

  const body = await req.json().catch(() => null)
  const parsed = BaseCurrencySchema.safeParse(body)
  if (!parsed.success) {
    return NextResponse.json({ error: 'Invalid request', details: parsed.error.flatten() }, { status: 400 })
  }

  return toResponse(await setBaseCurrency(parsed.data.baseCurrency, session.id))
}
