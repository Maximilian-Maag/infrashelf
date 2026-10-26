import { db } from '@/lib/db/client'
import { appConfig } from '@/lib/db/schema'
import { eq } from 'drizzle-orm'

/**
 * The base currency — what prices are stored in and what the stored exchange
 * rates are quoted against (FA-11.3).
 *
 * EUR is the default, and deliberately not just a fallback: it is what every
 * price and every rate in an existing installation already means, so a
 * deployment that never sets this reads its own numbers exactly as before.
 *
 * Kept in its own module rather than in the admin service so the exchange
 * client (`lib/exchange`) can read it without importing a service that imports
 * the client back.
 */
export const DEFAULT_BASE_CURRENCY = 'EUR'

/**
 * An ISO 4217 code, as far as shape goes: three letters. The rate table is the
 * authority on which codes actually exist, and a code with no rate is refused
 * where it matters (re-basing), not here.
 */
export const isCurrencyCode = (code: string): boolean => /^[A-Z]{3}$/.test(code)

export const normalizeCurrencyCode = (code: string): string => code.trim().toUpperCase()

/** The configured base currency, or the default when no config row exists yet. */
export const readBaseCurrency = async (): Promise<string> => {
  const [row] = await db
    .select({ baseCurrency: appConfig.baseCurrency })
    .from(appConfig)
    .where(eq(appConfig.id, 1))
    .limit(1)

  return row?.baseCurrency ?? DEFAULT_BASE_CURRENCY
}
