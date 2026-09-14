import { db } from '@/lib/db/client'
import { pipelineStacks, infrastructureElements } from '@/lib/db/schema'
import { eq, and, ne, sql } from 'drizzle-orm'
import { ok, err, type Result } from '@/lib/services/result'
import { logAudit, changedFields } from '@/lib/audit'
import { isEmptyUpdate, EMPTY_UPDATE_MESSAGE } from '@/lib/services/updates'
import type { PipelineStack, CreatePipelineStackRequest, UpdatePipelineStackRequest } from '@infrashelf/types'

const publicColumns = {
  id: pipelineStacks.id,
  productId: pipelineStacks.productId,
  environmentId: pipelineStacks.environmentId,
  name: pipelineStacks.name,
  stateKeyParam: pipelineStacks.stateKeyParam,
  steps: pipelineStacks.steps,
}

export const listPipelineStacks = async (productId: number): Promise<Result<PipelineStack[]>> => {
  const rows = await db
    .select(publicColumns)
    .from(pipelineStacks)
    .where(eq(pipelineStacks.productId, productId))
    // Ordered, or the list an administrator reads reshuffles between two page
    // loads for no reason they can see. By id, which is the order they were
    // added in; the steps INSIDE a stack are a jsonb array and keep their own
    // order, so provisioning was never affected by this.
    .orderBy(pipelineStacks.id)

  return ok(rows as PipelineStack[])
}

export const createPipelineStack = async (
  productId: number,
  input: CreatePipelineStackRequest,
  actorId?: number,
): Promise<Result<PipelineStack>> => {
  const [row] = await db
    .insert(pipelineStacks)
    .values({
      productId,
      environmentId: input.environmentId,
      name: input.name,
      stateKeyParam: input.stateKeyParam ?? 'hostname',
      steps: input.steps,
    })
    .returning(publicColumns)

  // `entityId` is the STACK, matching the `pipeline_stack.` prefix — every other
  // service passes the id of the entity its action names, and a filter on the prefix
  // is only useful if the id under it means the same thing every time. It carried
  // the product id, so a search for stack #7 found nothing and a search for product
  // #7 found stacks. NFA-04.3 makes this table append-only, so the entries already
  // written cannot be corrected; the product moves to `details`, where it belongs.
  await logAudit(
    actorId ?? null,
    'pipeline_stack.created',
    row.id,
    `Stack ${input.name} on product #${productId} for environment #${input.environmentId} with ${input.steps.length} step(s)`,
  )

  return ok(row as PipelineStack)
}

/**
 * Elements this stack's teardown would address, that are still standing.
 *
 * A stack is scoped to one product in one environment, and every element
 * provisioned from that pair derives its Terraform state key through this
 * stack's `stateKeyParam`. `decommissioned` rows are excluded — their state is
 * already gone, so nothing is at risk. `decommissioning` rows are NOT: their
 * destroy has been claimed but may not have run yet, which is precisely the
 * window this guard is about.
 */
const liveElementsFor = async (stack: { productId: number; environmentId: number }): Promise<number> => {
  const [row] = await db
    .select({ n: sql<number>`COUNT(*)::int` })
    .from(infrastructureElements)
    .where(
      and(
        eq(infrastructureElements.productId, stack.productId),
        eq(infrastructureElements.environmentId, stack.environmentId),
        ne(infrastructureElements.status, 'decommissioned'),
      ),
    )
  return row?.n ?? 0
}

export const updatePipelineStack = async (
  productId: number,
  stackId: number,
  input: UpdatePipelineStackRequest,
  actorId?: number,
): Promise<Result<PipelineStack>> => {
  if (isEmptyUpdate(input)) return err(400, EMPTY_UPDATE_MESSAGE)

  if (input.stateKeyParam !== undefined) {
    const [existing] = await db
      .select({
        productId: pipelineStacks.productId,
        environmentId: pipelineStacks.environmentId,
        stateKeyParam: pipelineStacks.stateKeyParam,
      })
      .from(pipelineStacks)
      .where(and(eq(pipelineStacks.id, stackId), eq(pipelineStacks.productId, productId)))
      .limit(1)

    if (!existing) return err(404, 'Not found')

    // Refused only when it actually changes: re-sending the same value with an
    // unrelated edit — which the admin form does, because it PATCHes the whole
    // record — must not be blocked.
    if (existing.stateKeyParam !== input.stateKeyParam) {
      const live = await liveElementsFor(existing)
      if (live > 0) {
        // #200. An element's Terraform state key is not recorded anywhere: it is
        // re-derived at trigger time from `variables[stack.stateKeyParam]`. So
        // changing this field under a running element changes where its NEXT
        // pipeline looks for state — and the next pipeline is usually its
        // destroy.
        //
        // The destroy then addresses a state that was never created, reports
        // success, and leaves the real state in the bucket with the
        // infrastructure it describes still running. `claimAndDestroy` has
        // already flipped the row to `decommissioning`, so the portal shows the
        // element as torn down while the VM is still billing.
        //
        // This is a guard, not the fix. The fix is to record the derived key on
        // the element at provisioning time so it cannot be recomputed at all —
        // which needs a column, and is the rest of #200. Until then, refusing
        // the edit is the only thing that keeps the two in step, and it closes
        // the realistic path: an admin editing a stack in the admin UI.
        return err(
          409,
          `${live} deployed element${live === 1 ? '' : 's'} still derive their Terraform state key ` +
            `from "${existing.stateKeyParam}". Changing it would make their teardown address a state ` +
            `that does not exist, leaving the real infrastructure running while the portal reports it ` +
            `as decommissioned. Decommission them first, or add a new stack for new orders.`,
        )
      }
    }
  }

  const [updated] = await db
    .update(pipelineStacks)
    .set({
      ...(input.name !== undefined && { name: input.name }),
      ...(input.stateKeyParam !== undefined && { stateKeyParam: input.stateKeyParam }),
      ...(input.steps !== undefined && { steps: input.steps }),
    })
    .where(and(eq(pipelineStacks.id, stackId), eq(pipelineStacks.productId, productId)))
    .returning(publicColumns)

  if (!updated) return err(404, 'Not found')

  await logAudit(
    actorId ?? null,
    'pipeline_stack.updated',
    stackId,
    `On product #${productId}: ${changedFields(input)}`,
  )

  return ok(updated as PipelineStack)
}

export const deletePipelineStack = async (
  productId: number,
  stackId: number,
  actorId?: number,
): Promise<Result<void>> => {
  const deleted = await db
    .delete(pipelineStacks)
    .where(and(eq(pipelineStacks.id, stackId), eq(pipelineStacks.productId, productId)))
    .returning({ id: pipelineStacks.id })

  if (!deleted.length) return err(404, 'Not found')

  await logAudit(actorId ?? null, 'pipeline_stack.deleted', stackId, `Deleted stack on product #${productId}`)

  return ok(undefined)
}
