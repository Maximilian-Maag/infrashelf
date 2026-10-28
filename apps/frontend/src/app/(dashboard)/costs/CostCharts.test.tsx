import { describe, it, expect } from 'vitest'
import { render, screen, within } from '@testing-library/react'
import type { CostBucket, CostPeriod } from '@infrashelf/types'
import { CostTrend } from './CostTrend'
import { CostDistribution } from './CostDistribution'
import { CostComparison } from './CostComparison'

/**
 * The cost charts (issue #106).
 *
 * These assert the three properties that make an inline-SVG chart safe to ship in
 * this app, none of which the type system can hold up:
 *
 *  1. Every number the picture encodes is also present as text, so a reader who
 *     cannot see it loses nothing. (axe checks structure; it cannot check that.)
 *  2. Identity is never carried by colour alone.
 *  3. The estimated / unconverted / not-a-projection caveats stay attached to the
 *     figures. A chart that drops them overstates precision the data lacks.
 */

const money = (eur: number) => `${eur.toFixed(2)} EUR`

const period = (p: string, totalBase: number, partial = false, orderCount = 1): CostPeriod => ({
  period: p,
  totalBase,
  orderCount,
  estimatedOrders: 0,
  partial,
})

const bucket = (id: number, label: string, totalBase: number): CostBucket => ({
  id,
  label,
  totalBase,
  orderCount: 1,
})

describe('CostTrend', () => {
  const series = [period('2026-06', 120, false, 4), period('2026-07', 0, false, 0), period('2026-08', 90, true, 3)]

  const renderTrend = (props: Partial<Parameters<typeof CostTrend>[0]> = {}) =>
    render(
      <CostTrend
        series={series}
        money={money}
        lang="en"
        estimatedOrders={0}
        unconverted={[]}
        {...props}
      />,
    )

  it('names the chart so it is not an unlabelled graphic', () => {
    renderTrend()
    // The name spans the window, because "spend over time" alone does not say
    // which time.
    const chart = screen.getByRole('img', { name: /spend over time/i })
    expect(chart.getAttribute('aria-label')).toMatch(/2026/)
  })

  it('puts every month and every figure in a table, not only in the picture', () => {
    const { container } = renderTrend()
    const table = container.querySelector('table') as HTMLElement
    // One header row plus one per month, including the zero month.
    expect(within(table).getAllByRole('row')).toHaveLength(series.length + 1)
    for (const amount of ['120.00 EUR', '90.00 EUR', '0.00 EUR']) {
      expect(within(table).getByText(amount), amount).toBeTruthy()
    }
    expect(within(table).getByText(/June 2026/)).toBeTruthy()
  })

  it('draws no column for a zero month but still lists it', () => {
    // Dropping the row would let the reader believe the gap was never measured.
    const { container } = renderTrend()
    expect(container.querySelectorAll('svg path')).toHaveLength(2)
    expect(screen.getByText(/July 2026/)).toBeTruthy()
  })

  it('says in words that the last month is unfinished', () => {
    // The hatch is a hint; the sentence is the information. A shorter last column
    // otherwise reads as a fall in spend. Said twice on purpose: once as a caveat
    // under the chart, once inside the column's own <title>.
    renderTrend()
    expect(screen.getAllByText(/this month is not over/i)).toHaveLength(2)
  })

  it('does not claim a month is unfinished when it is not', () => {
    renderTrend({ series: [period('2026-06', 120), period('2026-07', 90)] })
    expect(screen.queryByText(/this month is not over/i)).toBeNull()
  })

  it('keeps the not-a-projection caveat attached to the chart', () => {
    renderTrend()
    expect(screen.getByText(/not a projection over a period/i)).toBeTruthy()
  })

  it('carries the estimated and unconverted caveats with their figures', () => {
    renderTrend({ estimatedOrders: 2, unconverted: [{ currency: 'JPY', amount: 100 }] })
    expect(screen.getByText(/\(2\)/)).toBeTruthy()
    expect(screen.getByText(/100\.00 JPY/)).toBeTruthy()
  })

  it('says nothing was spent rather than drawing an empty axis', () => {
    renderTrend({ series: [] })
    expect(screen.getByText(/no spending recorded/i)).toBeTruthy()
    expect(screen.queryByRole('img')).toBeNull()
    // The caveats survive the empty state — an unconverted amount is exactly why a
    // window can look empty.
  })

  it('keeps all of its text out of the SVG, so it scales with the reader’s font', () => {
    // Text inside a stretched viewBox ignores the browser's font size and shrinks to
    // a few pixels on a phone. The axis is an HTML row laid out on the same grid.
    const { container } = renderTrend()
    expect(container.querySelectorAll('svg text')).toHaveLength(0)
    // One axis cell per column, so a label sits under its own mark.
    const axis = container.querySelector('div[aria-hidden="true"]') as HTMLElement
    expect(axis.children).toHaveLength(series.length)
  })

  it('scales the top of the axis to the largest month', () => {
    renderTrend()
    // The one y tick worth printing; every column is read against it.
    expect(screen.getAllByText('120.00 EUR').length).toBeGreaterThan(1)
  })

  /*
   * #195, F1. The disclosure below the chart is the ONLY text alternative to it
   * — the whole month-by-month table is behind it — and it shipped as a bare
   * `text-xs` summary, about 16px tall, against the 44px floor #178 set for
   * every other control in the app.
   *
   * Asserted here and not in the page scan: /costs is axe-scanned, but axe has
   * no rule for WCAG 2.5.5, so nothing there was ever going to catch it.
   */
  it('gives the data disclosure a pointer target, not just a label', () => {
    renderTrend()

    const summary = document.querySelector('summary')
    if (!summary) throw new Error('the chart has no disclosure to reveal its table')
    // `min-h-11` is 44px, which is the floor the rest of the app uses.
    expect(summary.className).toContain('min-h-11')
  })

  it('keeps the disclosure marker, so it reads as something that opens', () => {
    renderTrend()

    // A summary set to display:flex loses its triangle in Chrome. Padding is how
    // this one reaches 44px, and the distinction is the reason for the comment
    // on it — a future "tidy-up" to `flex items-center` would be a regression
    // nothing else would catch.
    const summary = document.querySelector('summary')
    if (!summary) throw new Error('the chart has no disclosure to reveal its table')
    expect(summary.className).not.toMatch(/\bflex\b/)
  })
})

