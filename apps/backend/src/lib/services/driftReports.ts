import { and, eq, inArray, isNull, lt, notInArray, or, sql } from 'drizzle-orm'
import { db } from '@/lib/db/client'
import { evaluateElementPolicies } from '@/lib/services/elementPolicy'
import type { StackStep } from '@infrashelf/types'
import {
  infrastructureElements, unclaimedStates, driftReportState, pipelineStacks,
  type DriftSummary,
} from '@/lib/db/schema'
import { logAudit } from '@/lib/audit'

/**
 * Recording what the scheduled drift pipeline found (#108).
 *
 * The portal does not ask. A pipeline in `infra-templates` runs on GitLab's own
 * schedule, takes the work list from `driftTargets`, runs
 * `plan -refresh-only -detailed-exitcode` against each state file, and POSTs one
 * report.
 *
 * That inversion is what makes this small. The push design in #108 needed
 * refresh-specific pipeline tracking (`pipeline_id` is already two-phase-owned
 * by provisioning and teardown), a third match branch in the webhook handler (a
 * refreshing element stays 'active' and matches neither existing predicate),
 * and log scraping to recover `-detailed-exitcode` from a pipeline status that
 * only carries success or failed. None of that exists here because none of it
 * is needed.
 *
 * A report is UNTRUSTED INPUT. It arrives from CI over a shared secret, and the
 * rules below are the whole of what it may do:
 *
 *  - it may never create, delete or decommission an element;
 *  - it may only write the four refresh columns, and only on elements that are
 *    'active' — an element mid-teardown is not something a stale plan should
 *    annotate;
 *  - it may only move an element's refresh state FORWARD in time;
 *  - a state key it does not recognise is recorded as an observation and
 *    nothing else.
 */

/** What a plan concluded about one state file. */
export type RefreshOutcome = 'clean' | 'drifted' | 'locked' | 'error'

export interface StateResult {
  stateKey: string
  outcome: RefreshOutcome
  summary?: DriftSummary
}

export interface DriftReport {
  checkedAt: Date
  results: StateResult[]
  /**
   * The run planned every entry of the work list it was given.
   *
   * Only then may absent observations be reconciled away — see
   * `recordDriftReport`. Defaults to false, so a caller that cannot promise it
   * gets the additive behaviour and never deletes anything.
   */
  complete?: boolean
}

export interface RecordedReport {
  /** Elements whose refresh state this report moved. */
  matched: number
  /** Reported keys no element in the estate accounts for. */
  unclaimed: number
  /** Reported keys owned only by an element that is no longer active. */
  ignored: number
  /** Elements skipped because their recorded check is already newer. */
  stale: number
  /**
   * Elements policy was asked about by this run (#110, slice 6).
   *
   * Reported back for the same reason the counts beside it are: a run whose log
   * says what the portal did with its report. Zero here means no engine is
   * configured for these elements' environments, which is a different thing from
   * an engine that answered.
   */
  policyEvaluated: number
  /** Of those, how many the engine could not be asked about (`unavailable`). */
  policyUnavailable: number
}

/**
 * How a step's state file is named.
 *
 * `state_keys` records ONE base per stack — the `TF_STATE_NAME` handed to the
 * trigger — but a stack fans out to a job per step, and `generate_stack.py`
 * gives each its own state under `<base>-<stateSuffix>`. So the base is not a
 * state key; it is the stem of one per step.
 *
 * Getting this wrong is invisible from either end on its own: the pipeline
 * would plan real state files and the portal would match none of them, and the
 * whole estate would report as unclaimed while every individual part looked
 * correct. It is one line, and it is the contract between two repositories.
 */
export const composeStateKey = (base: string, stateSuffix: string): string => `${base}-${stateSuffix}`

/** What both sides need of an element to resolve its stacks. */
interface StackOwner {
  productId: number
  environmentId: number
}

/**
 * The stack an element's recorded key belongs to, or null.
 *
 * The scoping is the point. The lookup is global — one query for every stack
 * rather than one per element — so the product and environment check the
 * per-element query used to give for free has to be explicit here. Both the work
 * list and the matcher go through this, because a key the pipeline is never
 * handed must not be a key the portal will accept back.
 */
const stackFor = (
  stacks: Map<string, { productId: number; environmentId: number; steps: StackStep[] | null }>,
  stackId: string,
  element: StackOwner,
) => {
  const stack = stacks.get(stackId)
  if (!stack) return null
  if (stack.productId !== element.productId || stack.environmentId !== element.environmentId) return null
  return stack
}

