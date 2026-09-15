import { describe, it, expect } from 'vitest'
import { render, screen, within } from '@testing-library/react'
import type { CostBucket } from '@infrashelf/types'
import { CostDistribution } from './CostDistribution'
import { CHART_STEPS } from '@/lib/chartTokens'

/**
 * The share-of-total bar (#106), and the table that carries the same figures as
 * text.
 *
 * This component had no test at all, which is most of why it scored 37% under
 * mutation: the numbers it draws — segment widths, the folded tail, the share
 * percentages — were asserted by nothing. What is tested here is the arithmetic
 * and the accessibility contract the file's own header commits to: nothing
 * knowable only from a hue, and the bar reaching 100% of its width.
 */
const bucket = (over: Partial<CostBucket> & { label: string; totalEur: number }): CostBucket =>
  ({ id: 1, orderCount: 1, ...over }) as CostBucket

const money = (eur: number) => `${eur.toFixed(2)} EUR`

const renderChart = (buckets: CostBucket[], over?: { estimatedOrders?: number }) =>
  render(
    <CostDistribution
      dimension="Per project"
      buckets={buckets}
      money={money}
      lang="en"
      chartId="dist"
      estimatedOrders={over?.estimatedOrders ?? 0}
      unconverted={[]}
    />,
  )

const segments = (container: HTMLElement) => [...container.querySelectorAll('svg g rect')]

/**
 * The axis row, scoped.
 *
 * `getByText('100%')` is ambiguous on this component: the axis prints it AND the
 * table prints it as the share of a lone bucket. Querying the page for it found
 * both and told me the assertion was wrong, not the component.
 */
const axis = (container: HTMLElement) =>
  within(container.querySelector('[aria-hidden="true"].relative') as HTMLElement)

describe('the bar encodes share as width', () => {
  it('gives each segment a width proportional to its share', () => {
    const { container } = renderChart([
      bucket({ id: 1, label: 'Alpha', totalEur: 75 }),
      bucket({ id: 2, label: 'Beta', totalEur: 25 }),
    ])

    const [first, second] = segments(container)
    // 1000 viewBox units: 75% and 25%, less the 2-unit gap on every segment but
    // the last. The gap eats into the segment rather than being drawn around it,
    // so the bar still reaches the full width.
    expect(first.getAttribute('width')).toBe('748')
    expect(second.getAttribute('width')).toBe('250')
  })

  it('lays the segments out cumulatively, with no gap at the left edge', () => {
    const { container } = renderChart([
      bucket({ id: 1, label: 'Alpha', totalEur: 60 }),
      bucket({ id: 2, label: 'Beta', totalEur: 40 }),
    ])

    const [first, second] = segments(container)
    expect(first.getAttribute('x')).toBe('0')
    // The second starts where the first's FULL share ended — not where its
    // gap-reduced width ended, or the bar would drift left by 2 units a segment.
    expect(second.getAttribute('x')).toBe('600')
  })

  it('keeps the last segment full width, so the bar reaches 100%', () => {
    const { container } = renderChart([
      bucket({ id: 1, label: 'Alpha', totalEur: 50 }),
      bucket({ id: 2, label: 'Beta', totalEur: 50 }),
    ])

    const rects = segments(container)
    const last = rects[rects.length - 1]
    const right = Number(last.getAttribute('x')) + Number(last.getAttribute('width'))
    expect(right).toBe(1000)
  })

  it('never draws a segment thinner than one unit', () => {
    // A rounding floor, so a tiny-but-real share is still visible rather than
    // vanishing into the gap subtraction.
    const { container } = renderChart([
      bucket({ id: 1, label: 'Huge', totalEur: 100_000 }),
      bucket({ id: 2, label: 'Sliver', totalEur: 1 }),
      bucket({ id: 3, label: 'Tail', totalEur: 1 }),
    ])

    for (const rect of segments(container)) {
      expect(Number(rect.getAttribute('width'))).toBeGreaterThanOrEqual(1)
    }
  })

  it('says so plainly when there are no buckets at all', () => {
    const { container } = renderChart([])
    expect(container.querySelector('svg')).toBeNull()
    expect(screen.getByText(/no spending recorded/i)).toBeInTheDocument()
  })

  it('drops the bar but keeps the table when every bucket is zero', () => {
    /*
     * Two different empty states, and the component is right to tell them apart.
     * No buckets means nothing was recorded. Buckets that all total zero means
     * something WAS recorded and priced at nothing — the rows still have to
     * appear, or a reader cannot tell "no orders" from "orders worth nothing".
     */
    const { container } = renderChart([bucket({ label: 'Nothing', totalEur: 0 })])

    expect(container.querySelector('svg')).toBeNull()
    expect(screen.queryByText(/no spending recorded/i)).not.toBeInTheDocument()

    const row = screen.getByText('Nothing').closest('tr') as HTMLElement
    // A share of zero out of zero is not 0%, it is unknowable — `sharePercent`
    // answers with an em dash rather than inventing a number.
    expect(within(row).getByText('—')).toBeInTheDocument()
  })
})

