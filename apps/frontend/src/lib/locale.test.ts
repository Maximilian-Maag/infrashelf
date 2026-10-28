import { describe, it, expect } from 'vitest'
import { convertPrice, localeToCurrency, priceInBase, sortByValue } from './locale'

const rates = { USD: 1.1, GBP: 0.85 } // relative to EUR

// The same rates re-based onto USD: EUR/USD = 1 / 1.1, GBP/USD = 0.85 / 1.1.
const ratesUsdBase = { EUR: 1 / 1.1, GBP: 0.85 / 1.1, USD: 1 }

describe('convertPrice', () => {
  it('formats the amount in the locale when currencies match', () => {
    // Same currency: no conversion, but still format grouping/decimals.
    expect(convertPrice('100', 'EUR', 'EUR', rates)).toEqual({ amount: '100.00', currency: 'EUR' })
    expect(convertPrice('1234.5', 'EUR', 'EUR', rates, 'en')).toEqual({ amount: '1,234.50', currency: 'EUR' })
    expect(convertPrice('1234.5', 'EUR', 'EUR', rates, 'de')).toEqual({ amount: '1.234,50', currency: 'EUR' })
  })

  it('returns the raw price for a non-numeric input when currencies match', () => {
    expect(convertPrice('n/a', 'EUR', 'EUR', rates, 'de')).toEqual({ amount: 'n/a', currency: 'EUR' })
  })

  it('converts EUR → USD via the rate', () => {
    const res = convertPrice('100', 'EUR', 'USD', rates)
    expect(res.currency).toBe('USD')
    // 100 EUR * 1.1 = 110.00 (en formatting)
    expect(res.amount).toBe('110.00')
  })

  it('anchors on a non-EUR base when one is configured', () => {
    // Rates quoted against USD, so the base itself is 1.
    // 100 USD → EUR at 1/1.1 EUR per USD = 90.91.
    const toEur = convertPrice('100', 'USD', 'EUR', ratesUsdBase, 'en', 'USD')
    expect(toEur.currency).toBe('EUR')
    expect(toEur.amount).toBe('90.91')
    // 100 EUR → USD at 1.1 USD per EUR = 110.00.
    const toUsd = convertPrice('100', 'EUR', 'USD', ratesUsdBase, 'en', 'USD')
    expect(toUsd.currency).toBe('USD')
    expect(toUsd.amount).toBe('110.00')
  })

  it('formats grouping/decimals in the requested locale', () => {
    const en = convertPrice('1000', 'EUR', 'USD', rates, 'en')
    const de = convertPrice('1000', 'EUR', 'USD', rates, 'de')
    // 1000 * 1.1 = 1100
    expect(en.amount).toBe('1,100.00')
    expect(de.amount).toBe('1.100,00')
  })

  it('falls back to the source price when the target rate is unknown', () => {
    expect(convertPrice('100', 'EUR', 'JPY', rates)).toEqual({ amount: '100', currency: 'EUR' })
  })

  it('returns the raw price for a non-numeric input', () => {
    expect(convertPrice('n/a', 'EUR', 'USD', rates)).toEqual({ amount: 'n/a', currency: 'EUR' })
  })
})

describe('localeToCurrency', () => {
  it('maps known locales to their currency', () => {
    expect(localeToCurrency('de')).toBe('EUR')
    expect(localeToCurrency('pl')).toBe('PLN')
    expect(localeToCurrency('sv')).toBe('SEK')
  })

  it('defaults to EUR for unknown locales', () => {
    expect(localeToCurrency('zz')).toBe('EUR')
  })
})

describe('priceInBase', () => {
  it('takes the base currency as 1 without needing a rate entry', () => {
    expect(priceInBase('9', 'EUR', rates)).toBe(9)
  })

  it('divides by the rate, which is quoted against the base', () => {
    // 1.1 USD to the euro, so 11 USD is 10 EUR.
    expect(priceInBase('11', 'USD', rates)).toBeCloseTo(10)
  })

  it('anchors on a non-EUR base when one is configured', () => {
    // With rates quoted against USD, 11 USD is 11 USD and 11 EUR is 12.1 USD.
    expect(priceInBase('11', 'USD', ratesUsdBase, 'USD')).toBe(11)
    expect(priceInBase('11', 'EUR', ratesUsdBase, 'USD')).toBeCloseTo(12.1)
  })

  it('is null when nothing says what the currency is worth', () => {
    expect(priceInBase('100', 'JPY', rates)).toBeNull()
    expect(priceInBase('100', 'JPY', { JPY: 0 })).toBeNull()
    expect(priceInBase('n/a', 'EUR', rates)).toBeNull()
  })
})

describe('sortByValue', () => {
  it('ranks by value, not by the digits', () => {
    // 9 GBP is 10.59 EUR at 0.85 to the euro, so the smaller number is the DEARER
    // offer. Sorting on Number(price) put it first and called it the cheapest.
    const sorted = sortByValue(
      [
        { price: '10', currency: 'EUR' },
        { price: '9', currency: 'GBP' },
      ],
      rates,
    )
    expect(sorted.map((a) => a.currency)).toEqual(['EUR', 'GBP'])
  })

  it('sorts an unconvertible amount last instead of assuming 1:1', () => {
    // Read as 1:1 it would be the cheapest of the three and lead the buy box.
    const sorted = sortByValue(
      [
        { price: '1', currency: 'JPY' },
        { price: '20', currency: 'EUR' },
        { price: '11', currency: 'USD' },
      ],
      rates,
    )
    expect(sorted.map((a) => a.currency)).toEqual(['USD', 'EUR', 'JPY'])
  })

  it('keeps the catalogue order among amounts it cannot separate', () => {
    // Sizes are listed in a deliberate order, so ties and unconvertibles must not
    // be reshuffled into an arbitrary one.
    const sorted = sortByValue(
      [
        { code: 'a', price: '5', currency: 'JPY' },
        { code: 'b', price: '5', currency: 'SEK' },
        { code: 'c', price: '10', currency: 'EUR' },
        { code: 'd', price: '10', currency: 'EUR' },
      ],
      rates,
    )
    expect(sorted.map((a) => a.code)).toEqual(['c', 'd', 'a', 'b'])
  })

  it('does not mutate the input', () => {
    const input = [
      { price: '20', currency: 'EUR' },
      { price: '1', currency: 'EUR' },
    ]
    sortByValue(input, rates)
    expect(input.map((a) => a.price)).toEqual(['20', '1'])
  })
})
