import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { eq, sql } from 'drizzle-orm'
import { db } from '@/lib/db/client'
import {
  appConfig, auditLog, deploymentEnvironments, deploymentWindows, holidays,
  holidayFeedState, orders, costCenters, projects,
} from '@/lib/db/schema'
import {
  createUser, createCategory, createProduct, createCiSource,
  createEnvironment, createProject, createOrder, createCostCenter, linkProductEnvironment,
} from '@/test/helpers'
import { createIntegration } from '@/lib/services/admin/integrations'
import {
  loadWindowPolicy, whenMayItDeploy, dueScheduledOrders, releaseDueScheduledOrders,
  deployScheduledOrderNow,
} from './windowPolicy'
import type * as OrdersService from '@/lib/services/orders'
import type * as AuditModule from '@/lib/audit'
import { logAudit } from '@/lib/audit'
import { provisionOrderElements } from '@/lib/services/orders'

vi.mock('@/lib/services/orders', async (importOriginal) => ({
  ...(await importOriginal<typeof OrdersService>()),
  provisionOrderElements: vi.fn(),
}))
vi.mock('@/lib/audit', async (importOriginal) => ({
  ...(await importOriginal<typeof AuditModule>()),
  logAudit: vi.fn(),
}))

/**
 * Reading the window policy out of the database, and deciding with it (#330).
 *
 * The arithmetic itself is tested next door without a database. What is only
 * testable here is the wiring: which switches have to be on, and what happens
 * when a deployment turns one on and forgets the other.
 */
const BERLIN = 'Europe/Berlin'

const setup = async (over: { respects?: boolean; windows?: { startMinute: number; durationMinutes: number }[] } = {}) => {
  const user = await createUser({ email: `win-${Math.random()}@test.dev` })
  const category = await createCategory()
  const product = await createProduct(category.id)
  const ci = await createCiSource()
  const environment = await createEnvironment(ci.id)
  const project = await createProject(user.id)

  await db.update(appConfig).set({ deploymentTimeZone: BERLIN }).where(eq(appConfig.id, 1))
  await db
    .update(deploymentEnvironments)
    .set({ respectsDeploymentWindows: over.respects ?? true })
    .where(eq(deploymentEnvironments.id, environment.id))
  for (const w of over.windows ?? [{ startMinute: 8 * 60, durationMinutes: 120 }]) {
    await db.insert(deploymentWindows).values(w)
  }
  return { user, product, environment, project }
}

beforeEach(() => {
  vi.spyOn(console, 'error').mockImplementation(() => {})
})

describe('loadWindowPolicy', () => {
  it('reads the zone, the windows and only the observed holidays', async () => {
    await setup()
    await db.insert(holidays).values([
      { date: '2026-10-05', name: 'Observed', source: 'feed', observed: true },
      // A holiday the company works through — recorded, not applied.
      { date: '2026-10-06', name: 'Not observed here', source: 'manual', observed: false },
    ])

    const policy = await loadWindowPolicy()

    expect(policy.timeZone).toBe(BERLIN)
    expect(policy.windows).toEqual([{ startMinute: 480, durationMinutes: 120 }])
    expect([...policy.holidays]).toEqual(['2026-10-05'])
  })
})

