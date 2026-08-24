// Copies Swagger UI's browser assets out of node_modules and into public/, so
// /api/docs serves them from its own origin.
//
// They used to come from unpkg.com at a floating `@5` with no integrity hash
// (issue #146): /api/docs is an authenticated page, so anything unpkg served —
// after a CDN compromise or a hostile publish of any 5.x — ran as the signed-in
// user against this API. The version is now pinned by pnpm-lock.yaml, with its
// integrity hash, like every other dependency.
//
// The output IS committed, rather than generated during the build. It has to be
// present for `next build`, for `pnpm test`, and inside Stryker's sandbox, and
// there is no single hook that runs before all three — the Docker deps stage in
// particular installs from the manifests alone, with scripts/ not yet copied.
// Committing 1.7 MB once removes the ordering question entirely.
//
// Run this after bumping swagger-ui-dist: `pnpm --filter backend vendor:swagger-ui`.
// Forgetting to is caught by the docs route test, which compares the committed
// bytes against the installed package.
import { copyFileSync, mkdirSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const require = createRequire(import.meta.url)
const source = dirname(require.resolve('swagger-ui-dist/package.json'))
const target = join(dirname(fileURLToPath(import.meta.url)), '..', 'public', 'swagger-ui')

// The standalone preset is deliberately absent: it draws the topbar whose URL
// box loads any spec the reader types, which is not something an internal API
// reference needs, and skipping it is 300 KB less vendored script.
const ASSETS = ['swagger-ui.css', 'swagger-ui-bundle.js']

mkdirSync(target, { recursive: true })
for (const asset of ASSETS) {
  copyFileSync(join(source, asset), join(target, asset))
}
console.warn(`[swagger-ui] vendored ${ASSETS.length} assets into ${target}`)
