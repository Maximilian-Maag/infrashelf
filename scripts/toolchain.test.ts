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
})
