import type { CostBucket } from '@infrashelf/types'
import { Card } from '@/components/ui/Card'
import { t } from '@/lib/i18n'
import { CHART_FILL, CHART_STEPS } from '@/lib/chartTokens'
import { foldTail, sharePercent } from './chartData'
import { CostCaveats } from './CostCaveats'

interface Props {
  /** Which dimension is being split — already translated, e.g. "Per project". */
  dimension: string
  /** Buckets from the API, largest first. */
  buckets: CostBucket[]
  money: (eur: number) => string
  lang: string
  /** Namespaces the SVG's clip path: two of these render on the page. */
  chartId: string
  estimatedOrders: number
  unconverted: { currency: string; amount: number }[]
}

// viewBox units, stretched to the card's width. The bar holds shapes only: SVG text
// would scale with the card and ignore the reader's font size, so the axis and the
// legend below are HTML.
const VIEW_W = 1000
const VIEW_H = 28
/** The surface gap between touching segments — never a stroke drawn round them. */
const GAP = 2
const TICKS = [0, 0.25, 0.5, 0.75, 1]

/**
 * Share of total across one dimension (issue #106).
 *
 * ── What it encodes ───────────────────────────────────────────────────────────
 * Segment WIDTH is the share, and that is the whole measurement. Tone steps darkest
 * to lightest in the order the API already sorted the buckets — largest share
 * darkest — so the ramp restates the ordering rather than inventing identities for
 * nominal categories. A reader who sees no colour at all still has: the left-to-right
 * order, the percentage axis, and the legend below, which names every segment with
 * its amount and its share as text. Nothing here is knowable only from a hue, which
 * is what WCAG 1.4.1 asks. Every tone clears 3:1 (1.4.11) against the card on any
 * branding colour, because the ramp is derived through `accentRamp`, not mixed in CSS.
 *
 * ── Why the tail is folded ────────────────────────────────────────────────────
 * Past about six segments adjacent shares are indistinguishable at any width, so a
 * seventh slice would be decoration. The tail is summed into "Other" rather than
 * dropped: segments that do not add up to the total make a share chart a lie.
 */
export function CostDistribution({
  dimension,
  buckets,
  money,
  lang,
  chartId,
  estimatedOrders,
  unconverted,
}: Props) {
  const title = `${t('shareOfTotal', lang)} · ${dimension}`
  const shown = foldTail(buckets, CHART_STEPS, t('other', lang))
  const total = shown.reduce((sum, b) => sum + b.totalEur, 0)

  if (shown.length === 0) {
    return (
      <Card title={title}>
        <p className="text-sm text-slate-600">{t('noSpend', lang)}</p>
        <CostCaveats estimatedOrders={estimatedOrders} unconverted={unconverted} lang={lang} />
      </Card>
    )
  }

  // Widths are laid out cumulatively so rounding cannot leave a gap at the right
  // edge that would read as unaccounted spend.
  let cursor = 0
  const segments = shown.map((bucket, i) => {
    const width = total > 0 ? (bucket.totalEur / total) * VIEW_W : 0
    const x = cursor
    cursor += width
    return { bucket, x, width, fill: CHART_FILL[i % CHART_FILL.length] }
  })

  return (
    <Card title={title}>
      {total > 0 && (
        <>
          <svg
            role="img"
            aria-label={title}
            viewBox={`0 0 ${VIEW_W} ${VIEW_H}`}
            // Stretched: the bar is a fixed height at every width, and only the
            // shares change with the card.
            preserveAspectRatio="none"
            className="block h-7 w-full"
          >
            <defs>
              {/* One rounded outline for the whole bar: the ends are rounded and the
                  interior joints are not, which is what one bar should look like. */}
              <clipPath id={`${chartId}-clip`}>
                <rect x="0" y="0" width={VIEW_W} height={VIEW_H} rx="4" />
              </clipPath>
            </defs>

            <g clipPath={`url(#${chartId}-clip)`}>
              {segments.map(({ bucket, x, width, fill }, i) =>
                width <= 0 ? null : (
                  <rect
                    key={`${bucket.id ?? 'none'}-${bucket.label}`}
                    x={x}
                    y="0"
                    // The gap eats into every segment but the last, so the bar still
                    // reaches 100 % of the width.
                    width={Math.max(1, width - (i === segments.length - 1 ? 0 : GAP))}
                    height={VIEW_H}
                    fill={fill}
                  >
                    <title>
                      {`${bucket.label}: ${money(bucket.totalEur)} — ${sharePercent(
                        bucket.totalEur,
                        total,
                        lang,
                      )}`}
                    </title>
                  </rect>
                ),
              )}
            </g>
          </svg>

          {/* The percentage axis, in HTML for the same reason: real text at the
              reader's own size. Positioned at each tick's true fraction rather than
              spaced evenly — `justify-between` distributes the GAPS, which puts a
              wide "100 %" and a narrow "0 %" label off their own marks. Hidden from
              assistive technology: read out as "0 25 50 75 100" it is noise next to
              the exact shares in the table below. */}
          <div aria-hidden="true" className="relative mt-1 h-4 text-xs text-slate-500">
            {TICKS.map((fraction) => (
              <span
                key={fraction}
                className="absolute top-0 whitespace-nowrap"
                style={{
                  left: `${fraction * 100}%`,
                  transform:
                    fraction === 0
                      ? undefined
                      : fraction === 1
                        ? 'translateX(-100%)'
                        : 'translateX(-50%)',
                }}
              >
                {sharePercent(fraction, 1, lang)}
              </span>
            ))}
          </div>
        </>
      )}

      {/* Legend and data in one: the swatch only repeats what the bar shows, so it is
          hidden from assistive technology and the row reads as label, amount, share. */}
      <table className="mt-3 w-full text-sm">
        <thead>
          <tr className="text-left text-xs text-slate-500">
            <th scope="col" className="py-1 font-medium">{dimension}</th>
            <th scope="col" className="py-1 text-right font-medium">{t('totalSpend', lang)}</th>
            <th scope="col" className="py-1 text-right font-medium">{t('share', lang)}</th>
          </tr>
        </thead>
        <tbody>
          {segments.map(({ bucket, fill }) => (
            <tr key={`${bucket.id ?? 'none'}-${bucket.label}`} className="border-t border-slate-100">
              <td className="py-1 text-slate-900">
                <span className="flex items-center gap-2">
                  <span
                    aria-hidden="true"
                    className="inline-block h-3 w-3 shrink-0 rounded-sm"
                    style={{ backgroundColor: fill }}
                  />
                  {bucket.label}
                </span>
              </td>
              <td className="py-1 text-right tabular-nums text-slate-900">{money(bucket.totalEur)}</td>
              <td className="py-1 text-right tabular-nums text-slate-600">
                {sharePercent(bucket.totalEur, total, lang)}
              </td>
            </tr>
          ))}
        </tbody>
      </table>

      <CostCaveats estimatedOrders={estimatedOrders} unconverted={unconverted} lang={lang} />
    </Card>
  )
}
