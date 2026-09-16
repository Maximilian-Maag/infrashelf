import type { CostPeriod } from '@infrashelf/types'
import { Card } from '@/components/ui/Card'
import { t } from '@/lib/i18n'
import { CHART_PRIMARY, CHART_GRID, CHART_AXIS } from '@/lib/chartTokens'
import { monthLabel } from './chartData'
import { CostCaveats } from './CostCaveats'

interface Props {
  /** Monthly buckets from the API, oldest first, gaps already filled. */
  series: CostPeriod[]
  /** EUR → the viewer's currency, already formatted. */
  money: (eur: number) => string
  lang: string
  estimatedOrders: number
  unconverted: { currency: string; amount: number }[]
}

// viewBox units. Roughly one unit per desktop pixel, so the mark specs below mean
// what they say at the width this card is actually rendered at.
const VIEW_W = 1000
const VIEW_H = 150
/** Capped rather than filling the slot: the leftover is the air between columns. */
const BAR_MAX = 22
/** The surface gap that separates touching columns — white doing the separating. */
const GAP = 2
/** A nonzero month must be visible; an invisible column reads as "no spend". */
const MIN_H = 2
/** At most this many x labels, so they never collide on a twelve-month window. */
const MAX_TICKS = 6
const HATCH_ID = 'isf-cost-trend-hatch'

/** A column with a 4px rounded cap and a square foot on the baseline. */
const columnPath = (x: number, width: number, top: number): string => {
  const height = VIEW_H - top
  const r = Math.max(0, Math.min(4, width / 2, height))
  return [
    `M ${x} ${VIEW_H}`,
    `L ${x} ${top + r}`,
    `Q ${x} ${top} ${x + r} ${top}`,
    `L ${x + width - r} ${top}`,
    `Q ${x + width} ${top} ${x + width} ${top + r}`,
    `L ${x + width} ${VIEW_H}`,
    'Z',
  ].join(' ')
}

/**
 * Spend per month (issue #106).
 *
 * ── Why inline SVG and no charting library ────────────────────────────────────
 * A library would be a dependency the whole app pays for — bundle weight on every
 * dashboard route, an SSR story to verify, and an accessibility story we would not
 * control. This page renders on the server; the chart below ships no JavaScript at
 * all, which is also why the tooltips are native SVG <title> rather than a hover
 * layer that would force the page into a client component.
 *
 * ── Why no text inside the SVG ────────────────────────────────────────────────
 * The picture scales with the card, and SVG text scales with it — which means it
 * ignores the reader's font size and shrinks to a few pixels on a phone. So the SVG
 * holds shapes only, and every label is HTML laid out on the same grid: the axis is
 * a flex row of equal cells, one per column, so the labels line up with the marks
 * without either of them knowing the other's pixel width.
 *
 * ── Why it is readable without seeing it ──────────────────────────────────────
 * Height encodes the amount and nothing is encoded by colour: there is one series,
 * so there is no identity to confuse. The picture carries an accessible name, every
 * column carries its month and amount as a <title>, and the same numbers are in the
 * table underneath — the chart summarises the table rather than being the only copy
 * of the data. The unfinished month is hatched AND stated in words, because a
 * shorter last column would otherwise read as a fall in spend.
 */
