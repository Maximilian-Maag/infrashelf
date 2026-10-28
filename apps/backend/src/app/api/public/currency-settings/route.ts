import { NextResponse } from 'next/server'
import { getCurrencySettings } from '@/lib/services/admin/exchangeRates'

/**
 * The base currency (FA-11.3), read-only and public.
 *
 * The frontend converts every displayed price in the browser, so it needs the
 * base the stored rates are quoted against — without it the helpers fall back to
 * EUR and a non-EUR installation shows every converted figure wrong. Reading the
 * base is therefore not a privilege the way the admin endpoints are: it is the
 * anchor the whole catalogue needs to render a price at all.
 *
 * Only the code is served, never the rate rows — those have their own public
 * endpoint. Writing stays root-only (`/api/admin/exchange-rates/base-currency`).
 */
export async function GET() {
  const result = await getCurrencySettings()
  if (!result.ok) return NextResponse.json({ error: result.message }, { status: result.status })
  return NextResponse.json(result.data)
}
