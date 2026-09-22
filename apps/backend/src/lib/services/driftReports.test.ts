import { describe, it, expect, beforeEach, vi } from 'vitest'
import { eq } from 'drizzle-orm'
import { db } from '@/lib/db/client'
import { infrastructureElements, unclaimedStates, driftReportState, auditLog, pipelineStacks } from '@/lib/db/schema'
import {
  createUser, createCategory, createProduct, createCiSource,
  createEnvironment, createProject, createOrder, createInfraElement,
} from '@/test/helpers'
import { createIntegration } from '@/lib/services/admin/integrations'
import type { StackStep } from '@infrashelf/types'
import { recordDriftReport, driftReportStatus, driftTargets } from './driftReports'

/**
 * Recording a drift report (#108).
 *
 * The report arrives from CI over a shared secret and is UNTRUSTED. What it may
 * and may not do is the substance of this file: it may annotate an active
 * element it can identify, and nothing else. It may never create, delete or
 * decommission anything.
 */
const AT = new Date('2026-09-10T06:00:00.000Z')

const scenario = async (over: { status?: string; stateKeys?: Record<string, string>; steps?: StackStep[] } = {}) => {
  const user = await createUser({ email: `drift-${Math.random()}@test.dev` })
  const category = await createCategory()
  const product = await createProduct(category.id)
  const ci = await createCiSource()
  const environment = await createEnvironment(ci.id)
  const project = await createProject(user.id)
  const [stack] = await db
    .insert(pipelineStacks)
    .values({
      productId: product.id,
      environmentId: environment.id,
      name: 'vm',
      stateKeyParam: 'hostname',
      steps: over.steps ?? [{ template: 'linode/virtual-machine', stateSuffix: 'vm', execOrder: 0, upstreamRefs: [] }],
    })
    .returning()
  const order = await createOrder(project.id, product.id, environment.id, user.id, { status: 'completed' })
  const element = await createInfraElement(order.id, project.id, environment.id, product.id, {
    status: over.status ?? 'active',
    stateKeys: over.stateKeys ?? { [String(stack.id)]: 'web-01-o42' },
  })
  return { element, stack }
}

const reload = async (id: number) => {
  const [row] = await db.select().from(infrastructureElements).where(eq(infrastructureElements.id, id))
  return row
}

beforeEach(() => {
  vi.spyOn(console, 'error').mockImplementation(() => {})
})

