import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

/**
 * The pinned toolchain says the same thing in all three places it is written.
 *
 * `mise.toml` is what a developer's machine installs, `packageManager` in
 * package.json is what pnpm and corepack enforce, and `node-version` in the CI
 * setup action is what every pipeline job runs. Nothing makes them agree, and
 * the failure when they drift is the worst kind: everything passes locally,
 * everything passes in CI, and the two were never running the same build.
 *
 * Read as text rather than parsed with a TOML library, deliberately — this is a
 * gate on three files, and adding a dependency to check a pin is a poor trade.
 */
const ROOT = join(import.meta.dirname, '..')
const read = (p: string) => readFileSync(join(ROOT, p), 'utf8')

const miseTool = (name: string): string => {
  const match = read('mise.toml').match(new RegExp(`^${name}\\s*=\\s*"([^"]+)"`, 'm'))
  if (!match) throw new Error(`mise.toml pins no ${name}`)
  return match[1]
}

describe('the pinned toolchain agrees with itself', () => {
  it('pins exact versions, not ranges', () => {
    // A range would let two developers run different builds against one lockfile,
    // which is the problem a lockfile solves one level up.
    for (const tool of ['node', 'pnpm']) {
      expect(miseTool(tool), `mise.toml ${tool}`).toMatch(/^\d+\.\d+\.\d+$/)
    }
  })

  it('pins the same pnpm as package.json packageManager', () => {
    // pnpm itself refuses to run when these disagree, so this turns a confusing
    // runtime refusal into a named test failure.
    const declared = JSON.parse(read('package.json')).packageManager as string
    expect(declared).toBe(`pnpm@${miseTool('pnpm')}`)
  })

  it('pins a Node whose major matches the one CI installs', () => {
    // CI pins the major and takes the latest patch; mise pins the patch so local
    // builds are reproducible. The majors have to match, or "works locally" and
    // "passes CI" stop being the same claim.
    const action = read('.github/actions/setup/action.yml')
    const ciMajor = action.match(/node-version:\s*'?(\d+)/)?.[1]
    expect(ciMajor, 'node-version in .github/actions/setup/action.yml').toBeDefined()
    expect(miseTool('node').split('.')[0]).toBe(ciMajor)
  })

  /*
   * The images are the fourth place the toolchain is written, and the one nothing
   * was watching.
   *
   * `npm install -g pnpm` with no version installs whatever npm's `latest` is at
   * build time. That is not a pin and not a range — it is the registry's opinion
   * of the day, and on 2026-09-19 it changed under a release nobody touched: pnpm
   * 12 became `latest`, and the linux/arm64 leg of CD — Release died in the deps
   * stage with exit code 1 and no output whatsoever, against the same lockfile
   * pnpm 11.9.0 installs from the same image. The amd64 leg went on passing
   * because its layer came from cache, so the workflow was red on one
   * architecture with nothing to read.
   *
   * A docker build is not something this suite can run, so it checks the two
   * things that make it a pin: a version is named, and it is the version the rest
   * of the toolchain pins.
   *
   * Per STAGE, not per file. `ARG` is scoped to the stage that declares it, so an
   * install in a stage whose ARG moved elsewhere expands `${PNPM_VERSION}` to
   * nothing and runs `npm install -g pnpm@` — which is neither a version nor a
   * loud failure. Counting the file's ARGs against the file's installs balances
   * out in exactly that case.
   */
  it('installs a pinned pnpm in every image stage that installs one', () => {
    for (const file of ['apps/frontend/Dockerfile', 'apps/backend/Dockerfile']) {
      // Split at `FROM `: everything up to the next one is a stage.
      const stages = read(file).split(/^FROM /m).slice(1)
      let installs = 0

      for (const stage of stages) {
        // The regression itself: an install with no version after it.
        expect(stage, `${file} installs pnpm unpinned`).not.toMatch(/npm install -g pnpm(?!@)/)

        const pinned = stage.match(/npm install -g pnpm@\$\{PNPM_VERSION\}/g) ?? []
        if (pinned.length === 0) continue
        installs += pinned.length

        const declared = [...stage.matchAll(/^ARG PNPM_VERSION=(\S+)$/gm)]
        expect(
          declared.length,
          `${file}: ${pinned.length} install(s) in a stage declaring ${declared.length} ARG(s)`,
        ).toBeGreaterThan(0)
        for (const [, version] of declared) expect(version, file).toBe(miseTool('pnpm'))
      }

      expect(installs, `${file} installs pnpm`).toBeGreaterThan(0)
    }
  })
})
