import { describe, it, expect } from 'vitest'
import type { ParameterType } from '@infrashelf/types'
import { parameterTypeLabel, parameterTypeOptions } from './parameterTypes'
import { t } from './i18n'

/**
 * The parameter-type list (#313, #245).
 *
 * The bug this guards against: the product page's editor wrote its four options
 * out by hand, so it never learned about `size` when `size` was added — one
 * screen offered T-shirt sizes and the other did not, for months, and nothing said
 * so. The list is now derived, and derived from the label map rather than a
 * second array, so a new type cannot be half-published.
 */
describe('parameterTypeOptions', () => {
  it('lists every parameter type the app knows', () => {
    const values = parameterTypeOptions('en').map((o) => o.value)
    expect(values).toEqual(['string', 'number', 'bool', 'dropdown', 'size'])
  })

  it('labels each option in the reader\u2019s language, not always English', () => {
    const en = Object.fromEntries(parameterTypeOptions('en').map((o) => [o.value, o.label]))
    const de = Object.fromEntries(parameterTypeOptions('de').map((o) => [o.value, o.label]))

    expect(de.size).toBe(t('typeSize', 'de'))
    // `size` is the type that was missing from one screen, so it is the one a
    // silent fallback would hide.
    expect(de.size).not.toBe(en.size)
    expect(de.dropdown).toBe(t('typeDropdown', 'de'))
  })

  it('renders a label for every value it offers', () => {
    for (const { value, label } of parameterTypeOptions('en')) {
      expect(label, `${value} has no label`).toBeTruthy()
    }
  })
})

describe('parameterTypeLabel', () => {
  it('is the same label the option list gives that type', () => {
    const option = parameterTypeOptions('fr').find((o) => o.value === 'number')
    expect(parameterTypeLabel('number', 'fr')).toBe(option?.label)
  })

  it('covers every type without falling back to English for a supported language', () => {
    const types: ParameterType[] = ['string', 'number', 'bool', 'dropdown', 'size']
    for (const type of types) {
      expect(parameterTypeLabel(type, 'de')).not.toBe(parameterTypeLabel(type, 'en'))
    }
  })
})