describe('the tail is folded rather than dropped', () => {
  it('sums everything past the step count into one bucket', () => {
    // Segments that do not add up to the total make a share chart a lie, so the
    // tail is summed rather than cut.
    const many = Array.from({ length: CHART_STEPS + 3 }, (_, i) =>
      bucket({ id: i + 1, label: `B${i}`, totalEur: 10 }),
    )
    renderChart(many)

    const rows = screen.getAllByRole('row').slice(1)
    expect(rows).toHaveLength(CHART_STEPS)
    // The folded row carries the sum of the four it replaced.
    const other = rows[rows.length - 1]
    expect(within(other).getByText('Other')).toBeInTheDocument()
    expect(within(other).getByText('40.00 EUR')).toBeInTheDocument()
  })

  it('leaves the buckets alone when there are few enough to show', () => {
    renderChart([
      bucket({ id: 1, label: 'Alpha', totalEur: 10 }),
      bucket({ id: 2, label: 'Beta', totalEur: 10 }),
    ])
    expect(screen.queryByText('Other')).not.toBeInTheDocument()
  })
})

describe('everything on the chart is also there as text', () => {
  it('names each segment with its amount and its share in the table', () => {
    renderChart([
      bucket({ id: 1, label: 'Alpha', totalEur: 75 }),
      bucket({ id: 2, label: 'Beta', totalEur: 25 }),
    ])

    const alpha = screen.getByText('Alpha').closest('tr') as HTMLElement
    expect(within(alpha).getByText('75.00 EUR')).toBeInTheDocument()
    expect(within(alpha).getByText('75%')).toBeInTheDocument()

    const beta = screen.getByText('Beta').closest('tr') as HTMLElement
    expect(within(beta).getByText('25%')).toBeInTheDocument()
  })

  it('gives every segment a title carrying label, amount and share', () => {
    // The SVG is one image to assistive technology; the per-segment title is what
    // a pointer user gets, and it must not disagree with the table.
    const { container } = renderChart([
      bucket({ id: 1, label: 'Alpha', totalEur: 75 }),
      bucket({ id: 2, label: 'Beta', totalEur: 25 }),
    ])
    const titles = [...container.querySelectorAll('svg title')].map((n) => n.textContent)
    expect(titles).toEqual(['Alpha: 75.00 EUR — 75%', 'Beta: 25.00 EUR — 25%'])
  })

  it('labels the bar with the dimension it is splitting', () => {
    const { container } = renderChart([bucket({ label: 'Alpha', totalEur: 10 })])
    const svg = container.querySelector('svg[role="img"]')
    expect(svg?.getAttribute('aria-label')).toContain('Per project')
  })

  it('hides the swatch and the axis from assistive technology', () => {
    // Both only restate what the table says in words; announced, they are noise.
    const { container } = renderChart([bucket({ label: 'Alpha', totalEur: 10 })])
    const axisRow = container.querySelector('[aria-hidden="true"].relative')
    expect(axisRow).not.toBeNull()
    expect(container.querySelector('span.rounded-sm')).toHaveAttribute('aria-hidden', 'true')
  })
})

describe('the percentage axis', () => {
  it('prints all five ticks', () => {
    const { container } = renderChart([bucket({ label: 'Alpha', totalEur: 10 })])
    for (const label of ['0%', '25%', '50%', '75%', '100%']) {
      expect(axis(container).getByText(label)).toBeInTheDocument()
    }
  })

  it('positions each tick at its true fraction, not evenly spaced', () => {
    const { container } = renderChart([bucket({ label: 'Alpha', totalEur: 10 })])
    expect(axis(container).getByText('25%').getAttribute('style')).toContain('left: 25%')
    expect(axis(container).getByText('75%').getAttribute('style')).toContain('left: 75%')
  })

  it('pulls the end labels inside the bar and leaves the first one alone', () => {
    // `justify-between` distributes the GAPS, which puts a wide "100 %" and a
    // narrow "0 %" off their own marks.
    const { container } = renderChart([bucket({ label: 'Alpha', totalEur: 10 })])
    expect(axis(container).getByText('0%').getAttribute('style')).not.toContain('translateX')
    expect(axis(container).getByText('100%').getAttribute('style')).toContain('translateX(-100%)')
    expect(axis(container).getByText('50%').getAttribute('style')).toContain('translateX(-50%)')
  })
})

describe('the caveats travel with the figures', () => {
  it('passes the estimated-order count through', () => {
    renderChart([bucket({ label: 'Alpha', totalEur: 10 })], { estimatedOrders: 3 })
    expect(screen.getByText(/3/)).toBeInTheDocument()
  })
})