describe('recordDriftReport', () => {
  it('records a clean check against the element that owns the state key', async () => {
    const { element } = await scenario()

    const out = await recordDriftReport({ checkedAt: AT, results: [{ stateKey: 'web-01-o42', outcome: 'clean' }] })

    expect(out).toEqual({ matched: 1, unclaimed: 0, ignored: 0, stale: 0, policyEvaluated: 0, policyUnavailable: 0 })
    const row = await reload(element.id)
    expect(row.lastRefreshedAt?.toISOString()).toBe(AT.toISOString())
    expect(row.lastRefreshOutcome).toBe('clean')
    expect(row.driftDetectedAt).toBeNull()
  })

  it('records drift with the resources the plan named', async () => {
    const { element } = await scenario()
    const summary = { resources: [{ address: 'module.vm.linode_instance.this', action: 'update' }] }

    await recordDriftReport({ checkedAt: AT, results: [{ stateKey: 'web-01-o42', outcome: 'drifted', summary }] })

    const row = await reload(element.id)
    expect(row.lastRefreshOutcome).toBe('drifted')
    expect(row.driftDetectedAt?.toISOString()).toBe(AT.toISOString())
    expect(row.driftSummary).toEqual(summary)
  })

  // Drift that has been fixed must stop being reported, or the badge is
  // permanent and stops meaning anything.
  it('clears drift when a later report comes back clean', async () => {
    const { element } = await scenario()
    await recordDriftReport({
      checkedAt: AT,
      results: [{ stateKey: 'web-01-o42', outcome: 'drifted', summary: { resources: [{ address: 'a', action: 'update' }] } }],
    })

    const later = new Date(AT.getTime() + 3_600_000)
    await recordDriftReport({ checkedAt: later, results: [{ stateKey: 'web-01-o42', outcome: 'clean' }] })

    const row = await reload(element.id)
    expect(row.driftDetectedAt).toBeNull()
    expect(row.driftSummary).toBeNull()
    expect(row.lastRefreshOutcome).toBe('clean')
  })

  /*
   * `locked` and `error` mean the plan could not run. Treating either as "no
   * drift" would clear a real finding because a teardown happened to hold the
   * state lock at that minute — silence reported as health, which is the exact
   * confusion #108 opens with.
   */
  it.each(['locked', 'error'] as const)('leaves existing drift alone on a %s result', async (outcome) => {
    const { element } = await scenario()
    const summary = { resources: [{ address: 'module.vm.linode_instance.this', action: 'delete' }] }
    await recordDriftReport({ checkedAt: AT, results: [{ stateKey: 'web-01-o42', outcome: 'drifted', summary }] })

    const later = new Date(AT.getTime() + 3_600_000)
    await recordDriftReport({ checkedAt: later, results: [{ stateKey: 'web-01-o42', outcome }] })

    const row = await reload(element.id)
    expect(row.driftSummary, 'the drift was cleared by a check that never ran').toEqual(summary)
    expect(row.driftDetectedAt?.toISOString()).toBe(AT.toISOString())
    // The outcome and the timestamp still move: we did try, and when.
    expect(row.lastRefreshOutcome).toBe(outcome)
    expect(row.lastRefreshedAt?.toISOString()).toBe(later.toISOString())
  })

  it('records a state key no element claims as an observation', async () => {
    await scenario()

    const out = await recordDriftReport({
      checkedAt: AT,
      results: [{ stateKey: 'left-behind-o7', outcome: 'drifted', summary: { resources: [] } }],
    })

    expect(out).toEqual({ matched: 0, unclaimed: 1, ignored: 0, stale: 0, policyEvaluated: 0, policyUnavailable: 0 })
    const [row] = await db.select().from(unclaimedStates).where(eq(unclaimedStates.stateKey, 'left-behind-o7'))
    expect(row.outcome).toBe('drifted')
  })

  // How long a state has been unaccounted for is the useful part of the record.
  it('keeps first_seen_at when an unclaimed state is seen again', async () => {
    await recordDriftReport({ checkedAt: AT, results: [{ stateKey: 'left-behind-o7', outcome: 'clean' }] })
    const later = new Date(AT.getTime() + 86_400_000)
    await recordDriftReport({ checkedAt: later, results: [{ stateKey: 'left-behind-o7', outcome: 'drifted' }] })

    const [row] = await db.select().from(unclaimedStates).where(eq(unclaimedStates.stateKey, 'left-behind-o7'))
    expect(row.firstSeenAt.toISOString()).toBe(AT.toISOString())
    expect(row.lastSeenAt.toISOString()).toBe(later.toISOString())
  })

  it('stops calling a state unclaimed once an element claims it', async () => {
    await recordDriftReport({ checkedAt: AT, results: [{ stateKey: 'web-01-o42', outcome: 'clean' }] })
    expect(await db.select().from(unclaimedStates)).toHaveLength(1)

    // The element is (re)created, so the key is now accounted for.
    await scenario()
    await recordDriftReport({ checkedAt: AT, results: [{ stateKey: 'web-01-o42', outcome: 'clean' }] })

    expect(await db.select().from(unclaimedStates)).toHaveLength(0)
  })

  /*
   * The rule that matters most. A report is CI-supplied input; an element on
   * its way out must not be annotated by a plan that started before the
   * teardown did.
   */
  it.each(['decommissioning', 'decommissioned'] as const)('does not touch a %s element', async (status) => {
    const { element } = await scenario({ status })

    const out = await recordDriftReport({ checkedAt: AT, results: [{ stateKey: 'web-01-o42', outcome: 'drifted' }] })

    const row = await reload(element.id)
    expect(row.lastRefreshedAt).toBeNull()
    expect(row.lastRefreshOutcome).toBeNull()
    /*
     * It is not silently dropped, and it is not an observation either. The
     * portal knows exactly what this state is — an element it is tearing down.
     * Filing it under `unclaimed` would put a row in the admin UI for every
     * teardown, describing a state nobody has lost track of.
     */
    expect(out.ignored).toBe(1)
    expect(out.unclaimed).toBe(0)
    expect(await db.select().from(unclaimedStates)).toHaveLength(0)
  })

  it('never creates or removes an element', async () => {
    const { element } = await scenario()
    const before = await db.select({ id: infrastructureElements.id }).from(infrastructureElements)

    await recordDriftReport({
      checkedAt: AT,
      results: [
        { stateKey: 'web-01-o42', outcome: 'drifted' },
        { stateKey: 'ghost-o99', outcome: 'drifted' },
      ],
    })

    const after = await db.select({ id: infrastructureElements.id }).from(infrastructureElements)
    expect(after.map((r) => r.id)).toEqual(before.map((r) => r.id))
    expect((await reload(element.id)).status).toBe('active')
  })

  it('matches every key an element owns, not just the first', async () => {
    const { element } = await scenario({ stateKeys: { '1': 'web-01-o42', '2': 'dns-01-o42' } })

    const out = await recordDriftReport({
      checkedAt: AT,
      results: [{ stateKey: 'web-01-o42', outcome: 'clean' }, { stateKey: 'dns-01-o42', outcome: 'drifted' }],
    })

    // One element, written once, however many of its states were planned.
    expect(out.matched).toBe(1)
    expect((await reload(element.id)).lastRefreshOutcome).toBe('drifted')
  })

  /*
   * The bug that made this an aggregation rather than a loop.
   *
   * An element owns one state file per step and they are planned separately.
   * Applying each result in turn made the element's reading depend on the ORDER
   * of the array: the drifted VM was written first, then the clean DNS record
   * overwrote it and cleared `drift_detected_at`. The drift was erased by a plan
   * that never looked at it.
   */
  it.each([
    ['drift last', ['clean', 'drifted'] as const],
    ['drift first', ['drifted', 'clean'] as const],
  ])('reads the same either way when the results arrive %s', async (_name, [first, second]) => {
    const { element } = await scenario({
      steps: [
        { template: 'linode/virtual-machine', stateSuffix: 'vm', execOrder: 0, upstreamRefs: [] },
        { template: 'linode/dns-record', stateSuffix: 'dns', execOrder: 1, upstreamRefs: [] },
      ],
    })

    await recordDriftReport({
      checkedAt: AT,
      results: [
        { stateKey: 'web-01-o42-vm', outcome: first, summary: { resources: [{ address: 'a', action: 'update' }] } },
        { stateKey: 'web-01-o42-dns', outcome: second, summary: { resources: [{ address: 'b', action: 'update' }] } },
      ],
    })

    const row = await reload(element.id)
    expect(row.lastRefreshOutcome).toBe('drifted')
    expect(row.driftDetectedAt?.toISOString()).toBe(AT.toISOString())
  })

  /*
   * An element is clean only when every one of its states was actually read.
   * `locked` beating `clean` is the same rule as leaving drift alone: silence
   * must not read as health.
   */
  it('is not clean when one of its states could not be read', async () => {
    const { element } = await scenario({
      steps: [
        { template: 'linode/virtual-machine', stateSuffix: 'vm', execOrder: 0, upstreamRefs: [] },
        { template: 'linode/dns-record', stateSuffix: 'dns', execOrder: 1, upstreamRefs: [] },
      ],
    })

    await recordDriftReport({
      checkedAt: AT,
      results: [
        { stateKey: 'web-01-o42-vm', outcome: 'clean' },
        { stateKey: 'web-01-o42-dns', outcome: 'locked' },
      ],
    })

    expect((await reload(element.id)).lastRefreshOutcome).toBe('locked')
  })

  it('audits drift, and only drift', async () => {
    await scenario()

    await recordDriftReport({ checkedAt: AT, results: [{ stateKey: 'web-01-o42', outcome: 'clean' }] })
    expect(await db.select().from(auditLog).where(eq(auditLog.action, 'infra.drift_detected'))).toHaveLength(0)

    const later = new Date(AT.getTime() + 3_600_000)
    await recordDriftReport({ checkedAt: later, results: [{ stateKey: 'web-01-o42', outcome: 'drifted' }] })
    // A clean run every fifteen minutes would bury the log, which is how an
    // audit log stops being read.
    expect(await db.select().from(auditLog).where(eq(auditLog.action, 'infra.drift_detected'))).toHaveLength(1)
  })

  /*
   * The contract between the two repositories, and the one that was wrong.
   *
   * `state_keys` records ONE base per stack, but a stack fans out to a job per
   * step and `generate_stack.py` writes each step's state under
   * `<base>-<stateSuffix>`. The matcher compared the reported key against the
   * recorded base, so it matched nothing a real pipeline would ever send: every
   * element in the estate would have come back `unclaimed` while both sides
   * looked individually correct.
   *
   * Nothing caught it because every test reported the base directly. This one
   * reports what `.ci/drift-report.gitlab-ci.yml` actually composes.
   */
  it('matches the per-step key the pipeline actually reports, not the base', async () => {
    const { element } = await scenario({
      steps: [
        { template: 'linode/virtual-machine', stateSuffix: 'vm', execOrder: 0, upstreamRefs: [] },
        { template: 'linode/dns-record', stateSuffix: 'dns', execOrder: 1, upstreamRefs: [] },
      ],
    })

    const out = await recordDriftReport({
      checkedAt: AT,
      results: [
        { stateKey: 'web-01-o42-vm', outcome: 'clean' },
        { stateKey: 'web-01-o42-dns', outcome: 'clean' },
      ],
    })

    expect(out).toEqual({ matched: 1, unclaimed: 0, ignored: 0, stale: 0, policyEvaluated: 0, policyUnavailable: 0 })
    expect((await reload(element.id)).lastRefreshOutcome).toBe('clean')
    expect(await db.select().from(unclaimedStates)).toHaveLength(0)
  })

  /*
   * The round trip, asserted end to end: whatever `driftTargets` hands out, the
   * composition the pipeline performs on it has to come back matchable. A change
   * to either side alone breaks this.
   */
  it('accepts every key composed from its own work list', async () => {
    await scenario({
      steps: [
        { template: 'linode/virtual-machine', stateSuffix: 'vm', execOrder: 0, upstreamRefs: [] },
        { template: 'linode/dns-record', stateSuffix: 'dns', execOrder: 1, upstreamRefs: [] },
      ],
    })

    // Exactly what .ci/drift-report.gitlab-ci.yml builds from targets.json.
    const results = (await driftTargets()).flatMap((t) =>
      t.stack.map((step) => ({ stateKey: `${t.stateName}-${step.stateSuffix}`, outcome: 'clean' as const })),
    )
    expect(results).toHaveLength(2)

    const out = await recordDriftReport({ checkedAt: AT, results })
    expect(out).toEqual({ matched: 1, unclaimed: 0, ignored: 0, stale: 0, policyEvaluated: 0, policyUnavailable: 0 })
  })

  /*
   * Continuous policy evaluation (#110, slice 6): the report that moves an element
   * is also the moment policy is asked about it, and the answer is stored on the
   * element rather than returned to the pipeline — the pipeline has no page to put
   * it on, and an operator does.
   */
  it('asks policy about the element the report moved, and stores the verdict', async () => {
    const { element } = await scenario()
    const root = await createUser({ role: 'root' })
    await createIntegration(root.id, {
      kind: 'opa',
      name: 'Policy engine',
      baseUrl: 'https://opa.example.com',
      authType: 'none',
      failureMode: 'best_effort',
      environmentId: element.environmentId,
    })
    // A fresh Response per call, and the element path — not the order one.
    const asked: string[] = []
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      asked.push(String(input))
      return new Response(
        JSON.stringify({ result: { decision: 'deny', rule: 'exposure/public-ip', message: 'A public IP is not permitted.' } }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      )
    })

    const out = await recordDriftReport({
      checkedAt: AT,
      results: [{ stateKey: 'web-01-o42', outcome: 'clean' }],
    })

    expect(out.policyEvaluated).toBe(1)
    expect(out.policyUnavailable).toBe(0)
    expect(asked).toHaveLength(1)
    expect(asked[0]).toContain('/v1/data/infrashelf/element/decision')

    const row = await reload(element.id)
    expect(row.policyOutcome).toBe('deny')
    expect(row.policyRule).toBe('exposure/public-ip')
    expect(row.policyMessage).toBe('A public IP is not permitted.')
    expect(row.policyCheckedAt?.toISOString()).toBe(AT.toISOString())
    // The report still did what it came to do: the drift columns are untouched by
    // any of this, which is what report-only means.
    expect(row.lastRefreshOutcome).toBe('clean')
  })

  /*
   * A dead engine must not stop the report from being recorded: what the plan says
   * is the part that cannot be re-derived, and the verdict is stored as
   * `unavailable` rather than left absent.
   */
  it('records the report even when the policy engine cannot be reached', async () => {
    const { element } = await scenario()
    const root = await createUser({ role: 'root' })
    await createIntegration(root.id, {
      kind: 'opa',
      name: 'Policy engine',
      baseUrl: 'https://opa.example.com',
      authType: 'none',
      failureMode: 'blocking',
      environmentId: element.environmentId,
    })
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('ECONNREFUSED'))

    const out = await recordDriftReport({
      checkedAt: AT,
      results: [{ stateKey: 'web-01-o42', outcome: 'drifted', summary: { resources: [] } }],
    })

    expect(out).toEqual({
      matched: 1,
      unclaimed: 0,
      ignored: 0,
      stale: 0,
      policyEvaluated: 1,
      policyUnavailable: 1,
    })
    const row = await reload(element.id)
    expect(row.lastRefreshOutcome).toBe('drifted')
    expect(row.policyOutcome).toBe('unavailable')
    expect(row.policyMessage).toContain('ECONNREFUSED')
  })

  /*
   * A retried job POSTing an older run's findings must not restore an obsolete
   * reading over a newer one. Without the guard the late `clean` below wins on
   * arrival order and the drift disappears.
   */
  it('refuses a report older than the one already recorded', async () => {
    const { element } = await scenario()
    const summary = { resources: [{ address: 'module.vm.linode_instance.this', action: 'update' }] }

    const later = new Date(AT.getTime() + 3_600_000)
    await recordDriftReport({ checkedAt: later, results: [{ stateKey: 'web-01-o42', outcome: 'drifted', summary }] })

    // The earlier run finally reports in.
    const out = await recordDriftReport({ checkedAt: AT, results: [{ stateKey: 'web-01-o42', outcome: 'clean' }] })

    expect(out.stale).toBe(1)
    expect(out.matched).toBe(0)
    // Not an observation either: the key is owned, the report was simply late.
    expect(out.unclaimed).toBe(0)
    const row = await reload(element.id)
    expect(row.lastRefreshOutcome).toBe('drifted')
    expect(row.lastRefreshedAt?.toISOString()).toBe(later.toISOString())
    expect(row.driftSummary).toEqual(summary)
  })

  it('does not let a late report drag the whole picture backwards', async () => {
    await scenario()
    const later = new Date(AT.getTime() + 3_600_000)

    await recordDriftReport({ checkedAt: later, results: [{ stateKey: 'web-01-o42', outcome: 'clean' }] })
    await recordDriftReport({ checkedAt: AT, results: [{ stateKey: 'web-01-o42', outcome: 'clean' }] })

    expect((await driftReportStatus()).lastReportAt?.toISOString()).toBe(later.toISOString())
  })

  /*
   * An observation is only as current as the last run that saw it. The report is
   * built from the portal's own work list, so a key that stops appearing is one
   * the portal has stopped asking about — and the row would otherwise sit in the
   * admin UI for ever describing a check that no longer runs.
   */
  it('reconciles away an observation a complete run no longer sees', async () => {
    await recordDriftReport({ checkedAt: AT, results: [{ stateKey: 'left-behind-o7', outcome: 'drifted' }] })
    expect(await db.select().from(unclaimedStates)).toHaveLength(1)

    const later = new Date(AT.getTime() + 3_600_000)
    await recordDriftReport({ checkedAt: later, results: [], complete: true })

    expect(await db.select().from(unclaimedStates)).toHaveLength(0)
  })

  // A partial run's silence about a key means nothing at all, so it must not be
  // read as "gone". `complete` is stated by the runner, never inferred here.
  it('keeps an observation when the run does not claim to be complete', async () => {
    await recordDriftReport({ checkedAt: AT, results: [{ stateKey: 'left-behind-o7', outcome: 'drifted' }] })

    const later = new Date(AT.getTime() + 3_600_000)
    await recordDriftReport({ checkedAt: later, results: [] })

    expect(await db.select().from(unclaimedStates)).toHaveLength(1)
  })

  it('keeps the observations a complete run did still see', async () => {
    await recordDriftReport({
      checkedAt: AT,
      results: [{ stateKey: 'left-behind-o7', outcome: 'drifted' }, { stateKey: 'gone-o8', outcome: 'clean' }],
    })
    expect(await db.select().from(unclaimedStates)).toHaveLength(2)

    const later = new Date(AT.getTime() + 3_600_000)
    await recordDriftReport({
      checkedAt: later,
      results: [{ stateKey: 'left-behind-o7', outcome: 'drifted' }],
      complete: true,
    })

    const rows = await db.select().from(unclaimedStates)
    expect(rows.map((r) => r.stateKey)).toEqual(['left-behind-o7'])
  })

  it('is idempotent — the same report twice leaves the same rows', async () => {
    const { element } = await scenario()
    const report = { checkedAt: AT, results: [{ stateKey: 'web-01-o42', outcome: 'drifted' as const }] }

    await recordDriftReport(report)
    const first = await reload(element.id)
    await recordDriftReport(report)
    const second = await reload(element.id)

    expect(second).toEqual(first)
  })
})

