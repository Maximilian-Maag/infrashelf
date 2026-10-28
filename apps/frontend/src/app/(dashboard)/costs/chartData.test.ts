import { describe, it, expect } from 'vitest'
import type { CostBucket } from '@infrashelf/types'
import { monthLabel, foldTail, sharePercent } from './chartData'

const bucket = (id: number, label: string, totalBase: number, orderCount = 1): CostBucket => ({
  id,
  label,
  totalBase,
  orderCount,
})

describe('monthLabel', () => {
  it('names the month in the viewer’s language', () => {
    expect(monthLabel('2026-08', 'en')).toMatch(/Aug/)
    expect(monthLabel('2026-08', 'de')).toMatch(/Aug/)
    expect(monthLabel('2026-01', 'fr', 'long')).toMatch(/janvier/i)
    // The year is always present: a twelve-month window crosses one.
    expect(monthLabel('2026-08', 'en')).toContain('2026')
  })

  it('reads the period as UTC, not the browser’s zone', () => {
    // The filter boundaries are UTC. Formatting the first of January in a western
    // zone would render it as the previous December and shift the whole axis.
    expect(monthLabel('2026-01', 'en')).toMatch(/Jan/)
    expect(monthLabel('2026-12', 'en')).toMatch(/Dec/)
  })

  it('falls back to the raw period rather than throwing on a bad language tag', () => {
    // getLang can hand through anything an Accept-Language header contained.
    expect(monthLabel('2026-08', 'not a tag')).toBe('2026-08')
  })

  it('falls back to the raw period for a malformed one', () => {
    for (const bad of ['', 'nonsense', '2026', '2026-13', '2026-00']) {
      expect(monthLabel(bad, 'en'), bad).toBe(bad)
    }
  })
})

describe('foldTail', () => {
  const many = Array.from({ length: 10 }, (_, i) => bucket(i + 1, `P${i + 1}`, 10 - i, 2))

  it('leaves a short list alone', () => {
    const short = many.slice(0, 4)
    expect(foldTail(short, 6, 'Other')).toEqual(short)
  })

  it('keeps the largest and folds the rest into one', () => {
    const folded = foldTail(many, 6, 'Other')
    expect(folded).toHaveLength(6)
    expect(folded.slice(0, 5)).toEqual(many.slice(0, 5))
    expect(folded[5].label).toBe('Other')
  })

  it('preserves the total, so the shares still add up', () => {
    // A share chart whose segments do not sum to the total is a lie about the total.
    const before = many.reduce((s, b) => s + b.totalBase, 0)
    const after = foldTail(many, 6, 'Other').reduce((s, b) => s + b.totalBase, 0)
    expect(after).toBeCloseTo(before, 2)
  })

  it('preserves the order count in the fold', () => {
    const folded = foldTail(many, 6, 'Other')
    expect(folded[5].orderCount).toBe(2 * 5)
  })

  it('rounds the folded amount to cents rather than leaving a float tail', () => {
    // 0.1 + 0.2 is 0.30000000000000004 in binary floating point, and that tail
    // would be printed verbatim by a currency formatter with no maximum digits.
    const cents = [bucket(1, 'a', 1), bucket(2, 'b', 0.1), bucket(3, 'c', 0.2)]
    expect(foldTail(cents, 2, 'Other')[1].totalBase).toBe(0.3)
  })

  it('folds at exactly one over the limit, not two', () => {
    const seven = many.slice(0, 7)
    const folded = foldTail(seven, 6, 'Other')
    expect(folded).toHaveLength(6)
    expect(folded[5].totalBase).toBeCloseTo(seven[5].totalBase + seven[6].totalBase, 2)
  })

  it('gives the fold no id, because it is not a row in any table', () => {
    expect(foldTail(many, 6, 'Other')[5].id).toBeNull()
  })

  it('returns nothing for a nonsensical limit rather than throwing', () => {
    expect(foldTail(many, 0, 'Other')).toEqual([])
  })
})

describe('sharePercent', () => {
  it('formats a share in the viewer’s locale', () => {
    expect(sharePercent(25, 100, 'en')).toMatch(/^25\s*%$/)
    // A comma decimal separator where the locale uses one.
    expect(sharePercent(12.5, 100, 'de')).toMatch(/12,5/)
  })

  it('does not divide by zero when nothing converted', () => {
    // Every amount can be unconverted, which leaves a real order count and a zero
    // total; NaN% would be worse than saying nothing.
    expect(sharePercent(0, 0, 'en')).toBe('—')
  })

  it('falls back to a plain percentage on a bad language tag', () => {
    expect(sharePercent(50, 200, 'not a tag')).toBe('25%')
  })
})
