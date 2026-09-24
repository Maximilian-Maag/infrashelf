import { fetchJobTraces, parseTofuOutputs, supportsJobTrace } from '@/lib/ci'
// The header rule is imported from its own module, not from `@/lib/ci`: test
// files mock that path wholesale and a mocked export would leave the splitter
// below comparing against `undefined`.
import { OUTPUTS_BLOCK_HEADER } from '@/lib/ci/outputsBlock'
import { elementLogSelector, queryLokiLogs } from '@/lib/integrations/loki'
import type { IntegrationTarget } from '@/lib/integrations/http'
import type { CiSource } from '@/lib/db/queries'

/**
 * Read one element's Terraform outputs out of its pipeline logs (issues #215, #218).
 *
 * Extracted from `settle.ts` so that a person looking at an element can ask for
 * the same read a second time. That matters more than it sounds: outputs are
 * parsed exactly once, when the order settles, and if anything was wrong at that
 * moment — a revoked CI token, a log the parser could not read (#216) — the
 * element is empty forever and the only remedies were a database script or
 * redeploying real infrastructure.
 *
 * Returns the outputs it could read and, when it read none, why. The caller
 * decides what to persist: the settle path and the refresh path want the same
 * answer written the same way, which is the whole reason this is one function.
 */
export interface OutputsRead {
  outputs: Record<string, string>
  /** Null when outputs were read. Otherwise, what to show an operator. */
  error: string | null
}

/**
 * How far back a Loki query looks when the caller does not say (§ #111, the Loki
 * item).
 *
 * A Loki `query_range` needs a bounded window — an unbounded read of a stream
 * that has been running since the element was provisioned is a query that either
 * times out or drags the index down — and the caller that knows when the run
 * happened should say so. This is the fallback for the ones that do not: long
 * enough to cover a provisioning run that has been sitting in a queue, short
 * enough to stay a bounded scan.
 */
const LOKI_DEFAULT_WINDOW_MS = 7 * 24 * 60 * 60 * 1000

/** What the read needs beyond the pipeline ids; every field is a caller's knowledge. */
export interface OutputsReadContext {
  elementId: number
  orderId?: number
  /**
   * The Loki integration serving this element's environment, resolved by the
   * caller with `resolveIntegration('loki', environmentId)`.
   *
   * Passed in rather than resolved here so this module stays a reader of logs
   * rather than a reader of the integration registry, and so the caller that has
   * already decided whether the deployment has a Loki does not make it ask twice.
   */
  loki?: IntegrationTarget | null
  /**
   * When the run this read is about started.
   *
   * Only used for the Loki window; the CI job API is addressed by pipeline id and
   * needs no interval. Omitted means `LOKI_DEFAULT_WINDOW_MS` before now.
   */
  since?: Date
}

/**
 * Reasons that belong to the environment rather than to one element.
 *
 * `loki` says whether the environment has a Loki integration the portal may
 * read. It changes the answer for the two cases that are NOT the CI source's
 * credential: a deployment with Loki does not need a CI source at all (#111), and
 * it does not need a provider whose job log can be fetched — which is the whole
 * point of reading logs from Loki, since two of the three providers cannot be
 * read (#97).
 */
export const outputsUnavailableReason = (
  ciSource: CiSource | null,
  opts: { loki?: boolean } = {},
): string | null => {
  if (opts.loki) return null
  if (!ciSource) {
    return 'This deployment environment has no CI source and no Loki integration, so the pipeline log cannot be read and no Terraform outputs can be collected. Set one under Admin → Environments, or configure a Loki the pipelines ship their logs to under Admin → Integrations.'
  }
  if (!supportsJobTrace(ciSource.provider)) {
    return `Reading pipeline logs is not implemented for ${ciSource.provider}, so Terraform outputs cannot be collected. Only GitLab supports it today — a Loki integration the pipelines ship their logs to makes them readable whatever the provider is.`
  }
  if (!ciSource.projectRef) {
    // GitLab's job endpoints are project-scoped and the project is only named in
    // the environment's trigger URL, so a URL of another shape means the log
    // cannot be located at all. An operator can fix this, but only if they are
    // told which URL and what is wrong with it — hence the shape in the message.
    return "The environment's trigger URL has no /projects/<id>/ segment, so the pipeline log cannot be located and no Terraform outputs can be collected. Check the webhook URL under Admin → Environments."
  }
  return null
}

/**
 * Cut one log stream into one trace per `Outputs:` block.
 *
 * A Loki stream is keyed by ELEMENT, not by pipeline: one element's lines hold a
 * block for every stack that applied, each printing its own outputs. Joining them
 * into one string and handing that to `parseTofuOutputs` would read the first
 * block and stop — the parser ends at the first line that is not an assignment,
 * and the next `Outputs:` header is exactly that — so an element provisioned by
 * two stacks would silently keep only the first stack's outputs.
 *
 * The header rule is `OUTPUTS_BLOCK_HEADER` rather than a copy of it: the parser
 * and this splitter disagreeing is the failure that looks like "this deployment
 * declared no outputs".
 */
export const outputsBlocksIn = (lines: readonly string[]): string[] => {
  const blocks: string[] = []
  let current: string[] | null = null

  for (const line of lines) {
    if (OUTPUTS_BLOCK_HEADER.test(line.trim())) {
      if (current) blocks.push(current.join('\n'))
      current = [line]
      continue
    }
    if (current) current.push(line)
  }

  if (current) blocks.push(current.join('\n'))
  return blocks
}

/**
 * Read the element's log lines from Loki, or say why not.
 *
 * Never throws: `queryLokiLogs` answers with a result, and this only has to decide
 * what the window is.
 */
