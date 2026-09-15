import { describe, it, expect, vi, beforeEach } from 'vitest'
import type * as DbClient from '@/lib/db/client'

/**
 * Two callers, one bootstrap (#416).
 *
 * `runBootstrap` used to set its latch BEFORE doing the work, so a second
 * concurrent caller returned immediately and was told the server was ready while
 * migrations were still running, the branding row did not exist and legacy CI
 * tokens were unconverted. Every health check goes through this.
 *
 * `runMigrations` is where the work starts, so it is the seam: mocking the
 * module's dependencies would mean mocking the whole file, and what has to be
 * proved is about the FUNCTION — that the work runs once and that both callers
 * wait for it.
 */
const migrate = vi.fn()
vi.mock('drizzle-orm/migrator', () => ({
  readMigrationFiles: () => [],
}))

let seen = 0
let release: (() => void) | undefined
let fail: ((err: Error) => void) | undefined
const gate = () =>
  new Promise<void>((resolve, reject) => {
    seen += 1
    release = () => resolve()
    fail = (err) => reject(err)
  })

vi.mock('@/lib/config/validate', () => ({ reportConfigProblems: vi.fn() }))

// The one piece of real work, replaced by a gate we can hold open.
vi.mock('@/lib/db/client', async (importOriginal) => {
  const actual = await importOriginal<typeof DbClient>()
  return {
    ...actual,
    client: Object.assign(
      async () => {
        migrate()
        await gate()
        return []
      },
      { unsafe: async () => [] },
    ),
  }
})

beforeEach(() => {
  seen = 0
  release = undefined
  fail = undefined
  migrate.mockReset()
  vi.resetModules()
})

describe('concurrent callers join the same bootstrap', () => {
  it('runs the work once and makes both callers wait for it', async () => {
    const { runBootstrap } = await import('./index')

    let firstDone = false
    let secondDone = false
    const first = runBootstrap().then(() => { firstDone = true })
    const second = runBootstrap().then(() => { secondDone = true })

    // Give both a tick to reach the gate. Before the fix the SECOND call
    // returned here, having done nothing and waited for nothing.
    await new Promise((r) => setTimeout(r, 20))
    expect(firstDone, 'first caller finished before the work did').toBe(false)
    expect(secondDone, 'second caller was told the server was ready').toBe(false)

    release?.()
    await Promise.all([first, second])

    expect(firstDone).toBe(true)
    expect(secondDone).toBe(true)
    // One run, not two: the second caller joined rather than starting its own.
    expect(seen).toBe(1)
  })

  it('lets a later caller retry after a failed bootstrap', async () => {
    // The property the previous fix added, which this must not undo: the latch
    // means "bootstrap SUCCEEDED", so a failure has to leave it retryable. The
    // in-flight promise must not be retained and handed to the next caller
    // either, or one unreachable database at boot means the server never
    // bootstraps again for the life of the process.
    const { runBootstrap } = await import('./index')

    const boom = new Error('database is unreachable')
    const failing = runBootstrap()
    await new Promise((r) => setTimeout(r, 20))
    expect(seen, 'the first attempt did not reach the work').toBe(1)
    fail?.(boom)
    await expect(failing).rejects.toThrow('database is unreachable')

    // A second call must be willing to do the work again rather than replaying
    // the failed attempt.
    const retry = runBootstrap()
    await new Promise((r) => setTimeout(r, 20))
    expect(seen, 'the retry never re-ran the work').toBe(2)
    release?.()
    await expect(retry).resolves.toBeUndefined()
  })
})
