import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { SessionUser } from '@infrashelf/types'

vi.mock('@/lib/ci/webhooks', () => ({
  triggerProductWebhooks: vi.fn().mockResolvedValue(['pipe-destroy']),
  triggerPipelineStacks: vi.fn().mockResolvedValue([]),
  // The teardown paths use the *Tracked variants so a trigger that fails to
  // start is reported rather than swallowed.
  triggerProductWebhooksTracked: vi.fn().mockResolvedValue({ pipelineIds: ['pipe-destroy'], failures: [] }),
  triggerPipelineStacksTracked: vi.fn().mockResolvedValue({ pipelineIds: [], failures: [] }),
}))

import { listProjects, getProjectById, createProject, updateProject, deleteProject } from './projects'
import { createParameter } from './admin/parameters'
import { triggerProductWebhooksTracked, triggerPipelineStacksTracked } from '@/lib/ci/webhooks'
import { db } from '@/lib/db/client'
import { projects, infrastructureElements, orders, orderComments, auditLog } from '@/lib/db/schema'
import { eq, desc } from 'drizzle-orm'
import {
  createUser,
  createProject as seedProject,
  createCategory,
  createProduct,
  createCiSource,
  createEnvironment,
  createOrder as seedOrder,
  createInfraElement,
} from '@/test/helpers'

const mockedWebhooks = vi.mocked(triggerProductWebhooksTracked)
const mockedStacks = vi.mocked(triggerPipelineStacksTracked)

beforeEach(() => {
  mockedWebhooks.mockReset().mockResolvedValue({ pipelineIds: ['pipe-destroy'], failures: [] })
  mockedStacks.mockReset().mockResolvedValue({ pipelineIds: [], failures: [] })
})

const makeSession = (u: { id: number; email: string; name: string; role: string }): SessionUser =>
  ({ id: u.id, email: u.email, name: u.name, role: u.role as SessionUser['role'] })

describe('listProjects', () => {
  it('admin sees all projects', async () => {
    const admin = await createUser({ role: 'admin', email: 'a@test.dev' })
    const pm1 = await createUser({ role: 'project_manager', email: 'pm1@test.dev' })
    const pm2 = await createUser({ role: 'project_manager', email: 'pm2@test.dev' })
    await seedProject(pm1.id)
    await seedProject(pm2.id)

    const result = await listProjects(makeSession(admin))
    expect(result.ok).toBe(true)
    if (result.ok) expect(result.data.length).toBe(2)
  })

  it('PM sees only their own projects', async () => {
    const pm1 = await createUser({ role: 'project_manager', email: 'pm1@test.dev' })
    const pm2 = await createUser({ role: 'project_manager', email: 'pm2@test.dev' })
    const own = await seedProject(pm1.id)
    await seedProject(pm2.id)

    const result = await listProjects(makeSession(pm1))
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.data.length).toBe(1)
      expect(result.data[0].id).toBe(own.id)
    }
  })
})

describe('getProjectById', () => {
  it('returns 404 for unknown project', async () => {
    const admin = await createUser({ role: 'admin' })
    const result = await getProjectById(makeSession(admin), 999_999)
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.status).toBe(404)
  })

  it('PM gets 403 for another user\'s project', async () => {
    const pm1 = await createUser({ role: 'project_manager', email: 'pm1@test.dev' })
    const pm2 = await createUser({ role: 'project_manager', email: 'pm2@test.dev' })
    const p = await seedProject(pm2.id)

    const result = await getProjectById(makeSession(pm1), p.id)
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.status).toBe(403)
  })

  it('admin can see any project', async () => {
    const admin = await createUser({ role: 'admin' })
    const pm = await createUser({ role: 'project_manager', email: 'pm@test.dev' })
    const p = await seedProject(pm.id)

    const result = await getProjectById(makeSession(admin), p.id)
    expect(result.ok).toBe(true)
    if (result.ok) expect(result.data.id).toBe(p.id)
  })
})

describe('createProject', () => {
  it('creates project with session.id as ownerId', async () => {
    const pm = await createUser({ role: 'project_manager' })
    const result = await createProject(makeSession(pm), {
      name: 'My Proj',
      description: 'desc',
    })
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.data.name).toBe('My Proj')
      expect(result.data.ownerId).toBe(pm.id)
      expect(result.data.description).toBe('desc')
    }
  })
})

