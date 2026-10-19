import { defineConfig } from 'vitest/config'
import react from '@vitejs/plugin-react'
import path from 'path'

/**
 * Stryker wraps every expression in the source tree in a mutant switch, so the
 * same test is several times slower under a mutation run than under an ordinary
 * one. Vitest's default 5s per-test limit is generous for the second and not for
 * the first — and the failure is silent in the worst way: Stryker aborts its
 * DRY RUN with "There were failed tests in the initial test run", never mutates
 * anything, and reports no score. The nightly backend leg had been doing exactly
 * that, so `thresholds.break = 80` was enforcing nothing at all.
 *
 * Raised only under Stryker, which sets STRYKER_MUTATOR_WORKER in each test
 * runner process.
 *
 * The ordinary-run budget is 15s, not the default 5s, and the reason is load
 * rather than slow assertions (#584). The same tests run in ~750ms alone and
 * cross 5s only with all 138 files in flight, so the strict limit was reporting
 * the machine rather than the test — the suite is green with `--testTimeout`
 * raised, and the failures were all "Test timed out in 5000ms", never a failed
 * assertion. 15s leaves the parallel run room to settle while a genuinely stuck
 * test still fails, and still far inside the Stryker budget it is replacing.
 */
const testTimeoutMs = process.env.STRYKER_MUTATOR_WORKER !== undefined ? 60_000 : 15_000

export default defineConfig({
  plugins: [react()],
  test: {
    testTimeout: testTimeoutMs,
    hookTimeout: testTimeoutMs,
    globals: true,
    environment: 'jsdom',
    // Stryker copies the whole source tree into .stryker-tmp/sandbox-*/ while a
    // mutation run is in progress. Those copies contain test files, so an ordinary
    // `vitest run` picks them up: the suite doubles, and the copies fail against a
    // mutated source — which looks like a broken working tree.
    exclude: ['**/node_modules/**', '**/dist/**', '**/.stryker-tmp/**'],
    setupFiles: ['./src/test/setup.ts'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'lcov'],
      include: ['src/**/*.{ts,tsx}'],
      exclude: ['src/test/**', 'src/**/*.test.{ts,tsx}'],
    },
  },
  resolve: {
    alias: { '@': path.resolve(__dirname, './src') },
  },
})
