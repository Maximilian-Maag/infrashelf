import { describe, it, expect } from 'vitest'
import { render, screen, within } from '@testing-library/react'
import { CostTrend } from './CostTrend'
import { CHART_PRIMARY } from '@/lib/chartTokens'

/**
 * Spend per month (#106).
 *
 * The file's own header commits to three things a test can hold it to: height
 * encodes the amount and nothing is encoded by colour, every number in the
 * picture is also in the table, and the unfinished month is marked so a shorter
 * last column cannot read as a fall in spend. Untested until now.
 */
const month = (over: { period: string; totalEur: number; partial?: boolean; orderCount?: number }) => ({
  period: over.period,
  totalEur: over.totalEur,
  partial: over.partial ?? false,
  orderCount: over.orderCount ?? 1,
})

const money = (eur: number) => `${eur.toFixed(2)} EUR`

const renderTrend = (series: ReturnType<typeof month>[]) =>
  render(
    <CostTrend
      series={series as never}
      money={money}
      lang="en"
      estimatedOrders={0}
      unconverted={[]}
    />,
  )

const columns = (container: HTMLElement) => [...container.querySelectorAll('svg path')]
/** The detail table. Months and amounts also appear on the axis and the y tick. */
const table = (container: HTMLElement) =>
  within(container.querySelector('table') as HTMLElement)
/** The x-axis row: one cell per column, most of them deliberately blank. */
const axisCells = (container: HTMLElement) =>
  [...(container.querySelector('div[aria-hidden="true"].sm\\:flex')?.children ?? [])].map(
    (n) => n.textContent,
  )

describe('with nothing to draw', () => {
  it('says so instead of rendering an empty plot', () => {
    const { container } = renderTrend([])
    expect(screen.getByText(/no spending recorded/i)).toBeInTheDocument()
    expect(container.querySelector('svg')).toBeNull()
  })
})

describe('height encodes the amount', () => {
  it('draws the tallest column for the largest month', () => {
    const { container } = renderTrend([
      month({ period: '2026-07', totalEur: 50 }),
      month({ period: '2026-08', totalEur: 100 }),
    ])
    const [small, large] = columns(container).map((p) => p.getAttribute('d') ?? '')
    // The path starts at the baseline and rises to `top`; a smaller `top` is a
    // taller column. Reading the second number of the `L` command is enough.
    const topOf = (d: string) => Number(/L \S+ (\S+)/.exec(d)?.[1])
    expect(topOf(large)).toBeLessThan(topOf(small))
  })

  it('scales the largest month to the full plot height', () => {
    const { container } = renderTrend([month({ period: '2026-08', totalEur: 100 })])
    const d = columns(container)[0].getAttribute('d') ?? ''
    /*
     * The apex, not the left edge: a column is centred in its slot, so its `x`
     * is not 0. The rounded cap means the straight segment stops at `top + r`
     * and the curve reaches `top` — so the tallest column is the one whose
     * curve apex is at y = 0.
     */
    expect(d).toMatch(/Q \d+ 0 /)
  })

  it('leaves a month with no spend undrawn rather than flat', () => {
    // A zero-height column is a smudge on the axis, not information.
    const { container } = renderTrend([
      month({ period: '2026-07', totalEur: 0 }),
      month({ period: '2026-08', totalEur: 100 }),
    ])
    expect(columns(container)).toHaveLength(1)
  })

  it('prints the top of the scale as text', () => {
    // The one y tick worth having — the figure every column is drawn against.
    const { container } = renderTrend([
      month({ period: '2026-07', totalEur: 40 }),
      month({ period: '2026-08', totalEur: 90 }),
    ])
    // Scoped: the same figure is in the table too, as the August row's amount.
    expect(container.querySelector('p.text-xs')?.textContent).toBe('90.00 EUR')
  })
})

describe('the unfinished month is marked', () => {
  it('hatches it rather than colouring it differently', () => {
    /*
     * The caveat this chart exists to avoid getting wrong: a partial month is
     * shorter than a complete one and would otherwise read as a fall in spend.
     * A hatch survives greyscale and forced-colors; a hue does not.
     */
    const { container } = renderTrend([
      month({ period: '2026-07', totalEur: 100 }),
      month({ period: '2026-08', totalEur: 40, partial: true }),
    ])
    const [complete, partial] = columns(container)
    expect(complete.getAttribute('fill')).toBe(CHART_PRIMARY)
    expect(partial.getAttribute('fill')).toContain('url(#')
  })

  it('says it in words as well, on the column title', () => {
    const { container } = renderTrend([month({ period: '2026-08', totalEur: 40, partial: true })])
    expect(container.querySelector('svg title')?.textContent).toContain('not over')
  })

  it('says nothing about it for a month that is finished', () => {
    const { container } = renderTrend([month({ period: '2026-08', totalEur: 40 })])
    expect(container.querySelector('svg title')?.textContent).not.toContain('not over')
  })
})

describe('every column carries its own figures', () => {
  it('names the month, the amount and the order count', () => {
    const { container } = renderTrend([
      month({ period: '2026-08', totalEur: 250, orderCount: 7 }),
    ])
    const title = container.querySelector('svg title')?.textContent ?? ''
    expect(title).toContain('August 2026')
    expect(title).toContain('250.00 EUR')
    expect(title).toContain('7 orders')
  })

  it('names the whole range on the picture itself', () => {
    const { container } = renderTrend([
      month({ period: '2026-06', totalEur: 10 }),
      month({ period: '2026-08', totalEur: 20 }),
    ])
    const label = container.querySelector('svg[role="img"]')?.getAttribute('aria-label') ?? ''
    expect(label).toContain('June 2026')
    expect(label).toContain('August 2026')
  })
})

