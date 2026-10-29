import { describe, it, expect } from 'vitest'
import { catalogQuery, parseCategory, PAGE_SIZE } from './query'

/**
 * The catalogue's query string (#472, #245).
 *
 * Two callers build it — the server render and the browser's "load more" — and
 * the second continues the first, so a parameter spelled differently between them
 * appends rows from a different query. Worth testing precisely: the two must
 * agree byte for byte.
 */
describe('catalogQuery', () => {
  const base = { lang: 'en', search: '', categoryId: null, offset: 0 }

  it('always carries the language, the page size and the offset', () => {
    expect(catalogQuery(base)).toBe(`/api/catalog?lang=en&limit=${PAGE_SIZE}&offset=0`)
    expect(PAGE_SIZE).toBe(24)
  })

  it('omits an empty search and a null category rather than sending blanks', () => {
    // `search=` would be a filter the backend has to normalise; omitting it is the
    // one spelling both callers can agree on.
    const url = catalogQuery(base)
    expect(url).not.toContain('search')
    expect(url).not.toContain('categoryId')
  })

  it('carries the search term when there is one', () => {
    expect(catalogQuery({ ...base, search: 'postgres' })).toContain('search=postgres')
  })

  it('carries the category id when one is selected', () => {
    expect(catalogQuery({ ...base, categoryId: 7 })).toContain('categoryId=7')
  })

  it('encodes a search term that needs it, rather than breaking the query', () => {
    expect(catalogQuery({ ...base, search: 'a b&c' })).toContain('search=a+b%26c')
  })

  it('advances the offset for the next page', () => {
    expect(catalogQuery({ ...base, offset: PAGE_SIZE })).toContain(`offset=${PAGE_SIZE}`)
  })

  it('keeps categoryId=0 distinguishable from no category at all', () => {
    // The caller sends `null` for "no filter"; `0` is a value it would only ever
    // send by mistake, and dropping it is the honest reading of "not a category".
    expect(catalogQuery({ ...base, categoryId: 0 })).toContain('categoryId=0')
  })
})

describe('parseCategory', () => {
  it('reads a plain id', () => {
    expect(parseCategory('7')).toBe(7)
    expect(parseCategory('007')).toBe(7)
  })

  it('treats anything unreadable as no filter rather than an error', () => {
    // The page would rather show the whole catalogue than refuse a URL somebody
    // trimmed by hand.
    for (const raw of ['', 'abc', '-1', '1.5', '7a', ' 7', undefined]) {
      expect(parseCategory(raw), `parseCategory(${JSON.stringify(raw)})`).toBeNull()
    }
  })

  it('rejects zero, which is not a category id', () => {
    expect(parseCategory('0')).toBeNull()
  })

  it('rejects a number past the safe-integer range instead of rounding it', () => {
    expect(parseCategory('9007199254740993')).toBeNull()
  })
})
