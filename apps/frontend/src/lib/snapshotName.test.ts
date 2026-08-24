import { describe, it, expect } from 'vitest'
import type { ProductSnapshot } from '@open-hybrid-cloud/types'
import { snapshotProductName } from './snapshotName'

const snapshot = (over: Partial<ProductSnapshot>): ProductSnapshot =>
  ({
    version: 1,
    capturedAt: '2026-01-01T00:00:00.000Z',
    productName: 'Virtual Machine',
    productDescription: '',
    environmentName: 'AWS Frankfurt',
    price: '10.00',
    currency: 'EUR',
    costCenterMode: 'project',
    forcedCostCenter: false,
    trialEnabled: false,
    trialDurationMinutes: 0,
    parameters: [],
    ...over,
  }) as ProductSnapshot

describe('snapshotProductName', () => {
  it('shows the reader their own language, from what the order recorded', () => {
    // The order detail was the one page that could never be fixed upstream: the
    // English name was frozen into the record at checkout (issue #162).
    const s = snapshot({ productNames: { de: 'Virtuelle Maschine', en: 'Virtual Machine' } })
    expect(snapshotProductName(s, 'de')).toBe('Virtuelle Maschine')
    expect(snapshotProductName(s, 'de-AT')).toBe('Virtuelle Maschine')
    expect(snapshotProductName(s, 'en')).toBe('Virtual Machine')
  })

  it('falls back through English, then German, then whatever was recorded', () => {
    expect(
      snapshotProductName(snapshot({ productNames: { en: 'VM', de: 'VM DE' } }), 'pl'),
    ).toBe('VM')
    expect(snapshotProductName(snapshot({ productNames: { de: 'VM DE' } }), 'pl')).toBe('VM DE')
    // Neither: any recorded name beats none, and the same one on every visit.
    const fr = snapshot({ productNames: { pt: 'Máquina', fr: 'Machine' } })
    expect(snapshotProductName(fr, 'sv')).toBe('Machine')
    expect(snapshotProductName(fr, 'sv')).toBe('Machine')
  })

  it('reads an order placed before the names were recorded', () => {
    // ABSENT means "this snapshot predates the field", not "the product had no
    // translations" — the single name it does carry is the whole answer.
    expect(snapshotProductName(snapshot({}), 'de')).toBe('Virtual Machine')
  })

  it('never retranslates: the recorded name wins over anything current', () => {
    // The value is the string the snapshot froze, so a later catalogue rename
    // cannot reach it. Nothing here reads the live product at all.
    const s = snapshot({ productNames: { de: 'Virtuelle Maschine' }, productName: 'Virtual Machine' })
    expect(snapshotProductName(s, 'de')).toBe('Virtuelle Maschine')
  })

  it('leaves the caller to fall back to the live product when there is no snapshot', () => {
    expect(snapshotProductName(null, 'de')).toBeNull()
    expect(snapshotProductName(undefined, 'de')).toBeNull()
  })
})
