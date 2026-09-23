import { createHash, randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, relative } from 'node:path'
import { inject } from 'vitest'
import { testDatabaseName } from './database'

/**
 * The provided context this guard travels in, declared so `inject` is typed rather
 * than stringly-typed at each call site.
 */
declare module 'vitest' {
  interface ProvidedContext {
    infrashelfTreeGuardRunId: string
  }
}

/**
 * The tree the suite is reading, recorded when the run starts (#543).
 *
 * ── Why this exists ─────────────────────────────────────────────────────────
 *
 * A full backend run is 232 test files over ~24 minutes. Vitest transforms each
 * module ONCE and serves that transform for the rest of the run — `run` mode has
 * no file watcher, so nothing invalidates it when the file changes on disk underneath.
 * Measured, not inferred: run a batch, rewrite `src/lib/db/schema.ts` on disk
 * half-way through, and every process that starts afterwards reads the NEW file
 * (its own hash of it) while the `schema.ts` MODULE it is handed is still the one
 * transformed before the rewrite.
 *
 * So a run over a tree that moves reads two revisions, mixed per module, silently
 * — a module first reached before the change keeps the old revision, a module
 * first reached after it gets the new one. That is #543 exactly. The run started at
 * 00:54:36 on `dev` at `ebe42df`, the checkout was switched to a branch off
 * `5a42dce` at 00:56:16 (a `git checkout -b` in the same directory the suite was
 * reading), and the four `policy_*` columns that #541 added arrived underneath it.
 * `schema.ts` is imported by the setup file and by nearly every test file, so it
 * had long since been transformed — pre-#541, without those columns — while
 * `elementPolicy.ts`, which does not exist before #541 and so has no earlier
 * revision to be served, arrived whole. The result was three failures in two files:
 * `update "infrastructure_elements" set  where (… )` (an empty SET, because
 * `buildUpdateSet` builds its list from the table's own columns) in
 * `driftReports.test.ts`, and `db:generate` proposing to DROP the four columns in
 * `journal.test.ts` — which ran last, at 01:17, against a tree that had been
 * post-#541 for twelve minutes. Both files pass on their own, which is the
 * expensive part: a red full-suite run stops naming the file at fault, and the next
 * person has to re-run each failing file by hand to find out whether they broke
 * something.
 *
 * ── What it does ────────────────────────────────────────────────────────────
 *
 * `globalSetup` snapshots the tree once per run — and once per watch-mode rerun,
 * which does not re-run `globalSetup` — before any worker exists; the per-file setup
 * compares its snapshot against that baseline when it starts and again when it
 * finishes, and refuses to let the run be read as a verdict on the code. It names
 * the files that differ, because "the tree moved" is only useful when it says where.
 *
 * ── Cost ────────────────────────────────────────────────────────────────────
 *
 * 535 files, 1.6 MB, ~9 ms per snapshot: ~4 s of aggregate worker time across a full
 * suite (twice per test file), and nothing on the critical path of any single test.
 * Hashing contents rather than mtimes is deliberate — an mtime changes when a file
 * is rewritten with identical bytes, and a guard that cries wolf on a `git checkout`
 * of the same content is a guard somebody turns off.
 */

/** What the suite reads. `src` is every module and spec; `drizzle` is what `journal.test.ts` reads. */
export const GUARDED_PATHS = ['src', 'drizzle'] as const

/** A file's digest, keyed by its path relative to the package root. */
export type TreeSnapshot = Record<string, string>

/** The baseline a run starts on, written by `globalSetup`. */
export interface GuardBaseline {
  startedAt: number
  root: string
  files: TreeSnapshot
}

/** What reading the baseline found. Absent and unreadable are different faults. */
export type BaselineRead =
  | { kind: 'ok'; baseline: GuardBaseline }
  | { kind: 'missing'; path: string }
  | { kind: 'unreadable'; path: string; reason: string }

const sha256 = (content: Buffer | string): string => createHash('sha256').update(content).digest('hex')

