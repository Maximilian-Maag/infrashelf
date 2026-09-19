import { listFiles, getFileContent, type CiSourceInfo } from '@/lib/ci'
import { parseTerraformVariables, parseTerraformModules } from '@/lib/tfparser'
import { parameters, pipelineStacks, type Parameter } from '@/lib/db/schema'
import { db } from '@/lib/db/client'
import { and, eq } from 'drizzle-orm'
import { logAudit } from '@/lib/audit'
import { isReservedCiVariable, isPipelineSuppliedVariable } from '@/lib/ci/reserved'

// `narrowingKey` is derived from `parameter_projects` and written only by
// `setProjectNarrowing` (#404), so nothing parsed out of a template has one.
type ParsedParameter = Omit<
  Parameter,
  'id' | 'scope' | 'scopeId' | 'environmentId' | 'sizeValues' | 'narrowingKey'
>

/** A variable the scan found, and where it came from. */
export interface ScannedVariable extends ParsedParameter {
  /**
   * Empty for the root template, otherwise the module path that declared it —
   * `network`, or `network/subnet` two levels down.
   *
   * Kept because "why is this parameter here" is the first question about an
   * imported list, and the answer is not in the variable's own name.
   */
  fromModule: string
}

/** A module the scan could see but not read. */
export interface SkippedModule {
  module: string
  source: string
  reason: string
}

export interface TemplateScan {
  variables: ScannedVariable[]
  skippedModules: SkippedModule[]
  /** Every .tf file actually read, root first. Shown so the operator can tell whether the path was right. */
  filesRead: string[]
}

/**
 * How deep the scan follows local `module` sources.
 *
 * Three is past anything this platform's templates do and short enough that a
 * pathological repository cannot turn one button press into hundreds of API
 * calls. A cycle is impossible to reach through relative paths without also
 * exceeding this.
 */
export const MAX_MODULE_DEPTH = 3

/** A source the CI file API can fetch: a path inside this repository. */
const isLocalSource = (source: string): boolean => source.startsWith('./') || source.startsWith('../')

/**
 * Resolve a module's relative source against the directory that calls it.
 *
 * Own implementation rather than `path.posix`: the inputs are repository paths,
 * never filesystem paths, and running them through the platform's resolver on
 * Windows would introduce backslashes the CI APIs do not accept.
 */
export const resolveRepoPath = (from: string, relative: string): string => {
  const segments = from.split('/').filter(Boolean)
  for (const part of relative.split('/')) {
    if (part === '' || part === '.') continue
    if (part === '..') segments.pop()
    else segments.push(part)
  }
  return segments.join('/')
}

/**
 * Every Terraform variable a template still needs a value for.
 *
 * The ROOT is the contract, and modules are followed only if it is silent.
 *
 * Checked against the real `infra-templates` repository before this was settled.
 * Every one of its twelve templates is built out of modules AND declares its own
 * `variables.tf`, under the header "Product parameters (set by users when
 * ordering)" — the root passes each of them down explicitly. Descending anyway
 * added 17 more variables across those twelve: `tags`, `deletion_protection`,
 * `apply_immediately`, `ami_owner`, `user_data`, `windows_time_zone`. Every one
 * is a module knob the template author deliberately left at its default, and
 * every one would have arrived as a field on the order form.
 *
 * So: if the root declares any variables, they are the answer and the modules are
 * not read. A root that declares none is the case module traversal exists for,
 * and only then does it descend — a child variable is included only when the
 * caller has NOT already assigned it, because
 * `module "compute" { instance_type = var.instance_type }` means the root has
 * answered that one.
 *
 * Remote sources — the registry, `git::`, anything not a relative path — cannot
 * be read through the CI file API. They are reported in `skippedModules` rather
 * than passed over silently: a partial import that says it is partial is usable,
 * one that does not is a trap.
 */
