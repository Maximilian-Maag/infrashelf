import { auth } from '@/lib/auth'
import { get } from '@/lib/api'
import { redirect } from 'next/navigation'
import type { CostReport, CostBucket, ExchangeRate, Project } from '@open-hybrid-cloud/types'
import { PageHeader } from '@/components/layout/PageHeader'
import { Card } from '@/components/ui/Card'
import { CostFilters } from './CostFilters'
import { CostExport } from './CostExport'
import { CostTrend } from './CostTrend'
import { CostDistribution } from './CostDistribution'
import { CostComparison } from './CostComparison'
import { CostCaveats } from './CostCaveats'
import { getLang } from '@/lib/getLang'
import { t } from '@/lib/i18n'
import { localeToCurrency, convertPrice } from '@/lib/locale'

// The range and project filters live in the URL (see CostFilters), so every
// filter combination is its own render — nothing here may be cached across them.
export const dynamic = 'force-dynamic'

/** Query parameters forwarded to the API verbatim; anything else is ignored. */
const FILTER_KEYS = ['range', 'from', 'to', 'projectId'] as const

interface Props {
  searchParams: Promise<Record<string, string | string[] | undefined>>
}

export default async function CostsPage({ searchParams }: Props) {
  const session = await auth()
  if (!session) redirect('/login')

  const token = (session as unknown as { apiToken: string }).apiToken
  const lang = await getLang()
  const localeCurrency = localeToCurrency(lang)
  const params = await searchParams

  const query = new URLSearchParams()
  for (const key of FILTER_KEYS) {
    // Take the first value if a key was repeated: the API expects one, and
    // guessing which of two conflicting values was meant is worse than picking.
    const raw = params[key]
    const value = Array.isArray(raw) ? raw[0] : raw
    if (value) query.set(key, value)
  }
  const reportQuery = new URLSearchParams(query)
  reportQuery.set('lang', lang)

  const [reportRes, projectsRes, ratesRes] = await Promise.allSettled([
    get<CostReport>(`/api/costs?${reportQuery.toString()}`, token),
    get<Project[]>('/api/projects', token),
    get<ExchangeRate[]>('/api/public/exchange-rates', token),
  ])

  // A rejected report is the one failure that leaves nothing to show — an invalid
  // custom range is the likely cause, so say so rather than rendering zeros that
  // would read as "nothing was spent".
  const report = reportRes.status === 'fulfilled' ? reportRes.value : null
  const projects = projectsRes.status === 'fulfilled' ? (projectsRes.value ?? []) : []
  // No rates degrades to EUR figures rather than a broken page: convertPrice
  // returns the original amount when it cannot convert.
  const rates: Record<string, number> =
    ratesRes.status === 'fulfilled'
      ? Object.fromEntries((ratesRes.value ?? []).map((r) => [r.currencyCode, parseFloat(r.rate)]))
      : {}

  /** EUR from the API → the viewer's currency, formatted in their locale. */
  const money = (eur: number) => {
    const { amount, currency } = convertPrice(eur.toFixed(2), 'EUR', localeCurrency, rates, lang)
    return `${amount} ${currency}`
  }

  return (
    <div className="max-w-6xl mx-auto space-y-6">
      <PageHeader
        title={t('costs', lang)}
        subtitle={t('costsSubtitle', lang)}
        actions={<CostExport token={token} lang={lang} />}
      />

      <CostFilters projects={projects} lang={lang} />

      {report === null ? (
        <div className="text-center py-12 text-red-600" role="alert">
          {t('unexpectedError', lang)}
        </div>
      ) : (
        <>
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
            <Card>
              <div className="space-y-2">
                <p className="text-sm font-medium text-slate-500">{t('totalSpend', lang)}</p>
                <p className="text-3xl font-bold text-slate-900">{money(report.totalEur)}</p>
                <p className="text-sm text-slate-600">
                  {report.orderCount} {t('ordersCounted', lang)}
                </p>
                {/* Always shown, not only when it looks odd: these figures are a sum
                    of recorded order prices, and the catalogue stores no billing
                    period, so any reading of them as a run rate is wrong. */}
                <CostCaveats
                  estimatedOrders={report.estimatedOrders}
                  unconverted={report.unconverted}
                  lang={lang}
                />
              </div>
            </Card>

            {/* "Is spend rising?" is the second question after "how much?", so the
                comparison sits beside the total rather than below the breakdowns. */}
            <CostComparison
              comparison={report.comparison}
              money={money}
              lang={lang}
              estimatedOrders={report.estimatedOrders}
              unconverted={report.unconverted}
            />
          </div>

          {report.orderCount === 0 ? (
            <div className="text-center py-12 text-slate-600">{t('noSpend', lang)}</div>
          ) : (
            <>
              <CostTrend
                series={report.series}
                money={money}
                lang={lang}
                estimatedOrders={report.estimatedOrders}
                unconverted={report.unconverted}
              />

              {/* Projects and cost centres, because those are the two dimensions
                  somebody is accountable for; product and environment stay as ranked
                  lists, where the question is "which is biggest", not "what share". */}
              <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
                <CostDistribution
                  chartId="cost-share-project"
                  dimension={t('perProject', lang)}
                  buckets={report.byProject}
                  money={money}
                  lang={lang}
                  estimatedOrders={report.estimatedOrders}
                  unconverted={report.unconverted}
                />
                <CostDistribution
                  chartId="cost-share-cost-center"
                  dimension={t('perCostCenter', lang)}
                  buckets={report.byCostCenter}
                  money={money}
                  lang={lang}
                  estimatedOrders={report.estimatedOrders}
                  unconverted={report.unconverted}
                />
              </div>

              {/* Only the two dimensions the share charts do NOT cover. Keeping a
                  ranked list of projects as well would print the same figures a
                  third time, one card apart, and the reader would have to check
                  whether the two disagreed. */}
              <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
                <Breakdown title={t('perProduct', lang)} buckets={report.byProduct} money={money} lang={lang} />
                <Breakdown title={t('perEnvironment', lang)} buckets={report.byEnvironment} money={money} lang={lang} />
              </div>
            </>
          )}
        </>
      )}
    </div>
  )
}

