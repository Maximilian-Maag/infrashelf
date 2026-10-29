import { describe, it, expect } from 'vitest'
import { CHART_STEPS, CHART_FILL, CHART_PRIMARY, CHART_MUTED, CHART_GRID, CHART_AXIS } from './chartTokens'

/**
 * The chart palette (issue #106, #195, #245).
 *
 * Structure, not the hex values: the steps are read from the operator's branding
 * at runtime and these are only the fallbacks. What has to hold is that the ramp
 * is complete, ordered the same way everywhere, and that the axis is a DIFFERENT
 * colour from the gridlines — the #195 finding was a bare literal in one chart
 * contradicting this file's own doc.
 */
describe('chartTokens', () => {
  it('publishes a full ramp, and says how many steps that is', () => {
    expect(CHART_STEPS).toBe(CHART_FILL.length)
    expect(CHART_FILL.length).toBe(6)
  })

  it('gives each step its own CSS variable, in order', () => {
    // The index is the tone: darkest first, painted in the order the data is
    // sorted. A step pointing at the wrong variable would repaint a chart out of
    // order without failing anything else.
    CHART_FILL.forEach((fill, i) => {
      expect(fill).toMatch(new RegExp(`^var\\(--chart-${i + 1}, #[0-9a-f]{6}\\)$`))
    })
  })

  it('reads the primary and muted steps off the ramp rather than repeating them', () => {
    expect(CHART_PRIMARY).toBe(CHART_FILL[0])
    expect(CHART_MUTED).toBe(CHART_FILL[4])
  })

  it('keeps the axis distinguishable from the gridlines (#195)', () => {
    expect(CHART_AXIS).not.toBe(CHART_GRID)
    expect(CHART_GRID).toMatch(/^#[0-9a-f]{6}$/)
    expect(CHART_AXIS).toMatch(/^#[0-9a-f]{6}$/)
  })
})
