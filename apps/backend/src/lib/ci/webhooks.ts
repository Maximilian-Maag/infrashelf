import { db } from '@/lib/db/client'
import { productWebhooks, pipelineStacks, deploymentEnvironments } from '@/lib/db/schema'
import { sql, eq, and } from 'drizzle-orm'
import { findCiSourceForEnv } from '@/lib/db/queries'
import { triggerPipeline } from './index'
import { ELEMENT_SEQUENCE_VAR, STATE_KEY_NAMESPACE_VAR, elementStateSuffix, stateKeyBase } from './stateKey'

/**
 * Result of fanning a trigger out over every configured webhook/stack.
 *
 * A single failing trigger must not abort the others (one broken stack should
 * not block the rest of a teardown), so failures are collected instead of
 * thrown. EVERY caller has to inspect `failures`. The pipelines-only wrappers
 * that used to let the provisioning paths skip them are gone (issue #134): a
 * product with one webhook and one stack whose webhook 502s left `failures`
 * unread, so the order was waiting on the stack alone and completed on it —
 * mailing "provisioning completed" for infrastructure that was half deployed.
 */
export interface TriggerOutcome {
  /** Pipeline ids that were successfully started. */
  pipelineIds: string[]
  /** One human-readable entry per configured trigger that could not be started. */
  failures: string[]
  /**
   * The Terraform state key used for each pipeline stack, keyed by stack id.
   *
   * Returned so provisioning can RECORD it on the element instead of leaving
   * every later trigger to derive it again from inputs that can move underneath
   * (#200). Empty for the webhook path, which sends no TF_STATE_NAME at all.
   */
  stateKeys?: Record<string, string>
}

/**
 * Called with each pipeline id the moment its trigger returns, before the next
 * trigger of the fan-out is fired.
 *
 * The CI system can report a pipeline back over the callback route before the
 * fan-out that started it has finished — a `rules:` mismatch or a broken
 * `.gitlab-ci.yml` fails a GitLab pipeline in well under a second — and the
 * callback handler finds its row by pipeline id. An id stored only after the
 * whole fan-out returns is an id that callback cannot match, and since GitLab
 * does not retry and this codebase deliberately does not poll, the order was
 * then stranded in 'provisioning' with no recovery short of SQL (issue #132).
 *
 * A throw from the callback is logged and swallowed: the pipeline is already
 * running and cannot be recalled, so losing the fan-out over a bookkeeping
 * failure would be strictly worse. The id is still returned in `pipelineIds`,
 * which is what the caller reconciles the row against at the end of the run.
 */
export type PipelineStarted = (pipelineId: string) => Promise<void>

const reportStarted = async (
  onStarted: PipelineStarted | undefined,
  pipelineId: string,
): Promise<void> => {
  if (!onStarted) return
  try {
    await onStarted(pipelineId)
  } catch (err) {
    console.error(`[ci] Could not record pipeline ${pipelineId} as started:`, err)
  }
}

/**
 * The state key a stack WOULD derive right now.
 *
 * Only reached for an element with no recorded key — one provisioned before
 * `state_keys` existed, or the provisioning run that is about to record it.
 */
const derivedStateName = (
  stack: { stateKeyParam: string },
  variables: Record<string, string>,
  unfilteredParameters: Record<string, string> | undefined,
  suffix: string,
): string => {
  const base = stateKeyBase({
    // See `unfilteredParameters`: a reserved name is absent from `variables` by
    // design, and for a legacy element that name may be what its state key was.
    param: variables[stack.stateKeyParam] ?? unfilteredParameters?.[stack.stateKeyParam],
    orderId: variables['ORDER_ID'],
    // Server-owned and per element, so a stack's stateKeyParam value can no
    // longer name another order's state — see `stateKeyBase` for why an element
    // without one keeps deriving its key the old way.
    namespace: variables[STATE_KEY_NAMESPACE_VAR],
  })
  // Never suffix an empty base: `-2` on its own is not a state name, and an
  // empty TF_STATE_NAME is the existing signal that nothing identified a state.
  return base === '' ? '' : `${base}${suffix}`
}

