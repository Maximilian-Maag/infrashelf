/**
 * The metric catalogue: one declaration per series family the portal exposes
 * (#548, the metrics half of the Grafana item in #111).
 *
 * ── Why the names live in a module of their own ─────────────────────────────
 *
 * `infra/grafana/dashboards/*.json` names these metrics in its PromQL, and those
 * dashboards are provisioned from this repository into a Grafana the portal only
 * knows the URL of. So the name is a contract between two artefacts that are
 * never loaded together: a panel naming a metric the endpoint does not emit
 * renders "No data" for ever, which on a dashboard is indistinguishable from a
 * quiet estate. Nothing in Prometheus warns about it, and nothing in Grafana
 * either.
 *
 * `dashboards.test.ts` therefore reads the JSON out of `infra/grafana` and fails
 * on disagreement in EITHER direction: a panel naming an undeclared metric, or a
 * declared metric that no panel reads. The second one matters as much as the
 * first — a series nobody looks at is a query cost and a thing to keep true for
 * no reason, so it should be a decision rather than an oversight.
 *
 * ── What is deliberately NOT here ───────────────────────────────────────────
 *
 * Anything per-request: request rate, error rate, latency. Those need
 * instrumentation in the request path rather than a read of the database, and
 * live in-process counters are per replica — a Prometheus scrape of two pods
 * would double every rate unless the deployment stops load-balancing them
 * together. That is a decision about how this chart is deployed, not a line of
 * code in a route handler, so it is left out of this slice rather than guessed
 * at (#548 names it as the follow-on).
 *
 * Every family below has a value that is only ever 0, 1 or a timestamp: the
 * portal REPORTS what it knows, and the expensive questions ("is this machine
 * healthy") belong to the machine's own exporters.
 */

/**
 * The public shape of a sample, without the layering the collector uses.
 *
 * `labels` is a record rather than an array so a collector cannot emit the same
 * label name twice, which Prometheus refuses at scrape time with a parse error
 * that names no file.
 */
export interface MetricSample {
  name: MetricName
  labels?: Readonly<Record<string, string | number>>
  value: number
}

/**
 * This exporter's kinds and HELP text, in the order they are printed.
 *
 * The order is the order of the output, so a diff of two scrapes is readable
 * without sorting it first.
 */
export const CATALOG = [
  {
    name: 'infrashelf_metrics_generated_timestamp_seconds',
    type: 'gauge',
    help: 'Unix time at which this response was assembled in the backend process. A dashboard renders its age to show a scrape that stopped arriving — a stale dashboard and a healthy estate look identical otherwise.',
  },
  {
    name: 'infrashelf_element_info',
    type: 'gauge',
    help: 'Always 1. The identifiers of one infrastructure element as labels, so a dashboard can filter on any of them and label_values() can offer them as variables. Value carries no information.',
  },
  {
    name: 'infrashelf_element_drifted',
    type: 'gauge',
    help: '1 when the last drift report (#108) found changes for this element, 0 when it found none. An element never reported on is ABSENT rather than 0: "never heard" is not "checked and clean".',
  },
  {
    name: 'infrashelf_element_drift_changes',
    type: 'gauge',
    help: 'How many resources the last drift report listed as changed for this element. Only emitted for elements that have drift, since a report that found none lists nothing.',
  },
  {
    name: 'infrashelf_element_last_refresh_timestamp_seconds',
    type: 'gauge',
    help: 'Unix time of the last drift check that reached this element, labelled with its outcome. Absent for an element nothing has checked yet.',
  },
  {
    name: 'infrashelf_element_policy_verdict',
    type: 'gauge',
    help: 'Always 1. The verdict of the last continuous policy evaluation (#110) as a label, so count by (verdict) is the compliance summary. verdict is "never" when the element has not been evaluated, which is deliberately not "allow".',
  },
  {
    name: 'infrashelf_element_policy_checked_timestamp_seconds',
    type: 'gauge',
    help: 'Unix time at which this element was last evaluated against policy. Absent for an element nothing has evaluated yet.',
  },
  {
    name: 'infrashelf_project_info',
    type: 'gauge',
    help: 'Always 1. The name of one project as a label, for label_values() and for a panel title that says whose estate it is.',
  },
  {
    name: 'infrashelf_project_elements',
    type: 'gauge',
    help: 'How many infrastructure elements this project has, by lifecycle status. A project with none has no series rather than a zero.',
  },
  {
    name: 'infrashelf_project_drifted_elements',
    type: 'gauge',
    help: 'How many of this project’s elements the last drift report found changes for. Counts only elements whose report said "drifted", so it is the number a project manager has to answer for.',
  },
  {
    name: 'infrashelf_project_policy_verdicts',
    type: 'gauge',
    help: 'How many of this project’s elements are in each policy verdict, including the "never" bucket of elements nothing has evaluated.',
  },
  {
    name: 'infrashelf_project_orders',
    type: 'gauge',
    help: 'How many orders this project has placed, by status. "pending" is the approval queue, "scheduled" and "provisioning" are in flight.',
  },
  {
    name: 'infrashelf_orders',
    type: 'gauge',
    help: 'How many orders exist, by status and environment — the portal-wide queue depth (#117 asks for it). "pending" is the approval queue, "scheduled" is waiting for its window, "provisioning" is in flight.',
  },
  {
    name: 'infrashelf_integration_health',
    type: 'gauge',
    help: 'Always 1. The health of one configured external system (#111) as a label: ok (last probe reached it), failing (last probe did not), never_probed, or disabled. An integration that is silently unreachable is worse than none, so "never_probed" is a state and not a gap.',
  },
  {
    name: 'infrashelf_integration_last_success_timestamp_seconds',
    type: 'gauge',
    help: 'Unix time at which a probe last reached this integration successfully. Absent when none ever has — the age of this series is the only honest answer to "is this still working".',
  },
] as const satisfies readonly { name: string; type: 'gauge'; help: string }[]

export type MetricName = (typeof CATALOG)[number]['name']

/** Every declared name, for the tests and for a deployment that wants to filter. */
export const METRIC_NAMES: readonly MetricName[] = CATALOG.map((m) => m.name)
