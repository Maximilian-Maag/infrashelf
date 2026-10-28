import { defineConfig } from 'vitest/config'
import react from '@vitejs/plugin-react'
import path from 'path'

/**
 * Stryker wraps every expression in the source tree in a mutant switch, so the
 * same test is several times slower under a mutation run than under an ordinary
 * one — and the failure is silent in the worst way: Stryker aborts its DRY RUN
 * with "There were failed tests in the initial test run", never mutates anything,
 * and reports no score. The nightly backend leg had been doing exactly that, so
 * `thresholds.break = 80` was enforcing nothing at all.
 */
const underMutationTesting = process.env.STRYKER_MUTATOR_WORKER !== undefined

export default defineConfig({
  plugins: [react()],
  test: {
    /*
     * A budget for EVERY run, and a wider one under Stryker (#584).
     *
     * Vitest's default is 5 s. That is the right bar for a test that is slow on
     * its own, and it was kept deliberately on that reasoning — but the full
     * suite runs 138 files in parallel, and under that load an ordinary test can
     * cross 5 s through no fault of its own. The symptom is a DIFFERENT file
     * losing the race each run (ProductEditForm #584, then InfraFilters, then
     * IntegrationsManager), all green in isolation — which is neither
     * reproducible nor fixable one `it` at a time, which is what #568 tried.
     *
     * So the budget is shared, as the issue proposed. 15 s clears the load and is
     * still short enough that a genuine six-second test is reported rather than
     * hidden: a real hang fails, just later. Under Stryker every expression is
     * wrapped in a mutant switch, so the same test is several times slower again.
     */
    testTimeout: underMutationTesting ? 60_000 : 15_000,
    hookTimeout: underMutationTesting ? 60_000 : 15_000,
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
