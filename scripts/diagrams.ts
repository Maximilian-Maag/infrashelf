/**
 * Renders `docs/architecture/workspace.dsl` into the pictures the handbook uses.
 *
 * The handbook used to redraw the C4 levels by hand in TikZ, so the same three
 * diagrams existed twice — once as the model and once as a drawing of it — and
 * only one of them was ever updated. This is the one that is generated, and
 * `docs/handbook.tex` includes its output.
 *
 * The pipeline is two hops: structurizr-cli exports each view to C4-PlantUML,
 * and PlantUML lays it out with Graphviz. Structurizr's own `autoLayout` hints
 * do NOT survive that — layout happens in Graphviz at render time — which is why
 * spacing is set here as PlantUML directives rather than in the DSL.
 *
 * Usage: `tsx scripts/diagrams.ts [--jpeg] [--pdf]`, or `make diagrams`.
 */
import { execFileSync } from 'node:child_process'
import * as fs from 'node:fs'
import * as path from 'node:path'
import { PINS, STRUCTURIZR_LIB, TOOL_DIR, resolveTools } from './diagramTools'

const REPO_ROOT = path.resolve(import.meta.dirname, '..')
const DSL = path.join(REPO_ROOT, 'docs', 'architecture', 'workspace.dsl')
const OUT = path.join(REPO_ROOT, 'docs', 'architecture', 'diagrams')
const PUML = path.join(TOOL_DIR, 'puml')

/**
 * The views, in the order a reader meets them — C4 levels first, then the two
 * deployment views. `docs/handbook.tex` includes them by these file names, so
 * renaming a view in the DSL renames a file here and breaks the handbook build;
 * that is deliberate, and better than a handbook that silently keeps the old
 * picture.
 */
const VIEWS = [
  'SystemContext',
  'Container',
  'Component_Frontend',
  'Component_Backend',
  'Deployment_DockerHost',
  'Deployment_Kubernetes',
] as const

/**
 * Layout directives injected into every exported `.puml`.
 *
 * The backend component view is 14 components and 38 relationships, and at
 * Graphviz's defaults its edge labels collide into an unreadable horizontal
 * ribbon. `nodesep`/`ranksep` buy the space that separates them.
 *
 * `PLANTUML_LIMIT_SIZE` matters just as much and is passed on the command line
 * below: the default is 4096px, and that view is 4899px wide, so without it the
 * picture is silently CLIPPED — the first render of it lost Microsoft Entra ID,
 * Bitbucket and the Mail Server off the right-hand edge with no warning at all.
 */
const LAYOUT = `skinparam nodesep 45
skinparam ranksep 110
skinparam wrapWidth 220
skinparam maxMessageSize 180
skinparam defaultTextAlignment center
`

/** Graphviz needs room; the default 4096 clips the backend component view. */
const LIMIT_SIZE = '16384'

const java = (args: string[]): void => {
  execFileSync('java', args, { stdio: ['ignore', 'ignore', 'inherit'] })
}

const main = (): void => {
  const flags = process.argv.slice(2)
  // `--jpeg` writes PNG: these are line drawings with flat fills and text, and
  // JPEG's block artefacts land exactly on the glyph edges that have to stay
  // legible. Kept as the flag name because that is what the build asks for.
  const wantRaster = flags.includes('--jpeg') || flags.includes('--png')
  const wantPdf = flags.includes('--pdf')
  if (!wantRaster && !wantPdf) {
    process.stderr.write('Nothing to do. Pass --jpeg (PNG files), --pdf (one PDF), or both.\n')
    process.exit(2)
  }

  const tools = resolveTools()
  if (!tools.ok) {
    process.stderr.write(
      `Missing or unpinned diagram tools: ${tools.missing.join(', ')}. Run \`make diagrams-install\`.\n`,
    )
    process.exit(1)
  }

  fs.rmSync(PUML, { recursive: true, force: true })
  fs.mkdirSync(PUML, { recursive: true })
  fs.mkdirSync(OUT, { recursive: true })

  process.stderr.write('Exporting views to C4-PlantUML...\n')
  java([
    '-cp', path.join(STRUCTURIZR_LIB, '*'),
    'com.structurizr.cli.StructurizrCliApplication',
    'export', '-workspace', DSL, '-format', 'plantuml/c4plantuml', '-output', PUML,
  ])

  // Every view the DSL defines must have arrived, or the handbook is about to
  // include a picture that no longer exists. Named individually so the failure
  // says which view went missing rather than "some files".
  const missing = VIEWS.filter((v) => !fs.existsSync(path.join(PUML, `structurizr-${v}.puml`)))
  if (missing.length > 0) {
    process.stderr.write(`The DSL no longer exports: ${missing.join(', ')}. Update VIEWS in this file.\n`)
    process.exit(1)
  }

  for (const view of VIEWS) {
    const file = path.join(PUML, `structurizr-${view}.puml`)
    const body = fs.readFileSync(file, 'utf8')
    if (!body.includes('top to bottom direction')) {
      process.stderr.write(`${view}: no layout anchor in the exported puml; the exporter changed shape.\n`)
      process.exit(1)
    }
    fs.writeFileSync(file, body.replace('top to bottom direction\n', `top to bottom direction\n${LAYOUT}`))
  }

  if (wantRaster) {
    process.stderr.write('Rendering PNG...\n')
    java([`-DPLANTUML_LIMIT_SIZE=${LIMIT_SIZE}`, '-jar', PINS.plantuml.file, '-tpng', '-o', OUT, `${PUML}/*.puml`])
  }

  if (wantPdf) {
    process.stderr.write('Rendering PDF...\n')
    const pdfDir = path.join(PUML, 'pdf')
    java([`-DPLANTUML_LIMIT_SIZE=${LIMIT_SIZE}`, '-jar', PINS.plantuml.file, '-tpdf', '-o', pdfDir, `${PUML}/*.puml`])

    // One file, in reading order — C4 levels first, deployment last. `pdfunite`
    // keeps each page vector, which `convert` would not.
    const pages = VIEWS.map((v) => path.join(pdfDir, `structurizr-${v}.pdf`))
    const absent = pages.filter((p) => !fs.existsSync(p))
    if (absent.length > 0) {
      process.stderr.write(`PlantUML produced no PDF for: ${absent.map((p) => path.basename(p)).join(', ')}\n`)
      process.exit(1)
    }
    const combined = path.join(OUT, 'c4-diagrams.pdf')
    execFileSync('pdfunite', [...pages, combined], { stdio: 'inherit' })
    process.stderr.write(`  ${path.relative(REPO_ROOT, combined)}\n`)
  }

  for (const f of fs.readdirSync(OUT).sort()) {
    process.stderr.write(`  docs/architecture/diagrams/${f}\n`)
  }
}

main()