describe('whenMayItDeploy', () => {
  // Wednesday 2026-09-02. Berlin is UTC+2, so 06:00Z is 08:00 local.
  const INSIDE = new Date('2026-09-02T07:00:00Z')
  const OUTSIDE = new Date('2026-09-02T20:00:00Z')

  it('does not wait inside a window', async () => {
    const { environment } = await setup()
    expect(await whenMayItDeploy(environment.id, INSIDE)).toBeNull()
  })

  it('waits for the next window outside one', async () => {
    const { environment } = await setup()
    const wait = await whenMayItDeploy(environment.id, OUTSIDE)
    // 22:00 Wednesday Berlin -> 08:00 Thursday.
    expect(wait?.scheduledFor.toISOString()).toBe('2026-09-03T06:00:00.000Z')
  })

  /*
   * The default that makes the upgrade safe. An environment that never opted in
   * behaves exactly as it did before this feature existed, whatever the hour.
   */
  it('does not wait for an environment that has not opted in', async () => {
    const { environment } = await setup({ respects: false })
    expect(await whenMayItDeploy(environment.id, OUTSIDE)).toBeNull()
  })

  /*
   * Two switches, and this is the second. A deployment that turned the flag on
   * and defined no windows would otherwise queue every order for ever — a worse
   * failure than not having the feature at all.
   */
  it('does not wait when the flag is on but no window is configured', async () => {
    const { environment } = await setup({ windows: [] })
    expect(await whenMayItDeploy(environment.id, OUTSIDE)).toBeNull()
  })

  // Every day excluded means the configuration can never open. Provisioning now
  // is the lesser wrong: the alternative is an order waiting for ever with
  // nothing to tell its requester.
  it('does not wait when no window can ever open', async () => {
    const { environment } = await setup()
    const rows = Array.from({ length: 400 }, (_, i) => {
      const d = new Date(Date.UTC(2026, 8, 2) + i * 86_400_000)
      return { date: d.toISOString().slice(0, 10), name: 'Shutdown', source: 'manual' as const, observed: true }
    })
    await db.insert(holidays).values(rows)

    expect(await whenMayItDeploy(environment.id, OUTSIDE)).toBeNull()
  })

  it('is null for an environment that does not exist, rather than throwing', async () => {
    await setup()
    expect(await whenMayItDeploy(999_999, OUTSIDE)).toBeNull()
  })
})

/*
 * The fail-closed rule (#330), asserted where it actually bites.
 *
 * With a feed configured and never once read, the portal has no holiday data —
 * so a public holiday and a working day are indistinguishable. Applying the
 * windows anyway would mean provisioning on Christmas morning while claiming
 * the opposite, so the windows are not applied at all and the order goes
 * straight through, as it would have before the feature existed.
 */
describe('whenMayItDeploy — the holiday feed guard', () => {
  const OUTSIDE = new Date('2026-09-02T20:00:00Z')

  it('does not hold an order when a configured feed has never been read', async () => {
    const { environment } = await setup()
    await db.update(holidayFeedState).set({ url: 'https://feed.test/h.ics' }).where(eq(holidayFeedState.id, 1))

    // 22:00 Berlin, far outside the 08:00 window — it would normally wait.
    expect(await whenMayItDeploy(environment.id, OUTSIDE)).toBeNull()
  })

  it('holds it as usual once the feed has been read at least once', async () => {
    const { environment } = await setup()
    await db
      .update(holidayFeedState)
      .set({ url: 'https://feed.test/h.ics', lastSuccessAt: new Date('2026-09-01T00:00:00Z') })
      .where(eq(holidayFeedState.id, 1))

    const wait = await whenMayItDeploy(environment.id, OUTSIDE)
    expect(wait?.scheduledFor.toISOString()).toBe('2026-09-03T06:00:00.000Z')
  })

  /*
   * A deployment that never configured a feed has said it does not want holiday
   * exclusion. Weekends still work, and refusing to apply windows there would
   * disable the feature for everyone who does not use a feed.
   */
  it('applies the windows normally when no feed is configured at all', async () => {
    const { environment } = await setup()

    const wait = await whenMayItDeploy(environment.id, OUTSIDE)
    expect(wait?.scheduledFor.toISOString()).toBe('2026-09-03T06:00:00.000Z')
  })
})