/** The stacks, once, indexed by id — `driftTargets` and the matcher both walk them. */
const stacksById = async () => {
  const stacks = await db
    .select({
      id: pipelineStacks.id,
      productId: pipelineStacks.productId,
      environmentId: pipelineStacks.environmentId,
      steps: pipelineStacks.steps,
    })
    .from(pipelineStacks)
  return new Map(stacks.map((s) => [String(s.id), s]))
}

interface Ownership {
  elementId: number
  active: boolean
}

/**
 * Every state key the estate can account for, and who owns it.
 *
 * Built rather than queried because the key is composed, not stored: a jsonb
 * predicate can match the recorded base but not `<base>-<suffix>`, and the
 * suffixes live on the stack. Two queries, both unfiltered — the estate is
 * bounded by the number of active elements, and the alternative is a query per
 * reported key.
 *
 * Non-active owners are included on purpose. "No element owns this" and "the
 * element that owns this is being torn down" are different answers, and only
 * the first one is an observation worth keeping.
 */
const stateKeyOwners = async (): Promise<Map<string, Ownership[]>> => {
  const [elements, stacks] = await Promise.all([
    db
      .select({
        id: infrastructureElements.id,
        status: infrastructureElements.status,
        productId: infrastructureElements.productId,
        environmentId: infrastructureElements.environmentId,
        stateKeys: infrastructureElements.stateKeys,
      })
      .from(infrastructureElements)
      .where(sql`${infrastructureElements.stateKeys} <> '{}'::jsonb`),
    stacksById(),
  ])

  const owners = new Map<string, Ownership[]>()
  const claim = (key: string, owner: Ownership) => {
    const existing = owners.get(key)
    if (existing) existing.push(owner)
    else owners.set(key, [owner])
  }

  for (const element of elements) {
    const owner: Ownership = { elementId: element.id, active: element.status === 'active' }
    for (const [stackId, base] of Object.entries(element.stateKeys ?? {})) {
      // The bare base is tolerated as well as the composed keys. Nothing in the
      // current pipeline reports it, but a single-step deployment that wrote
      // state under the base directly is accounted for rather than surfacing as
      // a phantom unclaimed state.
      claim(base, owner)
      for (const step of stackFor(stacks, stackId, element)?.steps ?? []) {
        claim(composeStateKey(base, step.stateSuffix), owner)
      }
    }
  }
  return owners
}

/**
 * Which outcome an element takes when its state files disagree.
 *
 * An element owns one state file per step, and they are planned independently.
 * Applying each result in turn made the element's final reading depend on the
 * ORDER of the array — a VM that drifted followed by a clean DNS record read as
 * clean, and the drift was cleared by a plan that never looked at it.
 *
 * So the results are aggregated first and the element written once:
 *
 *  - `drifted` wins outright. Drift in any part of an element is drift.
 *  - `error` and `locked` beat `clean`, because an element is only clean when
 *    every one of its states was actually read. Silence must not read as health
 *    — the point #108 opens with.
 *  - `error` over `locked`: losing a race with an apply is expected, a plan that
 *    could not run at all is not.
 */
const OUTCOME_RANK: Record<RefreshOutcome, number> = { drifted: 3, error: 2, locked: 1, clean: 0 }

/** Merged resources for an element, capped the same way one result is. */
const MAX_SUMMARY_RESOURCES = 200

const aggregate = (results: StateResult[]): { outcome: RefreshOutcome; summary: DriftSummary } => {
  let outcome: RefreshOutcome = 'clean'
  for (const result of results) {
    if (OUTCOME_RANK[result.outcome] > OUTCOME_RANK[outcome]) outcome = result.outcome
  }
  const resources = results
    .filter((r) => r.outcome === 'drifted')
    .flatMap((r) => r.summary?.resources ?? [])
    .slice(0, MAX_SUMMARY_RESOURCES)
  return { outcome, summary: { resources } }
}