const readLokiTraces = async (
  loki: IntegrationTarget,
  context: OutputsReadContext,
): Promise<{ traces: string[]; failure: string | null; truncated: boolean }> => {
  const until = new Date()
  const since = context.since ?? new Date(until.getTime() - LOKI_DEFAULT_WINDOW_MS)

  const result = await queryLokiLogs(loki, elementLogSelector(context.elementId), { since, until })
  if (!result.ok) return { traces: [], failure: result.error, truncated: false }

  return {
    // A line filter (`|~ "Outputs:"`) is deliberately NOT part of the query: the
    // parser is the authority on where an outputs block starts, and a selector
    // that pre-filtered lines would hide precisely the case where a pipeline
    // prints outputs in a shape the parser does not recognise — which is #216.
    traces: outputsBlocksIn(result.lines.map((l) => l.line)),
    failure: null,
    truncated: result.truncated,
  }
}

export const readOutputsForElement = async (
  ciSource: CiSource | null,
  pipelineIds: string[],
  context: OutputsReadContext,
): Promise<OutputsRead> => {
  if (pipelineIds.length === 0) {
    // A row whose triggers never fired. Its outputs are unknown, and borrowing a
    // sibling's is exactly the confusion the per-element loop ends. Its Loki
    // stream is empty for the same reason — no pipeline ran — so this stays the
    // first check rather than the last.
    console.warn(
      `[outputs] Element ${context.elementId}${context.orderId ? ` (order ${context.orderId})` : ''} ` +
        `has no pipeline of its own; no Terraform outputs recorded for it.`,
    )
    return {
      outputs: {},
      error:
        'No pipeline ever started for this element, so there is no log to read Terraform outputs from.',
    }
  }

  const outputs: Record<string, string> = {}
  // Kept so the element can say the log was unreadable rather than empty: a
  // revoked CI token and a template that declares no outputs are the same blank
  // card otherwise, and only one of them is anybody's to fix.
  const failures: string[] = []
  const traces: string[] = []
  let truncated = false

  // Loki first when the environment has one. It is provider-independent, and it
  // is the source an operator configured deliberately — a deployment that has
  // both is one mid-migration, and the answer should come from the new side.
  const from = context.loki ? 'loki' : 'ci'
  if (context.loki) {
    const read = await readLokiTraces(context.loki, context)
    traces.push(...read.traces)
    truncated = read.truncated
    if (read.failure) {
      // Logged as well as returned: when the provider's job API then succeeds the
      // outputs are still recorded and this string never reaches a page, but a
      // configured source that is failing is not something to leave in the dark.
      console.error(
        `[outputs] Element ${context.elementId}: could not read its log from Loki: ${read.failure}`,
      )
      failures.push(`Loki: ${read.failure}`)
    }
  }

  // The provider's job API: the whole answer when there is no Loki, and the second
  // source to ask when there is one but it had nothing to give — a pipeline that
  // has not started shipping its logs yet, or an element older than the window.
  if (traces.length === 0) {
    if (!ciSource) {
      // Only reachable with no Loki configured either, which the caller checks
      // first; saying it here keeps the message honest if it stops doing so.
      if (!context.loki) failures.push('no CI source is configured for this environment')
    } else if (!supportsJobTrace(ciSource.provider)) {
      failures.push(`${ciSource.provider} job logs cannot be read`)
    } else {
      for (const pipelineId of pipelineIds) {
        let fromPipeline: string[]
        try {
          fromPipeline = await fetchJobTraces(ciSource, pipelineId)
        } catch (err) {
          // One unreadable pipeline log must not cost the outputs of the pipelines
          // that did report.
          console.error(
            `[outputs] Could not read the job log of pipeline ${pipelineId} (element ${context.elementId}):`,
            err,
          )
          // The message, not the object: a stack trace is for the log, and the
          // useful half of "GitLab jobs fetch failed: 401" is the 401.
          failures.push(`pipeline ${pipelineId}: ${err instanceof Error ? err.message : String(err)}`)
          continue
        }
        traces.push(...fromPipeline)
      }
    }
  }

  for (const trace of traces) {
    for (const [key, value] of Object.entries(parseTofuOutputs(trace))) {
      // First writer wins, iterating this element's pipeline ids in the order
      // they were triggered: two of ITS pipelines both declaring `ip_address`
      // is a naming collision in the templates, and picking by CI timing would
      // make the recorded value change from run to run.
      if (key in outputs) {
        if (outputs[key] !== value) {
          console.warn(
            `[outputs] Element ${context.elementId}: output "${key}" is reported by more ` +
              `than one of its pipelines with different values; keeping the first.`,
          )
        }
        continue
      }
      outputs[key] = value
    }
  }

  if (Object.keys(outputs).length > 0) return { outputs, error: null }

  if (failures.length > 0) {
    // The hint follows whichever source failed, because the two have different
    // remedies and the operator is looking at one page.
    const hint =
      from === 'loki'
        ? 'Check the Loki integration under Admin → Integrations — its base URL and credential — and that the pipelines push their logs with the element_id label.'
        : "This is usually the CI source's access token — check it under Admin → CI Sources; it needs at least read_api scope."
    return {
      outputs,
      error: `The pipeline log could not be read, so Terraform outputs could not be collected: ${failures.join('; ')}. ${hint}`,
    }
  }

  if (truncated) {
    // An outputs block beyond the line limit is the one failure that looks exactly
    // like a template that declared nothing, so it is said rather than assumed
    // away.
    return {
      outputs,
      error:
        `The log read from Loki was truncated at the query's line limit, so no Terraform "Outputs:" ` +
        `block was seen. Narrow the window (or push less to Loki per element) and read again.`,
    }
  }

  return {
    outputs,
    error:
      'The pipeline log was read successfully and contained no Terraform "Outputs:" block, so this deployment declared none.',
  }
}
