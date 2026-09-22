import { and, eq, lte } from 'drizzle-orm'
import { db } from '@/lib/db/client'
import {
  appConfig, deploymentEnvironments, deploymentWindows, holidays, orders, productEnvironments,
} from '@/lib/db/schema'
import { isWithinWindow, nextWindowStart, type WindowPolicy } from './deploymentWindows'
import { logAudit, logAuditWith } from '@/lib/audit'
import { recheckOrderGates } from '@/lib/services/commitGates'
import type { Role } from '@infrashelf/types'
import { holidayGuard } from './holidayFeed'

/**
 * Reading the window policy out of the database (#330).
 *
 * The arithmetic in `deploymentWindows.ts` is pure and takes its inputs; this is
 * the only place that fetches them. Keeping the two apart is what lets every
 * DST and boundary case be tested without a database, and it means the rules
 * cannot quietly start depending on a clock.
 */

/** No windows configured means no restriction — the feature is opt-in twice. */
export const loadWindowPolicy = async (): Promise<WindowPolicy> => {
  const [config] = await db.select({ zone: appConfig.deploymentTimeZone }).from(appConfig).limit(1)
  const windows = await db
    .select({ startMinute: deploymentWindows.startMinute, durationMinutes: deploymentWindows.durationMinutes })
    .from(deploymentWindows)
  const observed = await db.select({ date: holidays.date }).from(holidays).where(eq(holidays.observed, true))

  return {
    windows,
    // UTC is the column default, so this is only ever null on a database that
    // predates the column — which the migration does not leave behind.
    timeZone: config?.zone ?? 'UTC',
    holidays: new Set(observed.map((h) => h.date)),
  }
}

/**
 * What should happen to an order that has just been approved.
 *
 * `null` means provision it now, which is the answer for every environment that
 * has not opted in and every moment inside a window.
 *
 * Two switches have to be on before an order ever waits: the environment must
 * set `respectsDeploymentWindows` — default false, so an upgrade changes nothing
 * — and at least one window must be configured. A deployment that turned the
 * flag on and defined no windows would otherwise queue every order for ever,
 * which is a worse failure than not having the feature.
 */
export const whenMayItDeploy = async (
  environmentId: number,
  now: Date,
): Promise<{ scheduledFor: Date } | null> => {
  const [environment] = await db
    .select({ respects: deploymentEnvironments.respectsDeploymentWindows })
    .from(deploymentEnvironments)
    .where(eq(deploymentEnvironments.id, environmentId))
    .limit(1)

  if (!environment?.respects) return null

  /*
   * Fail closed, and note which way "closed" points (#330).
   *
   * If a holiday feed is configured and has never once been read, the portal has
   * no holiday data — so a public holiday and a working day are
   * indistinguishable, and applying the windows would mean provisioning on
   * Christmas morning while claiming the opposite. The promise cannot be kept,
   * so it is not made: the order provisions now, exactly as it would have before
   * the feature existed, and the admin UI says loudly why.
   *
   * Deliberately NOT the other direction. Holding every order until somebody
   * fixes a feed would turn a third party's outage into a queue nobody asked
   * for, and the requester would have no idea. Deploying is the behaviour this
   * deployment had yesterday; refusing to deploy is a new failure invented by a
   * safety feature.
   *
   * A feed that worked once and is failing now does not reach here: it has a
   * last good answer, and public holidays do not move often.
   */
  const guard = await holidayGuard()
  if (guard) {
    console.error(`[windowPolicy] deployment windows are not being applied: ${guard}`)
    return null
  }

  const policy = await loadWindowPolicy()
  if (isWithinWindow(now, policy)) return null

  const next = nextWindowStart(now, policy)
  /*
   * `null` covers both ways a configuration can fail to open, and both answer
   * the same: provision now.
   *
   *  - No windows configured at all. The flag is on but the second half of the
   *    opt-in was never done.
   *  - Windows exist but every day within a year is excluded.
   *
   * There was an explicit `windows.length === 0` guard above this; it was
   * removed because `nextWindowStart` already returns null for that case, so
   * nothing could ever reach it — an unreachable branch is one nobody can
   * trust, and a mutant that deleted it passed every test.
   *
   * Provisioning is the lesser wrong either way: the alternative is an order
   * that waits for ever with nothing to tell its requester.
   */
  if (next === null) return null

  return { scheduledFor: next }
}

