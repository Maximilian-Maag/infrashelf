/**
 * The two jars that turn `docs/architecture/workspace.dsl` into pictures.
 *
 * Pinned by checksum for the same reason `scripts/opa.ts` pins opa: a build step
 * that runs whatever the download endpoint served is one supply-chain incident
 * away from putting someone else's output in the handbook. The pin is checked
 * against the bytes on disk before anything is executed, not against a version
 * string a replacement jar could equally print.
 *
 * Both land in `.diagrams/`, gitignored, so a working copy carries ~130 MB of
 * tooling without committing it.
 *
 * `make diagrams-install` runs this file; `scripts/diagrams.ts` calls
 * `resolveTools()` and refuses to render without it.
 */
import * as crypto from 'node:crypto'
import * as fs from 'node:fs'
import * as path from 'node:path'

export const STRUCTURIZR_VERSION = 'v2025.11.09'
export const PLANTUML_VERSION = '1.2026.7'

const REPO_ROOT = path.resolve(import.meta.dirname, '..')
export const TOOL_DIR = path.join(REPO_ROOT, '.diagrams')

interface Pin {
  url: string
  file: string
  sha256: string
}

export const PINS: Record<'structurizr' | 'plantuml', Pin> = {
  structurizr: {
    url: `https://github.com/structurizr/cli/releases/download/${STRUCTURIZR_VERSION}/structurizr-cli.zip`,
    file: path.join(TOOL_DIR, 'structurizr-cli.zip'),
    sha256: 'f5365a463fc44d539ed19bec00c48ba1e1ecda0ccfd1ba40d2e7472d264eb79a',
  },
  plantuml: {
    url: `https://github.com/plantuml/plantuml/releases/download/v${PLANTUML_VERSION}/plantuml-${PLANTUML_VERSION}.jar`,
    file: path.join(TOOL_DIR, 'plantuml.jar'),
    sha256: '33aa7ed0ca843e300690230d09268e1f526fdde7e86fecdfa39fb80412cafcde',
  },
}

/** Where the structurizr zip is unpacked; its jars are loaded as a classpath. */
export const STRUCTURIZR_LIB = path.join(TOOL_DIR, 'cli', 'lib')

const sha256Of = (file: string): string | null => {
  try {
    return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex')
  } catch {
    // Unreadable and absent are the same answer here: the caller is told the
    // pinned artefact is not present and installs it.
    return null
  }
}

/** Whether both jars are present AND are the bytes the pin names. */
export const resolveTools = (): { ok: true } | { ok: false; missing: string[] } => {
  const missing = Object.entries(PINS)
    .filter(([, pin]) => sha256Of(pin.file) !== pin.sha256)
    .map(([name]) => name)
  return missing.length === 0 ? { ok: true } : { ok: false, missing }
}

const download = async (pin: Pin): Promise<void> => {
  process.stderr.write(`Fetching ${pin.url}\n`)
  const response = await fetch(pin.url)
  if (!response.ok) throw new Error(`${pin.url} returned ${response.status}`)
  const body = Buffer.from(await response.arrayBuffer())

  const actual = crypto.createHash('sha256').update(body).digest('hex')
  if (actual !== pin.sha256) {
    throw new Error(
      `Checksum mismatch for ${path.basename(pin.file)}\n  expected ${pin.sha256}\n  actual   ${actual}\n` +
        'Refusing to write it. Either the pin in scripts/diagramTools.ts is stale or the download was tampered with.',
    )
  }

  fs.mkdirSync(path.dirname(pin.file), { recursive: true })
  fs.writeFileSync(pin.file, body)
}

const main = async (): Promise<void> => {
  for (const pin of Object.values(PINS)) {
    if (sha256Of(pin.file) === pin.sha256) {
      process.stderr.write(`  ok  ${path.basename(pin.file)}\n`)
      continue
    }
    await download(pin)
  }

  // Unpacked here rather than in the renderer: the zip is the artefact the
  // checksum names, and a half-unpacked tree from an interrupted render would
  // otherwise be indistinguishable from a good one.
  const { execFileSync } = await import('node:child_process')
  fs.rmSync(path.join(TOOL_DIR, 'cli'), { recursive: true, force: true })
  execFileSync('unzip', ['-q', '-o', PINS.structurizr.file, '-d', path.join(TOOL_DIR, 'cli')])
  if (!fs.existsSync(STRUCTURIZR_LIB)) {
    throw new Error(`structurizr-cli.zip did not contain ${STRUCTURIZR_LIB}`)
  }
  process.stderr.write(`Diagram tools ready in ${TOOL_DIR}\n`)
}

if (process.argv[1] && import.meta.url.endsWith(path.basename(process.argv[1]))) {
  main().catch((err: unknown) => {
    process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`)
    process.exit(1)
  })
}
