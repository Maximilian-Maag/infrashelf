/**
 * Extracts the facts the Rego policies in `policy/` reason about.
 *
 * Rego cannot read TypeScript, and the invariants worth enforcing here are all
 * cross-file: a route and its test, a table and the test setup that truncates
 * it, a translation key and 25 tables. So this walks the tree once and emits a
 * single JSON document — the whole input to `opa eval`.
 *
 * Two deliberate choices:
 *
 *  - TypeScript is read through the compiler's own parser (`createSourceFile`,
 *    no type checker) rather than by regex. Parsing costs ~1 s for the whole
 *    repo and removes the class of policy bug where a rule fires on a string
 *    literal or a comment.
 *
 *  - YAML is read line by line rather than through a YAML library. The facts we
 *    need from it are single scalars (`uses:`, `image:`) and every violation
 *    message has to say *which line* to edit; a parsed document throws the line
 *    numbers away, and adding a YAML dependency re-resolved unrelated entries in
 *    the lockfile. The subset scanned here — a scalar after a key on its own
 *    line — is the only shape these files use.
 *
 * Usage: `tsx scripts/policy-facts.ts [--out facts.json]` (default: stdout).
 */
import * as fs from 'node:fs'
import * as path from 'node:path'
import * as ts from 'typescript'

const REPO_ROOT = path.resolve(import.meta.dirname, '..')

const BACKEND = 'apps/backend'
const FRONTEND = 'apps/frontend'
const API_DIR = `${BACKEND}/src/app/api`
const SCHEMA_FILE = `${BACKEND}/src/lib/db/schema.ts`
const TEST_SETUP_FILE = `${BACKEND}/src/test/setup.ts`
const DRIZZLE_DIR = `${BACKEND}/drizzle`
const I18N_FILE = `${FRONTEND}/src/lib/i18n.ts`

/**
 * Columns that hold a credential. Named by their SQL identifier because that is
 * what a reviewer greps for and what the migration says; the extractor maps them
 * back to the Drizzle property names, so a policy can name both.
 *
 * The list is every column `schema.ts` documents as secret-bearing, not the ones
 * #144 happened to leak. A column that is absent here produces no fact at all, so
 * a projection that reaches it is neither denied nor deliberately allowlisted —
 * it is simply invisible, which is the failure mode this rule exists to remove.
 */
const SECRET_SQL_COLUMNS = [
  'access_token',
  'webhook_token',
  'callback_secret',
  'password_hash',
  'smtp_pass',
  'ai_api_key',
  // The session token's SHA-256 (sessions). Not the token itself, but a dump of
  // these is enough to recognise a presented token, so it stays off responses.
  'token_hash',
  // The TOTP factor (user_totp): an AES-256-GCM envelope of the shared secret,
  // and the in-flight enrollment kept beside it.
  'secret',
  'pending_secret',
  // SHA-256 of a recovery code (user_recovery_codes).
  'code_hash',
  // The integration registry's encrypted token or password (integrations).
  'credential',
]

const HTTP_METHODS = new Set(['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS'])
// `requireAuthPendingSecondFactor` authenticates exactly as `requireAuth` does —
// same token, same session row, same 401 without one. It differs only in that it
// permits an administrator who still owes an enrollment (#197), which is what
// makes the enrollment endpoints reachable at all. A route using it is
// authenticated; whether it *should* be one of the few that tolerates the pending
// state is a judgement the helper's own doc comment records, and rule 1 is not
// the thing that can decide it.
const AUTH_HELPERS = new Set([
  'requireAuth',
  'requireAuthPendingSecondFactor',
  'requireRole',
  'requireRoot',
])

// ---------------------------------------------------------------------------
// filesystem helpers
// ---------------------------------------------------------------------------

const IGNORED_DIRS = new Set(['node_modules', '.next', '.git', 'dist', '.stryker-tmp', 'test-results'])

function walk(dir: string, keep: (rel: string) => boolean): string[] {
  const abs = path.join(REPO_ROOT, dir)
  if (!fs.existsSync(abs)) return []
  const out: string[] = []
  for (const entry of fs.readdirSync(abs, { withFileTypes: true })) {
    if (IGNORED_DIRS.has(entry.name)) continue
    const rel = path.posix.join(dir, entry.name)
    if (entry.isDirectory()) out.push(...walk(rel, keep))
    else if (keep(rel)) out.push(rel)
  }
  return out.sort()
}

const read = (rel: string): string => fs.readFileSync(path.join(REPO_ROOT, rel), 'utf8')
const exists = (rel: string): boolean => fs.existsSync(path.join(REPO_ROOT, rel))

const parse = (rel: string): ts.SourceFile =>
  ts.createSourceFile(rel, read(rel), ts.ScriptTarget.Latest, /* setParentNodes */ true,
    rel.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS)

const lineOf = (sf: ts.SourceFile, node: ts.Node): number =>
  sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1

function visit(node: ts.Node, fn: (n: ts.Node) => void): void {
  fn(node)
  ts.forEachChild(node, (child) => visit(child, fn))
}

/** The name being called, for `f()`, `o.f()` and `o.p.f()` alike. */
function calleeName(node: ts.CallExpression): string | null {
  const e = node.expression
  if (ts.isIdentifier(e)) return e.text
  if (ts.isPropertyAccessExpression(e) && ts.isIdentifier(e.name)) return e.name.text
  return null
}

const propName = (p: ts.ObjectLiteralElementLike): string | null =>
  p.name && (ts.isIdentifier(p.name) || ts.isStringLiteral(p.name)) ? p.name.text : null

// ---------------------------------------------------------------------------
// routes
// ---------------------------------------------------------------------------

interface RouteFact {
  file: string
  apiPath: string
  methods: string[]
  authHelpers: string[]
  dynamicSegments: string[]
  lines: number
  /** The `params` keys that reach `parseRouteId`, not how many times it was called. */
  safeIdSegments: string[]
  /** `parseRouteId(x)` where `x` could not be traced back to a `params` key. */
  unattributedSafeIdParses: number
  /** `parseInt`/`Number` applied to a value destructured from `params`. */
  unsafeIdParses: { line: number; call: string; segment: string }[]
  testFiles: string[]
}

/**
 * Local name -> the `params` key it was destructured from.
 *
 * `const { id, envId } = await params` binds both under their own names;
 * `const { id: rawOrderId } = await params` binds `rawOrderId` to the key `id`.
 * The key is what the rule needs, because that is what the `[segment]` directory
 * is called — the local name is the route author's choice.
 *
 * Narrowing rule 5 to these is what keeps it off the two `parseInt(searchParams…)`
 * call sites, which are query parameters and a different question entirely.
 */
function paramBindings(sf: ts.SourceFile): Map<string, string> {
  const bound = new Map<string, string>()
  visit(sf, (node) => {
    if (!ts.isVariableDeclaration(node) || !node.initializer) return
    if (!ts.isObjectBindingPattern(node.name)) return
    const init = ts.isAwaitExpression(node.initializer) ? node.initializer.expression : node.initializer
    const text = init.getText(sf)
    if (!/(^|\.)params$/.test(text)) return
    for (const element of node.name.elements) {
      if (!ts.isIdentifier(element.name)) continue
      const key =
        element.propertyName && (ts.isIdentifier(element.propertyName) || ts.isStringLiteral(element.propertyName))
          ? element.propertyName.text
          : element.name.text
      bound.set(element.name.text, key)
    }
  })
  return bound
}

/**
 * The `params` key a `parseRouteId(...)` argument names, or null.
 *
 * Two shapes occur in this tree: an identifier destructured from `params`
 * (`parseRouteId(sourceId)`) and a direct read (`parseRouteId((await params).itemId)`).
 * Anything else — a value threaded through a helper, a computed key — is
 * deliberately *not* guessed at; it is counted separately so the rule can say it
 * saw a parse it could not attribute rather than silently crediting a segment.
 */
function parsedSegment(arg: ts.Expression, params: Map<string, string>): string | null {
  if (ts.isIdentifier(arg)) return params.get(arg.text) ?? null
  if (ts.isPropertyAccessExpression(arg) && ts.isIdentifier(arg.name)) {
    const base = arg.expression
    const inner = ts.isAwaitExpression(base) ? base.expression : base
    if (ts.isParenthesizedExpression(inner)) {
      const unwrapped = ts.isAwaitExpression(inner.expression) ? inner.expression.expression : inner.expression
      if (/(^|\.)params$/.test(unwrapped.getText())) return arg.name.text
    }
    if (/(^|\.)params$/.test(inner.getText())) return arg.name.text
  }
  return null
}

