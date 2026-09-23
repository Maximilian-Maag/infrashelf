import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, relative } from 'node:path'
import { testDatabaseName } from './database'

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
 * Where this run's baseline lives.
 *
 * Keyed by the database name the run WOULD claim, which is derived from the
 * working directory and `TEST_DB_SUFFIX` (`src/test/database.ts`) — so two
 * checkouts, or two runs separated by a suffix, never share one. Two runs in the
 * same directory with the same suffix do share it, and that is why the reader
 * checks the baseline's age against its own process (below): it can tell that a
 * snapshot written after it started belongs to somebody else, and refuses to
 * compare itself against it rather than passing on the strength of another run's
 * tree.
 */
export const guardFilePath = (runKey: string = testDatabaseName()): string => {
  const dir = join(tmpdir(), 'infrashelf-tree-guard')
  mkdirSync(dir, { recursive: true })
  // Readable and unique: the run's database name identifies it to a person looking
  // in the temp directory, and the digest keeps two keys that sanitise alike apart.
  const readable = runKey.replace(/[^a-zA-Z0-9_]/g, '_').slice(0, 60)
  return join(dir, `${readable}-${sha256(runKey).slice(0, 8)}.json`)
}

/**
 * Record the tree this run started on. Called from `globalSetup`, once per run and per rerun.
 *
 * `startedAt` is injectable because the guard only accepts a baseline written before
 * its reader started: a test that has to present one has to age it, and inventing a
 * clock is clearer about what is being tested than sleeping would be.
 */
export const writeGuardBaseline = (
  path: string = guardFilePath(),
  root: string = process.cwd(),
  startedAt: number = Date.now(),
): GuardBaseline => {
  const baseline: GuardBaseline = { startedAt, root, files: snapshotSourceTree(root) }
  // Written whole: a reader must never see half a JSON document, or it would report
  // a corrupt baseline that only ever existed for a microsecond.
  const temporary = `${path}.${process.pid}.tmp`
  writeFileSync(temporary, JSON.stringify(baseline))
  renameSync(temporary, path)
  return baseline
}

/** Read this run's baseline, saying which way it failed rather than returning a guess. */
export const readGuardBaseline = (path: string = guardFilePath()): BaselineRead => {
  if (!existsSync(path)) return { kind: 'missing', path }
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as GuardBaseline
    const ok = parsed && typeof parsed.startedAt === 'number' && typeof parsed.files === 'object'
    return ok ? { kind: 'ok', baseline: parsed } : { kind: 'unreadable', path, reason: 'not a baseline' }
  } catch (e) {
    return { kind: 'unreadable', path, reason: (e as Error).message }
  }
}

/**
 * When THIS process started, in the same units as `baseline.startedAt`.
 *
 * The baseline is written by the run's main process before it forks any worker, so
 * a baseline older than the worker is this run's. One written LATER belongs to a run
 * that began later — a second `vitest` in the same checkout with the same suffix —
 * and comparing against it would let this run pass on a tree somebody else snapshotted.
 */
const startedAfterThisProcess = (baseline: GuardBaseline, slackMs = 5_000): boolean =>
  baseline.startedAt > Date.now() - Math.round(process.uptime() * 1000) + slackMs

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
 * A baseline that is missing, unreadable, or somebody else's run is also a failure:
 * those are the states in which the guard would otherwise be silently absent, which
 * is the bug it exists to prevent.
 */
export const assertSourceUnchanged = (options: { path?: string; root?: string } = {}): void => {
  const root = options.root ?? process.cwd()
  const path = options.path ?? guardFilePath()
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
  if (startedAfterThisProcess(baseline)) {
    throw new Error(
      [
        `The tree baseline at ${path} was written after this process started (#543).`,
        '',
        `  baseline written: ${new Date(baseline.startedAt).toLocaleTimeString('en-GB', { hour12: false })}`,
        '  this process:     later than that',
        '',
        'That is another run of the suite — a second `vitest` in this checkout with the',
        'same TEST_DB_SUFFIX — and comparing against it would let this run pass on a tree',
        'it never saw. Give one of the two runs its own TEST_DB_SUFFIX.',
      ].join('\n'),
    )
  }

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