/**
 * Every file under `GUARDED_PATHS`, hashed. Recursive and unfiltered on purpose:
 * an unfiltered walk cannot be the reason a change went unnoticed, and the
 * alternative — a list of extensions to watch — would have to be kept in step
 * with whatever the suite starts importing next.
 */
export const snapshotSourceTree = (root: string = process.cwd()): TreeSnapshot => {
  const snapshot: TreeSnapshot = {}

  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : 1))) {
      const full = join(dir, entry.name)
      if (entry.isDirectory()) walk(full)
      // Symlinks are skipped: a link's own bytes are the target path, which does
      // not change when the file it points at does, so hashing it would only add
      // an entry that can never differ.
      else if (entry.isFile()) snapshot[relative(root, full)] = sha256(readFileSync(full))
    }
  }

  for (const guarded of GUARDED_PATHS) {
    const dir = join(root, guarded)
    if (existsSync(dir) && statSync(dir).isDirectory()) walk(dir)
  }

  return snapshot
}

/**
 * Where a run's baseline lives: one file per run, named by the run's own identity.
 *
 * The identity comes from `globalSetup`, which generates it and hands it to the
 * workers with Vitest's `provide`/`inject` (see `RUN_ID_KEY`). It is not derived from
 * the working directory or `TEST_DB_SUFFIX`: those are only as distinct as the person
 * running the suite remembers to make them, and two runs that share them would
 * otherwise share a baseline — run B's snapshot standing in for run A's, which is a
 * run reporting success on a tree it never read.
 */
export const guardFilePath = (runId: string): string => {
  const dir = join(tmpdir(), 'infrashelf-tree-guard')
  mkdirSync(dir, { recursive: true })
  return join(dir, `${runId}.json`)
}

/**
 * A name for a run: readable, and unique to it.
 *
 * The database name is in there because it is what a person looking in the temp
 * directory recognises — it says which checkout and which suffix — and the token is
 * what makes it this run's and nobody else's, so two runs in one checkout never
 * share a file whatever the suffix says.
 */
export const newRunId = (name: string = testDatabaseName()): string =>
  `${name.replace(/[^a-zA-Z0-9_]/g, '_').slice(0, 60)}-${randomUUID().slice(0, 8)}`

/** The key the run's identity travels under, from `globalSetup` to each worker. */
export const RUN_ID_KEY = 'infrashelfTreeGuardRunId'

/**
 * This worker's run identity, or `undefined` when the run never provided one.
 *
 * `undefined` is not a fallback to a derived name: a run that did not provide an
 * identity is a run whose baseline cannot be located, and the guard refuses to speak
 * rather than guess which file it should be comparing against.
 */
export const providedRunId = (): string | undefined => {
  try {
    // Typed as `unknown` deliberately: the declaration above says what this run
    // provides, and a value that arrives as anything else is still a state to report
    // rather than to assume away.
    const provided: unknown = inject(RUN_ID_KEY)
    return typeof provided === 'string' && provided.length > 0 ? provided : undefined
  } catch {
    // `inject` throws when the value was never provided, which is a state the guard
    // reports rather than a failure to recover from here.
    return undefined
  }
}

/** Record the tree a run started on. Called from `globalSetup`, once per run and per rerun. */
export const writeGuardBaseline = (
  path: string = guardFilePath(newRunId()),
  root: string = process.cwd(),
): GuardBaseline => {
  const baseline: GuardBaseline = { startedAt: Date.now(), root, files: snapshotSourceTree(root) }
  // Written whole: a reader must never see half a JSON document, or it would report
  // a corrupt baseline that only ever existed for a microsecond.
  const temporary = `${path}.${process.pid}.tmp`
  writeFileSync(temporary, JSON.stringify(baseline))
  renameSync(temporary, path)
  return baseline
}

/** Read a run's baseline, saying which way it failed rather than returning a guess. */
export const readGuardBaseline = (path: string): BaselineRead => {
  if (!existsSync(path)) return { kind: 'missing', path }
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as GuardBaseline
    const ok = parsed && typeof parsed.startedAt === 'number' && typeof parsed.files === 'object'
    return ok ? { kind: 'ok', baseline: parsed } : { kind: 'unreadable', path, reason: 'not a baseline' }
  } catch (e) {
    return { kind: 'unreadable', path, reason: (e as Error).message }
  }
}