export const scanTemplate = async (
  source: CiSourceInfo,
  projectId: string,
  ref: string,
  path: string,
  depth = 0,
  seen: Map<string, TemplateScan> = new Map(),
): Promise<TemplateScan> => {
  const scan: TemplateScan = { variables: [], skippedModules: [], filesRead: [] }

  // Two directories can reach the same module by different relative routes, and
  // a diamond should be READ once. It must not be ANSWERED once: whether a
  // variable is already covered is decided per caller, below, so returning
  // nothing to the second caller made a shared module's variable vanish
  // whenever the first caller happened to assign it —
  //
  //   module "a" { source = "../modules/shared"  size = "small" }
  //   module "b" { source = "../modules/shared" }
  //
  // filtered `size` out for `a`, which answers it, and handed `b` an empty
  // scan. `b` still needs a size and the order form had no field for one.
  //
  // So the scan is cached and replayed. `filesRead` and `skippedModules` come
  // back empty on a hit, because those are a record of work done and it was
  // done the first time.
  const key = path || '.'
  const cached = seen.get(key)
  if (cached) return { variables: cached.variables, skippedModules: [], filesRead: [] }

  // Stored before it is filled, so a module that reaches itself terminates on
  // the empty scan rather than recursing forever.
  seen.set(key, scan)

  const entries = await listFiles(source, projectId, ref, path)
  const tfFiles = entries
    .filter((e) => e.type === 'blob' && e.name.endsWith('.tf'))
    .map((e) => e.path)
    .sort()

  let combined = ''
  for (const file of tfFiles) {
    // One unreadable file does not sink the import: a template directory holding
    // something the token cannot see is still worth the variables it can.
    try {
      combined += `${await getFileContent(source, projectId, ref, file)}\n`
      scan.filesRead.push(file)
    } catch {
      scan.skippedModules.push({ module: '', source: file, reason: 'could not be read from the CI source' })
    }
  }

  for (const variable of parseTerraformVariables(combined)) {
    scan.variables.push({ ...variable, fromModule: '' })
  }

  // The root has spoken. Its `variables.tf` is what the template promises the
  // ordering user, and what the modules declare behind it is implementation.
  if (scan.variables.length > 0) return scan

  for (const call of parseTerraformModules(combined)) {
    if (!isLocalSource(call.source)) {
      scan.skippedModules.push({
        module: call.name,
        source: call.source,
        reason: 'not a path in this repository, so the file API cannot read it',
      })
      continue
    }
    if (depth >= MAX_MODULE_DEPTH) {
      scan.skippedModules.push({
        module: call.name,
        source: call.source,
        reason: `nested deeper than ${MAX_MODULE_DEPTH} levels`,
      })
      continue
    }

    const child = await scanTemplate(
      source,
      projectId,
      ref,
      resolveRepoPath(path, call.source),
      depth + 1,
      seen,
    )
    scan.filesRead.push(...child.filesRead)
    scan.skippedModules.push(...child.skippedModules)

    const answered = new Set(call.assigned)
    for (const variable of child.variables) {
      if (answered.has(variable.name)) continue
      scan.variables.push({
        ...variable,
        fromModule: variable.fromModule ? `${call.name}/${variable.fromModule}` : call.name,
      })
    }
  }

  // The root's own declaration wins over a module's, and an earlier module wins
  // over a later one — the first one read is the one nearest the template.
  const byName = new Map<string, ScannedVariable>()
  for (const variable of scan.variables) {
    if (!byName.has(variable.name)) byName.set(variable.name, variable)
  }
  scan.variables = [...byName.values()]

  return scan
}

/**
 * The variables from a scan that may become product parameters.
 *
 * Three exclusions, and the third is the one with teeth: a template declaring
 * `variable "ref"` or `variable "tf_action"` would otherwise produce a parameter
 * definition letting the ordering user choose the git ref, or turn a
 * provisioning order into a destroy (#183). The names the server owns are never
 * offered, whatever a template calls them.
 */
export const importableVariables = (scan: TemplateScan): ScannedVariable[] =>
  scan.variables.filter(
    (v) => !v.sensitive && !isPipelineSuppliedVariable(v.name) && !isReservedCiVariable(v.name),
  )

/**
 * What became of the pipeline stack, so the dialog can say it rather than
 * leaving the operator to check the stack list.
 */
export type StackOutcome =
  | { created: true; name: string; stateKeyParam: string; template: string }
  /** A stack is here and it already runs the template that was just imported. */
  | { created: false; reason: 'already-configured'; name: string }
  /**
   * A stack is here and it runs something ELSE.
   *
   * Reported rather than rewritten. A stack's steps decide the Terraform state
   * key each element is stood up under, and existing infrastructure was applied
   * against the old one — silently repointing the stack would leave a running
   * machine addressed by a name its teardown no longer derives. So the operator
   * is told exactly what is there and what was imported, and edits the stack
   * themselves if that is what they meant (#288).
   */
  | {
      created: false
      reason: 'points-elsewhere'
      name: string
      /** The templates the stack runs today, in step order. */
      existingTemplates: string[]
      /** The template this import scanned. */
      importedTemplate: string
    }
  | { created: false; reason: 'no-template-path' }

export interface ImportOutcome {
  created: number
  /** Already defined on this product, left as they are. */
  skipped: number
  createdNames: string[]
  skippedModules: SkippedModule[]
  filesRead: string[]
  /** Absent when the caller did not ask for a stack (no environment chosen). */
  stack?: StackOutcome
}

/**
 * Create a product parameter for every importable variable the product does not
 * already define.
 *
 * Existing definitions are never overwritten. An admin who has edited a label,
 * narrowed a type or set a different default has made a decision, and a
 * re-import is a request to pick up what is NEW — not to undo that.
 */
/**
 * The value of `TEMPLATE` for a template at this repository path.
 *
 * The dispatch rules in the repository root switch on `linode/kubernetes-cluster`,
 * while the import is given `templates/linode/kubernetes-cluster` — the directory
 * it reads. One leading `templates/` is the whole difference.
 */
