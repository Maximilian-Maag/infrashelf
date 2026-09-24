import type { CiProvider, CiProject, CiBranch, CiFile } from '@infrashelf/types'
import { OUTPUTS_BLOCK_HEADER } from './outputsBlock'
import {
  triggerGitLabPipeline,
  getGitLabApplyTraces,
  listGitLabProjects,
  listGitLabBranches,
  listGitLabFiles,
  getGitLabFileContent,
} from './gitlab'
import {
  triggerGitHubWorkflow,
  listGitHubRepos,
  listGitHubBranches,
  listGitHubFiles,
  getGitHubFileContent,
} from './github'
import {
  triggerBitbucketPipeline,
  listBitbucketRepos,
  listBitbucketBranches,
  listBitbucketFiles,
  getBitbucketFileContent,
} from './bitbucket'

export type CiSourceInfo = {
  url: string
  accessToken: string
  provider: CiProvider
  /**
   * The GitLab project pipelines of this source run in — a numeric id or a
   * URL-encoded path. Every pipeline/job read endpoint is project-scoped, and the
   * project is not part of `url`; see `gitlabProjectRefFromTriggerUrl`. Absent for
   * the browse/trigger paths, which do not need it.
   */
  projectRef?: string | null
}

export const triggerPipeline = (
  source: CiSourceInfo,
  webhookUrl: string,
  webhookToken: string,
  variables: Record<string, string>,
): Promise<string> => {
  switch (source.provider) {
    case 'gitlab':
      return triggerGitLabPipeline(webhookUrl, webhookToken, variables)
    case 'github':
      return triggerGitHubWorkflow(
        webhookUrl,
        source.accessToken,
        variables['WORKFLOW'] ?? 'main.yml',
        variables['BRANCH'] ?? 'main',
        variables,
      )
    case 'bitbucket':
      return triggerBitbucketPipeline(
        webhookUrl,
        source.accessToken,
        variables['BRANCH'] ?? 'main',
        variables,
      )
  }
}

/**
 * Can this provider's job log be read back?
 *
 * Only GitLab, today. That matters more than it looks: the apply log is the only
 * channel by which a deployment reports its Terraform outputs, so on GitHub and
 * Bitbucket an element never gets any — and nothing anywhere said so, which made it
 * look like the templates were at fault. Issue #97.
 *
 * Implementing the other two is real work rather than a missing case: GitHub serves
 * run logs as a redirect to a ZIP archive (needs an unzip dependency), and Bitbucket
 * needs the pipeline's steps enumerated before each step's log can be fetched.
 *
 * A `true` here is a statement about the provider only. GitLab additionally needs
 * `projectRef` on the source — callers should say so separately, because "we cannot
 * work out which project this ran in" is an operator's misconfiguration, not a
 * missing feature.
 */
export const supportsJobTrace = (provider: CiSourceInfo['provider']): boolean =>
  provider === 'gitlab'

/**
 * The stdout of every apply job that ran below `pipelineId`.
 *
 * A list, not one string: an order fans out over the product's webhooks and pipeline
 * stacks, and a stack applies once per step — each apply printing its own `Outputs:`
 * block, which `parseTofuOutputs` reads one at a time.
 */
export const fetchJobTraces = (
  source: CiSourceInfo,
  pipelineId: string,
): Promise<string[]> => {
  switch (source.provider) {
    case 'gitlab':
      if (!source.projectRef) {
        // Callers check this and say which environment is misconfigured; getting
        // here means one did not.
        return Promise.reject(
          new Error('GitLab job logs are project-scoped, but this CI source has no projectRef'),
        )
      }
      return getGitLabApplyTraces(source.url, source.accessToken, source.projectRef, pipelineId)
    case 'github':
    case 'bitbucket':
      // See supportsJobTrace: callers should check first and say why, rather than
      // treating an empty trace as "this deployment produced no outputs".
      return Promise.resolve([])
  }
}

/**
 * Parse the `Outputs:` block of an OpenTofu/Terraform apply log.
 *
 * The platform stores whatever this returns on the infrastructure element, and it
 * is the only channel by which a deployment can tell the portal anything — an
 * endpoint, a generated name, a connection string. So dropping a value silently is
 * the worst thing this function can do, and it used to drop a lot: it accepted only
 * `name = "quoted string"`, which meant numbers, booleans, lists, maps and
 * `<sensitive>` markers all vanished without trace. Issue #97.
 *
 * What is deliberately NOT parsed into structure: complex values are kept as the
 * text Terraform printed — structured values joined on one line, heredocs keeping
 * their own lines. The consumer is a key/value display
 * and a CSV column, and inventing a JSON shape here would be a guess about what a
 * template meant.
 */
/**
 * GitLab's per-line log prefix, when the instance emits timestamped job logs.
 *
 * With "job log timestamps" enabled — GitLab 17+, and on by default on some
 * instances — every line of a trace arrives as
 *
 *     2026-08-24T15:41:17.013321Z 01O Outputs:
 *     2026-08-24T15:41:17.013323Z 01O ip_address = "172.105.94.94"
 *
 * The parser trimmed whitespace and then looked for `^Outputs:`, which never
 * matched, and the key/value regex begins `[A-Za-z_]` so it failed on the leading
 * year too. Every deployment on such an instance recorded NO outputs, and looked
 * exactly like a template that declared none — hcp-dev shipped VMs for weeks that
 * way, and the apply log had `ip_address = "172.105.94.94"` in it the whole time.
 *
 * Matched narrowly on purpose: an ISO-8601 instant with a `Z`, then GitLab's
 * two-digit stream marker (`01O`, `00E`, `00O+`), then the content. A line of
 * Terraform output that merely begins with a date is not touched, because it has
 * no stream marker after it.
 */