describe('the x axis', () => {
  it('always names the most recent month', () => {
    // Labels are counted BACK from the last, because that is the one a reader
    // looks for first. Counted forward, a 7-month series would leave it blank.
    const series = Array.from({ length: 7 }, (_, i) =>
      month({ period: `2026-0${i + 1}`, totalEur: 10 }),
    )
    const { container } = renderTrend(series)
    const cells = axisCells(container)
    expect(cells[cells.length - 1]).toBeTruthy()
  })

  it('thins the labels out rather than printing all of them', () => {
    const series = Array.from({ length: 12 }, (_, i) =>
      month({ period: `2026-${String(i + 1).padStart(2, '0')}`, totalEur: 10 }),
    )
    const { container } = renderTrend(series)
    const named = axisCells(container).filter(Boolean)
    // One cell per column either way — it is the LABELS that thin out, so the
    // marks and the labels stay on the same grid.
    expect(axisCells(container)).toHaveLength(12)
    expect(named.length).toBeLessThan(12)
    expect(named.length).toBeGreaterThan(0)
  })

  it('names every month when there are few enough', () => {
    const { container } = renderTrend([
      month({ period: '2026-07', totalEur: 10 }),
      month({ period: '2026-08', totalEur: 20 }),
    ])
    expect(axisCells(container).filter(Boolean)).toHaveLength(2)
  })
})

describe('the table is the data, not a second rendering of it', () => {
  it('lists every month with its amount and order count', () => {
    const { container } = renderTrend([
      month({ period: '2026-07', totalEur: 10, orderCount: 2 }),
      month({ period: '2026-08', totalEur: 20, orderCount: 3 }),
    ])
    const july = table(container).getByText(/July 2026/).closest('tr') as HTMLElement
    expect(within(july).getByText('10.00 EUR')).toBeInTheDocument()
    expect(within(july).getByText('2')).toBeInTheDocument()
  })

  it('includes a month that had no spend, which the chart omits', () => {
    // The chart drops a zero column; the table must not, or the reader cannot
    // tell a quiet month from a missing one.
    const { container } = renderTrend([
      month({ period: '2026-07', totalEur: 0, orderCount: 0 }),
      month({ period: '2026-08', totalEur: 20 }),
    ])
    expect(table(container).getByText(/July 2026/)).toBeInTheDocument()
  })
})

describe('gaps the mutation run pointed at', () => {
  it('draws the gridlines only when there is a scale to draw them against', () => {
    // `max > 0`, not `>= 0`: with every month at zero there is no scale, and two
    // hairlines across an empty plot suggest one.
    const { container } = renderTrend([month({ period: '2026-08', totalEur: 0 })])
    // `svg > line`, not `svg line`: the hatch pattern inside <defs> is a <line>
    // too, and counting it made this assertion off by one.
    const grid = [...container.querySelectorAll('svg > line')]
    // The baseline axis is always drawn; the two gridlines above it are not.
    expect(grid).toHaveLength(1)
  })

  it('draws both gridlines once there is spend', () => {
    const { container } = renderTrend([month({ period: '2026-08', totalEur: 10 })])
    expect(container.querySelectorAll('svg > line')).toHaveLength(3)
  })

  it('counts the axis labels back from the last month, not forward from the first', () => {
    /*
     * `(last - i) % step`, not `(last + i) % step`. Both name the same NUMBER of
     * months, so a count assertion passes either way — what separates them is
     * WHICH months, and the most recent one has to be among them.
     */
    const series = Array.from({ length: 8 }, (_, i) =>
      month({ period: `2026-0${i + 1}`, totalEur: 10 }),
    )
    const { container } = renderTrend(series)
    const cells = axisCells(container)

    // step = ceil(8/6) = 2, counted back from index 7: 7, 5, 3, 1.
    expect(cells[7]).toBeTruthy()
    expect(cells[5]).toBeTruthy()
    expect(cells[6]).toBe('')
    expect(cells[0]).toBe('')
  })

  it('rounds the top corners rather than squaring or inverting them', () => {
    // `top + r`, not `top - r`: a negative radius turns the cap inside out, and
    // the column reads as a notch.
    const { container } = renderTrend([month({ period: '2026-08', totalEur: 100 })])
    const d = columns(container)[0].getAttribute('d') ?? ''
    // The straight segment stops BELOW the apex, so its y is greater than 0.
    const straightY = Number(/L \S+ (\S+)/.exec(d)?.[1])
    expect(straightY).toBeGreaterThan(0)
    expect(d).toMatch(/Q \d+ 0 /)
  })

  it('names each column of the table', () => {
    // Three headers, each its own string: an empty one leaves a column of
    // numbers with nothing saying what they are.
    const { container } = renderTrend([month({ period: '2026-08', totalEur: 10 })])
    const headers = [...(container.querySelectorAll('thead th') ?? [])].map((h) => h.textContent)
    expect(headers).toHaveLength(3)
    for (const header of headers) expect(header).toBeTruthy()
  })
})
