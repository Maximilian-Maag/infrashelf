import { describe, it, expect, vi, beforeEach } from 'vitest'
import { section } from './section'
import { ApiError } from './api'

const settled = <T>(value: T): PromiseSettledResult<T> => ({ status: 'fulfilled', value })
const rejected = (reason: unknown): PromiseSettledResult<never> => ({ status: 'rejected', reason })

beforeEach(() => {
  vi.spyOn(console, 'error').mockImplementation(() => {})
})

/**
 * The reason a rejected section failed is the thing every page built on
 * `Promise.allSettled` used to throw away (#415).
 */
describe('section', () => {
  it('passes a fulfilled value through with no error', () => {
    expect(section(settled([1, 2]), [] as number[], 'numbers')).toEqual({ data: [1, 2], error: null })
    expect(console.error).not.toHaveBeenCalled()
  })

  it('falls back when the endpoint answered with nothing', () => {
    // A 204 comes back as undefined, which is not a failure — it is the empty
    // answer, and it must not be reported as one.
    expect(section(settled(undefined), [] as number[], 'numbers')).toEqual({ data: [], error: null })
    expect(section(settled(null), [] as number[], 'numbers')).toEqual({ data: [], error: null })
    expect(console.error).not.toHaveBeenCalled()
  })

  it('keeps the status and the message of an ApiError', () => {
    // The status is the half that says which problem it is: 400 is a bad filter
    // the user can fix, 502 is not.
    const result = section(rejected(new ApiError(502, 'Bad Gateway')), [] as number[], 'numbers')
    expect(result).toEqual({ data: [], error: 'HTTP 502: Bad Gateway' })
  })

  it('describes a plain Error and a thrown non-Error too', () => {
    // `fetch` rejects with a TypeError on a dead connection, and nothing
    // guarantees what a library throws.
    expect(section(rejected(new Error('fetch failed')), 0, 'n').error).toBe('fetch failed')
    expect(section(rejected('nope'), 0, 'n').error).toBe('nope')
  })

  it('logs the failure server-side, named by section', () => {
    // So a failure the user reloads past still leaves a trace in the container
    // log — the third thing #415 asks for.
    section(rejected(new ApiError(500, 'boom')), [] as number[], 'admin products')
    expect(console.error).toHaveBeenCalledWith('[page] could not load admin products: HTTP 500: boom')
  })

  it('does not treat a falsy fulfilled value as missing', () => {
    // `?? fallback`, not `|| fallback`: a legitimate 0 or '' is an answer.
    expect(section(settled(0), 99, 'count').data).toBe(0)
    expect(section(settled(''), 'fallback', 'name').data).toBe('')
  })
})
