import { describe, it, expect } from 'vitest'
import { render, screen } from '@testing-library/react'
import { CostCaveats } from './CostCaveats'

const caveats = (over: Partial<Parameters<typeof CostCaveats>[0]> = {}) =>
  render(<CostCaveats estimatedOrders={0} unconverted={[]} lang="en" {...over} />)

/**
 * The precision caveats, repeated wherever a figure is drawn (#106).
 *
 * A column per month looks exactly like a monthly run rate, and the catalogue
 * stores no billing period — so what these say about the numbers beside them is
 * the difference between a figure and a claim.
 */
describe('CostCaveats', () => {
  it('always says the figure is not a projection', () => {
    // The one caveat that is unconditional: it is true of every figure on the
    // page, including a page with nothing wrong with it.
    caveats()
    expect(screen.getByText(/not a projection/i)).toBeInTheDocument()
  })

  it('says nothing else when there is nothing else to say', () => {
    caveats()
    expect(screen.queryByText(/estimated/i)).not.toBeInTheDocument()
    expect(screen.queryByText(/could not be converted/i)).not.toBeInTheDocument()
    expect(screen.queryByText(/no recoverable price/i)).not.toBeInTheDocument()
  })

  it('counts the orders priced from the live offering rather than their snapshot', () => {
    caveats({ estimatedOrders: 3 })
    expect(screen.getByText(/\(3\)/)).toBeInTheDocument()
  })

  it('names every currency it could not convert, and the amount in it', () => {
    // Counted at zero rather than silently as EUR, so the figure above is short
    // by exactly these — which is only legible if they are printed.
    caveats({ unconverted: [{ currency: 'CHF', amount: 1234.5 }, { currency: 'GBP', amount: 7 }] })

    const line = screen.getByText(/1234\.50 CHF/)
    expect(line).toHaveTextContent('7.00 GBP')
  })

  it('marks the unpriced orders more strongly than the rest', () => {
    // The strongest caveat on the card (#189): an estimated order is counted at a
    // price that may be wrong and an unconverted one is reported in its own
    // currency, but this is money simply missing from the total.
    caveats({ unpricedOrders: 2, estimatedOrders: 1 })

    const unpriced = screen.getByText(/\(2\)/)
    expect(unpriced.className).toContain('text-red-700')
    expect(screen.getByText(/\(1\)/).className).toContain('text-amber-700')
  })

  it('says the month is still running only when it is', () => {
    const running = caveats({ monthInProgress: true })
    expect(screen.getByText(/this month is not over/i)).toBeInTheDocument()
    running.unmount()

    caveats({ monthInProgress: false })
    expect(screen.queryByText(/this month is not over/i)).not.toBeInTheDocument()
  })
})
