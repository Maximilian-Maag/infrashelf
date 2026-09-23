import { integrationUrl } from '@/lib/integrations/http'

/**
 * Deep links into the Grafana dashboards for an element and for a project
 * (issue #546, the first bullet of #111's Grafana item).
 *
 * ── Why the portal builds this rather than the browser ──────────────────────
 *
 * The Grafana integration is an admin-only row: `/api/admin/integrations` is
 * root-only, like CI sources, because the rows hold credentials to systems that
 * can provision and destroy. The base URL is the only part of that row a project
 * manager has any business seeing, and reading it from an admin API is not a way
 * to get it. So the backend resolves the integration once and hands out the
 * finished URL, which also keeps the agreement about variable names in one place
 * — with a test on it, because a dashboard that disagrees with the portal opens
 * filtered by nothing and looks like a working link.
 *
 * ── What is deliberately NOT here ───────────────────────────────────────────
 *
 * The credential, the username, and the name of the integration's credentials
 * store: a link needs a base URL and nothing else, so nothing else is read (see
 * `resolveIntegrationEndpoint`). Embedding panels, alerting back into the portal
 * and the metrics endpoint #117 also asks for are not this slice: they need the
 * auth and CSP decisions the epic describes, and a link needs none of them.
 *
 * ── Dashboards as code ──────────────────────────────────────────────────────
 *
 * These UIDs name dashboards the platform ships and provisions from the
 * repository, for the reason the epic gives: hand-made dashboards drift exactly
 * like hand-made infrastructure, which is the problem #108 exists to solve. A
 * deployment that has not provisioned them gets a link Grafana answers 404 for —
 * visible, and fixable by deploying them. A link into nothing at all would be
 * invisible, which is worse.
 */
export const ELEMENT_DASHBOARD_UID = 'infrashelf-element'
export const PROJECT_DASHBOARD_UID = 'infrashelf-project'

/**
 * Grafana addresses a dashboard as `/d/<uid>/<slug>`. The slug is optional in a
 * URL a human edits, but the short form without one is served by a redirect the
 * deep link must not depend on.
 */
const ELEMENT_DASHBOARD_SLUG = 'element'
const PROJECT_DASHBOARD_SLUG = 'project'

/**
 * The window the link opens on. Six hours rather than Grafana's default of one:
 * someone opening this has just been told something is wrong, and the useful
 * question is "what has it been doing since it was deployed", not "what did it do
 * in the last hour".
 */
const RANGE_FROM = 'now-6h'
const RANGE_TO = 'now'

/** A dashboard link the portal can render, or `null` when there is none to render. */
export interface ObservabilityLink {
  url: string
  /** Which dashboard it is, so a caller can say so without parsing the URL. */
  dashboardUid: string
}

/**
 * Build one link, or `null` when the base URL cannot make one.
 *
 * Never throws. `integrationUrl` refuses a non-HTTP(S) base URL (a `file:` or a
 * `data:` URL an operator pasted), and a row from before that validator existed
 * is exactly the case that matters: an element page must not answer 500 because
 * an admin typed a bad URL into an integration nobody has looked at since. No
 * link is the honest rendering of "this cannot be reached from here", and the
 * probe's recorded error is where the reason lives.
 */
const dashboardLink = (
  baseUrl: string,
  dashboardUid: string,
  slug: string,
  variables: Record<string, string | number>,
): ObservabilityLink | null => {
  try {
    const url = integrationUrl(baseUrl, `/d/${dashboardUid}/${slug}`)
    for (const [name, value] of Object.entries(variables)) {
      url.searchParams.set(`var-${name}`, String(value))
    }
    url.searchParams.set('from', RANGE_FROM)
    url.searchParams.set('to', RANGE_TO)
    return { url: url.toString(), dashboardUid }
  } catch {
    return null
  }
}

/**
 * The dashboard for one element, filtered by every identifier the portal has for
 * it — element, order, project and environment — so the same link answers "this
 * machine" and "this machine in its neighbourhood".
 *
 * `environmentId` is nullable because a global dashboard may be asked about an
 * element whose environment is not known at the call site; when it is absent the
 * variable is omitted rather than sent empty, which in Grafana means "match
 * nothing" and would open an empty dashboard.
 */
export const elementDashboardLink = (
  baseUrl: string,
  ids: { elementId: number; orderId: number; projectId: number; environmentId: number | null },
): ObservabilityLink | null =>
  dashboardLink(baseUrl, ELEMENT_DASHBOARD_UID, ELEMENT_DASHBOARD_SLUG, {
    element_id: ids.elementId,
    order_id: ids.orderId,
    project_id: ids.projectId,
    ...(ids.environmentId === null ? {} : { environment_id: ids.environmentId }),
  })

/**
 * The dashboard for one project.
 *
 * Filtered by the project alone. A project spans environments, so an environment
 * variable here would silently hide every machine outside the one somebody
 * happened to resolve — the project view is where "all of my machines" is asked.
 */
export const projectDashboardLink = (
  baseUrl: string,
  ids: { projectId: number },
): ObservabilityLink | null =>
  dashboardLink(baseUrl, PROJECT_DASHBOARD_UID, PROJECT_DASHBOARD_SLUG, {
    project_id: ids.projectId,
  })