const GITLAB_LOG_PREFIX = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z \d{2}[A-Z]\+? ?/

export const parseTofuOutputs = (trace: string): Record<string, string> => {
  const stripped = trace.replace(/\x1B\[[0-9;]*[a-zA-Z]/g, '')
  const lines = stripped.split('\n').map((line) => line.replace(GITLAB_LOG_PREFIX, ''))
  const outputs: Record<string, string> = {}

  let inOutputs = false
  /** Set while a value spans several lines: a list, a map, or a heredoc. */
  let pending: { name: string; parts: string[]; depth: number; heredoc: string | null } | null = null

  const finish = () => {
    if (!pending) return
    // A heredoc keeps its line structure — it is a document, and joining it on one
    // line would destroy the thing it was written as. Everything else is collapsed:
    // Terraform indents structured values, and this is shown in a table cell.
    outputs[pending.name] =
      pending.heredoc !== null
        ? pending.parts.join('\n').trim()
        : pending.parts.join(' ').replace(/\s+/g, ' ').trim()
    pending = null
  }

  const unquote = (value: string): string =>
    value.startsWith('"') && value.endsWith('"') && value.length >= 2 ? value.slice(1, -1) : value

  /**
   * Net bracket depth, ignoring brackets inside quoted strings.
   *
   * `name = "a [ b"` is a complete scalar, not the start of a list — counting the
   * bracket inside the quotes would swallow every following output into it.
   */
  const depthOf = (text: string): number => {
    let depth = 0
    let inString = false
    let escaped = false
    for (const char of text) {
      if (escaped) { escaped = false; continue }
      if (char === '\\') { escaped = true; continue }
      if (char === '"') { inString = !inString; continue }
      if (inString) continue
      if (char === '[' || char === '{' || char === '(') depth++
      if (char === ']' || char === '}' || char === ')') depth--
    }
    return depth
  }

  /** `<<EOT` / `<<-EOT` opens a heredoc that runs until a line holding EOT. */
  const heredocTag = (value: string): string | null =>
    value.match(/^<<-?\s*([A-Za-z_][A-Za-z0-9_]*)\s*$/)?.[1] ?? null

  for (const line of lines) {
    const trimmed = line.trim()

    if (!inOutputs) {
      if (OUTPUTS_BLOCK_HEADER.test(trimmed)) inOutputs = true
      continue
    }

    if (pending) {
      // A heredoc ends at its terminator line and nowhere else — its content is
      // arbitrary text that may contain brackets, quotes and blank lines.
      if (pending.heredoc !== null) {
        if (trimmed === pending.heredoc) finish()
        else pending.parts.push(line)
        continue
      }
      pending.parts.push(trimmed)
      pending.depth += depthOf(trimmed)
      if (pending.depth <= 0) finish()
      continue
    }

    // A blank line inside the block is just spacing after the header.
    if (trimmed === '') continue

    const match = trimmed.match(/^([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/)
    if (!match) {
      // Not an assignment and not blank: the outputs block has ended (a warning,
      // a summary line, the next section).
      break
    }

    const [, name, rawValue] = match
    const value = rawValue.trim()

    const tag = heredocTag(value)
    if (tag !== null) {
      pending = { name, parts: [], depth: 0, heredoc: tag }
      continue
    }

    // An opening bracket that is not closed on this line starts a multi-line value.
    if (depthOf(value) > 0) {
      pending = { name, parts: [value], depth: depthOf(value), heredoc: null }
      continue
    }

    // `<sensitive>` is recorded rather than dropped: "there is a value here and it
    // is not being shown" is information, and a missing key looks like a template
    // that forgot to declare the output.
    outputs[name] = unquote(value)
  }

  finish()
  return outputs
}

export const listProjects = (
  source: CiSourceInfo,
  search?: string,
): Promise<CiProject[]> => {
  switch (source.provider) {
    case 'gitlab':
      return listGitLabProjects(source.url, source.accessToken, search)
    case 'github':
      return listGitHubRepos(source.url, source.accessToken, search)
    case 'bitbucket':
      return listBitbucketRepos(source.url, source.accessToken, search)
  }
}

export const listBranches = (
  source: CiSourceInfo,
  projectId: string,
): Promise<CiBranch[]> => {
  switch (source.provider) {
    case 'gitlab':
      return listGitLabBranches(source.url, source.accessToken, projectId)
    case 'github':
      return listGitHubBranches(source.url, source.accessToken, projectId)
    case 'bitbucket':
      return listBitbucketBranches(source.url, source.accessToken, projectId)
  }
}

export const listFiles = (
  source: CiSourceInfo,
  projectId: string,
  branch: string,
  path?: string,
): Promise<CiFile[]> => {
  const normalizedPath = path ?? ''
  switch (source.provider) {
    case 'gitlab':
      return listGitLabFiles(source.url, source.accessToken, projectId, branch, normalizedPath)
    case 'github':
      return listGitHubFiles(source.url, source.accessToken, projectId, branch, normalizedPath)
    case 'bitbucket':
      return listBitbucketFiles(source.url, source.accessToken, projectId, branch, normalizedPath)
  }
}

export const getFileContent = (
  source: CiSourceInfo,
  projectId: string,
  branch: string,
  filePath: string,
): Promise<string> => {
  switch (source.provider) {
    case 'gitlab':
      return getGitLabFileContent(source.url, source.accessToken, projectId, branch, filePath)
    case 'github':
      return getGitHubFileContent(source.url, source.accessToken, projectId, branch, filePath)
    case 'bitbucket':
      return getBitbucketFileContent(source.url, source.accessToken, projectId, branch, filePath)
  }
}
