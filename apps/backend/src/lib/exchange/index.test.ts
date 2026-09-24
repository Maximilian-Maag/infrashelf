import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { eq } from 'drizzle-orm'
import { db } from '@/lib/db/client'
import { exchangeRates } from '@/lib/db/schema'
import { refreshRates, convertAmount } from './index'

/**
 * The exchange-rate module (#307's tail): one pure conversion and one cron-fed
 * refresh.
 *
 * Both are the kind of code that fails quietly — a conversion is a number either
 * way, and a refresh that writes nothing looks exactly like a refresh whose rates
 * did not move — so the cases below are about WHICH answer comes back, not about
 * whether one does.
 */
const jsonRes = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })

beforeEach(() => {
  delete process.env.EXCHANGE_RATE_API_URL
})

afterEach(() => vi.restoreAllMocks())

describe('convertAmount', () => {
  // Rates as exchangerate.host publishes them: units of the currency per ONE unit
  // of the base, so dividing by the source's rate and multiplying by the target's
  // walks through the base.
  const rates = { EUR: 1, USD: 1.1, CHF: 0.95, JPY: 170 }

  it('walks through the base currency', () => {
    expect(convertAmount(110, 'USD', 'EUR', rates)).toBeCloseTo(100, 10)
    expect(convertAmount(100, 'EUR', 'USD', rates)).toBeCloseTo(110, 10)
    expect(convertAmount(100, 'CHF', 'JPY', rates)).toBeCloseTo((100 / 0.95) * 170, 10)
  })

  it('returns the amount unchanged when no conversion is asked for', () => {
    // Must not need a rate: a table missing EUR would otherwise make "convert EUR
    // to EUR" throw, which is the one conversion that cannot be wrong.
    expect(convertAmount(42.5, 'EUR', 'EUR', {})).toBe(42.5)
  })

  it('names both currencies when a rate is missing, whichever one it was', () => {
    // The message is read by whoever is looking at an empty budget line, and
    // "Exchange rate not found for USD or GBP" tells them which pair to add.
    expect(() => convertAmount(10, 'USD', 'GBP', { USD: 1.1 })).toThrow(
      'Exchange rate not found for USD or GBP',
    )
    expect(() => convertAmount(10, 'GBP', 'USD', { USD: 1.1 })).toThrow(
      'Exchange rate not found for GBP or USD',
    )
  })

  it('treats a zero rate as a missing one', () => {
    // `!fromRate` rather than `=== undefined`: a stored 0 divides by zero and
    // multiplies everything away, and no currency is worth zero of itself.
    expect(() => convertAmount(10, 'XXX', 'EUR', { XXX: 0, EUR: 1 })).toThrow(/not found/)
  })

  it('does not round: the caller formats, this converts', () => {
    expect(convertAmount(0.01, 'EUR', 'JPY', { EUR: 1, JPY: 170 })).toBeCloseTo(1.7, 10)
  })
})