describe('updateProject', () => {
  it('returns 404 for unknown project', async () => {
    const admin = await createUser({ role: 'admin' })
    const result = await updateProject(makeSession(admin), 999_999, { name: 'X' })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.status).toBe(404)
  })

  it('PM gets 403 for another user\'s project', async () => {
    const pm1 = await createUser({ role: 'project_manager', email: 'pm1@test.dev' })
    const pm2 = await createUser({ role: 'project_manager', email: 'pm2@test.dev' })
    const p = await seedProject(pm2.id)

    const result = await updateProject(makeSession(pm1), p.id, { name: 'Hijacked' })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.status).toBe(403)
  })

  it('admin can update any project, updating name and description', async () => {
    const admin = await createUser({ role: 'admin' })
    const pm = await createUser({ role: 'project_manager', email: 'pm@test.dev' })
    const p = await seedProject(pm.id)

    const result = await updateProject(makeSession(admin), p.id, {
      name: 'Updated',
      description: 'New desc',
    })
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.data.name).toBe('Updated')
      expect(result.data.description).toBe('New desc')
    }

    const [dbProj] = await db.select().from(projects).where(eq(projects.id, p.id))
    expect(dbProj.name).toBe('Updated')
    expect(dbProj.description).toBe('New desc')
  })
})

