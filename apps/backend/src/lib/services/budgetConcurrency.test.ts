import { describe, it, expect, vi, beforeEach } from 'vitest'
import { eq } from 'drizzle-orm'
import type { SessionUser } from '@infrashelf/types'
// Type-only, so it is erased and cannot make the mock factory circular.
import type * as BudgetsModule from './budgets'

/*
 * #403. The budget check and the order insert used to be two statements against
 * the pool, and the gap between them was the bug: two orders placed close
 * together both read the same `committed`, both found room, and both committed.
 *
 * In its own file because it is the only budget test that needs the
 * notification and CI mocks — `createOrder` is driven end to end here rather
 * than `checkBudget` being called directly, because the window this closes
 * exists between those two calls and is invisible to either one alone.
 */
vi.mock('@/lib/notification', () => ({
  sendOrderCreated: vi.fn().mockResolvedValue(undefined),
  sendApprovalRequest: vi.fn().mockResolvedValue(undefined),
  sendOrderApproved: vi.fn().mockResolvedValue(undefined),
  sendOrderRejected: vi.fn().mockResolvedValue(undefined),
}))

vi.mock('@/lib/ci/webhooks', () => ({
  triggerProductWebhooksTracked: vi.fn().mockResolvedValue({ pipelineIds: ['pipe-1'], failures: [] }),
  triggerPipelineStacksTracked: vi.fn().mockResolvedValue({ pipelineIds: [], failures: [] }),
}))

/*
 * A barrier inside the window, because `Promise.all` alone does not open it.
 *
 * Two `createOrder` calls started together are not guaranteed to be reading the
 * budget at the same moment — whether they overlap depends on how the event loop
 * interleaves a dozen awaits, and a test that only SOMETIMES reproduces a race
 * is not a guard against it. Written without this, this file passed with the
 * advisory lock removed.
 *
 * So `checkBudget` is wrapped to wait until two callers have reached it, or
 * until a short timeout. That is the point between taking the lock and writing
 * the row, so:
 *
 *   - without the lock, both orders arrive, the barrier opens at once, and both
 *     read `committed = 0` — the overspend, reproduced every run;
 *   - with it, the second order is still blocked on the lock and never arrives,
 *     the timeout releases the first, and the second reads the budget only
 *     after the first has committed.
 *
 * The real `checkBudget` still runs. This changes when it is called, not what
 * it answers.
 */
const barrier = vi.hoisted(() => {
  let waiting: (() => void)[] = []
  return {
    reset() { waiting = [] },
    arrive(): Promise<void> {
      return new Promise<void>((resolve) => {
        waiting.push(resolve)
        if (waiting.length >= 2) {
          for (const r of waiting) r()
          waiting = []
        } else {
          // Whoever is alone here is the only one that got through the lock.
          setTimeout(() => { for (const r of waiting) r(); waiting = [] }, 400)
        }
      })
    },
  }
})

vi.mock('@/lib/services/budgets', async (importOriginal) => {
  const actual = await importOriginal<typeof BudgetsModule>()
  return {
    ...actual,
    checkBudget: async (...args: Parameters<typeof actual.checkBudget>) => {
      await barrier.arrive()
      return actual.checkBudget(...args)
    },
  }
})

import { createOrder } from './orders'
import { db } from '@/lib/db/client'
import { costCenters, orders, projects } from '@/lib/db/schema'
import {
  createUser, createCategory, createProduct, createCiSource,
  createEnvironment, createProject, linkProductEnvironment, createCostCenter,
} from '@/test/helpers'

beforeEach(() => barrier.reset())

const makeSession = (u: { id: number; email: string; name: string; role: string }): SessionUser =>
  ({ id: u.id, email: u.email, name: u.name, role: u.role as SessionUser['role'] })

/**
 * A cost centre with room for exactly ONE order at the product's price, and a
 * project that bills to it. `block`, because `warn` tolerates overspend by
 * design and would prove nothing here.
 */
const scene = async (budget: string, price: string) => {
  const pm = await createUser({ role: 'project_manager' })
  const cat = await createCategory()
  const product = await createProduct(cat.id)
  const ci = await createCiSource()
  const env = await createEnvironment(ci.id)
  await linkProductEnvironment(product.id, env.id, { price, currency: 'EUR' })
  const project = await createProject(pm.id)
  const centre = await createCostCenter()
  await db.update(costCenters).set({
    budgetAmount: budget, budgetCurrency: 'EUR',
    budgetPeriod: 'total', budgetBehaviour: 'block',
  }).where(eq(costCenters.id, centre.id))
  // 'project' attribution: the order stores no cost centre and the spend
  // follows the project's, which is the default mode and the common case.
  await db.update(projects).set({ costCenterId: centre.id }).where(eq(projects.id, project.id))
  return { pm, product, env, project, centre }
}

describe('a budget that blocks cannot be spent twice at once (#403)', () => {
  it('lets exactly one of two concurrent orders through a budget with room for one', async () => {
    // 150 of budget, 100 a line: the first fits, the pair does not.
    const s = await scene('150.00', '100.00')
    const order = () => createOrder(makeSession(s.pm), {
      projectId: s.project.id,
      productId: s.product.id,
      environmentId: s.env.id,
      parameters: {},
    })

    // Started together, so both reach the budget read before either insert
    // lands. Without the advisory lock both read `committed = 0`, both find
    // room for 100 against 150, and both commit — 200 spent against 150.
    const [first, second] = await Promise.all([order(), order()])

    const accepted = [first, second].filter((r) => r.ok)
    const refused = [first, second].filter((r) => !r.ok)

    expect(accepted).toHaveLength(1)
    expect(refused).toHaveLength(1)
    expect(refused[0].ok === false && refused[0].status).toBe(409)

    // The row count is the actual claim: one order exists, not two.
    const rows = await db.select().from(orders).where(eq(orders.projectId, s.project.id))
    expect(rows).toHaveLength(1)
  })

  it('still lets both through when the budget covers both', async () => {
    // The guard has to refuse the right thing and nothing else — a lock that
    // serialises is not the same as a lock that rejects.
    const s = await scene('250.00', '100.00')
    const order = () => createOrder(makeSession(s.pm), {
      projectId: s.project.id,
      productId: s.product.id,
      environmentId: s.env.id,
      parameters: {},
    })

    const results = await Promise.all([order(), order()])

    expect(results.every((r) => r.ok)).toBe(true)
    const rows = await db.select().from(orders).where(eq(orders.projectId, s.project.id))
    expect(rows).toHaveLength(2)
  })

  it('does not serialise orders billed to different cost centres', async () => {
    // The lock is keyed on the cost centre. Two projects billing to two centres
    // must not queue behind each other.
    const a = await scene('150.00', '100.00')
    const b = await scene('150.00', '100.00')

    const results = await Promise.all([
      createOrder(makeSession(a.pm), {
        projectId: a.project.id, productId: a.product.id, environmentId: a.env.id, parameters: {},
      }),
      createOrder(makeSession(b.pm), {
        projectId: b.project.id, productId: b.product.id, environmentId: b.env.id, parameters: {},
      }),
    ])

    expect(results.every((r) => r.ok)).toBe(true)
  })
})