describe('driftReportStatus', () => {
  /*
   * "Reported clean" and "never heard" have to stay distinguishable. If the
   * pipeline stops running, every element quietly stops being updated and
   * nothing anywhere says why — silence must not read as health.
   */
  it('counts active elements nothing has ever reported on', async () => {
    await scenario()
    expect((await driftReportStatus()).neverReported).toBe(1)

    await recordDriftReport({ checkedAt: AT, results: [{ stateKey: 'web-01-o42', outcome: 'clean' }] })

    const status = await driftReportStatus()
    expect(status.neverReported).toBe(0)
    expect(status.lastReportAt?.toISOString()).toBe(AT.toISOString())
    expect(status.elementsReported).toBe(1)
  })

  it('has no last report before one arrives', async () => {
    const [row] = await db.select().from(driftReportState)
    expect(row.lastReportAt).toBeNull()
  })
})

describe('driftTargets', () => {
  /*
   * The work list the reporting pipeline asks for. `plan -refresh-only` needs
   * the template and the variables the apply used; a state file says neither.
   */
  const withStack = async (over: { status?: string; stateKeys?: Record<string, string> } = {}) => {
    const user = await createUser({ email: `targets-${Math.random()}@test.dev` })
    const category = await createCategory()
    const product = await createProduct(category.id)
    const ci = await createCiSource()
    const environment = await createEnvironment(ci.id)
    const project = await createProject(user.id)
    const [stack] = await db
      .insert(pipelineStacks)
      .values({
        productId: product.id,
        environmentId: environment.id,
        name: 'vm-and-dns',
        stateKeyParam: 'hostname',
        steps: [
          { template: 'linode/virtual-machine', stateSuffix: 'vm', execOrder: 0, upstreamRefs: [] },
          { template: 'linode/dns-record', stateSuffix: 'dns', execOrder: 1, upstreamRefs: [] },
        ],
      })
      .returning()
    const order = await createOrder(project.id, product.id, environment.id, user.id, { status: 'completed' })
    const element = await createInfraElement(order.id, project.id, environment.id, product.id, {
      status: over.status ?? 'active',
      parameters: { hostname: 'web-01', admin_password: 'secret' },
      stateKeys: over.stateKeys ?? { [String(stack.id)]: 'web-01-o42' },
    })
    return { element, stack }
  }

  it('gives the pipeline the base state name, the steps and the variables', async () => {
    const { element } = await withStack()

    const [target] = await driftTargets()

    expect(target.elementId).toBe(element.id)
    expect(target.stateName).toBe('web-01-o42')
    // The pipeline appends each step's suffix to the base — the same
    // composition generate_stack.py uses.
    expect(target.stack).toEqual([
      { template: 'linode/virtual-machine', stateSuffix: 'vm' },
      { template: 'linode/dns-record', stateSuffix: 'dns' },
    ])
    expect(target.variables.hostname).toBe('web-01')
  })

  it.each(['decommissioning', 'decommissioned'] as const)('omits a %s element', async (status) => {
    await withStack({ status })
    expect(await driftTargets()).toEqual([])
  })

  /*
   * Elements from before #200 have no recorded key. Recomputing one from
   * today's `stateKeyParam` would address a state file that was never created
   * if an admin has since edited it — the exact bug #200 fixed — so they are
   * omitted rather than guessed at.
   */
  it('omits an element with no recorded state key rather than deriving one', async () => {
    await withStack({ stateKeys: {} })
    expect(await driftTargets()).toEqual([])
  })

  /*
   * The stack lookup is global now — one query for all of them instead of one
   * per element — so the scoping the per-element query gave for free has to be
   * an explicit check. Without it a recycled stack id would hand the pipeline
   * another product's steps to plan this element's state against.
   */
  it('omits a state key whose stack belongs to another product', async () => {
    const { element } = await withStack()
    const otherCategory = await createCategory()
    const otherProduct = await createProduct(otherCategory.id)
    const [foreign] = await db
      .insert(pipelineStacks)
      .values({
        productId: otherProduct.id,
        environmentId: (await db.select().from(pipelineStacks).limit(1))[0].environmentId,
        name: 'someone-elses-stack',
        stateKeyParam: 'hostname',
        steps: [{ template: 'linode/object-storage', stateSuffix: 'obj', execOrder: 0, upstreamRefs: [] }],
      })
      .returning()
    await db
      .update(infrastructureElements)
      .set({ stateKeys: { [String(foreign.id)]: 'web-01-o42' } })
      .where(eq(infrastructureElements.id, element.id))

    expect(await driftTargets()).toEqual([])
  })

  it('omits a state key whose stack has since been deleted', async () => {
    await withStack({ stateKeys: { '999999': 'orphan-o1' } })
    // Its state file still exists, so it surfaces as an unclaimed state on the
    // next report — which is honest, and better than planning it against a guess.
    expect(await driftTargets()).toEqual([])
  })
})