describe('deleteProject', () => {
  it('returns 404 for unknown project', async () => {
    const admin = await createUser({ role: 'admin' })
    const result = await deleteProject(makeSession(admin), 999_999)
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.status).toBe(404)
  })

  it('PM gets 403 when deleting another PM\'s project', async () => {
    const pm1 = await createUser({ role: 'project_manager', email: 'pm1@test.dev' })
    const pm2 = await createUser({ role: 'project_manager', email: 'pm2@test.dev' })
    const p = await seedProject(pm2.id)

    const result = await deleteProject(makeSession(pm1), p.id)
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.status).toBe(403)
  })

  it('deletes an EMPTY project from DB and returns ok(undefined)', async () => {
    const admin = await createUser({ role: 'admin' })
    const pm = await createUser({ role: 'project_manager', email: 'pm@test.dev' })
    const p = await seedProject(pm.id)

    const result = await deleteProject(makeSession(admin), p.id)
    expect(result.ok).toBe(true)
    if (result.ok) expect(result.data).toBeUndefined()

    const rows = await db.select().from(projects).where(eq(projects.id, p.id))
    expect(rows.length).toBe(0)
  })

  // FA-09.5: cascade decommissioning on project delete
  it('cascade-decommissions all active infra elements of the project (FA-09.5)', async () => {
    const admin = await createUser({ role: 'admin' })
    const pm = await createUser({ role: 'project_manager', email: 'pm@test.dev' })
    const cat = await createCategory()
    const product = await createProduct(cat.id)
    const ci = await createCiSource()
    const env = await createEnvironment(ci.id)
    const project = await seedProject(pm.id)
    const order = await seedOrder(project.id, product.id, env.id, pm.id)
    await createInfraElement(order.id, project.id, env.id, product.id)
    await createInfraElement(order.id, project.id, env.id, product.id)

    const result = await deleteProject(makeSession(admin), project.id)
    expect(result.ok).toBe(true)

    // Destroy webhook fired for every active element
    expect(mockedWebhooks).toHaveBeenCalledTimes(2)
    expect(mockedWebhooks).toHaveBeenCalledWith(
      product.id,
      env.id,
      expect.objectContaining({ TF_ACTION: 'destroy' }),
      // The recorder that stores each pipeline id as it starts (issue #132).
      expect.any(Function),
    )
    // Pipeline-stack destroy fired for every active element too, so stack-
    // provisioned infra is not leaked on project deletion.
    expect(mockedStacks).toHaveBeenCalledTimes(2)
    expect(mockedStacks).toHaveBeenCalledWith(
      product.id,
      env.id,
      expect.objectContaining({ TF_ACTION: 'destroy' }),
      expect.any(Function),
      // Fifth argument, which the webhook trigger does not take: the element's
      // parameters with reserved names still in them, read only to derive the
      // state key. A legacy stack keyed on a reserved name has no other way to
      // find the value its own apply used.
      expect.anything(),
      // Sixth: the keys this element was PROVISIONED under (#200). The destroy
      // has to address the state that exists, not one re-derived from a stack
      // row that may have moved since.
      expect.anything(),
    )
    // The elements are NOT gone. An infrastructure element always has an order
    // (`order_id` is NOT NULL), so a project holding infrastructure is always a
    // project holding orders, and is retired rather than deleted (#187). Their
    // rows survive as the record of what was torn down, marked decommissioning.
    const rows = await db.select().from(infrastructureElements).where(eq(infrastructureElements.projectId, project.id))
    expect(rows).toHaveLength(2)
    expect(rows.every((r) => r.status === 'decommissioning')).toBe(true)

    const [row] = await db.select().from(projects).where(eq(projects.id, project.id))
    expect(row.retiredAt).not.toBeNull()
  })

  // FA-09.8: already-decommissioning / decommissioned elements are skipped
  it('skips infra elements already in decommissioning/decommissioned status (FA-09.8)', async () => {
    const admin = await createUser({ role: 'admin' })
    const pm = await createUser({ role: 'project_manager', email: 'pm@test.dev' })
    const cat = await createCategory()
    const product = await createProduct(cat.id)
    const ci = await createCiSource()
    const env = await createEnvironment(ci.id)
    const project = await seedProject(pm.id)
    const order = await seedOrder(project.id, product.id, env.id, pm.id)
    await createInfraElement(order.id, project.id, env.id, product.id, { status: 'decommissioning' })
    await createInfraElement(order.id, project.id, env.id, product.id, { status: 'decommissioned' })
    await createInfraElement(order.id, project.id, env.id, product.id, { status: 'active' })

    const result = await deleteProject(makeSession(admin), project.id)
    expect(result.ok).toBe(true)

    // Only the active element triggers a destroy webhook — the two already-in-flight are skipped
    expect(mockedWebhooks).toHaveBeenCalledTimes(1)
    expect(mockedWebhooks).toHaveBeenCalledWith(
      product.id,
      env.id,
      expect.objectContaining({ TF_ACTION: 'destroy' }),
      expect.any(Function),
    )
    expect(mockedStacks).toHaveBeenCalledTimes(1)
  })

  // Cascade-delete race: the destroy trigger must complete BEFORE the project
  // (and its cascaded infra rows) are deleted.
  it('awaits the destroy trigger before deleting the project', async () => {
    const admin = await createUser({ role: 'admin' })
    const pm = await createUser({ role: 'project_manager', email: 'pm@test.dev' })
    const cat = await createCategory()
    const product = await createProduct(cat.id)
    const ci = await createCiSource()
    const env = await createEnvironment(ci.id)
    const project = await seedProject(pm.id)
    const order = await seedOrder(project.id, product.id, env.id, pm.id)
    await createInfraElement(order.id, project.id, env.id, product.id)

    // At the moment the trigger fires, the project and its infra must still
    // exist (i.e. the delete has NOT run yet).
    let projectExistedAtTrigger = false
    let infraExistedAtTrigger = false
    mockedWebhooks.mockImplementationOnce(async () => {
      projectExistedAtTrigger =
        (await db.select().from(projects).where(eq(projects.id, project.id))).length > 0
      infraExistedAtTrigger =
        (await db.select().from(infrastructureElements).where(eq(infrastructureElements.projectId, project.id))).length > 0
      return { pipelineIds: ['pipe-destroy'], failures: [] }
    })

    const result = await deleteProject(makeSession(admin), project.id)
    expect(result.ok).toBe(true)

    expect(projectExistedAtTrigger).toBe(true)
    expect(infraExistedAtTrigger).toBe(true)

    // And afterwards the project is retired rather than deleted — it holds an
    // order, and that order's history is the thing #187 exists to keep. The row
    // survives; it is gone from every screen.
    const [row] = await db.select().from(projects).where(eq(projects.id, project.id))
    expect(row.retiredAt).not.toBeNull()
    const visible = await listProjects(makeSession(admin))
    expect(visible.ok && visible.data.some((p) => p.id === project.id)).toBe(false)
  })

  it('refuses to delete the project when a destroy trigger could not be started', async () => {
    const admin = await createUser({ role: 'admin', email: 'admin2@test.dev' })
    const pm = await createUser({ role: 'project_manager', email: 'pm2@test.dev' })
    const cat = await createCategory()
    const product = await createProduct(cat.id)
    const ci = await createCiSource()
    const env = await createEnvironment(ci.id)
    const project = await seedProject(pm.id)
    const order = await seedOrder(project.id, product.id, env.id, pm.id)
    await createInfraElement(order.id, project.id, env.id, product.id)
    mockedStacks.mockResolvedValueOnce({ pipelineIds: [], failures: ['pipeline stack "s" (#3): refused'] })

    const result = await deleteProject(makeSession(admin), project.id)
    // The cascade would remove the infrastructure_elements rows and leave the
    // provisioned infrastructure running untracked.
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.status).toBe(502)
      expect(result.message).toContain('refused')
    }

    const rows = await db.select().from(projects).where(eq(projects.id, project.id))
    expect(rows.length).toBe(1)
    const infra = await db
      .select()
      .from(infrastructureElements)
      .where(eq(infrastructureElements.projectId, project.id))
    expect(infra.length).toBe(1)
  })
})

