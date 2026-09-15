import type { CostComparison as Comparison, CostPeriod } from '@infrashelf/types'
import { Card } from '@/components/ui/Card'
import { t } from '@/lib/i18n'
import { CHART_PRIMARY, CHART_MUTED } from '@/lib/chartTokens'
import { monthLabel, sharePercent } from './chartData'
import { CostCaveats } from './CostCaveats'

interface Props {
  /** Null when the window covers fewer than two months. */
  comparison: Comparison | null
  money: (eur: number) => string
  lang: string
  estimatedOrders: number
  unconverted: { currency: string; amount: number }[]
}

const BAR_W = 320
const BAR_H = 10
const HATCH_ID = 'isf-cost-comparison-hatch'

/**
 * This month against last (issue #106).
 *
 * ── What it encodes, besides colour ───────────────────────────────────────────
 * Nothing depends on colour. The two bars are the same hue at two lightnesses, and
 * which is which is stated in words above each one — the tone only says which is
 * the current period. The delta is a signed number with an arrow glyph beside it,
 * never a red/green fill: "up" is not universally bad, and a reader who sees no
 * colour would learn nothing from one. Both absolute figures are printed, so the
 * direction is derivable even if the arrow and the sign are both missed.
 *
 * ── The two honesty problems this has to avoid ────────────────────────────────
 * Comparing against a month the filter excluded would report it as zero and read as
 * "spend doubled", so the API returns null instead and this says the window is too
 * short. And a month that is three days old is not comparable to a finished one, so
 * a running month is hatched and labelled as still growing.
 */
export function CostComparison({ comparison, money, lang, estimatedOrders, unconverted }: Props) {
  const title = t('monthOverMonth', lang)

  if (!comparison) {
    return (
      <Card title={title}>
        <p className="text-sm text-slate-600">{t('needTwoMonths', lang)}</p>
      </Card>
    )
  }

  const { current, previous, changeEur, changePct } = comparison
  const max = Math.max(current.totalEur, previous.totalEur)
  // A real minus sign, not a hyphen: this is a number, and the hyphen renders as a
  // dash too short to read as negative at this size.
  const sign = changeEur > 0 ? '+' : changeEur < 0 ? '−' : ''
  const arrow = changeEur > 0 ? '▲' : changeEur < 0 ? '▼' : '–'

  const Row = ({ period, emphasis }: { period: CostPeriod; emphasis: boolean }) => (
    <div>
      <div className="flex items-baseline justify-between gap-3 text-sm">
        <span className={emphasis ? 'font-medium text-slate-900' : 'text-slate-600'}>
          {monthLabel(period.period, lang, 'long')}
        </span>
        <span className="whitespace-nowrap font-medium tabular-nums text-slate-900">
          {money(period.totalEur)}
        </span>
      </div>
      {/* The bar restates the figure beside it, so it is hidden from assistive
          technology rather than announced twice. */}
      <svg
        aria-hidden="true"
        viewBox={`0 0 ${BAR_W} ${BAR_H}`}
        className="mt-1 w-full"
        style={{ height: 'auto' }}
      >
        <rect x="0" y="0" width={BAR_W} height={BAR_H} rx="4" fill="#f1f5f9" />
        {period.totalEur > 0 && max > 0 && (
          <rect
            x="0"
            y="0"
            width={Math.max(3, (period.totalEur / max) * BAR_W)}
            height={BAR_H}
            rx="4"
            fill={period.partial ? `url(#${HATCH_ID})` : emphasis ? CHART_PRIMARY : CHART_MUTED}
          />
        )}
      </svg>
    </div>
  )

  return (
    <Card title={title}>
      {/* One <defs> for both rows; a pattern is document-scoped, not element-scoped. */}
      <svg width="0" height="0" aria-hidden="true" className="block h-0 w-0">
        <defs>
          <pattern
            id={HATCH_ID}
            width="6"
            height="6"
            patternUnits="userSpaceOnUse"
            patternTransform="rotate(45)"
          >
            <rect width="6" height="6" fill={CHART_PRIMARY} />
            <line x1="3" y1="0" x2="3" y2="6" stroke="#ffffff" strokeWidth="2" />
          </pattern>
        </defs>
      </svg>

      <p className="text-2xl font-bold text-slate-900">
        <span aria-hidden="true" className="mr-1 text-lg">{arrow}</span>
        {sign}
        {money(Math.abs(changeEur))}
        {changePct !== null && (
          <span className="ml-2 text-base font-medium text-slate-600">
            ({sign}
            {/* Formatted, not interpolated: a raw JS number prints "48.3" beside a
                "48,3 €" in every locale that uses a comma. */}
            {sharePercent(Math.abs(changePct), 100, lang)})
          </span>
        )}
      </p>

      <div className="mt-3 space-y-3">
        <Row period={previous} emphasis={false} />
        <Row period={current} emphasis />
      </div>

      <CostCaveats
        estimatedOrders={estimatedOrders}
        unconverted={unconverted}
        lang={lang}
        monthInProgress={current.partial}
      />
    </Card>
  )
}