function routeFacts(testImports: Map<string, string[]>): RouteFact[] {
  const files = walk(API_DIR, (rel) => rel.endsWith('/route.ts'))
  return files.map((file) => {
    const sf = parse(file)
    const params = paramBindings(sf)
    const methods: string[] = []
    const authHelpers = new Set<string>()
    const unsafeIdParses: RouteFact['unsafeIdParses'] = []
    const safeIdSegments = new Set<string>()
    let unattributedSafeIdParses = 0

    visit(sf, (node) => {
      if (ts.isFunctionDeclaration(node) && node.name && HTTP_METHODS.has(node.name.text)) {
        const exported = node.modifiers?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword)
        if (exported) methods.push(node.name.text)
      }
      if (ts.isVariableStatement(node)) {
        const exported = node.modifiers?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword)
        for (const d of node.declarationList.declarations) {
          if (exported && ts.isIdentifier(d.name) && HTTP_METHODS.has(d.name.text)) methods.push(d.name.text)
        }
      }
      // `const GET = handler; export { GET }` and `export { handler as GET }`
      // export exactly as much as `export const GET` does. Missing them would let
      // an endpoint leave rules 1 and 10 — both gated on `count(methods) > 0` —
      // by changing only the shape of its export.
      if (ts.isExportDeclaration(node) && node.exportClause && ts.isNamedExports(node.exportClause)) {
        for (const element of node.exportClause.elements) {
          if (HTTP_METHODS.has(element.name.text)) methods.push(element.name.text)
        }
      }
      if (!ts.isCallExpression(node)) return

      const callee = calleeName(node)
      if (callee && AUTH_HELPERS.has(callee)) authHelpers.add(callee)
      if (callee === 'parseRouteId') {
        const arg = node.arguments[0]
        const segment = arg ? parsedSegment(arg, params) : null
        if (segment === null) unattributedSafeIdParses++
        else safeIdSegments.add(segment)
      }

      if (callee === 'parseInt' || callee === 'Number') {
        const arg = node.arguments[0]
        if (arg && ts.isIdentifier(arg) && params.has(arg.text)) {
          unsafeIdParses.push({
            line: lineOf(sf, node),
            call: node.getText(sf),
            segment: params.get(arg.text) as string,
          })
        }
      }
    })

    const apiPath = file.slice(`${API_DIR}/`.length, -'/route.ts'.length)
    return {
      file,
      apiPath,
      methods: [...new Set(methods)].sort(),
      authHelpers: [...authHelpers].sort(),
      dynamicSegments: apiPath.split('/').filter((s) => s.startsWith('[')),
      lines: read(file).split('\n').length,
      safeIdSegments: [...safeIdSegments].sort(),
      unattributedSafeIdParses,
      unsafeIdParses,
      testFiles: testImports.get(file) ?? [],
    }
  })
}

/**
 * route.ts -> the route.test.ts files that import it.
 *
 * Not "is there a sibling route.test.ts": `sessions/route.test.ts` imports and
 * exercises `sessions/[id]/route.ts`, and a rule that only looked for siblings
 * would report a route that is in fact covered. Import edges are the honest
 * signal.
 */
function routeTestImports(): Map<string, string[]> {
  const map = new Map<string, string[]>()
  for (const testFile of walk(API_DIR, (rel) => rel.endsWith('.test.ts'))) {
    const sf = parse(testFile)
    for (const stmt of sf.statements) {
      if (!ts.isImportDeclaration(stmt) || !ts.isStringLiteral(stmt.moduleSpecifier)) continue
      const spec = stmt.moduleSpecifier.text
      const resolved = spec.startsWith('.')
        ? path.posix.normalize(path.posix.join(path.posix.dirname(testFile), spec))
        : spec.startsWith('@/')
          ? path.posix.join(`${BACKEND}/src`, spec.slice(2))
          : null
      if (!resolved) continue
      const target = resolved.endsWith('.ts') ? resolved : `${resolved}.ts`
      if (!target.endsWith('/route.ts')) continue
      map.set(target, [...(map.get(target) ?? []), testFile])
    }
  }
  return map
}

// ---------------------------------------------------------------------------
// database schema vs. test setup
// ---------------------------------------------------------------------------

interface TableFact {
  export: string
  name: string
  secretColumns: { property: string; column: string }[]
  inTestTables: boolean
}

function tableFacts(): TableFact[] {
  const sf = parse(SCHEMA_FILE)
  const tables: TableFact[] = []

  const setup = read(TEST_SETUP_FILE)
  const truncated = new Set(
    [...setup.matchAll(/^\s*schema\.(\w+),/gm)].map((m) => m[1]),
  )

  visit(sf, (node) => {
    if (!ts.isVariableDeclaration(node) || !node.initializer) return
    if (!ts.isCallExpression(node.initializer)) return
    if (calleeName(node.initializer) !== 'pgTable') return
    const [nameArg, columnsArg] = node.initializer.arguments
    if (!nameArg || !ts.isStringLiteral(nameArg) || !ts.isIdentifier(node.name)) return

    const secretColumns: TableFact['secretColumns'] = []
    if (columnsArg && ts.isObjectLiteralExpression(columnsArg)) {
      for (const p of columnsArg.properties) {
        const property = propName(p)
        if (!property || !ts.isPropertyAssignment(p)) continue
        // `text('access_token')`, `varchar('smtp_pass', …)` — the SQL name is the
        // first argument of whichever column builder was used. `credential: text()`
        // gives no name at all, and drizzle then uses the property verbatim (this
        // schema sets no `casing`), so that is the fallback rather than a skip:
        // without it the integration registry's credential column has no fact.
        const text = p.initializer.getText(sf)
        const named = /^\w+\(\s*'([^']+)'/.exec(text)
        const column = named ? named[1] : property
        if (SECRET_SQL_COLUMNS.includes(column)) secretColumns.push({ property, column })
      }
    }

    tables.push({
      export: node.name.text,
      name: nameArg.text,
      secretColumns,
      inTestTables: truncated.has(node.name.text),
    })
  })

  return tables.sort((a, b) => a.name.localeCompare(b.name))
}

// ---------------------------------------------------------------------------
// select() projections
// ---------------------------------------------------------------------------

interface SelectFact {
  file: string
  line: number
  /** Column properties named in the projection, as `table.column` where visible. */
  columns: string[]
  secretColumns: string[]
}

/**
 * Every `.select({ … })` whose projection names a secret column.
 *
 * A bare `.select()` is not reported: it is unavoidably a whole-row read and
 * flagging all ~40 of them would drown the signal. What #144 actually was — a
 * hand-written projection that reached one column too far — is exactly what a
 * named projection makes visible.
 */
function selectFacts(secretProperties: Set<string>): SelectFact[] {
  const sources = [
    ...walk(`${BACKEND}/src`, (rel) => rel.endsWith('.ts') && !rel.endsWith('.test.ts')),
    ...walk(`${FRONTEND}/src`, (rel) => (rel.endsWith('.ts') || rel.endsWith('.tsx')) && !/\.test\.tsx?$/.test(rel)),
  ]
  const out: SelectFact[] = []
  for (const file of sources) {
    if (!read(file).includes('.select(')) continue
    const sf = parse(file)
    visit(sf, (node) => {
      if (!ts.isCallExpression(node) || calleeName(node) !== 'select') return
      const [projection] = node.arguments
      if (!projection || !ts.isObjectLiteralExpression(projection)) return
      const columns: string[] = []
      const secrets: string[] = []
      for (const p of projection.properties) {
        if (!ts.isPropertyAssignment(p)) continue
        const key = propName(p)
        const value = p.initializer.getText(sf)
        if (key) columns.push(`${key}: ${value}`)
        const referenced = /\.(\w+)$/.exec(value)?.[1]
        if (referenced && secretProperties.has(referenced)) secrets.push(referenced)
      }
      if (secrets.length > 0) {
        out.push({ file, line: lineOf(sf, node), columns, secretColumns: [...new Set(secrets)] })
      }
    })
  }
  return out
}

// ---------------------------------------------------------------------------
// i18n
// ---------------------------------------------------------------------------

interface I18nFacts {
  file: string
  interfaceKeys: string[]
  /** The codes in `SUPPORTED_LANGUAGES` — what the UI offers, table or no table. */
  supported: string[]
  languages: { code: string; keyCount: number; missing: string[] }[]
}

/**
 * The codes in `export const SUPPORTED_LANGUAGES = [{ code: 'bg', … }, …]`.
 *
 * Read separately from `translations` on purpose. A rule that only walked the
 * tables it found could never see the interesting failure — a code the language
 * picker still offers whose table was deleted, which `t()` answers entirely in
 * English without anything failing.
 */
function supportedCodes(sf: ts.SourceFile): string[] {
  const codes: string[] = []
  visit(sf, (node) => {
    if (!ts.isVariableDeclaration(node) || !ts.isIdentifier(node.name)) return
    if (node.name.text !== 'SUPPORTED_LANGUAGES' || !node.initializer) return
    const init = ts.isAsExpression(node.initializer) ? node.initializer.expression : node.initializer
    if (!ts.isArrayLiteralExpression(init)) return
    for (const entry of init.elements) {
      if (!ts.isObjectLiteralExpression(entry)) continue
      for (const p of entry.properties) {
        if (!ts.isPropertyAssignment(p) || propName(p) !== 'code') continue
        if (ts.isStringLiteral(p.initializer)) codes.push(p.initializer.text)
      }
    }
  })
  return codes.sort()
}

