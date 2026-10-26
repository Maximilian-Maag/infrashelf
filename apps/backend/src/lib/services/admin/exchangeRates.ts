import { db } from '@/lib/db/client'
import { appConfig, exchangeRates, type ExchangeRate } from '@/lib/db/schema'
import { eq, sql } from 'drizzle-orm'
import { refreshRates } from '@/lib/exchange'
import {
  DEFAULT_BASE_CURRENCY,
  isCurrencyCode,
  normalizeCurrencyCode,
  readBaseCurrency,
} from '@/lib/exchange/baseCurrency'
import { ok, err, type Result } from '@/lib/services/result'
import { logAudit, logAuditWith } from '@/lib/audit'

export interface CurrencySettings {
  baseCurrency: string
}

const readRates = async (): Promise<ExchangeRate[]> =>
  db.select().from(exchangeRates).orderBy(sql`${exchangeRates.currencyCode} ASC`)

export const getExchangeRates = async (): Promise<Result<ExchangeRate[]>> => {
  return ok(await readRates())
}

/**
 * The configured base currency (FA-11.3).
 *
 * Separate from the rate list because it is a setting, not a row of it: an
 * installation that has never refreshed rates still has a base currency, and it
 * is EUR until root says otherwise.
 */
export const getCurrencySettings = async (): Promise<Result<CurrencySettings>> => {
  return ok({ baseCurrency: await readBaseCurrency() })
}

/**
 * Set the base currency, re-basing the stored rates onto it.
 *
 * Changing the anchor means every stored rate has to change with it, or the
 * conversions it drives would all silently be read against the old base. The
 * re-base divides every rate by the new base's rate under the OLD anchor —
 * `rate[CUR] := rate[CUR] / rate[NEW]` — which leaves each currency's relative
 * value intact and makes the new base's own rate 1.
 *
 * Refused when no usable rate is stored for the requested currency: without it
 * there is nothing to divide by, and the portal would keep converting through
 * numbers that no longer mean anything. Refresh rates first, then set it.
 */
export const setBaseCurrency = async (
  input: string,
  actorId: number | null,
): Promise<Result<CurrencySettings>> => {
  const code = normalizeCurrencyCode(input)
  if (!isCurrencyCode(code)) {
    return err(400, 'The base currency must be a three-letter ISO 4217 code, such as EUR.')
  }

  const previous = await readBaseCurrency()
  if (code === previous) return ok({ baseCurrency: previous })

  const rows = await readRates()
  const rateOf = new Map(rows.map((r) => [r.currencyCode, Number(r.rate)]))

  // With no rates stored there is nothing to re-base — setting the base is a
  // plain change and the next refresh will quote against it directly.
  const anchor = rows.length === 0 ? 1 : rateOf.get(code)
  if (anchor === undefined || !Number.isFinite(anchor) || anchor <= 0) {
    return err(
      409,
      `No usable exchange rate is stored for ${code}, so the stored rates cannot be ` +
        `re-based onto it. Refresh the rates first, then set the base currency.`,
    )
  }

  const now = new Date()
  await db.transaction(async (tx) => {
    if (rows.length > 0) {
      for (const row of rows) {
        const rebased = Number(row.rate) / anchor
        await tx
          .update(exchangeRates)
          .set({ rate: String(rebased), updatedAt: now })
          .where(eq(exchangeRates.currencyCode, row.currencyCode))
      }
      // The new base is 1 by construction; make sure a row says so even if the
      // table did not carry one for it before.
      await tx
        .insert(exchangeRates)
        .values({ currencyCode: code, rate: '1', updatedAt: now })
        .onConflictDoUpdate({
          target: exchangeRates.currencyCode,
          set: { rate: '1', updatedAt: now },
        })
    }

    // Upsert, not a bare update: `app_config` is a single row that bootstrap
    // creates, but a database that has never been bootstrapped (or has been
    // truncated) has none, and an UPDATE against it would store nothing while
    // reporting success. Only `base_currency` is named on the conflict path, so
    // the SMTP and AI settings on the same row are left exactly as they were.
    await tx
      .insert(appConfig)
      .values({ id: 1, baseCurrency: code })
      .onConflictDoUpdate({ target: appConfig.id, set: { baseCurrency: code } })

    // Inside the transaction, with the change it describes: the base currency
    // decides what every price means, so who changed it and from what is the
    // record an accountant asks for. Written after the commit it could survive a
    // rollback and claim a change that did not happen.
    await logAuditWith(
      tx,
      actorId,
      'currency.base_currency_updated',
      undefined,
      `Base currency ${previous} → ${code}`,
    )
  })

  return ok({ baseCurrency: code })
}

export const refreshExchangeRates = async (
  actorId?: number,
): Promise<Result<ExchangeRate[]>> => {
  // What the refresh WROTE, not what the table holds afterwards: the audit line
  // used to report `rows.length`, so a refresh that wrote nothing still recorded
  // "152 rate(s) refreshed" — the same untrue success #554 was about, one layer up.
  const written = await refreshRates()

  const rows = await readRates()

  // Rates decide what every order costs, so a manual refresh is a mutation worth
  // recording — the count, not the rates themselves, which the table already has.
  await logAudit(actorId ?? null, 'exchange_rate.refreshed', undefined, `${written} rate(s) refreshed`)

  return ok(rows)
}

export { DEFAULT_BASE_CURRENCY }