export const templateNameFromPath = (path: string): string =>
  path.replace(/^\/+/, '').replace(/^templates\//, '').replace(/\/+$/, '')

/**
 * Which variable names the Terraform state, read out of the template itself.
 *
 * Every template in the reference repository says so in the description of the
 * variable concerned:
 *
 *   variable "cluster_label" {
 *     description = "Unique cluster label — also used as the Terraform state key (TF_STATE_NAME)"
 *   }
 *
 * so the state key does not have to be guessed or typed in. `hostname` is the
 * fallback because it is what the majority use and what `pipeline_stacks`
 * already defaults to — a wrong guess here is visible immediately (the state key
 * comes out empty and the trigger says so) rather than silently wrong.
 */
export const detectStateKeyParam = (scan: TemplateScan): string => {
  const named = scan.variables.find((v) => /TF_STATE_NAME|terraform state key/i.test(v.description))
  return named?.name ?? 'hostname'
}

/**
 * Give the product a pipeline stack for this environment, if it has none.
 *
 * Importing a template used to bring back its variables and nothing else, which
 * left the product in a state that looks finished and is not: offered in the
 * catalogue, a full order form, and a 502 at the till because a product is
 * provisioned by a webhook or a stack and it had neither. That is how a
 * Kubernetes product came to be unorderable straight after its import.
 *
 * Everything the stack needs is already known at import time — the environment,
 * the repository path, and which variable names the state — so there is nothing
 * to ask for. One step, because one imported template is one step; more are
 * added by hand afterwards, which is what the stack editor is for.
 *
 * Never overwrites. An existing stack is somebody's arrangement of steps, and
 * a re-import is a request to pick up new VARIABLES, not to flatten that.
 */
const ensurePipelineStack = async (
  productId: number,
  environmentId: number,
  path: string,
  scan: TemplateScan,
  actorId: number,
): Promise<StackOutcome> => {
  const template = templateNameFromPath(path)
  if (template === '') return { created: false, reason: 'no-template-path' }

  const [existing] = await db
    .select({ id: pipelineStacks.id, name: pipelineStacks.name, steps: pipelineStacks.steps })
    .from(pipelineStacks)
    .where(
      and(eq(pipelineStacks.productId, productId), eq(pipelineStacks.environmentId, environmentId)),
    )
    .limit(1)
  if (existing) {
    // "Kept" used to be the only thing a second import could say, whether the
    // stack matched the template or had nothing to do with it. So an operator
    // correcting a path, or re-importing after the template moved, got a
    // reassuring message and no change — and no way to tell the two apart
    // without opening the stack editor (#288).
    const existingTemplates = existing.steps.map((step) => step.template)
    return existingTemplates.includes(template)
      ? { created: false, reason: 'already-configured', name: existing.name }
      : {
          created: false,
          reason: 'points-elsewhere',
          name: existing.name,
          existingTemplates,
          importedTemplate: template,
        }
  }

  const stateKeyParam = detectStateKeyParam(scan)
  // The last path segment: unique per step within a stack, which is all the
  // suffix has to be, and readable in a state name.
  const stateSuffix = `-${template.split('/').pop()}`

  const [stack] = await db
    .insert(pipelineStacks)
    .values({
      productId,
      environmentId,
      name: template,
      stateKeyParam,
      steps: [{ template, stateSuffix }],
    })
    .returning({ id: pipelineStacks.id, name: pipelineStacks.name })

  await logAudit(
    actorId,
    'product.pipeline_stack_created',
    productId,
    `Created pipeline stack "${stack.name}" for environment #${environmentId} from the imported template, state key ${stateKeyParam}`,
  )

  return { created: true, name: stack.name, stateKeyParam, template }
}

export const importScannedParameters = async (
  productId: number,
  scan: TemplateScan,
  actorId: number,
  /** Where the stack goes. Omitted, only the parameters are imported. */
  stackFor?: { environmentId: number; path: string },
): Promise<ImportOutcome> => {
  const importable = importableVariables(scan)

  const existing = await db
    .select({ name: parameters.name })
    .from(parameters)
    .where(and(eq(parameters.scope, 'product'), eq(parameters.scopeId, productId)))
  const existingNames = new Set(existing.map((p) => p.name))

  const fresh = importable.filter((v) => !existingNames.has(v.name))

  for (const v of fresh) {
    await db.insert(parameters).values({
      scope: 'product',
      scopeId: productId,
      name: v.name,
      label: v.label,
      type: v.type,
      description: v.description,
      defaultValue: v.defaultValue,
      required: v.required,
      sensitive: false,
    })
  }

  // This path inserts `parameters` rows directly rather than going through
  // createParameter, so the service-layer audit sweep (#137) does not cover it.
  // Names only, never values — a synced default can be a connection string.
  if (fresh.length > 0) {
    await logAudit(
      actorId,
      'product.parameters_synced',
      productId,
      `Imported ${fresh.length} parameter(s) from the template: ${fresh.map((v) => v.name).join(', ')}`,
    )
  }

  const stack = stackFor
    ? await ensurePipelineStack(productId, stackFor.environmentId, stackFor.path, scan, actorId)
    : undefined

  return {
    created: fresh.length,
    skipped: importable.length - fresh.length,
    createdNames: fresh.map((v) => v.name),
    skippedModules: scan.skippedModules,
    filesRead: scan.filesRead,
    stack,
  }
}
