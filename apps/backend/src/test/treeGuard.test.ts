import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  snapshotSourceTree,
  guardFilePath,
  newRunId,
  providedRunId,
  writeGuardBaseline,
  readGuardBaseline,
  assertSourceUnchanged,
} from './treeGuard'

/*
 * The guard that turns #543 into a sentence instead of three mysteries.
 *
 * A full backend run reads 232 test files over ~24 minutes, and vitest transforms
 * each module ONCE and serves that transform for the rest of the run — so if the
 * tree changes while that is happening (a branch switch, a stash, a pull, an edit)
 * the run reads two revisions of the same file set, mixed per module, silently.
 * #543 was exactly that: two files green on their own, failing in the run, and the
 * console error naming a column the revision being read did not have.
 *
 * These tests are about the guard's own behaviour — does it notice, does it say
 * WHICH file, and does it refuse when it cannot tell — not about the race that
 * provokes it. Everything here works on a scratch tree under the OS temp directory,
 * so no test can touch the checkout it is running in. The two call sites in
 * `setup.ts` (start of file, and end of file) are verified by running the suite and
 * changing a file underneath it, which is a thing only a real run can do.
 */
let root: string

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'tree-guard-test-'))
  mkdirSync(join(root, 'src', 'lib'), { recursive: true })
  mkdirSync(join(root, 'drizzle', 'meta'), { recursive: true })
  writeFileSync(join(root, 'src', 'lib', 'thing.ts'), 'export const thing = 1\n')
  writeFileSync(join(root, 'src', 'lib', 'thing.test.ts'), "it('works', () => {})\n")
  writeFileSync(join(root, 'drizzle', '0001_thing.sql'), 'CREATE TABLE thing ();\n')
  writeFileSync(join(root, 'drizzle', 'meta', '_journal.json'), '{"entries":[]}\n')
})

afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

describe('snapshotSourceTree', () => {
  it('is the same for a tree nobody touches', () => {
    expect(snapshotSourceTree(root)).toEqual(snapshotSourceTree(root))
  })

  it('changes when a file the suite reads is edited', () => {
    const before = snapshotSourceTree(root)
    writeFileSync(join(root, 'src', 'lib', 'thing.ts'), 'export const thing = 2\n')

    const after = snapshotSourceTree(root)

    expect(after['src/lib/thing.ts']).not.toBe(before['src/lib/thing.ts'])
  })

  it('covers the test files too, not only the source they test', () => {
    expect(Object.keys(snapshotSourceTree(root))).toContain('src/lib/thing.test.ts')
  })

  it('covers the migrations, which is what journal.test.ts reads', () => {
    expect(Object.keys(snapshotSourceTree(root))).toContain('drizzle/0001_thing.sql')
    expect(Object.keys(snapshotSourceTree(root))).toContain('drizzle/meta/_journal.json')
  })

  it('records an added or removed file by its absence, not only by its hash', () => {
    const before = snapshotSourceTree(root)
    writeFileSync(join(root, 'src', 'lib', 'added.ts'), 'export const added = 1\n')
    const after = snapshotSourceTree(root)

    expect(Object.keys(before)).not.toContain('src/lib/added.ts')
    expect(Object.keys(after)).toContain('src/lib/added.ts')
  })
})

