import { spawnSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'

function resolveDbUrl(): string | undefined {
  if (process.env.DATABASE_URL) return process.env.DATABASE_URL
  // Fall back to backend .env for local dev (not set in playwright's root process)
  try {
    const content = readFileSync('./apps/backend/.env', 'utf-8')
    return content.match(/^DATABASE_URL=(.+)$/m)?.[1]
  } catch {
    return undefined
  }
}

function ensureDatabase(databaseUrl: string): void {
  try {
    const url = new URL(databaseUrl)
    const env = { ...process.env, PGPASSWORD: url.password || '' }
    const psqlArgs = ['-h', url.hostname, '-p', url.port || '5432', '-U', url.username]
    const dbName = url.pathname.slice(1)

    // Only create the database if it doesn't exist yet
    const probe = spawnSync('psql', [...psqlArgs, '-d', dbName, '-c', '\\q'], { env, stdio: 'pipe' })
    // `code` is on NodeJS.ErrnoException, which spawnSync types only as Error.
    const spawnFailed = (probe.error as NodeJS.ErrnoException | undefined)?.code === 'ENOENT'
    if (probe.status !== 0 && !spawnFailed) {
      spawnSync('psql', [...psqlArgs, '-d', 'postgres', '-c', `CREATE DATABASE "${dbName}"`], { env, stdio: 'pipe' })
    }
  } catch {
    // psql unavailable or URL malformed — backend will fail with a clear error
  }
}

/**
 * Put the demo catalogue in the database before a single test runs (issue #152).
 *
 * This is not a convenience. `runBootstrap()` — which is all that the backend does
 * on the way up — applies migrations, writes default branding and one root user,
 * and stops. Against that database roughly 56 of 283 tests took an "empty state →
 * `test.skip()`" branch, and the ones that skipped were the ones that mattered:
 * the whole of admin-pipeline-stacks, six of seven order-flow tests, the order
 * comment thread, favourites, trials, approvals, the data-dependent half of
 * infrastructure. A CI run that executed nothing reported `{"expected": 0,
 * "skipped": 283, "ok": true}`.
 *
 * It lives here rather than in a CI step so that a local run and a CI run start
 * from the *same* catalogue. A suite whose coverage depends on how much data
 * happens to be lying around is exactly what issue #154 turned out to be, and the
 * skip budget in .github/workflows/ci.yml can only mean something if the amount of
 * data is fixed.
 *
 * `seedDemoData` is idempotent (everything hangs off a marker category and the
 * whole thing is skipped when that exists) and deterministic — a fixed catalogue
 * of three products, two environments, one project, two cost centres, three orders
 * in three different states and two infrastructure elements. Re-running it against
 * a database that already has it is a no-op, so this costs one query on every run
 * after the first.
 *
 * Failing loudly is the point. A silent seed failure would put the suite straight
 * back into the state this fixes, with the difference that nobody would know.
 */
function seedDemoData(databaseUrl: string): void {
  // Absolute: the child runs with cwd=apps/backend (that is where its tsconfig,
  // its drizzle/ folder and its .env are), so a path relative to the repo root
  // would be resolved against the wrong directory — spawnSync ENOENT.
  const tsx = resolve(process.cwd(), 'node_modules/.bin/tsx')
  if (!existsSync(tsx)) {
    throw new Error(
      `Cannot seed the e2e database: ${tsx} is missing. Run \`pnpm install\` at the repo root.`,
    )
  }

  // Mirrors `make db-seed-demo`. --env-file only when there IS one: CI passes
  // DATABASE_URL/ADMIN_* in the environment and has no apps/backend/.env at all,
  // and node exits with an error when told to load a file that does not exist.
  const backend = resolve(process.cwd(), 'apps/backend')
  const args = ['--tsconfig', 'tsconfig.json']
  if (existsSync(resolve(backend, '.env'))) args.unshift('--env-file=.env')

  const result = spawnSync(tsx, [...args, 'src/seed-demo.ts'], {
    cwd: backend,
    env: { ...process.env, DATABASE_URL: databaseUrl },
    stdio: 'pipe',
    encoding: 'utf-8',
  })

  if (result.error) {
    throw new Error(`Cannot seed the e2e database: ${result.error.message}`)
  }
  if (result.status !== 0) {
    throw new Error(
      `Seeding the e2e database failed (exit ${result.status}).\n` +
        `${result.stdout ?? ''}\n${result.stderr ?? ''}`,
    )
  }
  // The seed says what it did (or that it was already there); pass that on, since
  // "which catalogue was this run asserting against" is the first question a
  // surprising failure raises.
  process.stdout.write(result.stdout ?? '')
}

export default async function globalSetup() {
  const databaseUrl = resolveDbUrl()
  if (!databaseUrl) {
    throw new Error(
      'No DATABASE_URL. The e2e suite needs a database it can seed — set it in the ' +
        'environment or in apps/backend/.env.',
    )
  }

  ensureDatabase(databaseUrl)
  seedDemoData(databaseUrl)
}
