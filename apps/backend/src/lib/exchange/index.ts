import { db } from '@/lib/db/client'
import { exchangeRates } from '@/lib/db/schema'

interface ExchangeRateApiResponse {
  rates: Record<string, number>
  base?: string
  success?: boolean
}

/**
 * The rates a refresh will write, or a refusal (#554).
 *
 * Three shapes arrive from a server that answered 200: the answer (a map of
 * currency to rate), something that is not the answer at all (a gateway, a changed
 * API, a cached error page) and a map whose entries are not rates. Each of them
 * ends the same way if it is not refused: `exchange_rates` keeps whatever it had,
 * every cost figure in the portal converts through yesterday's numbers, and the
 * caller reports a successful refresh.
 *
 * A refusal is the honest answer because a real one carries 150+ currencies — the
 * empty map is never a legitimate answer, only a shape that looks like one.
 */
const readRates = (raw: unknown): [string, number][] => {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    // An array is worth naming: `typeof [] === 'object'` passed the old check, and
    // `Object.entries([])` is empty — the same nothing, from a body that looks even
    // more like data.
    throw new Error('Invalid exchange rate API response')
  }

  const entries = Object.entries(raw as Record<string, unknown>)
  if (entries.length === 0) {
    throw new Error('The exchange rate API returned no rates')
  }

  return entries.map(([currencyCode, rate]) => {
    // Refused rather than stringified: `String({})` is '[object Object]', which the
    // numeric column rejects in the middle of the loop — the refresh fails having
    // written some of the table, which is worse than not having started.
    if (typeof rate !== 'number' || !Number.isFinite(rate) || rate <= 0) {
      throw new Error(`Invalid exchange rate for ${currencyCode}`)
    }
    return [currencyCode, rate]
  })
}

/**
 * Refresh the stored rates, and say how many were written.
 *
 * The count is returned because the audit line that reports this refresh used to
 * count the ROWS IN THE TABLE: a refresh that wrote nothing still said "152 rate(s)
 * refreshed", which is the same untrue success one layer up (#554).
 */
export const refreshRates = async (): Promise<number> => {
  const apiUrl =
    process.env.EXCHANGE_RATE_API_URL ?? 'https://api.exchangerate.host/latest'

  const res = await fetch(apiUrl)
  if (!res.ok) throw new Error(`Exchange rate fetch failed: ${res.status}`)

  const data = await res.json() as ExchangeRateApiResponse
  const rates = readRates(data.rates)

  const now = new Date()

  // Deliberately not one transaction: the rows are written one statement at a time,
  // and a failure part-way through throws, so the caller reports a failed refresh
  // rather than a successful one over half the table. What a transaction would
  // protect against is a partial write nobody notices, and there is nothing silent
  // left here once an empty or malformed answer is refused above.
  for (const [currencyCode, rate] of rates) {
    await db
      .insert(exchangeRates)
      .values({ currencyCode, rate: String(rate), updatedAt: now })
      .onConflictDoUpdate({
        target: exchangeRates.currencyCode,
        set: { rate: String(rate), updatedAt: now },
      })
  }

  return rates.length
}

export const convertAmount = (
  amount: number,
  from: string,
  to: string,
  rates: Record<string, number>,
): number => {
  if (from === to) return amount

  const fromRate = rates[from]
  const toRate = rates[to]

  if (!fromRate || !toRate) {
    throw new Error(`Exchange rate not found for ${from} or ${to}`)
  }

  // Convert to base then to target
  return (amount / fromRate) * toRate
}
