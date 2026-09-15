import { describe, it, expect } from 'vitest'
import { render, screen } from '@testing-library/react'
import type { CostComparison as Comparison } from '@infrashelf/types'
import { CostComparison } from './CostComparison'
import { CHART_PRIMARY, CHART_MUTED } from '@/lib/chartTokens'

/**
 * Month over month (#106).
 *
 * Untested until now, which is most of why it scored 33% under mutation. The
 * things worth pinning are the ones a reader acts on: the direction of the
 * change, the sign in front of the money, and the hatching that says a month is
 * still in progress — a figure the reader would otherwise compare against a
 * complete month as though it were one.
 */
const period = (over: { period: string; totalEur: number; partial?: boolean }) => ({
  period: over.period,
  totalEur: over.totalEur,
  partial: over.partial ?? false,
  orderCount: 1,
})

const comparison = (over: Partial<Comparison> & { currentEur: number; previousEur: number; changeEur: number; changePct: number | null; currentPartial?: boolean }) =>
  ({
    current: period({ period: '2026-09', totalEur: over.currentEur, partial: over.currentPartial }),
    previous: period({ period: '2026-08', totalEur: over.previousEur }),
    changeEur: over.changeEur,
    changePct: over.changePct,
  }) as unknown as Comparison

const money = (eur: number) => `${eur.toFixed(2)} EUR`

const renderCard = (c: Comparison | null) =>
  render(
    <CostComparison comparison={c} money={money} lang="en" estimatedOrders={0} unconverted={[]} />,
  )

/**
 * The headline line, as one string.
 *
 * The arrow, the sign, the money and the percentage are four sibling text nodes
 * in one `<p>`, so `getByText('-')` matches nothing and a `/\+/` matcher matches
 * several. Reading the paragraph is what the user actually sees.
 */
const headline = (container: HTMLElement) =>
  container.querySelector('p.text-2xl')?.textContent ?? ''

const bars = (container: HTMLElement) =>
  [...container.querySelectorAll('svg:not([width="0"]) rect')].filter(
    (r) => r.getAttribute('fill') !== '#f1f5f9',
  )

describe('with nothing to compare', () => {
  it('asks for a wider range rather than drawing an empty chart', () => {
    const { container } = renderCard(null)
    expect(screen.getByText(/needs two months/i)).toBeInTheDocument()
    expect(bars(container)).toHaveLength(0)
  })
})

describe('the direction of the change', () => {
  it('marks a rise with an up arrow and a plus', () => {
    const { container } = renderCard(
      comparison({ currentEur: 150, previousEur: 100, changeEur: 50, changePct: 50 }),
    )
    expect(screen.getByText('▲')).toBeInTheDocument()
    expect(headline(container)).toContain('+')
  })

  it('marks a fall with a down arrow and a real minus sign', () => {
    // A minus, not a hyphen: the hyphen renders too short to read as negative at
    // this size, which is the whole reason the component picks the character.
    const { container } = renderCard(
      comparison({ currentEur: 60, previousEur: 100, changeEur: -40, changePct: -40 }),
    )
    expect(screen.getByText('▼')).toBeInTheDocument()
    expect(headline(container)).toContain('−')
    expect(headline(container)).not.toContain('-')
  })

  it('marks no change with a dash and no sign at all', () => {
    renderCard(comparison({ currentEur: 100, previousEur: 100, changeEur: 0, changePct: 0 }))
    expect(screen.getByText('–')).toBeInTheDocument()
    expect(screen.queryByText('▲')).not.toBeInTheDocument()
    expect(screen.queryByText('▼')).not.toBeInTheDocument()
  })

  it('always prints the money as a magnitude, with the sign carried separately', () => {
    // `Math.abs`, so a fall reads "− 40.00" rather than "− -40.00".
    const { container } = renderCard(
      comparison({ currentEur: 60, previousEur: 100, changeEur: -40, changePct: -40 }),
    )
    expect(headline(container)).toContain('40.00 EUR')
    expect(headline(container)).not.toContain('-40.00')
  })

  it('hides the arrow from assistive technology, because the sign already says it', () => {
    renderCard(comparison({ currentEur: 150, previousEur: 100, changeEur: 50, changePct: 50 }))
    expect(screen.getByText('▲')).toHaveAttribute('aria-hidden', 'true')
  })
})

