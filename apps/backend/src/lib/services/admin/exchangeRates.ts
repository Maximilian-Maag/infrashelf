import { db } from '@/lib/db/client'
import { exchangeRates, type ExchangeRate } from '@/lib/db/schema'
import { sql } from 'drizzle-orm'
import { refreshRates } from '@/lib/exchange'
import { ok, type Result } from '@/lib/services/result'
import { logAudit } from '@/lib/audit'

export const getExchangeRates = async (): Promise<Result<ExchangeRate[]>> => {
  const rows = await db
    .select()
    .from(exchangeRates)
    .orderBy(sql`${exchangeRates.currencyCode} ASC`)

  return ok(rows)
}

export const refreshExchangeRates = async (
  actorId?: number,
): Promise<Result<ExchangeRate[]>> => {
  // What the refresh WROTE, not what the table holds afterwards: the audit line
  // used to report `rows.length`, so a refresh that wrote nothing still recorded
  // "152 rate(s) refreshed" — the same untrue success #554 was about, one layer up.
  const written = await refreshRates()

  const rows = await db
    .select()
    .from(exchangeRates)
    .orderBy(sql`${exchangeRates.currencyCode} ASC`)

  // Rates decide what every order costs, so a manual refresh is a mutation worth
  // recording — the count, not the rates themselves, which the table already has.
  await logAudit(actorId ?? null, 'exchange_rate.refreshed', undefined, `${written} rate(s) refreshed`)

  return ok(rows)
}