/** Scheduled orders whose window has opened, oldest first. */
export const dueScheduledOrders = async (now: Date): Promise<number[]> => {
  const rows = await db
    .select({ id: orders.id })
    .from(orders)
    .where(and(eq(orders.status, 'scheduled'), lte(orders.scheduledFor, now)))
    .orderBy(orders.scheduledFor)
  return rows.map((r) => r.id)
}

/**
 * The trial length the offering currently declares, or the schema default.
 *
 * Same fallback as the approval path: an offering withdrawn or given a nonsense
 * duration while the order waited must not block a deployment an admin already
 * approved — the trial is still torn down, just on the default clock.
 */
const trialDurationFor = async (productId: number, environmentId: number): Promise<number> => {
  const [offering] = await db
    .select({ minutes: productEnvironments.trialDurationMinutes })
    .from(productEnvironments)
    .where(and(eq(productEnvironments.productId, productId), eq(productEnvironments.environmentId, environmentId)))
    .limit(1)
  return offering && offering.minutes > 0 ? offering.minutes : 30
}

/**
 * Did this order's fan-out get anything started?
 *
 * `pipeline_id` is appended to as each trigger returns rather than in one write
 * at the end, so it is a truthful answer even from inside a failure — which is
 * what makes it usable as the guard below.
 *
 * The question matters because an order put back to 'scheduled' with its
 * `scheduled_for` still due is an order the sweep will provision again.
 * `provisionOrderElements` throws only when NOTHING started (it deletes its own
 * element rows on that path), but a throw from the bracket that CLOSES the run
 * arrives with pipelines already running — and that one must not be retried.
 */
const anythingStarted = async (orderId: number): Promise<boolean> => {
  const [row] = await db.select({ pipelineId: orders.pipelineId }).from(orders).where(eq(orders.id, orderId))
  return (row?.pipelineId ?? []).length > 0
}

/**
 * Root deploys a scheduled order now, without waiting for its window (#330).
 *
 * The same atomic claim the sweep uses, and for the same reason: root pressing
 * "Deploy now" at 07:59 while the 08:00 sweep fires must provision the order
 * once, not twice. Whoever loses the claim gets zero rows back and is told the
 * order is no longer scheduled, which is true and is what the UI should say.
 *
 * `windowOverrideBy` and `windowOverrideAt` are written in the SAME statement as
 * the claim rather than afterwards. They are the record of a guardrail being
 * stepped over, and a second write could fail and leave an order provisioned
 * outside its window with nothing saying who decided that.
 *
 * `scheduledFor` is deliberately left in place: it says which window this order
 * was waiting for, which is the context that makes the override legible months
 * later. The status is what stops the sweep touching it again.
 */
