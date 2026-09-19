import type { PipelineEvent } from '@infrashelf/types'
import { db } from '@/lib/db/client'
import { orders, infrastructureElements } from '@/lib/db/schema'
import { sql } from 'drizzle-orm'
import { logAudit } from '@/lib/audit'
import { sendProvisioningFailed } from '@/lib/notification'
import { findProductName, findUserEmail, findAdminEmails } from '@/lib/db/queries'
import { settleOrderIfComplete, settleElementIfComplete } from '@/lib/webhook/settle'

export const handlePipelineEvent = async (
  event: PipelineEvent,
  environmentId: number,
): Promise<void> => {
  const pipelineIdJson = JSON.stringify([event.pipelineId])

  // Scope the match to the environment whose callback secret authenticated this
  // request. A pipeline id is only unique within a CI source/environment, and
  // (more importantly) env A's secret must never be able to transition an
  // order/infra element that belongs to env B.
  //
  // 'failed' is in the selection because a restart in CI is a repair (#500): the
  // pipeline succeeds, the same webhook arrives, and with `provisioning` alone the
  // row matched nothing and the event was dropped with no record that it came. The
  // branch below decides what a matching success may then do; this predicate only
  // decides who gets to be considered.
  const matchingOrders = await db
    .select({
      id: orders.id,
      userId: orders.userId,
      productId: orders.productId,
      environmentId: orders.environmentId,
      pipelineId: orders.pipelineId,
      pipelineStatus: orders.pipelineStatus,
    })
    .from(orders)
    .where(
      sql`${orders.status} IN ('provisioning', 'failed') AND ${orders.environmentId} = ${environmentId} AND ${orders.pipelineId} @> ${pipelineIdJson}::jsonb`,
    )

  const matchingInfra = await db
    .select({
      id: infrastructureElements.id,
      orderId: infrastructureElements.orderId,
      productId: infrastructureElements.productId,
      environmentId: infrastructureElements.environmentId,
      pipelineId: infrastructureElements.pipelineId,
      pipelineStatus: infrastructureElements.pipelineStatus,
    })
    .from(infrastructureElements)
    .where(
      sql`${infrastructureElements.status} = 'decommissioning' AND ${infrastructureElements.environmentId} = ${environmentId} AND ${infrastructureElements.pipelineId} @> ${pipelineIdJson}::jsonb`,
    )

  if (event.status === 'success') {
    for (const order of matchingOrders) {
      // Merge this pipeline's success into the JSONB map atomically: `||` is a
      // single UPDATE, so two concurrent success events can't lose each other's
      // keys (read-modify-write would). Guard on the order being findable at all
      // — 'provisioning' or 'failed' (#500) — so a stale event can't resurrect a
      // completed or rejected order.
      //
      // `failed` is allowed through because it is where a restart in CI lands: the
      // operator fixes the pipeline in the CI UI, it succeeds, and this merge is
      // what records it. Whether that finishes the order is settle's call, and it
      // is the map merged here that decides: a sibling still failed or still
      // running leaves the order failed.
      const successPatch = JSON.stringify({ [event.pipelineId]: 'success' })
      const merged = await db
        .update(orders)
        .set({
          pipelineStatus: sql`${orders.pipelineStatus} || ${successPatch}::jsonb`,
          updatedAt: new Date(),
        })
        .where(sql`${orders.id} = ${order.id} AND ${orders.status} IN ('provisioning', 'failed')`)
        .returning({ pipelineId: orders.pipelineId, pipelineStatus: orders.pipelineStatus })

      if (!merged.length) continue // already terminal — ignore stale/duplicate event

      // Whether that success finishes the order — and what to do about it — is
      // `settleOrderIfComplete`'s to decide, because the trigger fan-out has to
      // reach the same decision when it outruns a callback (see pipelineTracking).
      await settleOrderIfComplete(order, merged[0], `Pipeline ${event.pipelineId} succeeded`)
    }

    for (const infra of matchingInfra) {
      // Same all-pipelines rule as orders: a teardown can fan out to several
      // pipelines (product webhooks + pipeline stacks), so merge this one's
      // success into the JSONB map (`||` is a single atomic UPDATE, so
      // concurrent events can't lose each other's keys) and let
      // `settleElementIfComplete` decide whether that finished the teardown.
      // Guard on 'decommissioning' so a stale event can't resurrect an
      // already-terminal element.
      const successPatch = JSON.stringify({ [event.pipelineId]: 'success' })
      const merged = await db
        .update(infrastructureElements)
        .set({ pipelineStatus: sql`${infrastructureElements.pipelineStatus} || ${successPatch}::jsonb` })
        .where(
          sql`${infrastructureElements.id} = ${infra.id} AND ${infrastructureElements.status} = 'decommissioning'`,
        )
        .returning({
          pipelineId: infrastructureElements.pipelineId,
          pipelineStatus: infrastructureElements.pipelineStatus,
        })

      if (!merged.length) continue // already terminal — ignore stale/duplicate event

      await settleElementIfComplete(infra, merged[0], `Pipeline ${event.pipelineId} succeeded`)
    }
  } else if (event.status === 'failed' || event.status === 'canceled') {
    for (const order of matchingOrders) {
      // A single failed/canceled pipeline fails the whole order immediately,
      // regardless of how many siblings already succeeded. Guard on
      // 'provisioning' (compare-and-swap) so a stale failure can't overwrite a
      // completed order and re-send notifications, and merge the status
      // atomically to avoid losing concurrent updates.
      //
      // Narrower than the success guard above, on purpose (#500): an order that is
      // already 'failed' learns nothing from a second failure, and the customer
      // and the admins have already been told once. Only a success can move a
      // failed order, and only when nothing is left outstanding.
      const failPatch = JSON.stringify({ [event.pipelineId]: event.status })
      const failed = await db
        .update(orders)
        .set({
          status: 'failed',
          pipelineStatus: sql`${orders.pipelineStatus} || ${failPatch}::jsonb`,
          updatedAt: new Date(),
        })
        .where(sql`${orders.id} = ${order.id} AND ${orders.status} = 'provisioning'`)
        .returning({ id: orders.id })

      if (!failed.length) continue // already terminal — ignore stale/duplicate event

      await logAudit(
        null,
        'order.failed',
        order.id,
        `Pipeline ${event.pipelineId} ${event.status}`,
      )

      const email = await findUserEmail(order.userId)
      const productName = await findProductName(order.productId)
      if (email) {
        await sendProvisioningFailed(email, productName, order.id)
      }

      const adminEmails = await findAdminEmails()
      for (const adminEmail of adminEmails) {
        if (adminEmail !== email) {
          await sendProvisioningFailed(adminEmail, productName, order.id)
        }
      }
    }

    for (const infra of matchingInfra) {
      // Record the failure in the per-pipeline map so a sibling pipeline's
      // later success can never satisfy the all-succeeded check and report the
      // teardown as complete. The element deliberately stays 'decommissioning'
      // — there is no terminal failure status, and leaving it non-'active'
      // keeps it out of service while flagging it for manual attention.
      const failPatch = JSON.stringify({ [event.pipelineId]: event.status })
      await db
        .update(infrastructureElements)
        .set({ pipelineStatus: sql`${infrastructureElements.pipelineStatus} || ${failPatch}::jsonb` })
        .where(
          sql`${infrastructureElements.id} = ${infra.id} AND ${infrastructureElements.status} = 'decommissioning'`,
        )

      await logAudit(
        null,
        'infra.decommission_failed',
        infra.id,
        `Pipeline ${event.pipelineId} ${event.status}`,
      )
    }
  }
}