function i18nFacts(): I18nFacts {
  const sf = parse(I18N_FILE)
  let interfaceKeys: string[] = []
  const languages: I18nFacts['languages'] = []

  visit(sf, (node) => {
    // `export type Translations = { … }`
    if (
      ts.isTypeAliasDeclaration(node) &&
      node.name.text === 'Translations' &&
      ts.isTypeLiteralNode(node.type)
    ) {
      interfaceKeys = node.type.members
        .map((m) => (m.name && ts.isIdentifier(m.name) ? m.name.text : null))
        .filter((n): n is string => n !== null)
    }
    // `interface Translations { … }`, should it ever be written that way
    if (ts.isInterfaceDeclaration(node) && node.name.text === 'Translations') {
      interfaceKeys = node.members
        .map((m) => (m.name && ts.isIdentifier(m.name) ? m.name.text : null))
        .filter((n): n is string => n !== null)
    }
  })

  const known = new Set(interfaceKeys)
  visit(sf, (node) => {
    if (!ts.isVariableDeclaration(node) || !ts.isIdentifier(node.name)) return
    if (node.name.text !== 'translations' || !node.initializer) return
    if (!ts.isObjectLiteralExpression(node.initializer)) return
    for (const lang of node.initializer.properties) {
      const code = propName(lang)
      if (!code || !ts.isPropertyAssignment(lang) || !ts.isObjectLiteralExpression(lang.initializer)) continue
      const keys = new Set(
        lang.initializer.properties
          .map((p) => propName(p))
          .filter((n): n is string => n !== null),
      )
      languages.push({
        code,
        keyCount: keys.size,
        missing: [...known].filter((k) => !keys.has(k)),
      })
    }
  })

  return { file: I18N_FILE, interfaceKeys, supported: supportedCodes(sf), languages }
}

// ---------------------------------------------------------------------------
// migrations
// ---------------------------------------------------------------------------

interface MigrationFacts {
  dir: string
  journalFile: string
  files: { file: string; tag: string; index: number }[]
  /**
   * The journal in file order. `when` is carried because it is the field
   * drizzle-kit actually compares — see the rule in policy/database.rego.
   */
  journal: { idx: number; tag: string; when: number }[]
}

function migrationFacts(): MigrationFacts {
  const journalFile = `${DRIZZLE_DIR}/meta/_journal.json`
  const files = walk(DRIZZLE_DIR, (rel) => rel.endsWith('.sql') && !rel.includes('/meta/'))
    .map((file) => {
      const tag = path.basename(file, '.sql')
      return { file, tag, index: Number.parseInt(tag.slice(0, 4), 10) }
    })
  const journal = exists(journalFile)
    ? (
        JSON.parse(read(journalFile)) as { entries: { idx: number; tag: string; when: number }[] }
      ).entries.map((e) => ({ idx: e.idx, tag: e.tag, when: e.when }))
    : []
  return { dir: DRIZZLE_DIR, journalFile, files, journal }
}

// ---------------------------------------------------------------------------
// YAML-sourced facts (see the note at the top of this file)
// ---------------------------------------------------------------------------

interface Located {
  file: string
  line: number
}

