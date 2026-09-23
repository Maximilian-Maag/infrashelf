import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs'
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
 * `globalSetup` snapshots the tree once per run, before any worker exists; the
 * per-file setup compares its own snapshot against that baseline and refuses to
 * let the run be read as a verdict on the code. It names the files that differ,
 * because "the tree moved" is only useful when it says where.
 *
 * ── Cost ────────────────────────────────────────────────────────────────────
 *
 * 535 files, 1.6 MB, ~9 ms per snapshot: ~2 s of aggregate worker time across the
 * whole suite, and nothing on the critical path of any single test. Hashing
 * contents rather than mtimes is deliberate — an mtime changes when a file is
 * rewritten with identical bytes, and a guard that cries wolf on a `git checkout`
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
 * same directory with the same suffix do share it, and that is survivable rather
 * than safe: the second run's `globalSetup` overwrites the baseline, and the
 * first run then compares against a fingerprint taken of a tree that is, in the
 * ordinary case, identical. It cannot be made per-run without threading a value
 * from the main process into every worker, which vitest does not offer.
 */
export const guardFilePath = (runKey: string = testDatabaseName()): string => {
  const dir = join(tmpdir(), 'infrashelf-tree-guard')
  mkdirSync(dir, { recursive: true })
  // Readable and unique: the run's database name identifies it to a person looking
  // in the temp directory, and the digest keeps two keys that sanitise alike apart.
  const readable = runKey.replace(/[^a-zA-Z0-9_]/g, '_').slice(0, 60)
  return join(dir, `${readable}-${sha256(runKey).slice(0, 8)}.json`)
}

/** Record the tree this run started on. Called once, from `globalSetup`. */
export const writeGuardBaseline = (
  path: string = guardFilePath(),
  root: string = process.cwd(),
): GuardBaseline => {
  const baseline: GuardBaseline = { startedAt: Date.now(), root, files: snapshotSourceTree(root) }
  writeFileSync(path, JSON.stringify(baseline))
  return baseline
}

/**
 * The baseline for this run, or null if there is none.
 *
 * Null is not an error and does not fail the run: it means `globalSetup` did not
 * write one (the guard was not configured, or the file was removed under it), and
 * a missing baseline is no evidence of anything about this tree. Nothing is
 * written here either — the baseline belongs to the run, and a worker inventing
 * one would compare against itself and always pass.
 */
export const readGuardBaseline = (path: string = guardFilePath()): GuardBaseline | null => {
  if (!existsSync(path)) return null
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as GuardBaseline
    return parsed && typeof parsed.files === 'object' ? parsed : null
  } catch {
    // A half-written baseline is a broken guard, not a moved tree.
    return null
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

/**
 * Refuse to report on a run whose tree moved.
 *
 * Throws rather than warns. A warning in a 24-minute log arrives next to three
 * failures in two files and reads as noise; the failure of this file is the thing
 * that stops the run being quoted as a result. It fires in the per-file setup, so
 * once the tree has moved EVERY file that starts afterwards fails with the same
 * sentence — which is the honest report for a run nobody can attribute.
 */
export const assertSourceUnchanged = (options: { path?: string; root?: string } = {}): void => {
  const root = options.root ?? process.cwd()
  const baseline = readGuardBaseline(options.path ?? guardFilePath())
  if (baseline === null) return

  const now = snapshotSourceTree(root)
  const changed = Object.keys(baseline.files).filter((path) => now[path] !== undefined && now[path] !== baseline.files[path])
  const removed = Object.keys(baseline.files).filter((path) => now[path] === undefined)
  const added = Object.keys(now).filter((path) => baseline.files[path] === undefined)

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
    `This run started at ${startedAt} on the tree it recorded in ${options.path ?? guardFilePath()}.`,
    'Files transformed before the change were read from one revision and files after',
    'it from another, so a failure here says nothing about the code: #543 was three of',
    'them, in two files that both pass on their own. Re-run on a tree nobody is',
    'touching — a `git worktree` is how to work on something else at the same time —',
    'and quote that run instead.',
  )

  throw new Error(parts.join('\n'))
}