export const deployScheduledOrderNow = async (
  orderId: number,
  actor: { id: number; email: string; role?: Role },
  now: Date,
): Promise<{ ok: true } | { ok: false; status: number; message: string }> => {
  /*
   * The gates, before the claim (#511): root deploying a scheduled order early
   * is the same commitment as approving it, a day later than the decision, so the
   * budget and the policy are asked again here too.
   *
   * Before the claim rather than after, because the claim writes the window
   * override and its audit entry in one transaction: refusing afterwards would
   * either have to roll that record back — losing the fact that root tried — or
   * leave an order provisioned against a spent budget. Asking first costs one
   * engine call on a button a human presses.
   */
  const gates = await recheckOrderGates(orderId, {
    seam: 'when it was deployed outside its window',
    actor: actor.role ? { id: actor.id, email: actor.email, role: actor.role } : null,
  })
  if (!gates.ok) return { ok: false, status: gates.status, message: gates.message }

  /*
   * The claim and its audit entry in ONE transaction.
   *
   * They were two statements, and the gap between them was a trap: the claim
   * commits `scheduled -> provisioning`, and if the audit insert then rejected,
   * the throw left an order no sweep will ever look at again —
   * `dueScheduledOrders` selects on `scheduled` — with no record of who moved
   * it. Stuck, and unattributed. Either both land or the order stays queued.
   */
  const claimed = await db.transaction(async (tx) => {
    const rows = await tx
      .update(orders)
      .set({
        status: 'provisioning',
        windowOverrideBy: actor.id,
        windowOverrideAt: now,
        updatedAt: now,
      })
      .where(and(eq(orders.id, orderId), eq(orders.status, 'scheduled')))
      .returning({
        id: orders.id, projectId: orders.projectId, productId: orders.productId,
        environmentId: orders.environmentId, parameters: orders.parameters,
        sizeCode: orders.sizeCode, quantity: orders.quantity, isTrial: orders.isTrial,
        scheduledFor: orders.scheduledFor,
      })

    if (rows.length === 0) return rows

    /*
     * Audited here — before provisioning, not after it.
     *
     * Everything below can take minutes and can fail, and the decision to step
     * over the guardrail was made either way. An override recorded only on
     * success would leave the least explicable case — root forced a deployment
     * out of hours and it broke — as the one with no audit entry.
     */
    await logAuditWith(
      tx,
      actor.id,
      'order.window_overridden',
      rows[0].id,
      `${actor.email} deployed order #${rows[0].id} without waiting for its window` +
        (rows[0].scheduledFor ? ` (was due ${rows[0].scheduledFor.toISOString()})` : ''),
    )
    return rows
  })

  if (claimed.length === 0) {
    const [existing] = await db.select({ status: orders.status }).from(orders).where(eq(orders.id, orderId))
    if (!existing) return { ok: false, status: 404, message: 'Order not found' }
    return {
      ok: false,
      status: 400,
      message: `Only a scheduled order can be deployed early; this one is ${existing.status}`,
    }
  }

  const order = claimed[0]

  try {
    const { provisionOrderElements } = await import('@/lib/services/orders')
    await provisionOrderElements({
      orderId: order.id,
      projectId: order.projectId,
      productId: order.productId,
      environmentId: order.environmentId,
      parameters: order.parameters,
      sizeCode: order.sizeCode,
      quantity: order.quantity > 0 ? order.quantity : 1,
      isTrial: order.isTrial,
      // Re-read for the reason the sweep re-reads it: a trial's clock starts
      // when it provisions, and passing 0 would give it a zero-minute life.
      trialDurationMinutes: order.isTrial ? await trialDurationFor(order.productId, order.environmentId) : 0,
    })
  } catch (e) {
    /*
     * Back to 'scheduled' only when nothing started — the same guard the sweep
     * uses, and needed here for the same reason.
     *
     * A human standing in front of this does NOT make it safe to reschedule an
     * order whose pipelines are already running: `scheduled_for` is still due,
     * so the next sweep would pick it up and deploy the same infrastructure a
     * second time, hours later, with nobody watching. The override stays
     * recorded either way — the decision was made.
     */
    const started = await anythingStarted(order.id)
    if (!started) {
      await db.update(orders).set({ status: 'scheduled', updatedAt: new Date() }).where(eq(orders.id, order.id))
    }
    return {
      ok: false,
      status: 502,
      message:
        (e instanceof Error ? e.message : 'Provisioning could not be started') +
        (started
          ? ' — the order was left provisioning: its pipelines had already started, so returning it to the queue would deploy the same infrastructure twice'
          : ''),
    }
  }

  return { ok: true }
}

/**
 * Release every scheduled order whose window has opened.
 *
 * The claim is `scheduled -> provisioning` conditioned on the row still being
 * scheduled, so two overlapping sweeps — or a sweep racing root's override —
 * cannot both provision one order. Whoever loses gets zero rows back and skips,
 * exactly as `claimAndDestroy` does for decommissioning.
 *
 * Each order is released independently: one product whose CI is unreachable
 * must not stop the other nineteen from deploying when their window opened.
 */