/** Every `key: value` pair on its own line, with the line number kept. */
function scalarLines(file: string, key: string): (Located & { value: string })[] {
  const out: (Located & { value: string })[] = []
  read(file).split('\n').forEach((raw, i) => {
    const m = new RegExp(`^\\s*-?\\s*${key}:\\s*(.+?)\\s*(?:#.*)?$`).exec(raw)
    if (!m) return
    const value = m[1].replace(/^["']|["']$/g, '')
    if (value === '' || value === '|' || value === '>') return
    out.push({ file, line: i + 1, value })
  })
  return out
}

interface ActionRef extends Located {
  uses: string
  action: string
  ref: string
  /**
   * What has to be pinned, and to what:
   *
   *  - `local`   — `./.github/actions/…`, reviewed with this repository.
   *  - `docker`  — `docker://…`, a third-party *image*, pinned by digest.
   *  - `repo`    — `owner/action@…`, a third-party repository, pinned by commit.
   *
   * `docker://` used to be filed under `local`, which read as "not ours to pin"
   * and is the opposite of the truth: it is the one form that fetches a whole
   * root filesystem from a registry, and `docker://vendor/image:latest` was
   * exempt from rule 6 entirely.
   */
  kind: 'local' | 'docker' | 'repo'
}

function actionRefs(): ActionRef[] {
  const files = [
    ...walk('.github/workflows', (rel) => /\.ya?ml$/.test(rel)),
    ...walk('.github/actions', (rel) => /\/action\.ya?ml$/.test(rel)),
  ]
  return files.flatMap((file) =>
    scalarLines(file, 'uses').map(({ line, value }) => {
      // A digest is `image@sha256:…`, a commit is `action@<sha>`; both sit after
      // the last `@`, and `docker://` carries no `@` of its own.
      const at = value.lastIndexOf('@')
      const kind = value.startsWith('./') ? 'local' : value.startsWith('docker://') ? 'docker' : 'repo'
      return {
        file,
        line,
        uses: value,
        action: at === -1 ? value : value.slice(0, at),
        ref: at === -1 ? '' : value.slice(at + 1),
        kind,
      } satisfies ActionRef
    }),
  )
}

interface ImageRef extends Located {
  image: string
  name: string
  tag: string
  /** The tag comes from a shell expansion, e.g. `${IMAGE_TAG:-latest}`. */
  interpolated: boolean
  /**
   * Where the reference was assembled. `helm` means it does not appear as an
   * `image:` scalar anywhere — the chart splits it across `repository`, `tag` and
   * `Chart.appVersion` — so the rule's message has to say which of those to edit.
   */
  origin: 'compose' | 'helm'
  /** Helm only: the chart's `tag` is empty, so the tag is `Chart.appVersion`. */
  fromChartAppVersion: boolean
}

/**
 * The image a Helm chart actually deploys.
 *
 * There is no `image:` scalar to read. `values.yaml` holds `repository` and
 * `tag` under an `image:` mapping, the deployment templates call
 * `infrashelf.<component>.image`, and `_helpers.tpl` resolves the pair as
 * `.Values.<component>.image.tag | default .Chart.AppVersion`. So an empty `tag`
 * — which is what the chart ships — silently means `Chart.appVersion`, and that
 * is `latest`. Walking `image:` scalars alone saw none of this and reported the
 * chart as clean.
 *
 * Reported against values.yaml rather than the template, because the tag is what
 * an operator edits and the fallback is what makes the empty value dangerous.
 */
function helmImageRefs(): ImageRef[] {
  const out: ImageRef[] = []
  for (const chart of walk('infra', (rel) => /\/Chart\.ya?ml$/.test(rel))) {
    const dir = path.posix.dirname(chart)
    const valuesFile = `${dir}/values.yaml`
    if (!exists(valuesFile)) continue
    const appVersion = scalarLines(chart, 'appVersion')[0]?.value ?? ''

    // `image:` opens a mapping; `repository` and `tag` are the lines under it
    // that are indented further. Same line-oriented subset as the rest of this
    // file — the point is to keep the line number the message has to print.
    const lines = read(valuesFile).split('\n')
    lines.forEach((raw, i) => {
      const opening = /^(\s*)image:\s*(?:#.*)?$/.exec(raw)
      if (!opening) return
      const indent = opening[1].length
      let repository = ''
      let tag: string | null = null
      let tagLine = i + 1
      for (let j = i + 1; j < lines.length; j++) {
        const body = lines[j]
        if (body.trim() === '' || /^\s*#/.test(body)) continue
        const width = body.length - body.trimStart().length
        if (width <= indent) break
        const m = /^\s*(\w+):\s*(.*?)\s*(?:#.*)?$/.exec(body)
        if (!m) continue
        const value = m[2].replace(/^["']|["']$/g, '')
        if (m[1] === 'repository') repository = value
        if (m[1] === 'tag') {
          tag = value
          tagLine = j + 1
        }
      }
      if (repository === '') return
      const fromChartAppVersion = tag === null || tag === ''
      const effective = fromChartAppVersion ? appVersion : (tag as string)
      out.push({
        file: valuesFile,
        line: tagLine,
        image: `${repository}:${effective}`,
        name: repository,
        tag: effective,
        interpolated: effective.includes('${'),
        origin: 'helm',
        fromChartAppVersion,
      })
    })
  }
  return out
}

function imageRefs(): ImageRef[] {
  const files = walk('infra', (rel) => /\.ya?ml$/.test(rel) && !rel.includes('/templates/'))
  const out: ImageRef[] = [...helmImageRefs()]
  for (const file of files) {
    for (const { line, value } of scalarLines(file, 'image')) {
      // `${IMAGE_TAG:-latest}` contains a colon that is not the tag separator, so
      // the split runs over a copy with every expansion blanked out. The filler is
      // written as an escape and not as a literal NUL: a raw NUL byte in the source
      // makes git, grep and ripgrep classify this file as binary and stop showing
      // its diffs.
      const masked = value.replace(/\$\{[^}]*\}/g, (m) => '\0'.repeat(m.length))
      const colon = masked.lastIndexOf(':')
      const hasTag = colon > masked.lastIndexOf('/')
      const tag = hasTag ? value.slice(colon + 1) : ''
      out.push({
        file,
        line,
        image: value,
        name: hasTag ? value.slice(0, colon) : value,
        tag,
        interpolated: tag.includes('${'),
        origin: 'compose',
        fromChartAppVersion: false,
      })
    }
  }
  return out
}

// ---------------------------------------------------------------------------
// hygiene: silenced failures and log call sites
// ---------------------------------------------------------------------------

interface SilentCatch extends Located {
  kind: string
  documented: boolean
}

/**
 * `catch {}` and `.catch(() => {})`, and whether the reason is inside the braces.
 *
 * "Documented" means a comment in the empty block itself — `catch { /* use
 * defaults *\/ }` — and nothing else. That is not a guess about style: 21 of the
 * 23 silent catches in the tree already write it that way, and it is the only
 * placement that stays attached when the code around it moves. A comment further
 * up describes the statement it sits above, which may or may not be the reason
 * this particular failure is safe to drop.
 *
 * A block holding only a comment has no statements, so these are still counted
 * as silenced — the rule is about explanation, not about whether the block is
 * literally empty.
 */
function silentCatches(): SilentCatch[] {
  const sources = [
    ...walk(`${BACKEND}/src`, (rel) => /\.tsx?$/.test(rel) && !/\.test\.tsx?$/.test(rel)),
    ...walk(`${FRONTEND}/src`, (rel) => /\.tsx?$/.test(rel) && !/\.test\.tsx?$/.test(rel)),
  ]
  const out: SilentCatch[] = []

  for (const file of sources) {
    if (!read(file).includes('catch')) continue
    const sf = parse(file)
    const explained = (block: ts.Block): boolean => /\/\/|\/\*/.test(block.getText(sf))

    visit(sf, (node) => {
      if (ts.isCatchClause(node) && node.block.statements.length === 0) {
        out.push({
          file,
          line: lineOf(sf, node),
          kind: 'catch {}',
          documented: explained(node.block),
        })
        return
      }
      if (!ts.isCallExpression(node) || calleeName(node) !== 'catch') return
      const [handler] = node.arguments
      if (!handler || !ts.isArrowFunction(handler)) return
      if (!ts.isBlock(handler.body) || handler.body.statements.length > 0) return
      out.push({
        file,
        line: lineOf(sf, node),
        kind: '.catch(() => {})',
        documented: explained(handler.body),
      })
    })
  }
  return out
}

interface ConsoleCall extends Located {
  method: string
  message: string
  /** Whether the *message* interpolates a value, rather than being fixed text. */
  messageNamesAValue: boolean
}

/**
 * `console.*` in library code, and whether its message carries a value.
 *
 * #116 is about finding the log line for one order. A message that interpolates
 * nothing can be grepped for, but never narrowed — which is the difference this
 * records.
 *
 * Only the message argument counts, and only when it interpolates. Counting *any*
 * non-literal argument made the fact true for every `console.error('… failed:', err)`
 * in the tree — an Error is not a record id, and it is exactly the argument that
 * is always there — so the rule reported nothing it was written to report.
 */
const messageNamesAValue = (arg: ts.Expression | undefined): boolean => {
  if (arg === undefined) return false
  if (ts.isTemplateExpression(arg)) return arg.templateSpans.length > 0
  // Six messages in this tree are long enough to be split across `+`, and the
  // interpolation is usually in the first fragment; treating the concatenation as
  // opaque would report every one of them.
  if (ts.isBinaryExpression(arg) && arg.operatorToken.kind === ts.SyntaxKind.PlusToken) {
    return messageNamesAValue(arg.left) || messageNamesAValue(arg.right)
  }
  if (ts.isParenthesizedExpression(arg)) return messageNamesAValue(arg.expression)
  return false
}

function consoleCalls(): ConsoleCall[] {
  const sources = [
    ...walk(`${BACKEND}/src/lib`, (rel) => /\.tsx?$/.test(rel) && !/\.test\.tsx?$/.test(rel)),
    ...walk(`${FRONTEND}/src/lib`, (rel) => /\.tsx?$/.test(rel) && !/\.test\.tsx?$/.test(rel)),
  ]
  const out: ConsoleCall[] = []
  for (const file of sources) {
    if (!read(file).includes('console.')) continue
    const sf = parse(file)
    visit(sf, (node) => {
      if (!ts.isCallExpression(node)) return
      const e = node.expression
      if (!ts.isPropertyAccessExpression(e) || e.expression.getText(sf) !== 'console') return
      const first = node.arguments[0]
      out.push({
        file,
        line: lineOf(sf, node),
        method: e.name.text,
        message: first ? first.getText(sf).split('\n')[0].slice(0, 120) : '',
        messageNamesAValue: messageNamesAValue(first),
      })
    })
  }
  return out
}

// ---------------------------------------------------------------------------

interface TestCaseFact extends Located {
  /** The test's name, as written — what the runner prints when it passes. */
  title: string
  /** Whether the body contains an assertion of any kind. */
  asserts: boolean
  /** Whether it announces itself as skipped, which is honest and not this rule's business. */
  skipped: boolean
}

/**
 * Every `it`/`test` in the repository, and whether it asserts anything.
 *
 * #154 catalogued ten e2e tests that report green having verified nothing —
 * bodies that are entirely `if (await x.isVisible()) { … }` with no `else`, a bare
 * `return` on an empty locator, a tautology like `expect(count > 0 || isEmpty)`.
 * They were found by reading every spec line by line. That is not a thing anyone
 * will do twice, and the failure mode is the worst kind: the suite gets bigger,
 * the report stays green, and the coverage is imaginary.
 *
 * This is the mechanical half of that audit. It cannot judge whether an assertion
 * is meaningful — `expect(true).toBe(true)` passes this — but "contains no
 * assertion at all" is decidable, and it is the case that actually recurs.
 *
 * A test that calls `test.skip()` is exempt: announcing that it did not run is the
 * honest behaviour this rule is trying to encourage, not the one it is trying to
 * stop. `a11y.spec.ts` already does that with a reason, and it is the pattern the
 * issue points at.
 */
const ASSERTION_CALLS = new Set(['expect', 'assert', 'expectTypeOf'])

/**
 * Calls that fail the test when the condition does not hold, without the word
 * `expect` appearing in the test body.
 *
 * Playwright's waits are assertions: `waitForURL` throws when the navigation does
 * not happen, and `dashboard.spec.ts` uses it deliberately in place of
 * `toHaveURL` because the timeout budget has to match a cold `next dev`. Counting
 * those as "asserts nothing" would report a working test as broken, and the fix
 * a reader would then apply — adding a redundant `expect` — makes the suite worse.
 */
const ASSERTING_WAITS = /^waitFor(URL|Response|Request|Selector|Event|LoadState|Function)?$/

/**
 * A helper whose name says it asserts. `expectAccessible`, `expectRealTranslations`
 * and `expectNoServerError` all contain the assertions their callers do not.
 *
 * Named-based, and deliberately so: following the call would mean resolving
 * imports across the repository, and a convention this consistent is cheaper to
 * rely on than to verify. The cost of being wrong is a missed empty test, not a
 * false accusation.
 */
const ASSERTING_HELPER = /^(expect|assert)[A-Z]/

interface UnscopedAlertFact extends Located {
  /** The expression as written, so the message can quote it. */
  text: string
}

/**
 * `page.getByRole('alert')` in an e2e spec — which can never resolve to one
 * element in this application.
 *
 * Next's App Router renders `<div role="alert" id="__next-route-announcer__">`
 * into every page to announce client-side navigations. It is empty, it is
 * always present, and it means a document-level alert query is a strict mode
 * violation waiting for the first test that reaches it — reported as
 * "resolved to 2 elements" rather than as anything about the alert.
 *
 * It cost a real debugging session on the costs dashboard, and it will cost the
 * next person the same, because the failure names the locator and not the
 * cause. `pageAlerts(page)` in `e2e/helpers.ts` excludes the announcer.
 *
 * Only the `page.`-rooted form is reported. `dialog.getByRole('alert')` and
 * `.filter({ hasText: … })` are already scoped and are how the two legitimate
 * uses in this suite are written.
 */
function unscopedAlertQueries(): UnscopedAlertFact[] {
  const out: UnscopedAlertFact[] = []
  for (const file of walk('e2e', (rel) => /\.spec\.ts$/.test(rel))) {
    const lines = read(file).split('\n')
    lines.forEach((line, i) => {
      if (!/\bpage\.getByRole\(\s*['"]alert['"]\s*\)/.test(line)) return
      // A `.filter(...)` immediately after narrows it to one, which is fine.
      if (/getByRole\(\s*['"]alert['"]\s*\)\s*\.filter\(/.test(line)) return
      out.push({ file, line: i + 1, text: line.trim().slice(0, 120) })
    })
  }
  return out
}

interface SkipCallFact extends Located {
  /** The call as written, so the message can quote the line a reader must edit. */
  text: string
  /** Whether a reason was given — a string the runner will print in the report. */
  hasReason: boolean
}

/**
 * Every in-body `test.skip(…)` in the e2e suite, and whether it says why.
 *
 * Rule 13 exempts a test that skips, on the grounds that announcing it did not
 * run is the honest behaviour. That exemption is load-bearing and it is
 * currently being spent on the opposite: ~70 of the skips in this suite are a
 * bare `test.skip()` conditioned on what a page shows —
 * `if (await noProducts.isVisible()) { test.skip(); return }` — which announces
 * nothing at all. The report says a test was skipped and cannot say whether that
 * was "no demo data locally" or "the catalogue page is throwing 500s".
 *
 * Since #285 the shards seed the database before they run, so in CI the second
 * reading is the likely one, and it is reported as a skip either way (#332).
 * That is the exact shape #322 had to fix in `provisioning.spec.ts`, where a
 * refused order — the regression the test existed for — came back green.
 *
 * Only in-body calls. `test.skip('a title', async () => {…})` DECLARES a skipped
 * test, and its string is a title rather than a reason; those are recognised by
 * carrying a function argument and are left alone. `test.skip(condition)` with
 * no message counts as unreasoned, because the report is the same as a bare one.
 */
function skipCalls(): SkipCallFact[] {
  const out: SkipCallFact[] = []
  for (const file of walk('e2e', (rel) => /\.spec\.ts$/.test(rel))) {
    const sf = parse(file)
    visit(sf, (node) => {
      if (!ts.isCallExpression(node)) return
      const fn = node.expression
      if (!ts.isPropertyAccessExpression(fn) || fn.name.text !== 'skip') return
      // `test.skip(…)` and `this.skip(…)`. A `page.skip()` does not exist, but
      // naming the two receivers keeps an unrelated `.skip` out of the facts.
      const receiver = ts.isIdentifier(fn.expression)
        ? fn.expression.text
        : fn.expression.kind === ts.SyntaxKind.ThisKeyword
          ? 'this'
          : null
      if (receiver !== 'test' && receiver !== 'this') return

      // The declaration form, whose string is the test's title.
      if (node.arguments.some((a) => ts.isArrowFunction(a) || ts.isFunctionExpression(a))) return

      out.push({
        file,
        line: lineOf(sf, node),
        text: node.getText(sf).replace(/\s+/g, ' ').slice(0, 120),
        hasReason: node.arguments.some((a) => ts.isStringLiteralLike(a) && a.text.trim() !== ''),
      })
    })
  }
  return out
}

function testCases(): TestCaseFact[] {
  const files = [
    ...walk('e2e', (rel) => /\.spec\.ts$/.test(rel)),
    ...walk(`${BACKEND}/src`, (rel) => /\.test\.tsx?$/.test(rel)),
    ...walk(`${FRONTEND}/src`, (rel) => /\.test\.tsx?$/.test(rel)),
  ]

  const out: TestCaseFact[] = []
  for (const file of files) {
    const sf = parse(file)

    // Helpers defined in this file that assert.
    //
    // `qr.test.ts` has `roundTrip(text, ecc)`, whose body is nothing but
    // assertions, and two of its tests are a loop around a call to it. Reporting
    // those as "asserts nothing" would be wrong, and the fix a reader would apply
    // — inlining the helper, or adding a redundant `expect` — makes the suite
    // worse. So the assertions of a local helper count for its callers.
    //
    // One level, and only within the file: following imports would mean resolving
    // the module graph, and a test whose assertions are two helpers deep in
    // another file is rare enough to be worth a false positive rather than that
    // machinery.
    const assertingHelpers = new Set<string>()
    visit(sf, (node) => {
      let name: string | null = null
      let body: ts.Node | undefined
      if (ts.isFunctionDeclaration(node) && node.name) {
        name = node.name.text
        body = node.body
      } else if (
        ts.isVariableDeclaration(node) &&
        ts.isIdentifier(node.name) &&
        node.initializer &&
        (ts.isArrowFunction(node.initializer) || ts.isFunctionExpression(node.initializer))
      ) {
        name = node.name.text
        body = node.initializer.body
      }
      if (!name || !body) return

      let found = false
      visit(body, (inner) => {
        if (!ts.isCallExpression(inner)) return
        const fn = inner.expression
        if (ts.isIdentifier(fn) && (ASSERTION_CALLS.has(fn.text) || ASSERTING_HELPER.test(fn.text))) {
          found = true
        }
        if (
          ts.isPropertyAccessExpression(fn) &&
          ts.isIdentifier(fn.expression) &&
          ASSERTION_CALLS.has(fn.expression.text)
        ) {
          found = true
        }
      })
      if (found) assertingHelpers.add(name)
    })
    visit(sf, (node) => {
      if (!ts.isCallExpression(node)) return
      const callee = node.expression
      // `it(...)` / `test(...)`, but not `it.each(...)(...)` — that one is a call
      // whose callee is itself a call, and the inner body is reached anyway.
      const name = ts.isIdentifier(callee)
        ? callee.text
        : ts.isPropertyAccessExpression(callee) && ts.isIdentifier(callee.expression)
          ? callee.expression.text
          : null
      if (name !== 'it' && name !== 'test') return

      // `test.describe`, `test.beforeEach`, `test.use` and friends are also
      // `test.<something>(…)`, and counting them as tests reported thirty-nine
      // "tests that assert nothing" of which most were hooks. Only the modifiers
      // that still declare a test case count.
      if (ts.isPropertyAccessExpression(callee)) {
        const modifier = callee.name.text
        if (!/^(only|skip|todo|fixme|failing|fails|concurrent|sequential|each|for)$/.test(modifier)) {
          return
        }
      }

      // `it.skip` / `test.skip` declares itself; so does a `test.skip()` inside.
      const declaredSkip =
        ts.isPropertyAccessExpression(callee) && /^(skip|todo|fixme)$/.test(callee.name.text)

      const title = node.arguments[0] && ts.isStringLiteralLike(node.arguments[0])
        ? node.arguments[0].text
        : ''
      const body = node.arguments.find((a) => ts.isArrowFunction(a) || ts.isFunctionExpression(a))
      if (!body) return

      let asserts = false
      let skipsInside = false
      visit(body, (inner) => {
        if (!ts.isCallExpression(inner)) return
        const fn = inner.expression
        if (
          ts.isIdentifier(fn) &&
          (ASSERTION_CALLS.has(fn.text) ||
            ASSERTING_HELPER.test(fn.text) ||
            assertingHelpers.has(fn.text))
        ) {
          asserts = true
        }
        if (ts.isPropertyAccessExpression(fn)) {
          // `test.skip()` / `this.skip()` — declaring that it did not run.
          if (fn.name.text === 'skip') skipsInside = true
          // `expect(x).toBe(y)` — the callee is a property access on the call.
          if (ts.isIdentifier(fn.expression) && ASSERTION_CALLS.has(fn.expression.text)) asserts = true
          // `page.waitForURL(…)` and friends, which throw on failure.
          if (ASSERTING_WAITS.test(fn.name.text)) asserts = true
        }
      })

      out.push({
        file,
        line: lineOf(sf, node),
        title,
        asserts,
        skipped: declaredSkip || skipsInside,
      })
    })
  }
  return out
}

// ---------------------------------------------------------------------------
// pages and the accessibility gate
// ---------------------------------------------------------------------------

const APP_DIR = `${FRONTEND}/src/app`
const A11Y_SPEC = 'e2e/a11y.spec.ts'

/** The arrays in `e2e/a11y.spec.ts` that axe is actually pointed at. */
const A11Y_PATH_ARRAYS = new Set(['PUBLIC_PAGES', 'AUTHED_PAGES', 'DETAIL_PAGES'])

/**
 * The URL path a `page.tsx` answers on.
 *
 * Next.js route groups — the `(dashboard)` and `(auth)` directories — organise
 * files without appearing in the URL, so they are stripped. Parallel and
 * intercepting routes (`@slot`, `(.)`) do not exist in this tree; if they ever
 * do, they belong here too.
 */
const routePathOfPage = (rel: string): string => {
  const segments = rel
    .slice(`${APP_DIR}/`.length, -'/page.tsx'.length)
    .split('/')
    .filter((seg) => seg !== '' && !(seg.startsWith('(') && seg.endsWith(')')))
  return segments.length === 0 ? '/' : `/${segments.join('/')}`
}

interface PageFact {
  file: string
  routePath: string
  /** A `[id]`-style segment: no single static URL reaches this page. */
  dynamic: boolean
  inA11ySpec: boolean
}

/**
 * Every page in the frontend, and whether the axe gate visits it.
 *
 * The gate is a hand-written list of paths, so a page added without touching
 * that list is never checked and nothing says so — the suite still reports the
 * same number of green a11y assertions it did before the page existed.
 */
function pageFacts(): PageFact[] {
  const pages = walk(APP_DIR, (rel) => rel.endsWith('/page.tsx'))
  if (pages.length === 0) return []

  const covered = new Set<string>()
  if (exists(A11Y_SPEC)) {
    const sf = parse(A11Y_SPEC)
    visit(sf, (node) => {
      if (!ts.isVariableDeclaration(node)) return
      if (!ts.isIdentifier(node.name) || !A11Y_PATH_ARRAYS.has(node.name.text)) return
      if (!node.initializer || !ts.isArrayLiteralExpression(node.initializer)) return
      for (const element of node.initializer.elements) {
        if (ts.isStringLiteral(element)) covered.add(element.text)
      }
    })
  }

  return pages.map((file) => {
    const routePath = routePathOfPage(file)
    return {
      file,
      routePath,
      dynamic: routePath.includes('['),
      inA11ySpec: covered.has(routePath),
    }
  })
}

// ---------------------------------------------------------------------------
// lists that are declared more than once
// ---------------------------------------------------------------------------

/**
 * The declarations that are copies of one list of language codes.
 *
 * Named explicitly rather than discovered, because "an array of two-letter
 * strings" matches half a dozen unrelated things in this tree — the four
 * base-language options on the product forms among them, which are deliberately
 * *not* the 25. A registry is also the only shape that can notice a copy being
 * renamed away: an entry that resolves to nothing is reported, where a search
 * would simply find one fewer list and compare the rest happily.
 *
 * Add a row here when a third copy appears; do not add one for a list that is
 * allowed to differ.
 */
const LANGUAGE_LIST_DECLARATIONS: { file: string; symbol: string; what: string }[] = [
  { file: I18N_FILE, symbol: 'SUPPORTED_LANGUAGES', what: 'the language picker' },
  { file: `${BACKEND}/src/lib/ai/index.ts`, symbol: 'LANGUAGES', what: 'the AI translation prompt' },
]

interface DeclaredList {
  file: string
  line: number
  symbol: string
  what: string
  /** False when the registry names a declaration this tree no longer has. */
  found: boolean
  codes: string[]
}

/**
 * The string codes in `const X = [...]`, for both shapes this repo writes:
 * `['de', 'en']` and `[{ code: 'de', name: 'Deutsch' }]`.
 */
function codesInDeclaration(sf: ts.SourceFile, symbol: string): { line: number; codes: string[] } | null {
  let found: { line: number; codes: string[] } | null = null
  visit(sf, (node) => {
    if (found !== null) return
    if (!ts.isVariableDeclaration(node) || !ts.isIdentifier(node.name)) return
    if (node.name.text !== symbol || !node.initializer) return
    const init = ts.isAsExpression(node.initializer) ? node.initializer.expression : node.initializer
    if (!ts.isArrayLiteralExpression(init)) return

    const codes: string[] = []
    for (const element of init.elements) {
      if (ts.isStringLiteral(element)) {
        codes.push(element.text)
        continue
      }
      if (!ts.isObjectLiteralExpression(element)) continue
      for (const p of element.properties) {
        if (!ts.isPropertyAssignment(p) || propName(p) !== 'code') continue
        if (ts.isStringLiteral(p.initializer)) codes.push(p.initializer.text)
      }
    }
    found = { line: lineOf(sf, node), codes: [...new Set(codes)].sort() }
  })
  return found
}

/**
 * Every hand-maintained copy of the supported-language list.
 *
 * The 25 codes exist twice: the frontend picker and the backend's translation
 * prompt, which asks the model for "exactly these 25 languages". Nothing links
 * the two, so adding a language to one of them produces a picker entry whose
 * translations are never requested, or a prompt that spends tokens on a language
 * nobody can select. Neither fails anything.
 */
function languageListFacts(): DeclaredList[] {
  return LANGUAGE_LIST_DECLARATIONS.map(({ file, symbol, what }) => {
    if (!exists(file)) return { file, line: 0, symbol, what, found: false, codes: [] }
    const declaration = codesInDeclaration(parse(file), symbol)
    if (declaration === null) return { file, line: 0, symbol, what, found: false, codes: [] }
    return { file, line: declaration.line, symbol, what, found: true, codes: declaration.codes }
  })
}

// ---------------------------------------------------------------------------
// the two ESLint flat configs
// ---------------------------------------------------------------------------

const ESLINT_CONFIGS = [`${BACKEND}/eslint.config.mjs`, `${FRONTEND}/eslint.config.mjs`]

interface EslintConfigFact {
  file: string
  /** False when one of the two configs has been deleted or renamed away. */
  found: boolean
  /** Every `rules: { … }` entry in the file, flattened and sorted by name. */
  rules: { name: string; value: string; line: number }[]
}

/** Source text with runs of whitespace collapsed, so formatting is not a diff. */
const normalised = (sf: ts.SourceFile, node: ts.Node): string =>
  node.getText(sf).replace(/\s+/g, ' ').trim()

/**
 * The rule blocks of both flat configs.
 *
 * Read as TypeScript because a flat config is a module, not data: the entries
 * are spread out over several config objects and a regex over `"rule": value`
 * would also match the paragraph-long comments that explain each choice.
 *
 * Flattened across the config objects rather than kept per block, because that
 * is how ESLint resolves them — later blocks win — and because the two files
 * only have to agree on the resulting rule set, not on how it is arranged.
 *
 * Every `rules:` property is collected, wherever it sits. Over-collecting is the
 * safe direction: a rule the extractor should not have read still has to appear
 * in both files, and a shape-based filter would be the thing that quietly
 * stopped reading the block someone rearranged.
 */
function eslintConfigFacts(): EslintConfigFact[] {
  return ESLINT_CONFIGS.map((file) => {
    if (!exists(file)) return { file, found: false, rules: [] }
    const sf = ts.createSourceFile(file, read(file), ts.ScriptTarget.Latest, true, ts.ScriptKind.JS)
    const rules = new Map<string, { name: string; value: string; line: number }>()
    visit(sf, (node) => {
      if (!ts.isPropertyAssignment(node) || propName(node) !== 'rules') return
      if (!ts.isObjectLiteralExpression(node.initializer)) return
      for (const entry of node.initializer.properties) {
        const name = propName(entry)
        if (name === null || !ts.isPropertyAssignment(entry)) continue
        rules.set(name, { name, value: normalised(sf, entry.initializer), line: lineOf(sf, entry) })
      }
    })
    return { file, found: true, rules: [...rules.values()].sort((a, b) => a.name.localeCompare(b.name)) }
  })
}

// ---------------------------------------------------------------------------
// environment variables
// ---------------------------------------------------------------------------

/**
 * Variables every process has, which no operator has to be told to set. An
 * exemption list rather than a prefix rule: each entry is a decision, and a
 * shape-based exemption would quietly cover the next variable that happens to
 * look like one of these.
 */
const AMBIENT_ENV_VARS = new Set(['NODE_ENV'])

/**
 * The filename, used three times: the root file is the whole-stack reference an
 * operator deploying this reads, and `apps/<app>/.env.example` is the one
 * actually loaded in development.
 */
const ENV_EXAMPLE = '.env.example'

interface EnvRead {
  name: string
  file: string
  line: number
  /** `apps/backend` or `apps/frontend` — which per-app example must list it. */
  app: string
}

interface EnvExampleFact {
  file: string
  keys: { name: string; line: number }[]
  /** Keys assigned more than once: the last assignment silently wins. */
  duplicates: { name: string; line: number; firstLine: number }[]
}

/**
 * Every `process.env.NAME` and `process.env['NAME']` in shipped application
 * code.
 *
 * Test files are excluded on purpose. `.env.example` documents what an operator
 * has to set to run the product; a variable a fixture invents is not that, and
 * including tests would make the rule report `process.env.X = 'y'` writes as if
 * they were configuration.
 *
 * Computed names — `process.env[name]` inside a helper, which is how
 * `lib/auth/sessions.ts` reads the two session TTLs — are not extracted. They
 * cannot be resolved without a type checker, and a rule that guessed at them
 * would report a variable that is documented and read as undocumented. The cost
 * is that those reads are invisible here, which is under-coverage rather than a
 * false positive.
 */
function envReads(): EnvRead[] {
  const out: EnvRead[] = []
  for (const app of [BACKEND, FRONTEND]) {
    const files = walk(`${app}/src`, (rel) =>
      /\.tsx?$/.test(rel) && !/\.test\.tsx?$/.test(rel))
    for (const file of files) {
      const sf = parse(file)
      visit(sf, (node) => {
        // `process.env.NAME`
        if (
          ts.isPropertyAccessExpression(node) &&
          ts.isPropertyAccessExpression(node.expression) &&
          ts.isIdentifier(node.expression.expression) &&
          node.expression.expression.text === 'process' &&
          node.expression.name.text === 'env' &&
          ts.isIdentifier(node.name)
        ) {
          out.push({ name: node.name.text, file, line: lineOf(sf, node), app })
        }
        // `process.env['NAME']`
        if (
          ts.isElementAccessExpression(node) &&
          ts.isPropertyAccessExpression(node.expression) &&
          ts.isIdentifier(node.expression.expression) &&
          node.expression.expression.text === 'process' &&
          node.expression.name.text === 'env' &&
          ts.isStringLiteral(node.argumentExpression)
        ) {
          out.push({ name: node.argumentExpression.text, file, line: lineOf(sf, node), app })
        }
      })
    }
  }
  return out.filter((r) => !AMBIENT_ENV_VARS.has(r.name))
}

/** The assignments in one `.env.example`, and any key assigned twice. */
function envExampleFacts(): EnvExampleFact[] {
  const files = [ENV_EXAMPLE, `${BACKEND}/${ENV_EXAMPLE}`, `${FRONTEND}/${ENV_EXAMPLE}`]
  return files.filter(exists).map((file) => {
    const keys: { name: string; line: number }[] = []
    const duplicates: { name: string; line: number; firstLine: number }[] = []
    const firstSeen = new Map<string, number>()
    read(file).split('\n').forEach((raw, i) => {
      const m = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=/.exec(raw)
      if (!m) return
      const line = i + 1
      const first = firstSeen.get(m[1])
      if (first === undefined) firstSeen.set(m[1], line)
      else duplicates.push({ name: m[1], line, firstLine: first })
      keys.push({ name: m[1], line })
    })
    return { file, keys, duplicates }
  })
}

// ---------------------------------------------------------------------------
// what a migration does to an existing table
// ---------------------------------------------------------------------------

interface MigrationColumnFact {
  file: string
  line: number
  table: string
  column: string
  /** `add` for ADD COLUMN, `setNotNull` for ALTER COLUMN … SET NOT NULL. */
  kind: 'add' | 'setNotNull'
  notNull: boolean
  /** A DEFAULT, or an IDENTITY/GENERATED clause, which supplies one. */
  hasDefault: boolean
  /** An earlier statement in the same file that gives existing rows a value. */
  backfilled: boolean
}

/**
 * Comments blanked out, newlines kept, so an offset still maps to a line.
 *
 * Necessary rather than tidy: every migration in this tree opens with a
 * paragraph of prose explaining the change, and those paragraphs contain the
 * words this extractor looks for — "NOT NULL", "DEFAULT", the column names.
 *
 * String literals are not tracked, so a `;` or a `--` inside one would split a
 * statement in the wrong place. No migration here has either, and the failure
 * mode is a statement the rule cannot read rather than one it misreads: the
 * halves stop matching ADD COLUMN and produce no fact.
 */
function stripSqlComments(sql: string): string {
  const blank = (text: string): string => text.replace(/[^\n]/g, ' ')
  return sql
    .replace(/\/\*[\s\S]*?\*\//g, blank)
    .replace(/--[^\n]*/g, blank)
}

const lineAt = (text: string, offset: number): number =>
  text.slice(0, offset).split('\n').length

/**
 * Columns that migrations add to, or constrain on, tables that already exist.
 *
 * `CREATE TABLE` is deliberately not read: a table being created is empty, so
 * every NOT NULL in it is free. The failure this exists to catch only happens to
 * a table with rows in it, and Postgres reports it as
 * `column "x" contains null values` — at deploy time, on the one database that
 * has data, after the migration has already been merged and released.
 */
function migrationColumnFacts(): MigrationColumnFact[] {
  const out: MigrationColumnFact[] = []
  for (const file of walk(DRIZZLE_DIR, (rel) => rel.endsWith('.sql') && !rel.includes('/meta/'))) {
    const sql = stripSqlComments(read(file))

    // Statements in order, with the offset each one starts at, so a backfill can
    // be recognised as something that happens BEFORE the constraint.
    const statements: { text: string; offset: number }[] = []
    let cursor = 0
    for (const chunk of sql.split(';')) {
      statements.push({ text: chunk, offset: cursor })
      cursor += chunk.length + 1
    }

    /** Columns an earlier statement has already given every row a value for. */
    const valued = new Set<string>()

    for (const { text, offset } of statements) {
      const table = /\bALTER\s+TABLE\s+(?:IF\s+EXISTS\s+)?"?([\w.]+)"?/i.exec(text)?.[1] ?? ''

      for (const m of text.matchAll(
        /\bADD\s+COLUMN\s+(?:IF\s+NOT\s+EXISTS\s+)?"?([A-Za-z_]\w*)"?([\s\S]*?)(?=,\s*(?:ADD|ALTER|DROP)\b|$)/gi,
      )) {
        const definition = m[2]
        const hasDefault =
          /\bDEFAULT\b/i.test(definition) || /\bGENERATED\b/i.test(definition)
        out.push({
          file,
          line: lineAt(sql, offset + (m.index ?? 0)),
          table,
          column: m[1],
          kind: 'add',
          notNull: /\bNOT\s+NULL\b/i.test(definition),
          hasDefault,
          backfilled: false,
        })
        if (hasDefault) valued.add(m[1])
      }

      for (const m of text.matchAll(
        /\bALTER\s+COLUMN\s+"?([A-Za-z_]\w*)"?\s+SET\s+NOT\s+NULL\b/gi,
      )) {
        out.push({
          file,
          line: lineAt(sql, offset + (m.index ?? 0)),
          table,
          column: m[1],
          kind: 'setNotNull',
          notNull: true,
          hasDefault: false,
          backfilled: valued.has(m[1]),
        })
      }

      // `UPDATE t SET "col" = …` — the backfill 0004 does before it constrains.
      if (/^\s*UPDATE\b/i.test(text)) {
        for (const m of text.matchAll(/"?([A-Za-z_]\w*)"?\s*=/g)) valued.add(m[1])
      }
    }
  }
  return out
}

// ---------------------------------------------------------------------------
// hardcoded user-facing text
// ---------------------------------------------------------------------------

interface HardcodedTextFact {
  file: string
  line: number
  /** 'text' for a JSX child, '@label' etc. for an attribute. */
  kind: string
  text: string
}

/**
 * JSX attributes whose string value is read out to a person rather than to the
 * machine. `className`, `href`, `id`, `name`, `type` and friends are absent on
 * purpose — those are markup, not prose.
 */
const TEXT_ATTRS = new Set([
  'label', 'placeholder', 'title', 'hint', 'alt', 'aria-label',
  'emptyMessage', 'confirmLabel', 'summary',
])

/**
 * Prose, as opposed to a value something downstream consumes verbatim.
 *
 * Every exclusion below was put there by a false positive found while counting
 * this against `dev`, and each one is a category rather than a special case:
 * codes the pipeline reads (`EUR`, `SIZE`, `REGION=eu-central`), paths and
 * templates (`linode/virtual-machine`), format examples the field is showing
 * the shape of (`smtp.example.com`, `you@example.com`), and single glyphs
 * (`&ldquo;`). Getting this wrong in the permissive direction costs a missed
 * string; getting it wrong the other way makes the gate cry wolf, which is
 * worse, so the doubtful cases are excluded.
 */
function isUserFacingProse(raw: string, kind: string): boolean {
  const s = raw.trim()
  if (s.length < 2) return false
  if (!/[A-Za-z]{2}/.test(s)) return false
  if (/^[A-Z0-9_]+$/.test(s)) return false
  if (/[/\\]|:\/\/|^\.|\{|\}/.test(s)) return false
  if (/^&[a-z]+;$/.test(s)) return false
  if (/^\S+@\S+\.\S+$/.test(s)) return false
  if (/^[a-z0-9.-]+\.[a-z]{2,}$/i.test(s)) return false
  if (/^[A-Z][A-Z0-9_]*=/.test(s)) return false

  // Casing tells a variable name from a word — `hostname`, `-vm`, `instanceType`
  // against `save`, `cancel` — and it tells them apart badly: both shapes are
  // lowercase. So it is applied ONLY to `placeholder`, which is where this app
  // shows the SHAPE of a value rather than saying something.
  //
  // Review of this PR was right to push on it. Applied everywhere, the rule hid
  // a genuine defect: `{t('orderedBy')} {name} on {date}` in the approvals list,
  // where `on` is a hardcoded English word in the middle of a translated
  // sentence. In JSX text and in `label`, a lowercase word is a word.
  if (kind === '@placeholder') {
    if (/^[a-z]+([A-Z][a-z]+)+$/.test(s)) return false
    if (/^[a-z-]+$/.test(s) && !s.includes(' ')) return false
  }
  return true
}

function hardcodedTextFacts(): HardcodedTextFact[] {
  const out: HardcodedTextFact[] = []
  const files = walk(`${FRONTEND}/src`, (rel) => rel.endsWith('.tsx') && !rel.includes('.test.'))

  for (const rel of files) {
    const sf = parse(rel)
    visit(sf, (node) => {
      if (ts.isJsxText(node)) {
        const text = node.text.replace(/\s+/g, ' ').trim()
        if (isUserFacingProse(text, 'text')) out.push({ file: rel, line: lineOf(sf, node), kind: 'text', text })
        return
      }
      // `<span>{'Saved.'}</span>` — a literal wrapped in braces is still a
      // literal, and the plain-text branch above never sees it. Caught in review
      // of this PR: without this the rule is one pair of braces away from being
      // bypassed, deliberately or by habit.
      if (ts.isJsxExpression(node)) {
        const inner = node.expression
        if (!inner) return
        if (!ts.isStringLiteral(inner) && !ts.isNoSubstitutionTemplateLiteral(inner)) return
        // An expression-valued ATTRIBUTE is only interesting for the attributes
        // that are spoken; `className={'x'}` is not.
        const attribute = ts.isJsxAttribute(node.parent) ? node.parent.name.getText(sf) : null
        if (attribute !== null && !TEXT_ATTRS.has(attribute)) return
        if (isUserFacingProse(inner.text, attribute === null ? 'text' : `@${attribute}`)) {
          out.push({
            file: rel,
            line: lineOf(sf, node),
            kind: attribute === null ? 'text' : `@${attribute}`,
            text: inner.text,
          })
        }
        return
      }

      if (!ts.isJsxAttribute(node)) return
      const name = node.name.getText(sf)
      if (!TEXT_ATTRS.has(name)) return
      // Only a bare string literal. `label={t('name', lang)}` is an expression
      // and is exactly what this rule is asking for. The braced-literal form is
      // handled above.
      if (!node.initializer || !ts.isStringLiteral(node.initializer)) return
      if (isUserFacingProse(node.initializer.text, `@${name}`)) {
        out.push({ file: rel, line: lineOf(sf, node), kind: `@${name}`, text: node.initializer.text })
      }
    })
  }
  return out
}

// ---------------------------------------------------------------------------
// server-only modules in the client bundle
// ---------------------------------------------------------------------------

interface ClientImportFact {
  file: string
  line: number
  module: string
}

/**
 * Modules that must never be reachable from a client component.
 *
 * `lib/serverApi.ts` statically imports `@/lib/auth`, so a client component
 * importing it pulls the whole NextAuth server configuration into the browser
 * bundle — which is how the strings `auth/login/mfa` and `NEXTAUTH_SECRET` got
 * into the built client chunks once already (#146).
 */
const SERVER_ONLY_MODULES = ['@/lib/serverApi', '@/lib/auth']

/**
 * Files that declare 'use client' and import one of those.
 *
 * The runtime guard inside `serverApi` cannot catch this: the import is resolved
 * at build time, so by the time any code runs the damage is in the bundle. Only
 * reading the imports catches it, and only before the build.
 */
/**
 * Whether the file opens with the 'use client' directive.
 *
 * Asked of the AST rather than of the text. A directive prologue is defined as
 * leading expression statements whose expression is a string literal, so the
 * parser has already dealt with the parts that make this awkward to match:
 * comments above it are not statements at all, and a `'use client'` further down
 * the file is an ordinary expression rather than a directive.
 *
 * It also avoids a regex over the whole prelude. The first version of this was
 * one, and CodeQL was right about it: alternation with a nested quantifier over
 * comment syntax backtracks exponentially on a file full of `*\/\/*`.
 */
function hasUseClientDirective(sf: ts.SourceFile): boolean {
  for (const statement of sf.statements) {
    if (!ts.isExpressionStatement(statement)) return false
    const expr = statement.expression
    if (!ts.isStringLiteral(expr) && !ts.isNoSubstitutionTemplateLiteral(expr)) return false
    if (expr.text === 'use client') return true
    // Another directive ('use strict', …) — keep looking through the prologue.
  }
  return false
}

interface SwallowedRedirectFact extends Located {
  /** `try/catch` or `.catch(...)` — what shape the swallow takes. */
  kind: string
  /** The serverApi call inside it, so the message can name what is at risk. */
  call: string
}

/**
 * A catch around a `@/lib/serverApi` call that does not rethrow Next's control
 * flow.
 *
 * `serverApi` signals an ended session by THROWING a `redirect()` (#427), which
 * is how Next signals `redirect()` and `notFound()` generally. So a `catch` that
 * exists to tolerate a failed fetch also eats the navigation: a signed-out user
 * pressing Back got "project not found" for a project that exists, and eleven
 * other pages quietly rendered defaults instead of the login screen (#434).
 *
 * This is the third time the same hazard has cost something — `Promise.allSettled`
 * in #415, `Promise.race` in #399, `try/catch` in #434 — and the first two were
 * each fixed once and then re-learned. `unstable_rethrow(e)` as the first line of
 * the catch is the whole remedy; this rule is here so it is structural rather
 * than remembered.
 *
 * Only server files: a client component's `get` comes from `@/lib/api`, which
 * ends the session in the browser instead and throws nothing.
 */
function swallowedRedirects(): SwallowedRedirectFact[] {
  const out: SwallowedRedirectFact[] = []
  const files = walk(`${FRONTEND}/src`, (rel) =>
    /\.tsx?$/.test(rel) && !/\.test\.tsx?$/.test(rel))

  for (const rel of files) {
    const text = read(rel)
    if (!text.includes('@/lib/serverApi')) continue
    const sf = parse(rel)
    if (hasUseClientDirective(sf)) continue

    // What this file imported from serverApi — `get`, `post`, `put`, `del`, or
    // whatever they were renamed to at the import site.
    const serverCalls = new Set<string>()
    for (const statement of sf.statements) {
      if (!ts.isImportDeclaration(statement)) continue
      if (!ts.isStringLiteral(statement.moduleSpecifier)) continue
      if (statement.moduleSpecifier.text !== '@/lib/serverApi') continue
      const named = statement.importClause?.namedBindings
      if (named && ts.isNamedImports(named)) {
        for (const el of named.elements) serverCalls.add(el.name.text)
      }
    }
    if (serverCalls.size === 0) continue

    /** The first serverApi call inside a node, if there is one. */
    const callInside = (node: ts.Node): string | null => {
      let found: string | null = null
      visit(node, (n) => {
        if (found) return
        if (ts.isCallExpression(n)) {
          const name = calleeName(n)
          if (name && serverCalls.has(name)) found = name
        }
      })
      return found
    }
    const rethrows = (node: ts.Node): boolean => /unstable_rethrow\s*\(/.test(node.getText(sf))

    visit(sf, (node) => {
      if (ts.isTryStatement(node) && node.catchClause) {
        const call = callInside(node.tryBlock)
        if (call && !rethrows(node.catchClause.block)) {
          out.push({ file: rel, line: lineOf(sf, node.catchClause), kind: 'try/catch', call })
        }
        return
      }
      if (!ts.isCallExpression(node) || calleeName(node) !== 'catch') return
      if (!ts.isPropertyAccessExpression(node.expression)) return
      const call = callInside(node.expression.expression)
      const [handler] = node.arguments
      if (!call || !handler) return
      if (rethrows(handler)) return
      out.push({ file: rel, line: lineOf(sf, node), kind: '.catch(...)', call })
    })
  }
  return out
}

function clientImportFacts(): ClientImportFact[] {
  const out: ClientImportFact[] = []
  const files = walk(`${FRONTEND}/src`, (rel) =>
    (rel.endsWith('.tsx') || rel.endsWith('.ts')) && !rel.includes('.test.'))

  for (const rel of files) {
    const sf = parse(rel)
    if (!hasUseClientDirective(sf)) continue

    for (const statement of sf.statements) {
      if (!ts.isImportDeclaration(statement)) continue
      if (!ts.isStringLiteral(statement.moduleSpecifier)) continue
      const spec = statement.moduleSpecifier.text
      if (!SERVER_ONLY_MODULES.includes(spec)) continue
      // A type-only import is erased before it reaches the bundle.
      if (statement.importClause?.isTypeOnly) continue
      out.push({ file: rel, line: lineOf(sf, statement), module: spec })
    }
  }
  return out
}

export function collectFacts(): Record<string, unknown> {
  const testImports = routeTestImports()
  const tables = tableFacts()
  const secretProperties = new Set(tables.flatMap((t) => t.secretColumns.map((c) => c.property)))

  return {
    repo: path.basename(REPO_ROOT),
    routes: routeFacts(testImports),
    tables,
    testSetupFile: TEST_SETUP_FILE,
    schemaFile: SCHEMA_FILE,
    secretColumns: SECRET_SQL_COLUMNS,
    selects: selectFacts(secretProperties),
    i18n: i18nFacts(),
    hardcodedText: hardcodedTextFacts(),
    migrations: migrationFacts(),
    actionRefs: actionRefs(),
    imageRefs: imageRefs(),
    silentCatches: silentCatches(),
    consoleCalls: consoleCalls(),
    testCases: testCases(),
    skipCalls: skipCalls(),
    unscopedAlertQueries: unscopedAlertQueries(),
    pages: pageFacts(),
    clientImports: clientImportFacts(),
    swallowedRedirects: swallowedRedirects(),
    a11ySpecFile: A11Y_SPEC,
    languageLists: languageListFacts(),
    eslintConfigs: eslintConfigFacts(),
    envReads: envReads(),
    envExamples: envExampleFacts(),
    envExampleFile: ENV_EXAMPLE,
    migrationColumns: migrationColumnFacts(),
  }
}

// Run as a script it prints the bundle; imported by scripts/policy-check.ts it
// only exports collectFacts().
if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(import.meta.filename)) {
  const json = `${JSON.stringify(collectFacts(), null, 2)}\n`
  const outFlag = process.argv.indexOf('--out')
  if (outFlag !== -1 && process.argv[outFlag + 1]) fs.writeFileSync(process.argv[outFlag + 1], json)
  else process.stdout.write(json)
}
