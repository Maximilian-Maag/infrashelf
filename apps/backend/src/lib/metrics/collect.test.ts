import { describe, it, expect } from 'vitest'
import { db } from '@/lib/db/client'
import { integrations } from '@/lib/db/schema'
import { collectPortalMetrics, integrationHealthState } from './collect'
import {
  createUser,
  createCategory,
  createProduct,
  createCiSource,
  createEnvironment,
  createProject,
  createOrder,
  createInfraElement,
} from '@/test/helpers'

/**
 * What the portal actually says about itself (#548).
 *
 * Asserted on the rendered text rather than on an intermediate array, because
 * the text is what a Prometheus sees and the rules it has to satisfy — a label
 * set, a value, the presence or absence of a series — are exactly the rules a
 * dashboard is written against.
 */

/** The samples of one family, without its HELP/TYPE lines. */
const seriesOf = (text: string, metric: string): string[] =>
  text
    .split('\n')
    .filter((line) => line.startsWith(`${metric}{`) || line.startsWith(`${metric} `))

const seed = async () => {
  const user = await createUser()
  const category = await createCategory()
  const product = await createProduct(category.id)
  const ciSource = await createCiSource()
  const environment = await createEnvironment(ciSource.id)
  const project = await createProject(user.id, 'Payments')
  const order = await createOrder(project.id, product.id, environment.id, user.id)
  return { user, category, product, ciSource, environment, project, order }
}

/** The value the collector is expected to print for a moment in time. */
const unix = (iso: string): number => Math.floor(new Date(iso).getTime() / 1000)

