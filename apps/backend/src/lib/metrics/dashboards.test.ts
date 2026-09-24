import { describe, it, expect } from 'vitest'
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { METRIC_NAMES } from './catalog'
import {
  ELEMENT_DASHBOARD_UID,
  PROJECT_DASHBOARD_UID,
  elementDashboardLink,
  projectDashboardLink,
} from '@/lib/integrations/grafana'

/**
 * The contract between the portal, the metric endpoint and the two dashboards
 * somebody provisions into their Grafana (#548).
 *
 * ── Why this is a test and not a paragraph in a README ──────────────────────
 *
 * Nothing here is checked by anything that runs: Grafana loads a dashboard whose
 * PromQL names a metric that does not exist and renders "No data" for ever, which
 * on a dashboard is indistinguishable from a quiet estate; a variable renamed in
 * the JSON still loads and filters nothing, so a deep link opens the whole estate
 * and looks like it worked; and a metric the endpoint emits that no panel reads
 * costs a query per scrape for nobody. All three are silent in production and
 * obvious here.
 *
 * The dashboards live in `infra/`, the metrics in `src/lib/metrics`, and the
 * links in `src/lib/integrations` — three artefacts that never meet at runtime
 * in a way that would complain, which is exactly the shape that needs a test.
 */
const DASHBOARD_DIR = join(process.cwd(), '..', '..', 'infra', 'grafana', 'dashboards')
const PROVISIONING = join(process.cwd(), '..', '..', 'infra', 'grafana', 'provisioning')

interface Dashboard {
  uid: string
  title: string
  time: { from: string; to: string }
  templating: { list: { name: string; type: string; current?: { value?: string }; query?: unknown; definition?: string }[] }
  panels: {
    type: string
    title?: string
    datasource?: { uid?: string }
    targets?: { expr?: string; datasource?: { uid?: string } }[]
  }[]
}

const readDashboard = (uid: string): Dashboard =>
  JSON.parse(readFileSync(join(DASHBOARD_DIR, `${uid}.json`), 'utf8')) as Dashboard

/** Every string anywhere in the dashboard, which is where a metric name can hide. */
const stringsIn = (value: unknown): string[] => {
  if (typeof value === 'string') return [value]
  if (Array.isArray(value)) return value.flatMap(stringsIn)
  if (value && typeof value === 'object') return Object.values(value).flatMap(stringsIn)
  return []
}

/** `infrashelf_foo_bar` out of a PromQL expression or a label_values() query. */
const metricNamesIn = (dashboard: Dashboard): Set<string> =>
  new Set(
    stringsIn(dashboard).flatMap((text) => text.match(/\binfrashelf_[a-z0-9_]+\b/g) ?? []),
  )

const links = () => {
  const element = elementDashboardLink('https://grafana.example.com', {
    elementId: 17,
    orderId: 42,
    projectId: 3,
    environmentId: 9,
  })
  const project = projectDashboardLink('https://grafana.example.com', { projectId: 3 })

  // A link builder returns null for a base URL it cannot use. Both URLs here are
  // fine, so a null is a change to the builder rather than a fixture problem —
  // and saying so once beats a non-null assertion at every use below.
  if (!element) throw new Error('the element deep link could not be built')
  if (!project) throw new Error('the project deep link could not be built')
  return { element, project }
}

