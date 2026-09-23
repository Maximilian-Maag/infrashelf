import { describe, it, expect } from 'vitest'
import {
  ELEMENT_DASHBOARD_UID,
  PROJECT_DASHBOARD_UID,
  elementDashboardLink,
  projectDashboardLink,
} from './grafana'

/*
 * The deep link is a contract between the portal and a dashboard provisioned from
 * this repository (#546, #111's Grafana item): if the portal and the dashboard
 * disagree about a variable name, the link opens a dashboard filtered by nothing,
 * which looks like a working link and answers the wrong question. So the shape is
 * asserted here rather than assumed, including the details that are easy to get
 * subtly wrong — the trailing slash in `base_url`, an environment-scoped path, and
 * the slug Grafana needs (it does not redirect `/d/<uid>` on its own).
 */

const ids = { elementId: 42, orderId: 7, projectId: 3, environmentId: 5 }

describe('elementDashboardLink', () => {
  it('points at the shipped element dashboard, with every portal identifier as a variable', () => {
    const link = elementDashboardLink('https://grafana.example.com', ids)

    expect(link?.dashboardUid).toBe(ELEMENT_DASHBOARD_UID)
    expect(link?.url).toContain('/d/infrashelf-element/element?')
    expect(link?.url).toContain('var-element_id=42')
    expect(link?.url).toContain('var-order_id=7')
    expect(link?.url).toContain('var-project_id=3')
    expect(link?.url).toContain('var-environment_id=5')
  })

  it('opens on a window worth looking at, rather than Grafana default of the last hour', () => {
    const link = elementDashboardLink('https://grafana.example.com', ids)

    expect(link?.url).toContain('from=now-6h')
    expect(link?.url).toContain('to=now')
  })

  it('survives a base URL with a path and a trailing slash, which is how gateways are configured', () => {
    const link = elementDashboardLink('https://gw.example.com/grafana/', ids)

    // Not `https://gw.example.com/d/...`: the base's own path is part of where
    // Grafana lives, and dropping it points at the gateway root (see integrationUrl).
    expect(link?.url.startsWith('https://gw.example.com/grafana/d/infrashelf-element/element?')).toBe(true)
  })

  it('omits the environment variable rather than sending an empty one', () => {
    const link = elementDashboardLink('https://grafana.example.com', { ...ids, environmentId: null })

    expect(link?.url).not.toContain('var-environment_id')
    expect(link?.url).toContain('var-element_id=42')
  })

  it('is null rather than a broken link when the base URL cannot be used', () => {
    // A base URL that predates the validator, or a hand-edited row. The element
    // page must not answer 500 because an admin typed a bad URL into an
    // integration nobody has looked at since.
    expect(elementDashboardLink('not a url', ids)).toBeNull()
    expect(elementDashboardLink('file:///etc/passwd', ids)).toBeNull()
  })
})

describe('projectDashboardLink', () => {
  it('points at the shipped project dashboard, filtered by the project', () => {
    const link = projectDashboardLink('https://grafana.example.com', { projectId: 3 })

    expect(link?.dashboardUid).toBe(PROJECT_DASHBOARD_UID)
    expect(link?.url).toContain('/d/infrashelf-project/project?')
    expect(link?.url).toContain('var-project_id=3')
    // A project spans environments, so no element or environment filter: asking a
    // dashboard for one would silently hide the other environments' machines.
    expect(link?.url).not.toContain('var-environment_id')
    expect(link?.url).not.toContain('var-element_id')
  })

  it('is null when the base URL cannot be used', () => {
    expect(projectDashboardLink('ftp://grafana.example.com', { projectId: 3 })).toBeNull()
  })
})
