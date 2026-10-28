import type { CostBucket } from '@infrashelf/types'

/**
 * Shared data shaping for the cost charts (issue #106).
 *
 * Kept out of the components so the rules that decide what a chart is allowed to
 * show — how a month is named, and where the tail is folded — are testable without
 * rendering an SVG.
 */

/**
 * `YYYY-MM` → a month name in the viewer's language.
 *
 * The API deliberately returns a machine-readable period rather than a formatted
 * label: the backend does not know the viewer's locale, and 25 hard-coded month
 * tables would be 300 translation strings for something Intl already knows. UTC
 * because the filter boundaries are UTC — formatting in the browser's zone would
 * shift a January order into December for anyone west of Greenwich.
 */
export const monthLabel = (
  period: string,
  lang: string,
  month: 'short' | 'long' = 'short',
): string => {
  const [year, index] = period.split('-').map(Number)
  if (!Number.isInteger(year) || !Number.isInteger(index) || index < 1 || index > 12) return period
  try {
    return new Intl.DateTimeFormat(lang, { month, year: 'numeric', timeZone: 'UTC' }).format(
      new Date(Date.UTC(year, index - 1, 1)),
    )
  } catch {
    // An unsupported or malformed language tag makes Intl throw. The raw period is
    // still readable, which is better than a chart with no axis at all.
    return period
  }
}

/**
 * The largest `max - 1` buckets plus everything else summed into one.
 *
 * Part-to-whole stops being readable past about six segments — adjacent shares blur
 * and no tone ramp can separate them — so the tail is folded rather than drawn. It
 * is folded, not dropped: the segments still add up to the total, which is the only
 * thing that makes a share chart honest. The API already sorts by spend descending.
 */
export const foldTail = (buckets: CostBucket[], max: number, otherLabel: string): CostBucket[] => {
  if (max < 1) return []
  if (buckets.length <= max) return buckets
  const tail = buckets.slice(max - 1)
  return [
    ...buckets.slice(0, max - 1),
    {
      id: null,
      label: otherLabel,
      totalBase: Math.round(tail.reduce((sum, b) => sum + b.totalBase, 0) * 100) / 100,
      orderCount: tail.reduce((sum, b) => sum + b.orderCount, 0),
    },
  ]
}

/** A share as a locale-formatted percentage, or `—` when the total is zero. */
export const sharePercent = (value: number, total: number, lang: string): string => {
  if (total <= 0) return '—'
  try {
    return new Intl.NumberFormat(lang, { style: 'percent', maximumFractionDigits: 1 }).format(
      value / total,
    )
  } catch {
    return `${Math.round((value / total) * 1000) / 10}%`
  }
}