export const releaseDueScheduledOrders = async (
  now: Date,
): Promise<{ released: number[]; failed: { orderId: number; reason: string }[] }> => {
  const due = await dueScheduledOrders(now)
  const released: number[] = []
  const failed: { orderId: number; reason: string }[] = []

  for (const orderId of due) {
    const claimed = await db
      .update(orders)
      .set({ status: 'provisioning', updatedAt: now })
      .where(and(eq(orders.id, orderId), eq(orders.status, 'scheduled')))
      .returning({
        id: orders.id, projectId: orders.projectId, productId: orders.productId,
        environmentId: orders.environmentId,
        parameters: orders.parameters, sizeCode: orders.sizeCode,
        quantity: orders.quantity, isTrial: orders.isTrial,
      })

    // Someone got there first — root's override, or another replica's sweep.
    if (claimed.length === 0) continue

    const order = claimed[0]

    /*
     * The gates, asked again (#511). The sweep is where an order installs
     * itself hours or days after anybody looked at it, and it asked nothing:
     * the budget can have been lowered and the policy changed in between.
     *
     * On a refusal the order goes back to 'pending' rather than to 'scheduled'.
     * A gate that refuses is a decision for a person, and 'scheduled' would put
     * it straight back where the next sweep picks it up — retrying, and
     * re-logging, every minute until somebody notices. 'pending' is the queue
     * an admin is looking at, and it is also where the order is approvable again
     * once the budget is raised or the rule changed.
     */
    const gates = await recheckOrderGates(order.id, { seam: 'when its deployment window opened' })
    if (!gates.ok) {
      /*
       * `scheduledFor` is cleared with the status, and not only for tidiness:
       * `orders_scheduled_consistency` refuses a `pending` order that still
       * carries a release time — "a row carrying either without the other is a
       * bug that surfaces as an order the sweep picks up for ever". The
       * database caught this before the test suite did.
       */
      await db
        .update(orders)
        .set({ status: 'pending', scheduledFor: null, updatedAt: now })
        .where(eq(orders.id, order.id))
      failed.push({ orderId: order.id, reason: gates.message })
      continue
    }

    try {
      const { provisionOrderElements } = await import('@/lib/services/orders')
      await provisionOrderElements({
        orderId: order.id,
        projectId: order.projectId,
        productId: order.productId,
        environmentId: order.environmentId,
        parameters: order.parameters,
        sizeCode: order.sizeCode,
        quantity: order.quantity > 0 ? order.quantity : 1,
        isTrial: order.isTrial,
        // Re-read here, exactly as the approval path does, and for a sharper
        // version of the same reason: a trial's clock starts when it
        // PROVISIONS, which for a scheduled order is now rather than when it
        // was approved. Passing 0 would have given every scheduled trial a
        // zero-minute lifetime — torn down by the next decommission sweep,
        // minutes after it came up.
        trialDurationMinutes: order.isTrial ? await trialDurationFor(order.productId, order.environmentId) : 0,
      })
    } catch (e) {
      /*
       * Back to 'scheduled' rather than 'failed' — but ONLY when nothing started.
       *
       * The ordinary failure is safe to retry: `provisionOrderElements` throws
       * only when not one pipeline started, and it deletes the element rows it
       * had inserted on the way out. The next sweep picks the order up again,
       * which is what should happen when CI blinks — an order marked failed for
       * that is one a human has to notice and redo.
       *
       * What is NOT safe to retry is a throw that arrives with pipelines already
       * running, from the bracket that closes the run. Rescheduling that order
       * would provision the same infrastructure a second time. This differs from
       * the approval path, where a human decides whether to retry; the sweep
       * retries by itself, so it has to be sure. `pipeline_id` is appended to as
       * each trigger returns, not at the end, so it is a truthful answer to
       * "did anything start".
       */
      const started = await anythingStarted(order.id)

      if (!started) {
        await db.update(orders).set({ status: 'scheduled', updatedAt: new Date() }).where(eq(orders.id, order.id))
      }
      failed.push({
        orderId: order.id,
        reason:
          (e instanceof Error ? e.message : String(e)) +
          (started
            ? ' — left in provisioning: pipelines had already started, so rescheduling it would deploy the same infrastructure twice'
            : ''),
      })
      continue
    }

    /*
     * Outside the recovery above, deliberately.
     *
     * Inside it, an audit write that failed after a successful provisioning put
     * the order back to 'scheduled' with its `scheduled_for` still due — and the
     * next sweep provisioned it all over again. Losing the audit line is bad;
     * duplicating the infrastructure because of it is worse, so this says so on
     * stderr and the order stays where it is.
     */
    try {
      await logAudit(null, 'order.window_opened', order.id, 'Deployment window opened; provisioning started')
    } catch (e) {
      console.error(`[windowPolicy] order ${order.id} provisioned but its audit entry failed:`, e)
    }
    released.push(order.id)
  }

  return { released, failed }
}