describe('CostDistribution', () => {
  const buckets = [bucket(1, 'Webshop', 60), bucket(2, 'Intranet', 30), bucket(3, 'Wiki', 10)]

  const renderShare = (props: Partial<Parameters<typeof CostDistribution>[0]> = {}) =>
    render(
      <CostDistribution
        chartId="test-share"
        dimension="Per project"
        buckets={buckets}
        money={money}
        lang="en"
        estimatedOrders={0}
        unconverted={[]}
        {...props}
      />,
    )

  it('states every label, amount and share as text beside the bar', () => {
    renderShare()
    for (const label of ['Webshop', 'Intranet', 'Wiki']) {
      expect(screen.getByText(label), label).toBeTruthy()
    }
    expect(screen.getByText('60.00 EUR')).toBeTruthy()
    expect(screen.getByText(/^60\s*%$/)).toBeTruthy()
    expect(screen.getByText(/^10\s*%$/)).toBeTruthy()
  })

  it('hides the colour swatch from assistive technology', () => {
    // It repeats what the bar shows; announced, it would be noise, and it is never
    // the only thing carrying a segment's identity.
    const { container } = renderShare()
    expect(container.querySelectorAll('span[aria-hidden="true"]')).toHaveLength(buckets.length)
  })

  it('labels the percentage axis so a width can be read as a share', () => {
    // HTML, not SVG text: text inside the picture scales with the card and ignores
    // the reader's font size.
    const { container } = renderShare()
    expect(container.querySelectorAll('svg text')).toHaveLength(0)
    const axis = [...(container.querySelectorAll('div[aria-hidden="true"] > span') ?? [])].map(
      (n) => n.textContent?.replace(/\s/g, ''),
    )
    expect(axis).toEqual(['0%', '25%', '50%', '75%', '100%'])
  })

  it('folds the tail into one segment instead of drawing an unreadable number', () => {
    const many = Array.from({ length: 9 }, (_, i) => bucket(i + 1, `Project ${i + 1}`, 9 - i))
    renderShare({ buckets: many })
    expect(screen.getByText('Other')).toBeTruthy()
    // Five named plus the fold, and the shares still total 100 %.
    expect(screen.getAllByRole('row')).toHaveLength(7)
    expect(screen.queryByText('Project 7')).toBeNull()
  })

  it('shows the shares against the folded total, so they sum to a hundred', () => {
    const { container } = renderShare({ buckets: [bucket(1, 'A', 50), bucket(2, 'B', 50)] })
    const table = container.querySelector('table') as HTMLElement
    expect(within(table).getAllByText(/^50\s*%$/)).toHaveLength(2)
  })

  it('keeps the caveats attached', () => {
    renderShare({ estimatedOrders: 1 })
    expect(screen.getByText(/not a projection over a period/i)).toBeTruthy()
    expect(screen.getByText(/\(1\)/)).toBeTruthy()
  })

  it('lists the buckets without a bar when nothing could be converted', () => {
    // Every amount unconverted leaves real order counts and a zero total; a share
    // bar of zero-width segments would be a chart of nothing.
    renderShare({
      buckets: [bucket(1, 'Webshop', 0)],
      unconverted: [{ currency: 'JPY', amount: 100 }],
    })
    expect(screen.queryByRole('img')).toBeNull()
    expect(screen.getByText('Webshop')).toBeTruthy()
    expect(screen.getByText('—')).toBeTruthy()
  })
})