export const triggerPipelineStacksTracked = async (
  productId: number,
  environmentId: number,
  variables: Record<string, string>,
  onStarted?: PipelineStarted,
  /**
   * The element's stored parameters BEFORE reserved names were filtered out of
   * them, consulted only to derive the state key and never sent anywhere.
   *
   * A pre-#183 stack may name a RESERVED variable as its `stateKeyParam` — `REF`
   * is the realistic one — and the value of that parameter is the raw state key
   * its apply created. `withoutReservedCiVariables` correctly keeps that name out
   * of the outgoing request, but derivation still has to see it: without this the
   * lookup below misses, `stateKeyBase` falls back to the order id, and destroy
   * or retry addresses a state that element never had. The filtered map is still
   * consulted first, so nothing changes for a stack whose stateKeyParam is an
   * ordinary parameter name.
   */
  unfilteredParameters?: Record<string, string>,
  /**
   * The keys this element was PROVISIONED under, by stack id.
   *
   * Passed by retry and teardown, which must address the state that already
   * exists rather than whatever the stack row would derive today. Two rules,
   * and the difference between them is the whole point:
   *
   *   * empty — the element predates the column, so every stack derives as
   *     before. Their state exists under the old key and nothing else can find
   *     it;
   *   * non-empty and a stack is missing from it — that stack was added after
   *     this element was provisioned, so nothing here was ever applied by it and
   *     firing a destroy would address a state that never existed.
   */
  recordedStateKeys?: Record<string, string>,
): Promise<TriggerOutcome> => {
  const ciSource = await findCiSourceForEnv(environmentId)
  if (!ciSource) return { pipelineIds: [], failures: [], stateKeys: {} }

  // Stack rows carry their JSON step definition; the trigger URL + token are
  // owned by the deployment environment (single source of truth — see
  // migration 0003_stack_inherits_env_webhook.sql for the history).
  const [env] = await db
    .select({ webhookUrl: deploymentEnvironments.webhookUrl, webhookToken: deploymentEnvironments.webhookToken })
    .from(deploymentEnvironments)
    .where(eq(deploymentEnvironments.id, environmentId))
    .limit(1)
  if (!env) return { pipelineIds: [], failures: [], stateKeys: {} }

  const stacks = await db
    .select()
    .from(pipelineStacks)
    .where(and(eq(pipelineStacks.productId, productId), eq(pipelineStacks.environmentId, environmentId)))

  const pipelineIds: string[] = []
  const failures: string[] = []
  const stateKeys: Record<string, string> = {}
  const hasRecord = recordedStateKeys !== undefined && Object.keys(recordedStateKeys).length > 0
  // Appended to whichever base the state key is derived from, so two elements of
  // one order never share a state file — including when the base comes from the
  // stack's own stateKeyParam, which is a user-supplied parameter and therefore
  // identical across the elements of one line.
  const suffix = elementStateSuffix(variables[ELEMENT_SEQUENCE_VAR])
  for (const stack of stacks) {
    if (!stack.steps || (stack.steps as unknown[]).length === 0) continue

    const recorded = recordedStateKeys?.[String(stack.id)]
    // Known not to have provisioned this element: the stack was added after it.
    // Firing a destroy would address a state that was never created, and the
    // pipeline would report success for having done nothing.
    if (hasRecord && recorded === undefined) continue

    const tfStateName = recorded ?? derivedStateName(stack, variables, unfilteredParameters, suffix)
    // Recorded BEFORE the trigger, not after it succeeds: a trigger whose HTTP
    // call fails may still have started the pipeline, and a key nobody wrote
    // down is a state with no teardown.
    stateKeys[String(stack.id)] = tfStateName
    try {
      const pid = await triggerPipeline(ciSource, env.webhookUrl, env.webhookToken, {
        ...variables,
        TEMPLATE: 'orchestrator',
        TF_STATE_NAME: tfStateName,
        PIPELINE_STACK: JSON.stringify(stack.steps),
      })
      pipelineIds.push(pid)
      await reportStarted(onStarted, pid)
    } catch (err) {
      // Named: a failed trigger is how an order silently does not provision, and
      // "which stack, for which product in which environment" is the first
      // question asked of the log (#482).
      console.error(`[ci] Pipeline stack #${stack.id} ("${stack.name}") failed to trigger for product #${productId} in environment #${environmentId}:`, err)
      failures.push(`pipeline stack "${stack.name}" (#${stack.id}): ${errMessage(err)}`)
    }
  }
  return { pipelineIds, failures, stateKeys }
}

export const triggerProductWebhooksTracked = async (
  productId: number,
  environmentId: number,
  variables: Record<string, string>,
  onStarted?: PipelineStarted,
): Promise<TriggerOutcome> => {
  const ciSource = await findCiSourceForEnv(environmentId)
  if (!ciSource) return { pipelineIds: [], failures: [] }

  const webhooks = await db
    .select()
    .from(productWebhooks)
    .where(
      sql`${productWebhooks.productId} = ${productId} AND ${productWebhooks.environmentId} = ${environmentId}`,
    )
    .orderBy(productWebhooks.execOrder)

  const pipelineIds: string[] = []
  const failures: string[] = []
  for (const wh of webhooks) {
    try {
      const pid = await triggerPipeline(ciSource, wh.webhookUrl, wh.webhookToken, variables)
      pipelineIds.push(pid)
      await reportStarted(onStarted, pid)
    } catch (err) {
      console.error(`[ci] Product webhook #${wh.id} ("${wh.name}") failed to trigger for product #${productId} in environment #${environmentId}:`, err)
      failures.push(`product webhook "${wh.name}" (#${wh.id}): ${errMessage(err)}`)
    }
  }
  return { pipelineIds, failures }
}

const errMessage = (err: unknown): string => (err instanceof Error ? err.message : String(err))