describe('the dashboards and the portal agree', () => {
  it('is one file per dashboard UID the portal links into, named after it', () => {
    const files = readdirSync(DASHBOARD_DIR).sort()

    // The file name is the UID, so `git grep infrashelf-element` finds both the
    // link and the dashboard, and a reviewer cannot miss one of them.
    expect(files).toEqual([`${ELEMENT_DASHBOARD_UID}.json`, `${PROJECT_DASHBOARD_UID}.json`])
    for (const file of files) {
      const dashboard = readDashboard(file.replace('.json', ''))
      expect(`${dashboard.uid}.json`).toBe(file)
      expect(dashboard.title).toContain('InfraShelf')
    }
  })

  it('declares every variable the deep link sets, and the window it opens on', () => {
    for (const [which, link] of Object.entries(links())) {
      const url = new URL(link.url)

      // The path segment is the UID: a link that addressed a different dashboard
      // with the right variables would open the wrong page filtered correctly.
      expect(url.pathname.split('/')[2]).toBe(link.dashboardUid)
      const dashboard = readDashboard(link.dashboardUid)
      expect(dashboard.uid).toBe(link.dashboardUid)

      const declared = new Set(dashboard.templating.list.map((v) => v.name))
      for (const [key] of url.searchParams) {
        if (!key.startsWith('var-')) continue
        // A variable the dashboard does not declare is silently ignored by
        // Grafana, so the link opens unfiltered and looks like it worked.
        expect(declared, `${which} dashboard is missing ${key}`).toContain(key.slice(4))
      }

      expect(`${url.searchParams.get('from')}→${url.searchParams.get('to')}`).toBe(
        `${dashboard.time.from}→${dashboard.time.to}`,
      )
    }
  })

  it('lets the element dashboard widen to order, project and environment', () => {
    const dashboard = readDashboard(ELEMENT_DASHBOARD_UID)
    const declared = dashboard.templating.list.map((v) => v.name)

    // The portal sends all four; three of them exist so an element can be seen in
    // its neighbourhood, and the fourth is the variable the panels filter on.
    expect(declared).toEqual(['datasource', 'element_id', 'project_id', 'environment_id', 'order_id'])

    // The chained ones are derived from the element rather than from the whole
    // estate: a project dropdown listing every project would let the page be
    // filtered to a project this element is not in.
    for (const name of ['project_id', 'environment_id', 'order_id']) {
      const variable = dashboard.templating.list.find((v) => v.name === name)
      expect(variable?.definition).toContain('infrashelf_element_info{element_id="$element_id"}')
    }
  })

  it('names only metrics the endpoint emits', () => {
    const declared = new Set<string>(METRIC_NAMES)

    for (const uid of [ELEMENT_DASHBOARD_UID, PROJECT_DASHBOARD_UID]) {
      const referenced = metricNamesIn(readDashboard(uid))
      expect(referenced.size).toBeGreaterThan(0)
      expect([...referenced].filter((name) => !declared.has(name))).toEqual([])
    }
  })

  it('leaves no metric that no dashboard reads', () => {
    const referenced = new Set(
      [ELEMENT_DASHBOARD_UID, PROJECT_DASHBOARD_UID].flatMap((uid) => [...metricNamesIn(readDashboard(uid))]),
    )

    // The other direction, and not a formality: a series nothing plots is a
    // query per scrape and a promise to keep it true. A metric that is genuinely
    // portal-only should get a panel, not an exemption here.
    expect(METRIC_NAMES.filter((name) => !referenced.has(name))).toEqual([])
  })

  it('points every panel at the datasource variable, not at a baked-in UID', () => {
    for (const uid of [ELEMENT_DASHBOARD_UID, PROJECT_DASHBOARD_UID]) {
      const dashboard = readDashboard(uid)
      const datasource = dashboard.templating.list.find((v) => v.name === 'datasource')

      expect(datasource?.type).toBe('datasource')
      // The default the datasource provisioning file provisions under. Renaming
      // one without the other is a dashboard where every panel says "Datasource
      // infrashelf-prometheus was not found".
      const provisioned = readFileSync(join(PROVISIONING, 'datasources', 'prometheus.yaml'), 'utf8')
      expect(provisioned).toContain(`uid: ${datasource?.current?.value}`)

      const panels = dashboard.panels.filter((p) => p.type !== 'row')
      expect(panels.length).toBeGreaterThan(0)
      for (const panel of panels) {
        expect(panel.datasource?.uid, `${uid} / ${panel.title}`).toBe('${datasource}')
        for (const target of panel.targets ?? []) {
          expect(target.datasource?.uid, `${uid} / ${panel.title}`).toBe('${datasource}')
          expect(target.expr).toBeTruthy()
        }
      }
    }
  })

  it('mounts the dashboards from the provisioning file that ships with them', () => {
    const provider = readFileSync(join(PROVISIONING, 'dashboards', 'infrashelf.yaml'), 'utf8')

    // The JSON is only provisioned if a provider points at the directory it is
    // mounted into — the one join in this arrangement a file rename can break
    // without any test noticing, unless this one does.
    expect(provider).toContain('path: /var/lib/grafana/dashboards')
    expect(provider).toContain('allowUiUpdates: false')
  })
})