function Breakdown({
  title,
  buckets,
  money,
  lang,
}: {
  title: string
  buckets: CostBucket[]
  money: (eur: number) => string
  lang: string
}) {
  // Bars are relative to the largest bucket, not to the total: with one dominant
  // project every other bar would be a sliver and the comparison — the point of
  // the breakdown — would be unreadable. The API already sorts by spend.
  const max = buckets.reduce((m, b) => Math.max(m, b.totalEur), 0)
  return (
    <Card title={title}>
      {buckets.length === 0 ? (
        <p className="text-sm text-slate-600">{t('noSpend', lang)}</p>
      ) : (
        <ul className="space-y-3">
          {buckets.map((bucket) => (
            <li key={`${bucket.id ?? 'none'}-${bucket.label}`}>
              <div className="flex items-baseline justify-between gap-3 text-sm">
                <span className="text-slate-900">{bucket.label}</span>
                <span className="whitespace-nowrap font-medium text-slate-900">{money(bucket.totalEur)}</span>
              </div>
              <div className="mt-1 flex items-center gap-2">
                {/* Decoration only — the figure beside it is the accessible value,
                    so the bar itself is hidden from assistive technology. */}
                <div className="h-1.5 flex-1 rounded-full bg-slate-100" aria-hidden="true">
                  <div
                    className="h-1.5 rounded-full bg-blue-500"
                    style={{ width: `${max > 0 ? Math.max(2, (bucket.totalEur / max) * 100) : 0}%` }}
                  />
                </div>
                <span className="text-xs text-slate-500 whitespace-nowrap">
                  {bucket.orderCount} {t('ordersCounted', lang)}
                </span>
              </div>
            </li>
          ))}
        </ul>
      )}
    </Card>
  )
}