describe('refreshRates', () => {
  const rowsFor = async (code: string) =>
    db.select().from(exchangeRates).where(eq(exchangeRates.currencyCode, code))

  it('writes one row per currency the API returned', async () => {
    const fetchMock = vi
      .spyOn(global, 'fetch')
      .mockResolvedValue(jsonRes({ success: true, base: 'EUR', rates: { USD: 1.1, CHF: 0.95 } }))

    await refreshRates()

    expect(fetchMock).toHaveBeenCalledWith('https://api.exchangerate.host/latest')
    // `numeric(18,6)`, so the stored value comes back at the column's scale:
    // six decimal places is the precision a rate is kept at, and the padding is
    // Postgres's, not the string conversion's.
    expect((await rowsFor('USD'))[0]?.rate).toBe('1.100000')
    expect((await rowsFor('CHF'))[0]?.rate).toBe('0.950000')
  })

  it('updates a rate that moved instead of duplicating it', async () => {
    // The whole point of the upsert: a currency's rate is one row, and a refresh
    // that inserted a second would leave whichever one the read happened to pick.
    await db.insert(exchangeRates).values({ currencyCode: 'USD', rate: '1.05', updatedAt: new Date(0) })
    vi.spyOn(global, 'fetch').mockResolvedValue(jsonRes({ rates: { USD: 1.1 } }))

    await refreshRates()

    const rows = await rowsFor('USD')
    expect(rows).toHaveLength(1)
    expect(rows[0]?.rate).toBe('1.100000')
    expect(rows[0]?.updatedAt.getTime()).toBeGreaterThan(0)
  })

  it('uses the configured API URL when there is one', async () => {
    // Some deployments cannot reach the public host, so the URL is configurable —
    // and the test asserts the fetch target rather than the value, because a
    // refresh pointed at the wrong host is a table of yesterday's rates.
    process.env.EXCHANGE_RATE_API_URL = 'https://rates.internal/latest'
    const fetchMock = vi.spyOn(global, 'fetch').mockResolvedValue(jsonRes({ rates: { USD: 1.1 } }))

    await refreshRates()

    expect(fetchMock).toHaveBeenCalledWith('https://rates.internal/latest')
  })

  it('throws with the status rather than writing nothing', async () => {
    vi.spyOn(global, 'fetch').mockResolvedValue(new Response('rate limited', { status: 429 }))

    await expect(refreshRates()).rejects.toThrow('Exchange rate fetch failed: 429')
  })

  it('refuses a response whose rates are not a map', async () => {
    for (const rates of [undefined, null, 'nope', 42]) {
      vi.spyOn(global, 'fetch').mockResolvedValue(jsonRes({ rates }))
      await expect(refreshRates(), String(rates)).rejects.toThrow('Invalid exchange rate API response')
      vi.restoreAllMocks()
    }
  })

  it('refuses an EMPTY map rather than reporting a refresh that did nothing', async () => {
    // #554: `{ "rates": {} }` used to pass the shape check, write no rows and
    // RESOLVE — so a provider that changed shape left yesterday's rates in place
    // while the caller reported success, and every cost figure converted through
    // them. A real answer carries 150+ currencies.
    vi.spyOn(global, 'fetch').mockResolvedValue(jsonRes({ rates: {} }))

    await expect(refreshRates()).rejects.toThrow('The exchange rate API returned no rates')
    expect(await db.select().from(exchangeRates)).toHaveLength(0)
  })

  it('refuses an array of rates as a shape it does not know', async () => {
    // `typeof [] === 'object'`, so an array of `{ code, rate }` objects passed the
    // old check and produced the same nothing — from a body that looks even more
    // like data.
    vi.spyOn(global, 'fetch').mockResolvedValue(jsonRes({ rates: [{ code: 'USD', rate: 1.1 }] }))

    await expect(refreshRates()).rejects.toThrow('Invalid exchange rate API response')
    expect(await db.select().from(exchangeRates)).toHaveLength(0)
  })

  it('refuses an entry that is not a positive number, and writes none of the table', async () => {
    // `String({})` is '[object Object]', which the numeric column rejects in the
    // middle of the loop: the refresh failed with half the table refreshed, some of
    // it written minutes and some of it months ago. Refusing up front is what makes
    // "the refresh failed" mean the rates are all still the previous ones.
    for (const bad of ['1.1', null, {}, [], -1, 0, Number.NaN]) {
      vi.spyOn(global, 'fetch').mockResolvedValue(jsonRes({ rates: { USD: bad, CHF: 0.95 } }))

      await expect(refreshRates(), JSON.stringify(bad)).rejects.toThrow('Invalid exchange rate for USD')
      expect(await db.select().from(exchangeRates), JSON.stringify(bad)).toHaveLength(0)
      vi.restoreAllMocks()
    }
  })

  it('answers the number of rates it wrote', async () => {
    // The count the audit line reports. It used to be `rows.length` — the size of
    // the table — so the two numbers below are the ones that used to be confused.
    await db.insert(exchangeRates).values({ currencyCode: 'SEK', rate: '11.5' })
    vi.spyOn(global, 'fetch').mockResolvedValue(jsonRes({ rates: { USD: 1.1, CHF: 0.95 } }))

    await expect(refreshRates()).resolves.toBe(2)
    expect(await db.select().from(exchangeRates)).toHaveLength(3)
  })
})