export const recordDriftReport = async (report: DriftReport): Promise<RecordedReport> => {
  const owners = await stateKeyOwners()

  // Partition the report before writing anything: which element each result
  // belongs to, and which results belong to no element that can take them.
  const perElement = new Map<number, StateResult[]>()
  const unknown: StateResult[] = []
  let ignored = 0

  for (const result of report.results) {
    const claimants = owners.get(result.stateKey) ?? []
    const active = claimants.filter((c) => c.active)
    if (active.length === 0) {
      // Owned, but by an element on its way out. Not an observation: the portal
      // knows exactly what this state is, and a teardown is about to remove it.
      if (claimants.length > 0) ignored += 1
      else unknown.push(result)
      continue
    }
    for (const owner of active) {
      const bucket = perElement.get(owner.elementId)
      if (bucket) bucket.push(result)
      else perElement.set(owner.elementId, [result])
    }
  }

  const matchedElements: { id: number; outcome: RefreshOutcome; summary: DriftSummary }[] = []
  let stale = 0

  for (const [elementId, results] of perElement) {
    const { outcome, summary } = aggregate(results)
    const drifted = outcome === 'drifted'

    const rows = await db
      .update(infrastructureElements)
      .set({
        lastRefreshedAt: report.checkedAt,
        lastRefreshOutcome: outcome,
        // Cleared only on a clean report so the column describes CURRENT drift,
        // and left alone on 'locked' or 'error': a plan that could not run has
        // not established that the drift went away.
        ...(drifted
          ? { driftDetectedAt: report.checkedAt, driftSummary: summary }
          : outcome === 'clean'
            ? { driftDetectedAt: null, driftSummary: null }
            : {}),
      })
      .where(
        and(
          eq(infrastructureElements.id, elementId),
          // Re-checked at the write. The partition above read the status a
          // moment ago; a teardown starting in between must still not be
          // annotated by a plan that predates it.
          eq(infrastructureElements.status, 'active'),
          // Monotonic. A retried job POSTing an older run's findings must not
          // restore an obsolete `clean` over a newer `drifted` — and a report
          // applied twice is a no-op rather than a second audit entry.
          or(
            isNull(infrastructureElements.lastRefreshedAt),
            lt(infrastructureElements.lastRefreshedAt, report.checkedAt),
          ),
        ),
      )
      .returning({ id: infrastructureElements.id })

    if (rows.length === 0) stale += 1
    else matchedElements.push({ id: elementId, outcome, summary })
  }

  /*
   * Continuous policy evaluation (#110, slice 6), for the elements this run
   * actually moved.
   *
   * Here rather than in the reporting pipeline because the pipeline knows state
   * files and the portal knows the order behind each element — its parameters, its
   * size, the requester — and a policy about "whose VM is this" cannot be answered
   * from a plan. Report-only: nothing below this line reads the verdict, and the
   * columns it writes are for the element page (see `elementPolicy.ts`).
   *
   * Awaited rather than fired and forgotten: the caller is a scheduler that wants
   * to know the portal is done with its report, and an unhandled rejection in a
   * background call is the one way a sweep could break without saying so. Every
   * failure inside is a stored `unavailable` verdict, never a throw.
   */
  const policy = await evaluateElementPolicies(
    matchedElements.map((e) => e.id),
    report.checkedAt,
  )

  for (const result of unknown) {
    await db
      .insert(unclaimedStates)
      .values({
        stateKey: result.stateKey,
        firstSeenAt: report.checkedAt,
        lastSeenAt: report.checkedAt,
        outcome: result.outcome,
        summary: result.summary ?? null,
      })
      .onConflictDoUpdate({
        target: unclaimedStates.stateKey,
        // `first_seen_at` is deliberately not touched: how long a state has been
        // unaccounted for is the useful part of the record.
        set: { lastSeenAt: report.checkedAt, outcome: result.outcome, summary: result.summary ?? null },
      })
  }

  // A state key that has since been claimed — an element adopted or recreated —
  // stops being an observation. Left behind it would report a problem that is
  // no longer one.
  const accountedFor = report.results
    .map((r) => r.stateKey)
    .filter((key) => !unknown.some((u) => u.stateKey === key))
  if (accountedFor.length > 0) {
    await db.delete(unclaimedStates).where(inArray(unclaimedStates.stateKey, accountedFor))
  }

  /*
   * An observation is only as current as the last run that saw it.
   *
   * The report is derived from the work list the portal itself handed out, so a
   * key that stops appearing is a key the portal has stopped asking about — the
   * element went away, or its stack did. The state file may well still exist,
   * but nothing is checking it any more and the row would sit in the admin UI
   * for ever describing a check that no longer runs.
   *
   * Only on a run that promises it planned the whole list. A partial run's
   * silence about a key means nothing at all, which is why `complete` defaults
   * to false rather than being inferred.
   */
  if (report.complete) {
    const seen = report.results.map((r) => r.stateKey)
    await db.delete(unclaimedStates).where(seen.length > 0 ? notInArray(unclaimedStates.stateKey, seen) : undefined)
  }

  await db
    .update(driftReportState)
    .set({
      lastReportAt: report.checkedAt,
      elementsReported: matchedElements.length,
      unclaimedReported: unknown.length,
    })
    .where(
      and(
        eq(driftReportState.id, 1),
        // Same monotonicity, for the same reason: a late retry must not make the
        // whole picture look staler than it is.
        or(isNull(driftReportState.lastReportAt), lt(driftReportState.lastReportAt, report.checkedAt)),
      ),
    )

  // Only when something actually drifted. A clean run every fifteen minutes
  // would bury the audit log, which is how an audit log stops being read.
  const drifted = matchedElements.filter((m) => m.outcome === 'drifted')
  if (drifted.length > 0) {
    await logAudit(
      null,
      'infra.drift_detected',
      drifted[0].id,
      `Drift reported on ${drifted.length} element(s): ` +
        drifted.map((d) => `#${d.id} (${d.summary.resources.length} resources)`).join(', '),
    )
  }

  return {
    matched: matchedElements.length,
    unclaimed: unknown.length,
    ignored,
    stale,
    policyEvaluated: policy.evaluated,
    policyUnavailable: policy.unavailable,
  }
}