// `orders.project_id` is ON DELETE CASCADE and `order_comments.order_id` cascades
// from there, so deleting a project took every order inside it — and with them
// `product_snapshot`, the column that exists so a catalogue edit cannot rewrite
// what a customer was charged. The spend then left the dashboard, the CSV and the
// PDF, retroactively. Proved on a real Postgres before this was written (#187).
describe('deleteProject keeps order history (issue #187)', () => {
  async function projectWithAnOrder() {
    const admin = await createUser({ role: 'admin' })
    const pm = await createUser({ role: 'project_manager' })
    const cat = await createCategory()
    const product = await createProduct(cat.id)
    const ci = await createCiSource()
    const env = await createEnvironment(ci.id)
    const project = await seedProject(pm.id)
    const order = await seedOrder(project.id, product.id, env.id, pm.id, { status: 'completed' })
    return { admin, pm, project, order }
  }

  it('retires a project that holds orders instead of deleting it', async () => {
    const { admin, project, order } = await projectWithAnOrder()

    const result = await deleteProject(makeSession(admin), project.id)

    expect(result.ok).toBe(true)
    const [row] = await db.select().from(projects).where(eq(projects.id, project.id))
    expect(row).toBeDefined()
    expect(row.retiredAt).not.toBeNull()
    // The point of the whole change.
    const kept = await db.select().from(orders).where(eq(orders.id, order.id))
    expect(kept).toHaveLength(1)
  })

  it('keeps the comments on those orders too', async () => {
    const { admin, pm, project, order } = await projectWithAnOrder()
    await db.insert(orderComments).values({ orderId: order.id, userId: pm.id, body: 'approved by finance' })

    await deleteProject(makeSession(admin), project.id)

    const kept = await db.select().from(orderComments).where(eq(orderComments.orderId, order.id))
    expect(kept).toHaveLength(1)
  })

  // Retired is not "still there" — it is gone from every screen, and its row
  // survives only as the project_id those orders point at.
  it('hides a retired project from the list and from its own page', async () => {
    const { admin, pm, project } = await projectWithAnOrder()
    await deleteProject(makeSession(admin), project.id)

    const list = await listProjects(makeSession(admin))
    expect(list.ok && list.data.some((p) => p.id === project.id)).toBe(false)

    const own = await listProjects(makeSession(pm))
    expect(own.ok && own.data.some((p) => p.id === project.id)).toBe(false)

    const detail = await getProjectById(makeSession(admin), project.id)
    expect(detail.ok).toBe(false)
    if (!detail.ok) expect(detail.status).toBe(404)
  })

  it('answers 404 when asked to delete an already retired project', async () => {
    const { admin, project } = await projectWithAnOrder()
    await deleteProject(makeSession(admin), project.id)

    const again = await deleteProject(makeSession(admin), project.id)

    expect(again.ok).toBe(false)
    if (!again.ok) expect(again.status).toBe(404)
  })

  // A project nobody ever ordered in has no history to keep, and tombstoning it
  // would fill the table for nothing.
  it('still hard-deletes a project with no orders', async () => {
    const admin = await createUser({ role: 'admin' })
    const pm = await createUser({ role: 'project_manager' })
    const project = await seedProject(pm.id)

    const result = await deleteProject(makeSession(admin), project.id)

    expect(result.ok).toBe(true)
    expect(await db.select().from(projects).where(eq(projects.id, project.id))).toHaveLength(0)
  })
})