describe('the baseline the run starts on', () => {
  it('is written once and read back with the tree it describes', () => {
    const path = join(root, 'baseline.json')
    const written = writeGuardBaseline(path, root)

    const read = readGuardBaseline(path)

    expect(written.root).toBe(root)
    expect(read.kind).toBe('ok')
    if (read.kind === 'ok') expect(read.baseline.files).toEqual(written.files)
  })

  it('is replaced whole, so a reader never sees half a document', () => {
    const path = join(root, 'baseline.json')
    writeGuardBaseline(path, root)
    writeGuardBaseline(path, root)

    const read = readGuardBaseline(path)

    expect(read.kind).toBe('ok')
  })

  it('says it is missing, rather than guessing at a tree it never saw', () => {
    expect(readGuardBaseline(join(root, 'never-written.json')).kind).toBe('missing')
  })

  it('tells an unreadable baseline apart from a missing one', () => {
    const path = join(root, 'corrupt.json')
    writeFileSync(path, '{"startedAt": 1, "files": ')

    const read = readGuardBaseline(path)

    expect(read.kind).toBe('unreadable')
    if (read.kind === 'unreadable') expect(read.path).toBe(path)
  })

  it('is named after the run it belongs to, so two runs in one checkout never share it', () => {
    expect(guardFilePath('infrashelf_test_one-aaaa1111')).not.toBe(guardFilePath('infrashelf_test_one-bbbb2222'))
    expect(guardFilePath('infrashelf_test_one-aaaa1111')).toContain('infrashelf_test_one-aaaa1111')
  })

  it('names a run after its database and a token, so two runs never look alike', () => {
    // The database name is for a human looking in the temp directory; the token is
    // what stops a run comparing itself against a newer run's snapshot and passing.
    expect(newRunId('infrashelf_test_x')).toContain('infrashelf_test_x')
    expect(newRunId('infrashelf_test_x')).not.toBe(newRunId('infrashelf_test_x'))
    expect(newRunId('infrashelf test/x')).toMatch(/^[a-zA-Z0-9_-]+$/)
  })
})

describe('assertSourceUnchanged', () => {
  it('passes silently while the tree is the one the run started on', () => {
    const path = join(root, 'baseline.json')
    writeGuardBaseline(path, root)

    expect(() => assertSourceUnchanged({ path, root })).not.toThrow()
  })

  it('names the file that was rewritten under the run, which is the whole point', () => {
    const path = join(root, 'baseline.json')
    writeGuardBaseline(path, root)
    writeFileSync(join(root, 'src', 'lib', 'thing.ts'), 'export const thing = 2\n')

    expect(() => assertSourceUnchanged({ path, root })).toThrow(/src\/lib\/thing\.ts/)
  })

  it('says what changed rather than only that something did', () => {
    const path = join(root, 'baseline.json')
    writeGuardBaseline(path, root)
    rmSync(join(root, 'src', 'lib', 'thing.test.ts'))
    writeFileSync(join(root, 'src', 'lib', 'new.test.ts'), 'it("is new", () => {})\n')

    let message = ''
    try {
      assertSourceUnchanged({ path, root })
    } catch (e) {
      message = (e as Error).message
    }

    expect(message).toContain('src/lib/new.test.ts')
    expect(message).toContain('src/lib/thing.test.ts')
    expect(message).toMatch(/changed while this suite was running/i)
  })

  it('counts the files it did not name, so a branch switch does not print 200 paths', () => {
    const path = join(root, 'baseline.json')
    writeGuardBaseline(path, root)
    for (let i = 0; i < 12; i++) {
      writeFileSync(join(root, 'src', `bulk-${i}.ts`), `export const n = ${i}\n`)
    }

    let message = ''
    try {
      assertSourceUnchanged({ path, root })
    } catch (e) {
      message = (e as Error).message
    }

    expect(message).toContain('12')
    expect(message).toMatch(/more/i)
  })

  it('refuses to speak when the run never wrote a baseline, instead of passing quietly', () => {
    // The dangerous state is the silent one: a guard that is absent for a reason
    // nobody sees is the #543 bug with extra steps.
    expect(() => assertSourceUnchanged({ path: join(root, 'absent.json'), root })).toThrow(/absent\.json/)
    expect(() => assertSourceUnchanged({ path: join(root, 'absent.json'), root })).toThrow(
      /not one to report as a result/i,
    )
  })

  it('refuses a baseline it cannot read, which is a writer it did not expect', () => {
    const path = join(root, 'corrupt.json')
    writeFileSync(path, '{"startedAt": 1, "files": ')

    expect(() => assertSourceUnchanged({ path, root })).toThrow(/cannot be read/)
  })

  it('knows which run it is in, because globalSetup provided the identity', () => {
    // This asserts the wiring rather than the parsing: if `provide` leaves globalSetup,
    // every file loses the ability to find its own baseline, and this test is what says
    // so. (The branch for a run that provided nothing is defensive — a setup file loaded
    // without globalSetup — and cannot be reached from inside a run, which is the only
    // place these tests execute.)
    expect(providedRunId()).toMatch(/-[0-9a-f]{8}$/)
  })
})