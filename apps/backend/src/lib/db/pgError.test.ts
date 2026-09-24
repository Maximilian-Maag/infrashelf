import { describe, it, expect } from 'vitest'
import {
  pgErrorCode,
  pgConstraintName,
  UNIQUE_VIOLATION,
  FK_VIOLATION,
  CHECK_VIOLATION,
} from './pgError'

/**
 * Reading a Postgres error code back out of whatever drizzle wrapped it in
 * (#307's tail).
 *
 * The walk is the part that is easy to get wrong — the code is one or more levels
 * down a `cause` chain, and reading `e.code` directly, which is what the raw
 * `postgres` call sites do correctly because they bypass drizzle, silently finds
 * nothing here. That turns a 409 "an integration with that name exists" into a
 * 500 carrying a constraint name, which is how this file came to exist (#404).
 */
describe('pgErrorCode', () => {
  it('reads a code off the error itself', () => {
    expect(pgErrorCode({ code: UNIQUE_VIOLATION })).toBe(UNIQUE_VIOLATION)
  })

  it('walks one level of `cause`, which is what drizzle wraps the driver error in', () => {
    expect(pgErrorCode({ name: 'DrizzleQueryError', cause: { code: FK_VIOLATION } })).toBe(FK_VIOLATION)
  })

  it('walks several levels', () => {
    const deep = { cause: { cause: { cause: { cause: { code: CHECK_VIOLATION } } } } }
    expect(pgErrorCode(deep)).toBe(CHECK_VIOLATION)
  })

  it('stops looking rather than following a long or circular chain for ever', () => {
    // A `cause` chain is not guaranteed to be either short or acyclic: drizzle, a
    // driver and a wrapper layer can each add a link, and a self-referential
    // `cause` would hang the request rather than fail it.
    const long = { cause: { cause: { cause: { cause: { cause: { code: UNIQUE_VIOLATION } } } } } }
    expect(pgErrorCode(long)).toBeNull()

    const circular: { cause?: unknown } = {}
    circular.cause = circular
    expect(pgErrorCode(circular)).toBeNull()
  })

  it('ignores a code that is not a string', () => {
    // A numeric 23505 is not a SQLSTATE as far as this is concerned — and the walk
    // continues, so a wrapper carrying a number does not hide the real code below.
    expect(pgErrorCode({ code: 23505 })).toBeNull()
    expect(pgErrorCode({ code: 23505, cause: { code: UNIQUE_VIOLATION } })).toBe(UNIQUE_VIOLATION)
  })

  it('answers null for the things that are not errors at all', () => {
    for (const empty of [null, undefined, 'boom', 42, {}]) {
      expect(pgErrorCode(empty), String(empty)).toBeNull()
    }
  })
})

describe('pgConstraintName', () => {
  it('walks for the constraint the same way it walks for the code', () => {
    expect(pgConstraintName({ cause: { constraint_name: 'integrations_name_unique' } })).toBe(
      'integrations_name_unique',
    )
    expect(pgConstraintName({ constraint_name: 'parameters_product_key' })).toBe('parameters_product_key')
  })

  it('answers null when the failure names no constraint', () => {
    // A connection error has a code in some drivers and no constraint; the caller
    // saying "a row with that name exists" for it would be a guess.
    expect(pgConstraintName({ code: UNIQUE_VIOLATION })).toBeNull()
    expect(pgConstraintName(null)).toBeNull()
  })
})

describe('the SQLSTATE constants', () => {
  it('are the codes Postgres actually sends', () => {
    // Asserted as values: these are a wire contract with the server, not
    // identifiers, and a typo in one is invisible until the error it classifies
    // arrives — which is when it is least convenient.
    expect(UNIQUE_VIOLATION).toBe('23505')
    expect(FK_VIOLATION).toBe('23503')
    expect(CHECK_VIOLATION).toBe('23514')
  })
})