describe('dueScheduledOrders', () => {
  const scheduleOne = async (at: Date, status: 'scheduled' | 'pending' = 'scheduled') => {
    const { user, product, environment, project } = await setup()
    const order = await createOrder(project.id, product.id, environment.id, user.id, { status })
    await db.update(orders).set({ status, scheduledFor: at }).where(eq(orders.id, order.id))
    return order
  }

  it('returns an order whose window has opened', async () => {
    const order = await scheduleOne(new Date('2026-09-03T06:00:00Z'))
    expect(await dueScheduledOrders(new Date('2026-09-03T06:00:01Z'))).toEqual([order.id])
  })

  it('does not return one whose window has not opened yet', async () => {
    await scheduleOne(new Date('2026-09-03T06:00:00Z'))
    expect(await dueScheduledOrders(new Date('2026-09-03T05:59:00Z'))).toEqual([])
  })

  /*
   * A pending order with a release time is not something the sweep should
   * provision behind an approver's back — and the database will not let one
   * exist. `orders_scheduled_consistency` is what stops it, so the honest
   * assertion is on the constraint rather than on the query filtering a row it
   * can never see. (This test was written the other way first, and the insert
   * failed — which is the constraint doing its job.)
   */
  it('cannot even store a release time on an order that is not scheduled', async () => {
    const { user, product, environment, project } = await setup()
    const order = await createOrder(project.id, product.id, environment.id, user.id, { status: 'pending' })

    let thrown: unknown
    try {
      await db.update(orders).set({ scheduledFor: new Date('2026-09-03T06:00:00Z') }).where(eq(orders.id, order.id))
    } catch (e) {
      thrown = e
    }

    // Drizzle wraps the driver error, so the constraint name is on the cause
    // rather than the message — asserting on the message alone would pass for
    // any failed query at all, including a typo in the column name.
    expect(thrown).toBeInstanceOf(Error)
    const cause = (thrown as { cause?: { constraint_name?: string } }).cause
    expect(cause?.constraint_name).toBe('orders_scheduled_consistency')
  })

  /*
   * `scheduled_for` is NOT cleared when an order is released — it is the record
   * of which window let it through. So the status filter is the only thing
   * stopping the sweep picking a released order up again and provisioning it
   * twice, and a mutant that dropped it passed everything until this existed.
   */
  it('does not return an order it has already released', async () => {
    const { user, product, environment, project } = await setup()
    const order = await createOrder(project.id, product.id, environment.id, user.id, { status: 'pending' })
    await db
      .update(orders)
      .set({ status: 'scheduled', scheduledFor: new Date('2026-09-03T06:00:00Z') })
      .where(eq(orders.id, order.id))

    const now = new Date('2026-09-04T00:00:00Z')
    expect(await dueScheduledOrders(now)).toEqual([order.id])

    // Released — the timestamp stays, the status moves.
    await db.update(orders).set({ status: 'provisioning' }).where(eq(orders.id, order.id))

    expect(await dueScheduledOrders(now)).toEqual([])
  })

  it('returns the longest-waiting first', async () => {
    const later = await scheduleOne(new Date('2026-09-03T10:00:00Z'))
    const earlier = await scheduleOne(new Date('2026-09-03T06:00:00Z'))
    expect(await dueScheduledOrders(new Date('2026-09-04T00:00:00Z'))).toEqual([earlier.id, later.id])
  })
})

/*
 * Releasing what the window has made due (#330).
 *
 * The sweep retries by itself, unlike the approval path where a human decides.
 * That is the whole difficulty: every failure has to answer "is it safe to run
 * this order again?", and getting it wrong deploys the same infrastructure
 * twice.
 */
