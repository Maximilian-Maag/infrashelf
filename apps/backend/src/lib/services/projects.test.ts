import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { SessionUser } from '@open-hybrid-cloud/types'

vi.mock('@/lib/ci/webhooks', () => ({
  triggerProductWebhooks: vi.fn().mockResolvedValue(['pipe-destroy']),
  triggerPipelineStacks: vi.fn().mockResolvedValue([]),
  // The teardown paths use the *Tracked variants so a trigger that fails to
  // start is reported rather than swallowed.
  triggerProductWebhooksTracked: vi.fn().mockResolvedValue({ pipelineIds: ['pipe-destroy'], failures: [] }),
  triggerPipelineStacksTracked: vi.fn().mockResolvedValue({ pipelineIds: [], failures: [] }),
}))

import { listProjects, getProjectById, createProject, updateProject, deleteProject } from './projects'
import { triggerProductWebhooksTracked, triggerPipelineStacksTracked } from '@/lib/ci/webhooks'
import { db } from '@/lib/db/client'
import { projects, infrastructureElements } from '@/lib/db/schema'
import { eq } from 'drizzle-orm'
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

  it('deletes the project from DB and returns ok(undefined)', async () => {
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
    )
    // The project is gone (its infra elements cascade-delete via FK)
    const rows = await db.select().from(infrastructureElements).where(eq(infrastructureElements.projectId, project.id))
    expect(rows.length).toBe(0)
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

    // And afterwards the project is gone
    const rows = await db.select().from(projects).where(eq(projects.id, project.id))
    expect(rows.length).toBe(0)
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