describe('collectPortalMetrics', () => {
  it('describes an element by its identifiers, not by its contents', async () => {
    const { user, product, environment, project, order } = await seed()
    const element = await createInfraElement(order.id, project.id, environment.id, product.id, {
      // A parameter a customer marked sensitive, and a file path: neither is a
      // label, and neither may appear anywhere in the response. A monitoring
      // system has no idea which of a product's parameters is private, so the
      // only safe rule is that the endpoint holds none of them.
      parameters: { admin_password: 'hunter2-such-a-secret', hostname: 'web-01' },
      outputs: { ip: '10.0.0.5' },
    })

    const text = await collectPortalMetrics()

    expect(text).toContain(
      `infrashelf_element_info{element_id="${element.id}",environment_id="${environment.id}",` +
        `order_id="${order.id}",product_id="${product.id}",project_id="${project.id}",` +
        `sequence="1",status="active"} 1`,
    )
    expect(text).not.toContain('hunter2-such-a-secret')
    expect(text).not.toContain('10.0.0.5')
    expect(text).not.toContain('web-01')

    // The order's user is not a label either: the dashboard filters by element,
    // project and environment, and a person's id on a metrics endpoint is an
    // identity nobody asked to publish.
    expect(text).not.toContain('user_id')
    expect(user.id).toBeGreaterThan(0)
  })

  it('reports drift as a pair, and says "never checked" by saying nothing', async () => {
    const { product, environment, project, order } = await seed()
    const drifted = await createInfraElement(order.id, project.id, environment.id, product.id, {
      lastRefreshOutcome: 'drifted',
      lastRefreshedAt: new Date('2026-09-23T10:00:00Z'),
      driftDetectedAt: new Date('2026-09-23T10:00:00Z'),
      driftSummary: { resources: [{ address: 'a', action: 'update' }, { address: 'b', action: 'create' }] },
    })
    const clean = await createInfraElement(order.id, project.id, environment.id, product.id, {
      lastRefreshOutcome: 'clean',
      lastRefreshedAt: new Date('2026-09-23T10:00:00Z'),
    })
    const unexamined = await createInfraElement(order.id, project.id, environment.id, product.id)

    const text = await collectPortalMetrics()

    expect(seriesOf(text, 'infrashelf_element_drifted')).toEqual([
      `infrashelf_element_drifted{element_id="${drifted.id}",environment_id="${environment.id}",project_id="${project.id}"} 1`,
    ])
    expect(seriesOf(text, 'infrashelf_element_drift_changes')).toEqual([
      `infrashelf_element_drift_changes{element_id="${drifted.id}",environment_id="${environment.id}",project_id="${project.id}"} 2`,
    ])

    // Both checked elements said WHEN, and what the answer was. The one nothing
    // has looked at has no series at all: on a dashboard that is "no data",
    // which is the honest rendering, while a 0 would read as "checked, no
    // drift" — the confusion #108 stores NULLs to avoid.
    expect(seriesOf(text, 'infrashelf_element_last_refresh_timestamp_seconds')).toEqual([
      `infrashelf_element_last_refresh_timestamp_seconds{element_id="${drifted.id}",environment_id="${environment.id}",outcome="drifted",project_id="${project.id}"} ${unix('2026-09-23T10:00:00Z')}`,
      `infrashelf_element_last_refresh_timestamp_seconds{element_id="${clean.id}",environment_id="${environment.id}",outcome="clean",project_id="${project.id}"} ${unix('2026-09-23T10:00:00Z')}`,
    ])
    for (const line of seriesOf(text, 'infrashelf_element_drifted')) {
      expect(line).not.toContain(`element_id="${clean.id}"`)
      expect(line).not.toContain(`element_id="${unexamined.id}"`)
    }
    expect(seriesOf(text, 'infrashelf_element_last_refresh_timestamp_seconds')).not.toHaveLength(3)
  })

  it('counts a never-evaluated element into the project’s verdicts rather than dropping it', async () => {
    const { product, environment, project, order } = await seed()
    const allowed = await createInfraElement(order.id, project.id, environment.id, product.id, {
      policyOutcome: 'allow',
      policyCheckedAt: new Date('2026-09-23T11:00:00Z'),
      policyRule: 'cost-centre-required',
    })
    await createInfraElement(order.id, project.id, environment.id, product.id)

    const text = await collectPortalMetrics()

    expect(seriesOf(text, 'infrashelf_element_policy_verdict')).toEqual([
      `infrashelf_element_policy_verdict{element_id="${allowed.id}",environment_id="${environment.id}",project_id="${project.id}",verdict="allow"} 1`,
      `infrashelf_element_policy_verdict{element_id="${allowed.id + 1}",environment_id="${environment.id}",project_id="${project.id}",verdict="never"} 1`,
    ])
    expect(seriesOf(text, 'infrashelf_element_policy_checked_timestamp_seconds')).toEqual([
      `infrashelf_element_policy_checked_timestamp_seconds{element_id="${allowed.id}",environment_id="${environment.id}",project_id="${project.id}"} ${unix('2026-09-23T11:00:00Z')}`,
    ])

    // "never" is part of the total, so the buckets add up to the element count
    // beside them — a compliance panel whose parts sum to less than the whole is
    // a panel nobody can act on.
    expect(seriesOf(text, 'infrashelf_project_policy_verdicts')).toEqual([
      `infrashelf_project_policy_verdicts{project_id="${project.id}",verdict="allow"} 1`,
      `infrashelf_project_policy_verdicts{project_id="${project.id}",verdict="never"} 1`,
    ])
  })

  it('aggregates per project for the project dashboard, and portal-wide for the queue', async () => {
    const { user, product, environment, project, order } = await seed()
    const other = await createProject(user.id, 'Analytics')

    await createOrder(project.id, product.id, environment.id, user.id, { status: 'completed' })
    await createOrder(other.id, product.id, environment.id, user.id)

    await createInfraElement(order.id, project.id, environment.id, product.id, {
      driftDetectedAt: new Date('2026-09-23T10:00:00Z'),
      driftSummary: { resources: [{ address: 'a', action: 'update' }] },
    })
    await createInfraElement(order.id, project.id, environment.id, product.id, { status: 'active' })
    await createInfraElement(order.id, project.id, environment.id, product.id, { status: 'decommissioned' })

    const text = await collectPortalMetrics()

    expect(seriesOf(text, 'infrashelf_project_info')).toContain(
      `infrashelf_project_info{name="Payments",project_id="${project.id}"} 1`,
    )
    expect(seriesOf(text, 'infrashelf_project_elements')).toEqual([
      `infrashelf_project_elements{project_id="${project.id}",status="active"} 2`,
      `infrashelf_project_elements{project_id="${project.id}",status="decommissioned"} 1`,
    ])
    expect(seriesOf(text, 'infrashelf_project_drifted_elements')).toEqual([
      `infrashelf_project_drifted_elements{project_id="${project.id}"} 1`,
    ])
    expect(seriesOf(text, 'infrashelf_project_orders')).toEqual([
      `infrashelf_project_orders{project_id="${order.projectId}",status="completed"} 1`,
      `infrashelf_project_orders{project_id="${order.projectId}",status="pending"} 1`,
      `infrashelf_project_orders{project_id="${other.id}",status="pending"} 1`,
    ])
    // A project with no elements has no series rather than a zero: absence is
    // how this format says "nothing to report", and Postgres' GROUP BY will not
    // invent the row either.
    expect(seriesOf(text, 'infrashelf_project_elements')).not.toContainEqual(
      expect.stringContaining(`project_id="${other.id}"`),
    )

    // The environment is part of the portal-wide series because that is the axis
    // an operator filters by, and it is the same number the project panel shows.
    expect(seriesOf(text, 'infrashelf_orders')).toEqual([
      `infrashelf_orders{environment_id="${environment.id}",status="completed"} 1`,
      `infrashelf_orders{environment_id="${environment.id}",status="pending"} 2`,
    ])
  })

  it('distinguishes an integration that works from one nobody has ever tried', async () => {
    const { environment } = await seed()
    const base = {
      kind: 'grafana' as const,
      baseUrl: 'https://grafana.example.com',
      authType: 'none' as const,
      failureMode: 'best_effort' as const,
    }
    await db.insert(integrations).values([
      // Portal-wide, never contacted: NULL last_error means "no failure
      // recorded", which is also what a successful contact leaves behind — the
      // whole reason this cannot be read as health.
      { ...base, kind: 'loki', name: 'loki-global', environmentId: null },
      { ...base, kind: 'grafana', name: 'grafana-env', environmentId: environment.id, lastContactedAt: new Date('2026-09-23T09:00:00Z') },
      { ...base, kind: 'nexus', name: 'nexus-down', environmentId: null, lastError: 'connect ECONNREFUSED' },
      { ...base, kind: 'pulp', name: 'pulp-off', environmentId: null, enabled: false, lastContactedAt: new Date('2026-09-22T09:00:00Z') },
    ])

    const text = await collectPortalMetrics()

    // One series per integration, in a stable order, with the state as a label —
    // so `count by (state)` is the whole health panel and adding an integration
    // never changes the query.
    expect(seriesOf(text, 'infrashelf_integration_health')).toEqual([
      // Portal-wide is 0: Prometheus has no NULL label, and the dashboards select
      // on `environment_id=~"$environment_id|0"` for exactly this reason.
      'infrashelf_integration_health{environment_id="0",kind="loki",name="loki-global",state="never_probed"} 1',
      'infrashelf_integration_health{environment_id="0",kind="nexus",name="nexus-down",state="failing"} 1',
      // Disabled outranks a stored success: the operator said not to contact it,
      // so its old timestamp is history rather than current state.
      'infrashelf_integration_health{environment_id="0",kind="pulp",name="pulp-off",state="disabled"} 1',
      `infrashelf_integration_health{environment_id="${environment.id}",kind="grafana",name="grafana-env",state="ok"} 1`,
    ])

    // Only the two that were ever reached have a timestamp, so a panel can tell
    // "last reached 4 hours ago" from "there is nothing to be stale".
    expect(seriesOf(text, 'infrashelf_integration_last_success_timestamp_seconds')).toEqual([
      `infrashelf_integration_last_success_timestamp_seconds{environment_id="0",kind="pulp",name="pulp-off"} ${unix('2026-09-22T09:00:00Z')}`,
      `infrashelf_integration_last_success_timestamp_seconds{environment_id="${environment.id}",kind="grafana",name="grafana-env"} ${unix('2026-09-23T09:00:00Z')}`,
    ])
  })

  it('stamps the response with the time it was assembled', async () => {
    const at = new Date('2026-09-23T12:34:56.789Z')
    const text = await collectPortalMetrics(at)

    // Floored to the second: this is subtracted, not plotted, and Postgres keeps
    // milliseconds the format has no use for.
    expect(text).toContain(`infrashelf_metrics_generated_timestamp_seconds ${Math.floor(at.getTime() / 1000)}`)
  })

  it('emits every declared family it has rows for, and no family twice', async () => {
    const { product, environment, project, order } = await seed()
    await createInfraElement(order.id, project.id, environment.id, product.id, {
      policyOutcome: 'deny',
      policyCheckedAt: new Date(),
      lastRefreshOutcome: 'clean',
      lastRefreshedAt: new Date(),
    })

    const text = await collectPortalMetrics()

    // The dashboards test proves the names are the ones the panels read; this one
    // proves the endpoint's own shape holds — one HELP block per family, which is
    // what a scraper parses.
    const helpLines = text.split('\n').filter((line) => line.startsWith('# HELP '))
    expect(new Set(helpLines).size).toBe(helpLines.length)
    expect(text).toContain('# HELP infrashelf_project_info ')
    expect(text.endsWith('\n')).toBe(true)
  })
})

/**
 * The one function here that can be wrong quietly: `lastError` is NULL both for
 * an integration that was reached and for one nobody has tried, so reading the
 * first NULL as health is a mistake that looks like a working dashboard.
 */
describe('integrationHealthState', () => {
  const at = new Date('2026-09-23T09:00:00Z')

  it('is never_probed when nothing has contacted it, and ok once something has', () => {
    expect(integrationHealthState({ enabled: true, lastContactedAt: null, lastError: null })).toBe('never_probed')
    expect(integrationHealthState({ enabled: true, lastContactedAt: at, lastError: null })).toBe('ok')
  })

  it('is failing when the last attempt left an error, even after earlier successes', () => {
    expect(integrationHealthState({ enabled: true, lastContactedAt: at, lastError: 'ECONNREFUSED' })).toBe('failing')
  })

  it('is disabled rather than failing, so an operator switching one off is not an alarm', () => {
    expect(integrationHealthState({ enabled: false, lastContactedAt: at, lastError: 'ECONNREFUSED' })).toBe('disabled')
  })
})