// `grep -c logAudit services/projects.ts` was 0: the most destructive operation
// in the system was the one writing nothing to the append-only log. #137 closed
// without projects, presumably because they live in `services/` rather than
// `services/admin/`.
describe('project audit trail (issue #187)', () => {
  const lastEntry = async (action: string) => {
    const [row] = await db
      .select()
      .from(auditLog)
      .where(eq(auditLog.action, action))
      .orderBy(desc(auditLog.id))
      .limit(1)
    return row
  }

  it('records a creation', async () => {
    const pm = await createUser({ role: 'project_manager' })

    const created = await createProject(makeSession(pm), { name: 'Pilot' })

    expect(created.ok).toBe(true)
    const entry = await lastEntry('project.created')
    expect(entry.userId).toBe(pm.id)
    expect(entry.details).toContain('Pilot')
  })

  it('records what an update changed', async () => {
    const pm = await createUser({ role: 'project_manager' })
    const project = await seedProject(pm.id)

    await updateProject(makeSession(pm), project.id, { name: 'Renamed' })

    const entry = await lastEntry('project.updated')
    expect(entry.entityId).toBe(project.id)
    expect(entry.details).toContain('name')
  })

  it('records a retirement, and says how much history it kept', async () => {
    const admin = await createUser({ role: 'admin' })
    const pm = await createUser({ role: 'project_manager' })
    const cat = await createCategory()
    const product = await createProduct(cat.id)
    const ci = await createCiSource()
    const env = await createEnvironment(ci.id)
    const project = await seedProject(pm.id)
    await seedOrder(project.id, product.id, env.id, pm.id, { status: 'completed' })

    await deleteProject(makeSession(admin), project.id)

    const entry = await lastEntry('project.retired')
    expect(entry.userId).toBe(admin.id)
    expect(entry.entityId).toBe(project.id)
    expect(entry.details).toMatch(/1 order/)
  })

  it('records a hard delete of an empty project', async () => {
    const admin = await createUser({ role: 'admin' })
    const pm = await createUser({ role: 'project_manager' })
    const project = await seedProject(pm.id)

    await deleteProject(makeSession(admin), project.id)

    const entry = await lastEntry('project.deleted')
    expect(entry.entityId).toBe(project.id)
  })
})

describe('a delete that #404 refuses (CodeRabbit on PR #495)', () => {
  /*
   * The question CodeRabbit asked was the right one: `deleteProject` claims every
   * active element (active → decommissioning) and AWAITS `fireDestroyTriggers`
   * BEFORE it opens its transaction, so a refusal returned from inside that
   * transaction would arrive with the infrastructure already on its way down and
   * the project it belonged to still standing.
   *
   * It cannot happen, and the reason is structural rather than lucky. The #404
   * refusal lives on the hard-delete branch, which is reached only when the
   * project holds no orders (#187 retires the rest). `infrastructure_elements.
   * order_id` is NOT NULL and references `orders`, and an element is created
   * from an order in its own project — so a project with no orders has no
   * elements, and the loop that claims rows and fires destroys never runs a
   * single iteration.
   *
   * A preflight before the loop looks like the obvious belt-and-braces and is
   * actively wrong: it would fire on the RETIRE path too, where nothing cascades
   * and the narrowing the collision is predicted from is not going anywhere.
   * These two tests pin both halves, because the reasoning above is invisible at
   * the call site and the next person to read that comment will be tempted.
   */

  /** The colliding pair: one definition narrowed to `projectId`, one narrowed to nothing. */
  const collidingPair = async (projectId: number) => {
    expect((await createParameter({ scope: 'global', name: 'region', type: 'string' })).ok).toBe(true)
    expect(
      (
        await createParameter({
          scope: 'global',
          name: 'region',
          type: 'string',
          projectIds: [projectId],
        } as never)
      ).ok,
    ).toBe(true)
  }

  it('fires no destroy trigger and claims no element', async () => {
    const admin = await createUser({ role: 'admin', email: 'admin-404@test.dev' })
    const pm = await createUser({ role: 'project_manager', email: 'pm-404@test.dev' })
    const project = await seedProject(pm.id)
    await collidingPair(project.id)

    const result = await deleteProject(makeSession(admin), project.id)

    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.status).toBe(409)
      expect(result.message).toContain('region')
    }

    expect(mockedWebhooks).not.toHaveBeenCalled()
    expect(mockedStacks).not.toHaveBeenCalled()

    const rows = await db.select().from(projects).where(eq(projects.id, project.id))
    expect(rows.length).toBe(1)
  })

  it('does not stand in the way of a project that is retired rather than deleted', async () => {
    // The retire path leaves the project row, so `parameter_projects` keeps every
    // row it had and no fingerprint changes. Refusing here would block #187 for a
    // conflict that the request does not create.
    const admin = await createUser({ role: 'admin', email: 'admin-404b@test.dev' })
    const pm = await createUser({ role: 'project_manager', email: 'pm-404b@test.dev' })
    const cat = await createCategory()
    const product = await createProduct(cat.id)
    const ci = await createCiSource()
    const env = await createEnvironment(ci.id)
    const project = await seedProject(pm.id)
    await seedOrder(project.id, product.id, env.id, pm.id)
    await collidingPair(project.id)

    const result = await deleteProject(makeSession(admin), project.id)

    expect(result.ok).toBe(true)
    const [row] = await db.select().from(projects).where(eq(projects.id, project.id))
    expect(row.retiredAt).not.toBeNull()
  })
})