describe('CostComparison', () => {
  const comparison = {
    previous: period('2026-07', 40),
    current: period('2026-08', 50, true),
    changeBase: 10,
    changePct: 25,
  }

  const renderCompare = (props: Partial<Parameters<typeof CostComparison>[0]> = {}) =>
    render(
      <CostComparison
        comparison={comparison}
        money={money}
        lang="en"
        estimatedOrders={0}
        unconverted={[]}
        {...props}
      />,
    )

  it('names both months and prints both figures', () => {
    // The direction is derivable from the two absolutes even if the sign and the
    // arrow are both missed.
    renderCompare()
    expect(screen.getByText(/July 2026/)).toBeTruthy()
    expect(screen.getByText(/August 2026/)).toBeTruthy()
    expect(screen.getByText('40.00 EUR')).toBeTruthy()
    expect(screen.getByText('50.00 EUR')).toBeTruthy()
  })

  it('signs the delta rather than colouring it', () => {
    const { container } = renderCompare()
    expect(container.textContent).toContain('+10.00 EUR')
    expect(container.textContent).toContain('(+25%)')
  })

  it('uses a real minus sign for a fall', () => {
    renderCompare({
      comparison: { ...comparison, changeBase: -30, changePct: -75 },
    })
    // U+2212, not a hyphen: at this size a hyphen does not read as negative.
    expect(screen.getByText(/−30\.00 EUR/)).toBeTruthy()
    expect(screen.getByText(/\(−75%\)/)).toBeTruthy()
  })

  it('shows the absolute change and no percentage from a zero base', () => {
    // Infinity and "100 %" are both lies about a rise from nothing.
    const { container } = renderCompare({
      comparison: {
        previous: period('2026-07', 0),
        current: period('2026-08', 30),
        changeBase: 30,
        changePct: null,
      },
    })
    expect(container.textContent).toContain('+30.00 EUR')
    expect(container.textContent).not.toMatch(/\(\+/)
  })

  it('says the window is too short instead of comparing against nothing', () => {
    renderCompare({ comparison: null })
    expect(screen.getByText(/a comparison needs two months/i)).toBeTruthy()
    // No figures at all, rather than a delta computed against an excluded month.
    expect(screen.queryByText(/EUR/)).toBeNull()
  })

  it('flags an unfinished current month, which is not comparable to a whole one', () => {
    renderCompare()
    expect(screen.getByText(/this month is not over/i)).toBeTruthy()
  })

  it('keeps the caveats attached', () => {
    renderCompare({ unconverted: [{ currency: 'JPY', amount: 100 }] })
    const notices = screen.getByText(/not a projection over a period/i)
    expect(notices).toBeTruthy()
    expect(within(notices.parentElement as HTMLElement).getByText(/100\.00 JPY/)).toBeTruthy()
  })
})
