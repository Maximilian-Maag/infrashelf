/**
 * Read the portal's own state out of Postgres and render it as Prometheus text
 * (#548: the metric source #117 asks for, and the thing the two dashboards read).
 *
 * ── What this is, and what it is not ────────────────────────────────────────
 *
 * Every series here is a fact the portal already stores. That is deliberate:
 * the alternative — instrumenting the request path with counters — answers
 * questions about the portal itself, and a scrape of two pods answers each of
 * them twice (the counters are per process, and Prometheus has no way to know
 * that). Which of those two things a deployment wants is a deployment decision,
 * so this slice ships the one that needs no such decision and is true wherever
 * it is scraped.
 *
 * ── The two labels that mean "unknown" ──────────────────────────────────────
 *
 * `verdict="never"` and the ABSENCE of a drift/refresh series both stand for
 * "the portal has not been told". That distinction is the whole reason #108 and
 * #110 store nullable columns rather than defaults, and it survives into the
 * metrics: an element nothing has checked must not appear on a dashboard as an
 * element with nothing wrong. Prometheus's own idiom for this is absence — a
 * series that does not exist cannot be in a `count by ()` — and a "never" bucket
 * is only used where the count has to include it to be a total.
 *
 * ── Nothing secret reaches a label ──────────────────────────────────────────
 *
 * Labels are element/project/environment ids, statuses, timestamps, an
 * integration's kind and its operator-chosen name. Not parameters, not outputs,
 * and not a credential: `parameters` is where a `sensitive` flag lives, and a
 * metrics endpoint is scraped by a monitoring system with no idea which of those
 * values a customer marked private. The columns are named explicitly in each
 * query below for the same reason `publicColumns` exists in the integrations
 * service — a `select()` with no arguments hands out every column the table has,
 * including the ones added after this was written.
 */
import { isNotNull, sql } from 'drizzle-orm'
import { db } from '@/lib/db/client'
import { infrastructureElements, integrations, orders, projects } from '@/lib/db/schema'
import type { MetricSample } from './catalog'
import { renderPrometheus } from './render'

/** The states an integration can be read as being in, in the order a panel shows them. */
export const INTEGRATION_HEALTH_STATES = ['ok', 'failing', 'never_probed', 'disabled'] as const
export type IntegrationHealthState = (typeof INTEGRATION_HEALTH_STATES)[number]

/**
 * Which state a stored health record is in.
 *
 * `never_probed` is separated from `ok` on purpose, and it is the case that
 * makes this function worth having: `lastError` is NULL both for an integration
 * that was reached and for one nobody has ever tried, and reading the first
 * NULL as health is exactly the confusion #111 opens with ("an integration that
 * is silently unreachable is worse than none").
 *
 * `disabled` outranks the health record: an operator switching an integration
 * off is saying it should not be contacted, so its last failure is history
 * rather than current state.
 */
export const integrationHealthState = (row: {
  enabled: boolean
  lastContactedAt: Date | null
  lastError: string | null
}): IntegrationHealthState => {
  if (!row.enabled) return 'disabled'
  if (row.lastError !== null) return 'failing'
  return row.lastContactedAt === null ? 'never_probed' : 'ok'
}

/**
 * Unix time in seconds, which is what Prometheus wants.
 *
 * Floored rather than kept as a fraction: these are stored to the millisecond
 * by Postgres, and a sub-second timestamp in a scrape is precision nobody asked
 * for on a gauge whose whole use is subtraction.
 */
const seconds = (at: Date): number => Math.floor(at.getTime() / 1000)

/**
 * Portal-wide means "not bound to an environment" (#111), and Prometheus has no
 * NULL label value.
 *
 * 0 rather than the empty string: an empty label value is legal but is what a
 * broken exporter emits, and a panel selector for it reads as a bug. Environment
 * ids start at 1, so 0 is unambiguous.
 */
const PORTAL_WIDE = 0

/**
 * A project id an element belongs to, as a label.
 *
 * Element, project and environment ids are all part of every per-element series
 * rather than only on `element_info`, because a dashboard variable in Grafana
 * interpolates into a SELECTOR: `{element_id="$element_id"}` has to be able to
 * find its own series, and a filter that has to be joined to another series
 * cannot be written as one.
 */
const elementScope = (row: {
  id: number
  projectId: number
  environmentId: number
}): Record<string, number> => ({
  element_id: row.id,
  project_id: row.projectId,
  environment_id: row.environmentId,
})

/** One sample's worth of an element's drift record, or nothing when it has none. */
const driftSamples = (row: {
  id: number
  projectId: number
  environmentId: number
  driftDetectedAt: Date | null
  driftSummary: { resources: unknown[] } | null
}): MetricSample[] => {
  if (row.driftDetectedAt === null) return []
  return [
    { name: 'infrashelf_element_drifted', labels: elementScope(row), value: 1 },
    {
      name: 'infrashelf_element_drift_changes',
      labels: elementScope(row),
      value: row.driftSummary?.resources.length ?? 0,
    },
  ]
}

/**
 * Gather everything and render it.
 *
 * `now` is a parameter so a test can pin the generated-at sample; the route
 * passes nothing.
 */
