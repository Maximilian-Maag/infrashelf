import type { Parameter } from '@/lib/db/schema'

// `sizeValues` is omitted too: the parser reads a Terraform declaration, and
// nothing in one says what an instance type should be at size M. Which variable
// is driven by the T-shirt size is an operator's decision, made after the import
// by switching the parameter's type to `size` and filling the map in.
// `narrowingKey` is derived from `parameter_projects` and written only by
// `setProjectNarrowing` (#404), so nothing parsed out of a template has one.
type ParsedParameter = Omit<
  Parameter,
  'id' | 'scope' | 'scopeId' | 'environmentId' | 'sizeValues' | 'narrowingKey'
>

// Match variable blocks including nested braces
const extractVariableBlocks = (content: string): Array<{ name: string; body: string }> => {
  const results: Array<{ name: string; body: string }> = []
  const pattern = /variable\s+"([^"]+)"\s*\{/g
  let match: RegExpExecArray | null

  while ((match = pattern.exec(content)) !== null) {
    const name = match[1]
    const start = match.index + match[0].length
    let depth = 1
    let i = start

    while (i < content.length && depth > 0) {
      if (content[i] === '{') depth++
      else if (content[i] === '}') depth--
      i++
    }

    const body = content.slice(start, i - 1)
    results.push({ name, body })
  }

  return results
}

// The key has to START here. Without the lookbehind, `source` matches inside
// `image_source`, and `String.match` returns the FIRST hit anywhere in the body:
//
//   module "vm" {
//     image_source = "ubuntu-24"
//     source       = "../modules/vm"
//   }
//
// read its source as `ubuntu-24`, which is not a local path, so the module was
// reported as unreadable and every variable behind it was lost. The same slip
// costs a `type` or a `description` its value wherever an argument ends in one.
// `.` and `-` are excluded too, so `local.source` and `my-source` do not match.
const keyPattern = (key: string, value: string) => new RegExp(`(?<![\\w.-])${key}\\s*=\\s*${value}`, 'm')

const extractStringValue = (body: string, key: string): string | undefined => {
  const match = body.match(keyPattern(key, '"([^"]*)"'))
  return match?.[1]
}

const extractBareValue = (body: string, key: string): string | undefined => {
  const match = body.match(keyPattern(key, '([^\\n\\r]+)'))
  return match?.[1]?.trim()
}

const mapType = (
  rawType: string | undefined,
  body: string,
): 'string' | 'number' | 'bool' | 'dropdown' => {
  // Use dropdown if validation block with condition exists
  if (/validation\s*\{[^}]*condition\s*=/s.test(body)) return 'dropdown'

  const t = (rawType ?? 'string').trim().toLowerCase()
  if (t === 'number') return 'number'
  if (t === 'bool') return 'bool'
  if (t === 'string') return 'string'
  return 'string'
}

const extractSensitive = (body: string): boolean => {
  const match = body.match(/sensitive\s*=\s*(true|false)/m)
  return match?.[1] === 'true'
}

const extractRequired = (body: string): boolean => {
  // A variable without a default is required
  return !/default\s*=/.test(body)
}

const extractDefault = (body: string): string => {
  const stringDefault = extractStringValue(body, 'default')
  if (stringDefault !== undefined) return stringDefault

  const bareDefault = extractBareValue(body, 'default')
  if (!bareDefault || bareDefault === 'null') return ''

  return bareDefault
}

export const parseTerraformVariables = (content: string): ParsedParameter[] => {
  const blocks = extractVariableBlocks(content)
  return blocks.map(({ name, body }) => {
    const rawType = extractStringValue(body, 'type') ?? extractBareValue(body, 'type')
    return {
      name,
      label: name.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase()),
      type: mapType(rawType, body),
      description: extractStringValue(body, 'description') ?? '',
      defaultValue: extractDefault(body),
      required: extractRequired(body),
      sensitive: extractSensitive(body),
    }
  })
}

/** One `module "name" { … }` call in a Terraform file. */
export interface ParsedModule {
  /** The label — `module "network"` → `network`. */
  name: string
  /** The `source` argument, verbatim. */
  source: string
  /**
   * The argument names the caller assigns inside the block.
   *
   * These are the child's variables that are already answered, so they are NOT
   * things the ordering user has to supply. Everything else the child declares
   * is.
   *
   * Terraform's own meta-arguments are excluded — `source`, `version`, `count`,
   * `for_each`, `providers`, `depends_on` and `lifecycle` are how the module is
   * called, not inputs it declares, and counting them would be counting
   * arguments no child ever has a `variable` block for.
   */
  assigned: string[]
}

/**
 * The `module` blocks a Terraform file calls.
 *
 * A template built out of modules declares few variables of its own: the root
 * wires modules together and the values a person still has to choose live in the
 * children. Reading only the root's `variables.tf` therefore finds nothing, which
 * is what "I cannot import parameters from a template made of modules" means.
 *
 * Deliberately NOT a general HCL parser. It answers two questions — where does
 * this module come from, and which of its inputs are already fixed here — and
 * both are shallow enough to read with the same brace-matching the variable
 * blocks use.
 */
export const parseTerraformModules = (content: string): ParsedModule[] => {
  const results: ParsedModule[] = []
  const pattern = /module\s+"([^"]+)"\s*\{/g
  let match: RegExpExecArray | null

  while ((match = pattern.exec(content)) !== null) {
    const name = match[1]
    const start = match.index + match[0].length
    let depth = 1
    let i = start
    while (i < content.length && depth > 0) {
      if (content[i] === '{') depth++
      else if (content[i] === '}') depth--
      i++
    }
    const body = content.slice(start, i - 1)

    const source = extractStringValue(body, 'source')
    if (source === undefined) continue

    // Top-level assignments only. A key inside `providers = { … }` or any other
    // nested block is not an input the child declares as a variable, and
    // counting one would wrongly mark a real child variable as already answered.
    const assigned = topLevelAssignments(body).filter((k) => !MODULE_META_ARGUMENTS.has(k))
    results.push({ name, source, assigned })
  }

  return results
}

/** How a module is CALLED, as opposed to what it declares. */
const MODULE_META_ARGUMENTS = new Set([
  'source', 'version', 'count', 'for_each', 'providers', 'depends_on', 'lifecycle',
])

/** The `key =` names at brace depth 0 of a block body. */
const topLevelAssignments = (body: string): string[] => {
  const names: string[] = []
  let depth = 0
  for (const rawLine of body.split('\n')) {
    const line = rawLine.trim()
    if (depth === 0) {
      const assignment = line.match(/^([A-Za-z_][A-Za-z0-9_-]*)\s*=/)
      if (assignment) names.push(assignment[1])
    }
    // Counted after the match so a line that OPENS a block still registers its
    // own name — `providers = {` is an assignment to `providers`.
    for (const ch of line) {
      if (ch === '{' || ch === '[' || ch === '(') depth++
      else if (ch === '}' || ch === ']' || ch === ')') depth--
    }
  }
  return names
}
