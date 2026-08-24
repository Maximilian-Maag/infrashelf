import { describe, it, expect } from 'vitest'
import { isUsableCallbackSecret } from './callback-secret'

describe('isUsableCallbackSecret', () => {
  it('accepts a portal-generated secret', () => {
    expect(isUsableCallbackSecret(`ohc-cb-${'a'.repeat(64)}`)).toBe(true)
  })

  it('accepts a short but non-blank legacy secret', () => {
    expect(isUsableCallbackSecret('x')).toBe(true)
  })

  // The three ways migration 0004's backfill of the free-text webhook_token can
  // leave a row that authenticates everyone (issue #140).
  it.each([
    ['empty', ''],
    ['spaces', '   '],
    ['a tab and a newline', '\t\n'],
  ])('refuses a secret that is %s', (_label, secret) => {
    expect(isUsableCallbackSecret(secret)).toBe(false)
  })
})