/** How stale the whole picture is, for the admin UI to show. */
export const driftReportStatus = async (): Promise<{
  lastReportAt: Date | null
  elementsReported: number
  unclaimedReported: number
  neverReported: number
}> => {
  const [state] = await db.select().from(driftReportState).where(eq(driftReportState.id, 1))
  const [{ n }] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(infrastructureElements)
    .where(and(eq(infrastructureElements.status, 'active'), sql`${infrastructureElements.lastRefreshedAt} IS NULL`))

  return {
    lastReportAt: state?.lastReportAt ?? null,
    elementsReported: state?.elementsReported ?? 0,
    unclaimedReported: state?.unclaimedReported ?? 0,
    // Active elements nothing has ever said anything about. Distinct from
    // "reported clean" and the number an operator actually needs.
    neverReported: n,
  }
}

/** One element's worth of work for the reporting pipeline. */
export interface DriftTarget {
  elementId: number
  /** The base state name; each step appends its own `stateSuffix`. */
  stateName: string
  stack: { template: string; stateSuffix: string }[]
  /** What this element was provisioned with, so a plan can run against it. */
  variables: Record<string, string>
}

/**
 * The work list the scheduled pipeline asks for (#108).
 *
 * `plan -refresh-only` needs the template AND the variables the apply used —
 * a state file alone does not say which module produced it or what its inputs
 * were. So the portal has to hand both over, and this is that endpoint's data.
 *
 * It is worth being plain about what that means: CI already receives exactly
 * these variables when the element is provisioned, so this is not a new class
 * of exposure — but it is the whole estate at once rather than one order's
 * worth. Hence: behind the same shared secret as the report itself, ACTIVE
 * elements only, and nothing about an element whose teardown has started.
 *
 * Elements with no recorded `state_keys` are omitted rather than guessed at.
 * Those predate #200, and recomputing the key from today's `stateKeyParam`
 * would address a state file that was never created — the exact bug #200 fixed.
 */
export const driftTargets = async (): Promise<DriftTarget[]> => {
  // One query for the stacks, not one per element: this runs over the whole
  // active estate, and the per-element version was a round trip each.
  const [elements, stacks] = await Promise.all([
    db
      .select({
        id: infrastructureElements.id,
        productId: infrastructureElements.productId,
        environmentId: infrastructureElements.environmentId,
        parameters: infrastructureElements.parameters,
        stateKeys: infrastructureElements.stateKeys,
      })
      .from(infrastructureElements)
      .where(eq(infrastructureElements.status, 'active')),
    stacksById(),
  ])

  const targets: DriftTarget[] = []
  for (const element of elements) {
    for (const [stackId, stateName] of Object.entries(element.stateKeys ?? {})) {
      // A stack deleted since the element was provisioned, or one that no longer
      // belongs to this element's product and environment. Its state file still
      // exists, so it will turn up as an unclaimed state — which is the honest
      // outcome, and better than planning it against a guess.
      const stack = stackFor(stacks, stackId, element)
      if (!stack) continue

      targets.push({
        elementId: element.id,
        stateName,
        stack: (stack.steps ?? []).map((step) => ({
          template: step.template,
          stateSuffix: step.stateSuffix,
        })),
        variables: element.parameters ?? {},
      })
    }
  }
  return targets
}