export function CostTrend({ series, money, lang, estimatedOrders, unconverted }: Props) {
  const title = t('spendOverTime', lang)

  if (series.length === 0) {
    return (
      <Card title={title}>
        <p className="text-sm text-slate-600">{t('noSpend', lang)}</p>
        <CostCaveats estimatedOrders={estimatedOrders} unconverted={unconverted} lang={lang} />
      </Card>
    )
  }

  const max = series.reduce((m, p) => Math.max(m, p.totalEur), 0)
  const slot = VIEW_W / series.length
  const barW = Math.max(2, Math.min(BAR_MAX, slot - GAP * 2))
  const topOf = (value: number) =>
    max > 0 && value > 0 ? Math.min(VIEW_H - MIN_H, VIEW_H - (value / max) * VIEW_H) : VIEW_H

  // Every nth label, counted back from the last so the most recent month is always
  // named — it is the one the reader looks for first.
  const step = Math.ceil(series.length / MAX_TICKS)
  const last = series.length - 1
  const name = `${title}: ${monthLabel(series[0].period, lang, 'long')} – ${monthLabel(
    series[last].period,
    lang,
    'long',
  )}`

  return (
    <Card title={title}>
      {/* The one y tick worth printing: the top of the scale every column is drawn
          against. It sits on the gridline it names. */}
      <p className="text-xs text-slate-600">{money(max)}</p>

      <svg
        role="img"
        aria-label={name}
        viewBox={`0 0 ${VIEW_W} ${VIEW_H}`}
        // Stretched, not fitted: the plot keeps a fixed height at every width, so a
        // wide card gets a wider chart rather than a taller one. Columns thin out
        // with the viewport, which is what they should do; the only cost is that a
        // rounded cap is a few tenths of a pixel out of round.
        preserveAspectRatio="none"
        className="mt-1 block h-32 w-full sm:h-40"
      >
        <defs>
          {/* 45°, in the card colour, so an unfinished month reads as provisional in
              greyscale and under forced-colors as well as in the palette. */}
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

        {/* Solid hairlines one step off the card: the grid must never compete with
            the data. vectorEffect keeps them hairlines despite the stretched aspect. */}
        {max > 0 && (
          <>
            <line
              x1="0" y1="1" x2={VIEW_W} y2="1"
              stroke={CHART_GRID} strokeWidth="1" vectorEffect="non-scaling-stroke"
            />
            <line
              x1="0" y1={VIEW_H / 2} x2={VIEW_W} y2={VIEW_H / 2}
              stroke={CHART_GRID} strokeWidth="1" vectorEffect="non-scaling-stroke"
            />
          </>
        )}
        <line
          x1="0" y1={VIEW_H - 1} x2={VIEW_W} y2={VIEW_H - 1}
          stroke={CHART_AXIS} strokeWidth="1" vectorEffect="non-scaling-stroke"
        />

        {series.map((period, i) => {
          if (period.totalEur <= 0) return null
          return (
            <path
              key={period.period}
              d={columnPath(slot * i + (slot - barW) / 2, barW, topOf(period.totalEur))}
              fill={period.partial ? `url(#${HATCH_ID})` : CHART_PRIMARY}
            >
              <title>
                {`${monthLabel(period.period, lang, 'long')}: ${money(period.totalEur)} — ${
                  period.orderCount
                } ${t('ordersCounted', lang)}${
                  period.partial ? ` — ${t('monthInProgress', lang)}` : ''
                }`}
              </title>
            </path>
          )
        })}
      </svg>

      {/* The x axis: one cell per column, so a label sits under its own mark without
          either side measuring the other. Hidden from assistive technology because
          the table below names every month in full — and dropped altogether on a
          phone, where a twelve-month axis cannot fit legibly and a clipped label is
          worse than the table it duplicates. */}
      <div aria-hidden="true" className="hidden text-xs text-slate-600 sm:flex">
        {series.map((period, i) => (
          <span key={period.period} className="min-w-0 flex-1 truncate text-center">
            {(last - i) % step === 0 ? monthLabel(period.period, lang) : ''}
          </span>
        ))}
      </div>

      <CostCaveats
        estimatedOrders={estimatedOrders}
        unconverted={unconverted}
        lang={lang}
        monthInProgress={series[last].partial}
      />

      {/* The data, not a second rendering of it: everything the columns encode is
          here as text, for a reader who cannot see the picture and for anyone who
          wants the exact figure the axis only approximates. */}
      <details className="mt-2">
        {/* `min-h-11`, because this is a pointer target and not just a label.
            It is the ONLY text alternative to the chart — the whole table below
            is behind it — and it shipped as a bare `text-xs` summary about
            16px tall, against the 44px floor #178 set for every other control
            in the app. /costs is axe-scanned, but axe has no rule for WCAG
            2.5.5, so nothing was ever going to catch it (#195, F1).

            Padding rather than `flex`: a summary set to display:flex loses its
            disclosure triangle in Chrome, and the marker is what says the thing
            opens. */}
        <summary className="cursor-pointer text-xs text-slate-600 min-h-11 py-3">{t('details', lang)}</summary>
        <table className="mt-2 w-full text-sm">
          <thead>
            <tr className="text-left text-xs text-slate-600">
              <th scope="col" className="py-1 font-medium">{t('month', lang)}</th>
              <th scope="col" className="py-1 text-right font-medium">{t('totalSpend', lang)}</th>
              <th scope="col" className="py-1 text-right font-medium">{t('ordersCounted', lang)}</th>
            </tr>
          </thead>
          <tbody>
            {series.map((period) => (
              <tr key={period.period} className="border-t border-slate-100">
                <td className="py-1 text-slate-900">{monthLabel(period.period, lang, 'long')}</td>
                <td className="py-1 text-right tabular-nums text-slate-900">{money(period.totalEur)}</td>
                <td className="py-1 text-right tabular-nums text-slate-600">{period.orderCount}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </details>
    </Card>
  )
}
