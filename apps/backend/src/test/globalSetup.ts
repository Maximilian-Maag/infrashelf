import { rmSync } from 'node:fs'
import { guardFilePath, newRunId, RUN_ID_KEY, writeGuardBaseline } from './treeGuard'

/**
 * The tree this run started on, recorded once, under an identity of the run's own (#543).
 *
 * `globalSetup` is the only moment that is unambiguously "before the run": it executes
 * in the main process, once, before the pool spawns a worker, and nothing has read a
 * source file yet. The baseline it writes is what every test file's setup compares
 * itself against — see `src/test/treeGuard.ts` for why a run over a moving tree has to
 * be refused rather than reported.
 *
 * Two things have to be handed over rather than assumed:
 *
 * - **The identity**, with `provide`. The baseline file is named after it, so two runs
 *   in one checkout cannot share one even if they share `TEST_DB_SUFFIX`: without this,
 *   a run whose tree moved could compare itself against a newer run's snapshot and pass.
 *   `provide` is a property rather than a method explicitly so that passing it around
 *   here does not lose its receiver.
 * - **A fresh baseline on a rerun.** Watch mode does not re-run `globalSetup`, so the
 *   first run's baseline would fail every rerun on the very edit that asked for it.
 *   `onTestsRerun` fires before each rerun, which is `globalSetup`'s moment for every
 *   run after the first.
 *
 * The file is removed when the run ends: it is one run's private record, it is a
 * megabyte and a half of JSON, and leaving a directory of them behind in the temp
 * directory would be somebody else's mystery in a month.
 *
 * Deliberately not a `console.log`: on a run nobody interferes with there is nothing
 * to say, and the guard's whole value is that it is silent until the one occasion it
 * is not.
 */
export default async function globalSetup(project: {
  provide: (key: string, value: unknown) => void
  onTestsRerun?: (cb: () => void) => void
}): Promise<() => void> {
  let baselinePath = ''

  const startRun = (): void => {
    const runId = newRunId()
    baselinePath = guardFilePath(runId)
    project.provide(RUN_ID_KEY, runId)
    writeGuardBaseline(baselinePath)
  }

  startRun()
  project.onTestsRerun?.(startRun)

  return () => {
    rmSync(baselinePath, { force: true })
  }
}