/** How many differing paths the failure message names before it just counts them. */
const NAMED_PATHS = 8

const quote = (paths: string[]): string => {
  const shown = paths.slice(0, NAMED_PATHS).map((p) => `  ${p}`)
  const rest = paths.length - NAMED_PATHS
  if (rest > 0) shown.push(`  … and ${rest} more`)
  return shown.join('\n')
}

const CANNOT_SPEAK = [
  '',
  'The guard compares each test file against the tree this run started on; without a',
  'baseline it cannot say anything about this run, and a run it cannot speak about is',
  'not one to report as a result. Most likely `src/test/globalSetup.ts` is not in the',
  'vitest config, or the temporary directory it writes to was not writable.',
].join('\n')

/**
 * Refuse to report on a run whose tree moved.
 *
 * Throws rather than warns. A warning in a 24-minute log arrives next to three
 * failures in two files and reads as noise; the failure of this file is the thing
 * that stops the run being quoted as a result. It is called by the per-file setup
 * when the file starts AND when it finishes, so a change made while the last test in
 * the run is still reading files is caught too — and once the tree has moved EVERY
 * file that starts afterwards fails with the same sentence, which is the honest
 * report for a run nobody can attribute.
 *
 * A baseline that is missing, unreadable, or that this run cannot even locate is also
 * a failure: those are the states in which the guard would otherwise be silently
 * absent, which is the bug it exists to prevent.
 */
export const assertSourceUnchanged = (options: { path?: string; root?: string } = {}): void => {
  const root = options.root ?? process.cwd()
  const runId = providedRunId()
  const path = options.path ?? (runId === undefined ? undefined : guardFilePath(runId))

  if (path === undefined) {
    throw new Error(
      [
        `No run identity to locate this run's baseline (#543): no value was provided under ${RUN_ID_KEY},`,
        'which `src/test/globalSetup.ts` does before any worker is forked.',
        CANNOT_SPEAK,
      ].join('\n'),
    )
  }

  const read = readGuardBaseline(path)

  if (read.kind === 'missing') {
    throw new Error(
      [`No tree baseline for this run: nothing at ${path} (#543).`, CANNOT_SPEAK].join('\n'),
    )
  }
  if (read.kind === 'unreadable') {
    throw new Error(
      [`The tree baseline at ${path} cannot be read: ${read.reason} (#543).`, CANNOT_SPEAK].join('\n'),
    )
  }

  const baseline = read.baseline

  const now = snapshotSourceTree(root)
  const changed = Object.keys(baseline.files).filter((p) => now[p] !== undefined && now[p] !== baseline.files[p])
  const removed = Object.keys(baseline.files).filter((p) => now[p] === undefined)
  const added = Object.keys(now).filter((p) => baseline.files[p] === undefined)

  if (changed.length === 0 && removed.length === 0 && added.length === 0) return

  const startedAt = new Date(baseline.startedAt).toLocaleTimeString('en-GB', { hour12: false })
  const total = changed.length + removed.length + added.length
  const parts = [
    `${total} file${total === 1 ? '' : 's'} under ${GUARDED_PATHS.join('/')} changed while this suite was running (#543).`,
    '',
  ]
  if (changed.length > 0) parts.push('rewritten:', quote(changed))
  if (added.length > 0) parts.push('appeared:', quote(added))
  if (removed.length > 0) parts.push('disappeared:', quote(removed))
  parts.push(
    '',
    `This run started at ${startedAt} on the tree it recorded in ${path}.`,
    'Files transformed before the change were read from one revision and files after',
    'it from another, so a failure here says nothing about the code: #543 was three of',
    'them, in two files that both pass on their own. Re-run on a tree nobody is',
    'touching — a `git worktree` is how to work on something else at the same time —',
    'and quote that run instead.',
  )

  throw new Error(parts.join('\n'))
}