describe('releaseDueScheduledOrders', () => {
  const AT = new Date('2026-09-02T07:00:00Z')

  const dueOrder = async () => {
    const { user, product, environment, project } = await setup()
    const order = await createOrder(project.id, product.id, environment.id, user.id, { status: 'pending' })
    await db
      .update(orders)
      .set({ status: 'scheduled', scheduledFor: new Date(AT.getTime() - 60_000) })
      .where(eq(orders.id, order.id))
    return order
  }

  const reload = async (id: number) => (await db.select().from(orders).where(eq(orders.id, id)))[0]

  beforeEach(() => {
    vi.mocked(provisionOrderElements).mockReset()
    vi.mocked(logAudit).mockReset()
    vi.mocked(provisionOrderElements).mockResolvedValue({ elementIds: [1], pipelineIds: ['p1'], failures: [] } as never)
    vi.mocked(logAudit).mockResolvedValue(undefined as never)
  })

  it('provisions a due order and leaves it provisioning', async () => {
    const order = await dueOrder()

    const out = await releaseDueScheduledOrders(AT)

    expect(out.released).toEqual([order.id])
    expect((await reload(order.id)).status).toBe('provisioning')
  })

  /*
   * Nothing started, so running it again is exactly what should happen:
   * `provisionOrderElements` throws only when not one pipeline started, and it
   * removes the element rows it inserted on the way out.
   */
  it('reschedules an order whose provisioning started nothing', async () => {
    const order = await dueOrder()
    vi.mocked(provisionOrderElements).mockRejectedValue(new Error('CI unreachable'))

    const out = await releaseDueScheduledOrders(AT)

    expect(out.released).toEqual([])
    expect(out.failed[0].reason).toContain('CI unreachable')
    const row = await reload(order.id)
    expect(row.status).toBe('scheduled')
    // Still due, so the next sweep picks it up.
    expect(row.scheduledFor).not.toBeNull()
  })

  /*
   * The bug this guard exists for. A throw from the bracket that CLOSES the run
   * arrives with pipelines already running; rescheduling would deploy the same
   * infrastructure a second time.
   */
  it('does not reschedule an order whose pipelines had already started', async () => {
    const order = await dueOrder()
    vi.mocked(provisionOrderElements).mockImplementation(async () => {
      await db.update(orders).set({ pipelineId: ['pipe-1'] }).where(eq(orders.id, order.id))
      throw new Error('finishOrderTriggerRun exploded')
    })

    const out = await releaseDueScheduledOrders(AT)

    expect(out.released).toEqual([])
    expect(out.failed[0].reason).toContain('deploy the same infrastructure twice')
    expect((await reload(order.id)).status).toBe('provisioning')
  })

  /*
   * Losing the audit line is bad; duplicating the infrastructure because of it
   * is worse. The audit write used to sit inside the recovery, so a failure
   * there put a successfully provisioned order back to 'scheduled' with its
   * `scheduled_for` still due.
   */
  it('keeps a provisioned order provisioned when its audit entry fails', async () => {
    const order = await dueOrder()
    vi.mocked(logAudit).mockRejectedValue(new Error('audit table is on fire'))

    const out = await releaseDueScheduledOrders(AT)

    expect(out.released).toEqual([order.id])
    expect((await reload(order.id)).status).toBe('provisioning')
  })

  it('leaves an order alone once something else has claimed it', async () => {
    const order = await dueOrder()
    await db.update(orders).set({ status: 'provisioning' }).where(eq(orders.id, order.id))

    const out = await releaseDueScheduledOrders(AT)

    expect(out.released).toEqual([])
    expect(vi.mocked(provisionOrderElements)).not.toHaveBeenCalled()
  })

  /*
   * The sweep asks the gates too (#511).
   *
   * This is the path where an order installs itself hours or days after anybody
   * looked at it, so it is the one where the budget and the policy have most
   * obviously had time to change — and it used to ask neither. A refusal here is
   * a decision for a person, so the order goes back to the approvals queue
   * rather than to 'scheduled', where the next sweep would pick it up again
   * every minute.
   */
  describe('the gates, re-asked when the window opens', () => {
    afterEach(() => vi.restoreAllMocks())

    const withEngine = async () => {
      const root = await createUser({ role: 'root', email: `root-${Math.random()}@test.dev` })
      await createIntegration(root.id, {
        kind: 'opa',
        name: 'Policy engine',
        baseUrl: 'https://opa.example.com',
        authType: 'none',
        failureMode: 'blocking',
      })
    }

    const deny = () =>
      vi.spyOn(global, 'fetch').mockResolvedValue(
        new Response(
          JSON.stringify({ result: { decision: 'deny', rule: 'quota/vm-count', message: 'At the limit' } }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        ),
      )

    /** A due order whose budget was lowered under it while it waited. */
    const overspentDueOrder = async () => {
      const { user, product, environment, project } = await setup()
      await linkProductEnvironment(product.id, environment.id, { price: '400.00', currency: 'EUR' })
      const centre = await createCostCenter()
      await db.update(costCenters).set({
        budgetAmount: '500.00', budgetCurrency: 'EUR', budgetPeriod: 'total', budgetBehaviour: 'block',
      }).where(eq(costCenters.id, centre.id))
      await db.update(projects).set({ costCenterId: centre.id }).where(eq(projects.id, project.id))
      const order = await createOrder(project.id, product.id, environment.id, user.id, { status: 'pending' })
      await db
        .update(orders)
        .set({ status: 'scheduled', scheduledFor: new Date(AT.getTime() - 60_000) })
        .where(eq(orders.id, order.id))
      await db.update(costCenters).set({ budgetAmount: '100.00' }).where(eq(costCenters.id, centre.id))
      return { order }
    }

    it('does not provision an order whose budget no longer allows it', async () => {
      await overspentDueOrder()

      const out = await releaseDueScheduledOrders(AT)

      expect(vi.mocked(provisionOrderElements)).not.toHaveBeenCalled()
      expect(out.released).toEqual([])
      expect(out.failed[0].reason).toMatch(/over budget/i)
    })

    it('returns it to the approval queue rather than rescheduling it', async () => {
      // 'scheduled' would put it straight back where the next sweep picks it up,
      // retrying and re-logging every minute until somebody noticed.
      const { order } = await overspentDueOrder()

      await releaseDueScheduledOrders(AT)

      expect((await reload(order.id)).status).toBe('pending')
    })

    it('does not provision an order a policy denies by then', async () => {
      const order = await dueOrder()
      await withEngine()
      deny()

      const out = await releaseDueScheduledOrders(AT)

      expect(vi.mocked(provisionOrderElements)).not.toHaveBeenCalled()
      expect(out.failed[0].reason).toContain('quota/vm-count')
      expect((await reload(order.id)).status).toBe('pending')
    })

    it('records the refusal against the seam that made it', async () => {
      // The sweep has no actor, so the entry says so — 'null' is the convention
      // its `order.window_opened` entry already follows.
      await dueOrder()
      await withEngine()
      deny()

      await releaseDueScheduledOrders(AT)

      const calls = vi.mocked(logAudit).mock.calls
      const denial = calls.find((c) => c[1] === 'order.policy_denied')
      expect(denial).toBeTruthy()
      expect(String(denial?.[3])).toContain('when its deployment window opened')
    })

    it('still provisions what still fits, when nothing has changed', async () => {
      const order = await dueOrder()

      const out = await releaseDueScheduledOrders(AT)

      expect(out.released).toEqual([order.id])
      expect((await reload(order.id)).status).toBe('provisioning')
    })
  })
})

/*
 * Root deploying a scheduled order early (#330).
 *
 * #330 shipped the `scheduled` state with no way out of it but the sweep. This
 * is the way out, and it is the one place where the guarantee the feature makes
 * is deliberately stepped over — so what it records matters as much as what it
 * does.
 */
describe('deployScheduledOrderNow', () => {
  const AT = new Date('2026-09-02T20:00:00Z')
  const ROOT = { id: 0, email: 'root@test.dev' }

  const scheduledOrder = async () => {
    const { user, product, environment, project } = await setup()
    const order = await createOrder(project.id, product.id, environment.id, user.id, { status: 'pending' })
    await db
      .update(orders)
      .set({ status: 'scheduled', scheduledFor: new Date('2026-09-03T06:00:00Z') })
      .where(eq(orders.id, order.id))
    return { order, actor: { ...ROOT, id: user.id } }
  }

  const reload = async (id: number) => (await db.select().from(orders).where(eq(orders.id, id)))[0]

  beforeEach(() => {
    vi.mocked(provisionOrderElements).mockReset()
    vi.mocked(logAudit).mockReset()
    vi.mocked(provisionOrderElements).mockResolvedValue({ elementIds: [1], pipelineIds: ['p1'], failures: [] } as never)
    vi.mocked(logAudit).mockResolvedValue(undefined as never)
  })

  it('provisions the order and records who overrode the window', async () => {
    const { order, actor } = await scheduledOrder()

    expect(await deployScheduledOrderNow(order.id, actor, AT)).toEqual({ ok: true })

    const row = await reload(order.id)
    expect(row.status).toBe('provisioning')
    expect(row.windowOverrideBy).toBe(actor.id)
    expect(row.windowOverrideAt?.toISOString()).toBe(AT.toISOString())
    // Left in place on purpose: it says which window this order was waiting
    // for, which is the context that makes the override legible later.
    expect(row.scheduledFor).not.toBeNull()
  })

  /*
   * Read from the TABLE, not from a mocked `logAudit`. The entry is written with
   * `logAuditWith(tx, ...)` inside the claim's transaction — a mock would assert
   * that a function was called and say nothing about whether the row survived
   * the commit, which is the only part that matters here.
   */
  it('audits the override before provisioning, naming who and what was due', async () => {
    const { order, actor } = await scheduledOrder()

    await deployScheduledOrderNow(order.id, actor, AT)

    const [entry] = await db.select().from(auditLog).where(eq(auditLog.action, 'order.window_overridden'))
    expect(entry.userId).toBe(actor.id)
    expect(entry.entityId).toBe(order.id)
    expect(entry.details).toContain('without waiting for its window')
  })

  /*
   * The reason it is one transaction. The claim commits `scheduled ->
   * provisioning`; if the audit insert then failed on its own, the order would
   * be left where no sweep looks — `dueScheduledOrders` selects on `scheduled`
   * — with nothing recording who moved it. Rolling back together keeps the
   * order in the queue, which is recoverable.
   */
  it('leaves the order queued if the override cannot be recorded', async () => {
    const { order, actor } = await scheduledOrder()
    // The audit table is the thing that fails; the claim must go back with it.
    await db.execute(sql`ALTER TABLE audit_log ADD CONSTRAINT tmp_no_override CHECK (action <> 'order.window_overridden')`)
    try {
      await expect(deployScheduledOrderNow(order.id, actor, AT)).rejects.toThrow()
    } finally {
      await db.execute(sql`ALTER TABLE audit_log DROP CONSTRAINT tmp_no_override`)
    }

    const row = await reload(order.id)
    expect(row.status, 'the claim outlived the audit that justifies it').toBe('scheduled')
    expect(row.windowOverrideBy).toBeNull()
    expect(vi.mocked(provisionOrderElements)).not.toHaveBeenCalled()
  })

  /*
   * The decision to step over the guardrail was made whether or not CI then
   * answered. An override recorded only on success would leave the least
   * explicable case — forced out of hours, and it broke — with no audit entry.
   */
  it('records the override even when provisioning fails', async () => {
    const { order, actor } = await scheduledOrder()
    vi.mocked(provisionOrderElements).mockRejectedValue(new Error('CI unreachable'))

    const outcome = await deployScheduledOrderNow(order.id, actor, AT)

    expect(outcome).toMatchObject({ ok: false, status: 502 })
    const [entry] = await db.select().from(auditLog).where(eq(auditLog.action, 'order.window_overridden'))
    expect(entry.entityId).toBe(order.id)
    const row = await reload(order.id)
    expect(row.status, 'nothing started, so it goes back in the queue').toBe('scheduled')
    expect(row.windowOverrideBy).toBe(actor.id)
  })

  /*
   * The trap a human being present does NOT remove. Putting the order back to
   * 'scheduled' with `scheduled_for` still due hands it to the sweep, which
   * would deploy the same infrastructure again hours later with nobody watching.
   */
  it('leaves the order provisioning when its pipelines had already started', async () => {
    const { order, actor } = await scheduledOrder()
    vi.mocked(provisionOrderElements).mockImplementation(async () => {
      await db.update(orders).set({ pipelineId: ['pipe-1'] }).where(eq(orders.id, order.id))
      throw new Error('finishOrderTriggerRun exploded')
    })

    const outcome = await deployScheduledOrderNow(order.id, actor, AT)

    expect(outcome).toMatchObject({ ok: false })
    if (outcome.ok) return
    expect(outcome.message).toContain('deploy the same infrastructure twice')
    expect((await reload(order.id)).status).toBe('provisioning')
  })

  /*
   * Root pressing "Deploy now" at 07:59 while the 08:00 sweep fires must
   * provision the order once. The claim is what settles it, so whoever loses
   * has to be told something true.
   */
  it('refuses an order the sweep has already claimed', async () => {
    const { order, actor } = await scheduledOrder()
    await db.update(orders).set({ status: 'provisioning' }).where(eq(orders.id, order.id))

    const outcome = await deployScheduledOrderNow(order.id, actor, AT)

    expect(outcome).toMatchObject({ ok: false, status: 400 })
    if (!outcome.ok) expect(outcome.message).toContain('provisioning')
    expect(vi.mocked(provisionOrderElements)).not.toHaveBeenCalled()
  })

  it('is a 404 for an order that does not exist', async () => {
    expect(await deployScheduledOrderNow(999_999, ROOT, AT)).toMatchObject({ ok: false, status: 404 })
  })

  /*
   * Deploying early is the same commitment as approving, taken later than the
   * decisions behind it, so the gates are asked here too (#511). Before the
   * claim rather than after: the claim writes the window override and its audit
   * entry in one transaction, and refusing afterwards would either lose the
   * record that root tried or provision against a spent budget.
   */
  describe('the gates, re-asked before the window is overridden', () => {
    afterEach(() => vi.restoreAllMocks())

    /** A scheduled order whose budget was lowered under it while it waited. */
    const overspentScheduledOrder = async () => {
      const { user, product, environment, project } = await setup()
      await linkProductEnvironment(product.id, environment.id, { price: '400.00', currency: 'EUR' })
      const centre = await createCostCenter()
      await db.update(costCenters).set({
        budgetAmount: '500.00', budgetCurrency: 'EUR', budgetPeriod: 'total', budgetBehaviour: 'block',
      }).where(eq(costCenters.id, centre.id))
      await db.update(projects).set({ costCenterId: centre.id }).where(eq(projects.id, project.id))
      const order = await createOrder(project.id, product.id, environment.id, user.id, { status: 'pending' })
      await db
        .update(orders)
        .set({ status: 'scheduled', scheduledFor: new Date('2026-09-03T06:00:00Z') })
        .where(eq(orders.id, order.id))
      await db.update(costCenters).set({ budgetAmount: '100.00' }).where(eq(costCenters.id, centre.id))
      return { order, actor: { ...ROOT, id: user.id } }
    }

    it('refuses to deploy early when the budget no longer allows it', async () => {
      const { order, actor } = await overspentScheduledOrder()

      const outcome = await deployScheduledOrderNow(order.id, actor, AT)

      expect(outcome).toMatchObject({ ok: false, status: 409 })
      if (!outcome.ok) expect(outcome.message).toMatch(/over budget/i)
      expect(vi.mocked(provisionOrderElements)).not.toHaveBeenCalled()
    })

    it('leaves it scheduled, with no override recorded, when it is refused', async () => {
      // The window was never stepped over, so there is nothing to record about
      // stepping over it — and the order still has its window.
      const { order, actor } = await overspentScheduledOrder()

      await deployScheduledOrderNow(order.id, actor, AT)

      const row = await reload(order.id)
      expect(row.status).toBe('scheduled')
      expect(row.windowOverrideBy).toBeNull()
      expect(vi.mocked(logAudit).mock.calls.filter((c) => c[1] === 'order.window_overridden')).toHaveLength(0)
    })

    it('refuses when a policy denies the order by then', async () => {
      // No budget in play: the budget gate is asked first, so a fixture with a
      // lowered ceiling would be refused by that one and never reach the rule.
      const { order, actor } = await scheduledOrder()
      const root = await createUser({ role: 'root', email: `root-${Math.random()}@test.dev` })
      await createIntegration(root.id, {
        kind: 'opa',
        name: 'Policy engine',
        baseUrl: 'https://opa.example.com',
        authType: 'none',
        failureMode: 'blocking',
      })
      vi.spyOn(global, 'fetch').mockResolvedValue(
        new Response(
          JSON.stringify({ result: { decision: 'deny', rule: 'quota/vm-count', message: 'At the limit' } }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        ),
      )

      const outcome = await deployScheduledOrderNow(order.id, actor, AT)

      expect(outcome).toMatchObject({ ok: false, status: 409 })
      if (!outcome.ok) expect(outcome.message).toContain('quota/vm-count')
      expect(vi.mocked(provisionOrderElements)).not.toHaveBeenCalled()
      expect((await reload(order.id)).status).toBe('scheduled')
    })

    it('still deploys what still fits', async () => {
      const { order, actor } = await scheduledOrder()

      expect(await deployScheduledOrderNow(order.id, actor, AT)).toEqual({ ok: true })
    })

    /*
     * #519. The escapes reached the approvals queue (#514) and the order form
     * (#509) and stopped short of this path, which is the one where the operator is
     * mid-incident with an order that is ready to go: approved, waiting for a
     * window, wanted now. Same two rights, same rule, same audit entry.
     */
    it('lets root waive the budget refusal here too (#519)', async () => {
      const { order, actor } = await overspentScheduledOrder()

      // With a role: `recheckOrderGates` decides against the actor's own, and the
      // fixtures above pass one without — which is why nothing could waive here.
      const outcome = await deployScheduledOrderNow(order.id, { ...actor, role: 'root' }, AT, {
        overrideBudget: true,
      })

      expect(outcome).toEqual({ ok: true })
      expect(vi.mocked(provisionOrderElements)).toHaveBeenCalled()
      const entry = vi.mocked(logAudit).mock.calls.find((c) => c[1] === 'order.budget_overridden')
      expect(entry?.[3]).toMatch(/over budget/i)
    })

    it('names the refusal, so the button that started this can offer the escape (#519)', async () => {
      // Without the code the control has only the sentence, and matching on prose
      // is what breaks the first time somebody rewords it.
      const { order, actor } = await overspentScheduledOrder()

      const outcome = await deployScheduledOrderNow(order.id, { ...actor, role: 'root' }, AT)

      expect(outcome).toMatchObject({ ok: false, status: 409, code: 'budget_blocked' })
    })

    it('does not waive it for an actor who is not root', async () => {
      const { order, actor } = await overspentScheduledOrder()

      const outcome = await deployScheduledOrderNow(order.id, { ...actor, role: 'admin' }, AT, {
        overrideBudget: true,
      })

      expect(outcome).toMatchObject({ ok: false, status: 409 })
      expect(vi.mocked(provisionOrderElements)).not.toHaveBeenCalled()
      expect((await reload(order.id)).status).toBe('scheduled')
    })
  })
})