describe('the percentage beside the change', () => {
  it('prints it when there is one', () => {
    // `changePct` is a percentage NUMBER, not a fraction: the component passes it
    // through `sharePercent(pct, 100)`, so 50 renders as "50%". Written as 0.5
    // this asserted "0.5%" and the test was the thing that was wrong.
    const { container } = renderCard(
      comparison({ currentEur: 150, previousEur: 100, changeEur: 50, changePct: 50 }),
    )
    expect(headline(container)).toContain('50%')
  })

  it('omits it entirely when the previous month was zero', () => {
    // A change from nothing has no percentage — the API sends null rather than
    // infinity, and the card must not print "Infinity%".
    const { container } = renderCard(
      comparison({ currentEur: 150, previousEur: 0, changeEur: 150, changePct: null }),
    )
    expect(headline(container)).not.toContain('%')
  })
})

describe('the two bars', () => {
  it('scales each against the larger month', () => {
    const { container } = renderCard(
      comparison({ currentEur: 50, previousEur: 100, changeEur: -50, changePct: -50 }),
    )
    const [previous, current] = bars(container)
    // 320 viewBox units wide: the bigger month fills it, the smaller takes half.
    expect(previous.getAttribute('width')).toBe('320')
    expect(current.getAttribute('width')).toBe('160')
  })

  it('never draws a bar thinner than three units', () => {
    // A month with almost nothing in it still has to be visible as a bar.
    const { container } = renderCard(
      comparison({ currentEur: 0.01, previousEur: 10_000, changeEur: -9999.99, changePct: -100 }),
    )
    for (const bar of bars(container)) {
      expect(Number(bar.getAttribute('width'))).toBeGreaterThanOrEqual(3)
    }
  })

  it('draws no bar at all for a month with nothing in it', () => {
    const { container } = renderCard(
      comparison({ currentEur: 0, previousEur: 100, changeEur: -100, changePct: -100 }),
    )
    // Only the previous month's bar; a zero-width rect would be a smudge.
    expect(bars(container)).toHaveLength(1)
  })

  it('emphasises the current month and mutes the previous one', () => {
    const { container } = renderCard(
      comparison({ currentEur: 100, previousEur: 50, changeEur: 50, changePct: 100 }),
    )
    const [previous, current] = bars(container)
    expect(previous.getAttribute('fill')).toBe(CHART_MUTED)
    expect(current.getAttribute('fill')).toBe(CHART_PRIMARY)
  })

  it('hatches a month that is still in progress', () => {
    /*
     * The caveat that matters most on this card: a partial month compared against
     * a complete one looks like a fall. The hatch is what says "not finished",
     * and it beats the emphasis colour rather than the other way round.
     */
    const { container } = renderCard(
      comparison({ currentEur: 40, previousEur: 100, changeEur: -60, changePct: -60, currentPartial: true }),
    )
    const [, current] = bars(container)
    expect(current.getAttribute('fill')).toContain('url(#')
    expect(current.getAttribute('fill')).not.toBe(CHART_PRIMARY)
  })
})

describe('both months are named as text', () => {
  it('labels each row with its own month', () => {
    renderCard(comparison({ currentEur: 150, previousEur: 100, changeEur: 50, changePct: 50 }))
    expect(screen.getByText(/August 2026/)).toBeInTheDocument()
    expect(screen.getByText(/September 2026/)).toBeInTheDocument()
  })

  it('prints each month total beside its label', () => {
    renderCard(comparison({ currentEur: 150, previousEur: 100, changeEur: 50, changePct: 50 }))
    expect(screen.getByText('150.00 EUR')).toBeInTheDocument()
    expect(screen.getByText('100.00 EUR')).toBeInTheDocument()
  })

  it('hides the bars from assistive technology, since the figures are already text', () => {
    const { container } = renderCard(
      comparison({ currentEur: 150, previousEur: 100, changeEur: 50, changePct: 50 }),
    )
    for (const svg of container.querySelectorAll('svg')) {
      expect(svg).toHaveAttribute('aria-hidden', 'true')
    }
  })
})
