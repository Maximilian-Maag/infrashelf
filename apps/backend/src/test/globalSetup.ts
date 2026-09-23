import { writeGuardBaseline } from './treeGuard'

/**
 * The tree this run started on, recorded once (#543).
 *
 * `globalSetup` is the only moment that is unambiguously "before the run": it
 * executes in the main process, once, before the pool spawns a worker, and nothing
 * has read a source file yet. The baseline it writes is what every test file's setup
 * compares itself against — see `src/test/treeGuard.ts` for why a run over a moving
 * tree has to be refused rather than reported.
 *
 * Watch mode is the exception that has to be handled here rather than noticed later:
 * an edit triggers a rerun WITHOUT another `globalSetup`, so the baseline from the
 * first run would make every rerun fail on the very edit that asked for it. Vitest
 * hands the project to this function, and `onTestsRerun` is the hook that fires
 * before each rerun — the same moment `globalSetup` occupies for the first one.
 *
 * Deliberately not a `console.log`: on a run nobody interferes with there is nothing
 * to say, and the guard's whole value is that it is silent until the one occasion it
 * is not.
 */
export default async function globalSetup(project: { onTestsRerun?: (cb: () => void) => void }): Promise<void> {
  writeGuardBaseline()
  project.onTestsRerun?.(() => writeGuardBaseline())
}