export const collectPortalMetrics = async (now: Date = new Date()): Promise<string> => {
  const samples: MetricSample[] = [
    { name: 'infrashelf_metrics_generated_timestamp_seconds', value: seconds(now) },
  ]

  const elementRows = await db
    .select({
      id: infrastructureElements.id,
      orderId: infrastructureElements.orderId,
      projectId: infrastructureElements.projectId,
      environmentId: infrastructureElements.environmentId,
      productId: infrastructureElements.productId,
      status: infrastructureElements.status,
      sequence: infrastructureElements.sequence,
      lastRefreshedAt: infrastructureElements.lastRefreshedAt,
      lastRefreshOutcome: infrastructureElements.lastRefreshOutcome,
      driftDetectedAt: infrastructureElements.driftDetectedAt,
      driftSummary: infrastructureElements.driftSummary,
      policyCheckedAt: infrastructureElements.policyCheckedAt,
      policyOutcome: infrastructureElements.policyOutcome,
    })
    .from(infrastructureElements)

  for (const row of elementRows) {
    samples.push({
      name: 'infrashelf_element_info',
      labels: {
        ...elementScope(row),
        order_id: row.orderId,
        product_id: row.productId,
        status: row.status,
        sequence: row.sequence,
      },
      value: 1,
    })
    samples.push(...driftSamples(row))

    // Absent rather than 0 when nothing has checked it: `drifted` is only
    // emitted for an element with drift, and an element that is merely clean
    // still has an outcome, so the pair reads as "checked at T, and here is what
    // it said".
    if (row.lastRefreshedAt !== null) {
      samples.push({
        name: 'infrashelf_element_last_refresh_timestamp_seconds',
        labels: { ...elementScope(row), outcome: row.lastRefreshOutcome ?? 'unknown' },
        value: seconds(row.lastRefreshedAt),
      })
    }

    samples.push({
      name: 'infrashelf_element_policy_verdict',
      labels: { ...elementScope(row), verdict: row.policyOutcome ?? 'never' },
      value: 1,
    })
    if (row.policyCheckedAt !== null) {
      samples.push({
        name: 'infrashelf_element_policy_checked_timestamp_seconds',
        labels: elementScope(row),
        value: seconds(row.policyCheckedAt),
      })
    }
  }

  const projectRows = await db.select({ id: projects.id, name: projects.name }).from(projects)
  for (const row of projectRows) {
    samples.push({
      name: 'infrashelf_project_info',
      labels: { project_id: row.id, name: row.name },
      value: 1,
    })
  }

  const elementsByStatus = await db
    .select({
      projectId: infrastructureElements.projectId,
      status: infrastructureElements.status,
      count: sql<number>`count(*)::int`,
    })
    .from(infrastructureElements)
    .groupBy(infrastructureElements.projectId, infrastructureElements.status)

  for (const row of elementsByStatus) {
    samples.push({
      name: 'infrashelf_project_elements',
      labels: { project_id: row.projectId, status: row.status },
      value: row.count,
    })
  }

  const verdictsByProject = await db
    .select({
      projectId: infrastructureElements.projectId,
      verdict: infrastructureElements.policyOutcome,
      count: sql<number>`count(*)::int`,
    })
    .from(infrastructureElements)
    .groupBy(infrastructureElements.projectId, infrastructureElements.policyOutcome)

  for (const row of verdictsByProject) {
    // The NULL group is the "never" bucket, and it is kept in this aggregate
    // rather than dropped: a project whose elements have never been evaluated is
    // the case the compliance panel exists to show, and leaving it out would
    // make the total disagree with the element count beside it.
    samples.push({
      name: 'infrashelf_project_policy_verdicts',
      labels: { project_id: row.projectId, verdict: row.verdict ?? 'never' },
      value: row.count,
    })
  }

  const driftedByProject = await db
    .select({
      projectId: infrastructureElements.projectId,
      count: sql<number>`count(*)::int`,
    })
    .from(infrastructureElements)
    .where(isNotNull(infrastructureElements.driftDetectedAt))
    .groupBy(infrastructureElements.projectId)

  for (const row of driftedByProject) {
    samples.push({
      name: 'infrashelf_project_drifted_elements',
      labels: { project_id: row.projectId },
      value: row.count,
    })
  }

  const ordersByProject = await db
    .select({
      projectId: orders.projectId,
      status: orders.status,
      count: sql<number>`count(*)::int`,
    })
    .from(orders)
    .groupBy(orders.projectId, orders.status)

  for (const row of ordersByProject) {
    samples.push({
      name: 'infrashelf_project_orders',
      labels: { project_id: row.projectId, status: row.status },
      value: row.count,
    })
  }

  const ordersByEnvironment = await db
    .select({
      status: orders.status,
      environmentId: orders.environmentId,
      count: sql<number>`count(*)::int`,
    })
    .from(orders)
    .groupBy(orders.status, orders.environmentId)

  for (const row of ordersByEnvironment) {
    samples.push({
      name: 'infrashelf_orders',
      labels: { status: row.status, environment_id: row.environmentId },
      value: row.count,
    })
  }

  const integrationRows = await db
    .select({
      kind: integrations.kind,
      name: integrations.name,
      environmentId: integrations.environmentId,
      enabled: integrations.enabled,
      lastContactedAt: integrations.lastContactedAt,
      lastError: integrations.lastError,
    })
    .from(integrations)

  for (const row of integrationRows) {
    samples.push({
      name: 'infrashelf_integration_health',
      labels: {
        kind: row.kind,
        name: row.name,
        environment_id: row.environmentId ?? PORTAL_WIDE,
        state: integrationHealthState(row),
      },
      value: 1,
    })
    if (row.lastContactedAt !== null) {
      samples.push({
        name: 'infrashelf_integration_last_success_timestamp_seconds',
        labels: {
          kind: row.kind,
          name: row.name,
          environment_id: row.environmentId ?? PORTAL_WIDE,
        },
        value: seconds(row.lastContactedAt),
      })
    }
  }

  return renderPrometheus(samples)
}
