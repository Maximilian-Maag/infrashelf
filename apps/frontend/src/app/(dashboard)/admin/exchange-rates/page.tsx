import { auth } from '@/lib/auth'
import { get } from '@/lib/serverApi'
import { section } from '@/lib/section'
import { redirect } from 'next/navigation'
import type { Role, ExchangeRate, CurrencySettings } from '@infrashelf/types'
import { PageHeader } from '@/components/layout/PageHeader'
import { ExchangeRatesTable } from './ExchangeRatesTable'
import { t } from '@/lib/i18n'
import { getLang } from '@/lib/getLang'

export default async function ExchangeRatesPage() {
  const session = await auth()
  if (!session) redirect('/login')
  const role = (session.user as unknown as { role: Role }).role
  if (role !== 'root') redirect('/admin')

  const lang = await getLang()

  /*
   * Fetched here, not by the component on mount (#456). This page is already a
   * server component — it authenticates and redirects before anything renders —
   * so the browser gets the rows with the HTML instead of after it. `section()`
   * so an outage arrives as a reason rather than as an empty list (#415).
   */
  const [ratesRes, currencyRes] = await Promise.allSettled([
    get<ExchangeRate[]>('/api/admin/exchange-rates'),
    get<CurrencySettings>('/api/admin/exchange-rates/base-currency'),
  ])
  const rates = section(ratesRes, [] as ExchangeRate[], 'exchange rates')
  // The base the rates are quoted against (FA-11.3). Read here with the rates so
  // the control and the column header are correct on first paint, not after a
  // round trip. A failed read falls back to the EUR default.
  const baseCurrency =
    (currencyRes.status === 'fulfilled' ? currencyRes.value?.baseCurrency : null) ?? 'EUR'

  return (
    <div className="max-w-3xl mx-auto space-y-6">
      <PageHeader title={t('exchangeRates', lang)} subtitle={t('exchangeRatesSubtitle', lang)} />
      <ExchangeRatesTable initial={rates.data} initialError={rates.error} initialBaseCurrency={baseCurrency} />
    </div>
  )
}
