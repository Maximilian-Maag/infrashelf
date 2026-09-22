import { describe, it, expect } from 'vitest'
import { eq, sql } from 'drizzle-orm'
import { db } from '@/lib/db/client'
import { costCenters, orders, projects, exchangeRates, productEnvironments, auditLog } from '@/lib/db/schema'
import {
  createCategory, createProduct, createCiSource, createEnvironment,
  linkProductEnvironment, createProject, createUser, createCostCenter, createOrder,
} from '@/test/helpers'
import { checkBudget, loadAllBudgetStates, loadBudgetState, setCostCentreBudget } from './budgets'

/**
 * A budget decides whether an order is refused, so each case below is written
 * against a way of getting that wrong — spend attributed to the wrong centre,
 * spend that has been asked for but not yet built, or a currency quietly
 * treated as if it were the budget's.
 */

const setBudget = async (
  id: number,
  budget: { amount: string; currency: string; period: 'total' | 'monthly'; behaviour: 'warn' | 'block' },
) => {
  await db.update(costCenters).set({
    budgetAmount: budget.amount, budgetCurrency: budget.currency,
    budgetPeriod: budget.period, budgetBehaviour: budget.behaviour,
  }).where(eq(costCenters.id, id))
}

/** A project, product and environment priced in `currency`, ready to order against. */
const scene = async (price = '100.00', currency = 'EUR') => {
  const cat = await createCategory()
  const product = await createProduct(cat.id)
  const ci = await createCiSource()
  const env = await createEnvironment(ci.id)
  await linkProductEnvironment(product.id, env.id, { price, currency })
  const user = await createUser()
  const project = await createProject(user.id)
  const centre = await createCostCenter()
  return { product, env, user, project, centre }
}

const placeOrder = async (
  s: Awaited<ReturnType<typeof scene>>,
  over?: { status?: string; quantity?: number; onOrder?: boolean; createdAt?: Date },
) => {
  const order = await createOrder(s.project.id, s.product.id, s.env.id, s.user.id, {
    status: over?.status ?? 'pending',
    ...(over?.quantity !== undefined ? { quantity: over.quantity } : {}),
  })
  const patch: Record<string, unknown> = {}
  // 'select'/'overhead' modes store the centre ON the order; 'project' mode
  // deliberately stores none and attribution follows the project.
  if (over?.onOrder) patch.costCenterId = s.centre.id
  if (over?.createdAt) patch.createdAt = over.createdAt
  if (Object.keys(patch).length) await db.update(orders).set(patch).where(eq(orders.id, order.id))
  return order
}

describe('no budget is not a refusal', () => {
  it('passes a cost centre that has no budget set', async () => {
    const s = await scene()
    const verdict = await checkBudget(s.centre.id)
    expect(verdict.outcome).toBe('ok')
    expect(verdict.state?.amount).toBeNull()
  })

  it('passes an order that has no cost centre at all', async () => {
    // An estate that has not adopted budgets must not have every order refused.
    expect((await checkBudget(null)).outcome).toBe('ok')
  })
})

describe('attribution follows costs.ts, not orders.cost_center_id alone', () => {
  it("counts an order against its project's centre in the default 'project' mode", async () => {
    // The defect this guards: an order in 'project' mode stores NO cost centre,
    // so a check reading only `orders.cost_center_id` would see zero spend and
    // wave through an estate that is already over budget.
    const s = await scene('100.00')
    await db.update(projects).set({ costCenterId: s.centre.id }).where(eq(projects.id, s.project.id))
    await setBudget(s.centre.id, { amount: '150.00', currency: 'EUR', period: 'total', behaviour: 'block' })
    await placeOrder(s)

    const state = await loadBudgetState(s.centre.id)
    expect(state?.committed).toBe(100)
  })

  it('counts an order that carries its own centre', async () => {
    const s = await scene('100.00')
    await setBudget(s.centre.id, { amount: '150.00', currency: 'EUR', period: 'total', behaviour: 'block' })
    await placeOrder(s, { onOrder: true })

    expect((await loadBudgetState(s.centre.id))?.committed).toBe(100)
  })

  it('does not count an order belonging to a different centre', async () => {
    const s = await scene('100.00')
    const other = await createCostCenter()
    await db.update(projects).set({ costCenterId: other.id }).where(eq(projects.id, s.project.id))
    await setBudget(s.centre.id, { amount: '150.00', currency: 'EUR', period: 'total', behaviour: 'block' })
    await placeOrder(s)

    expect((await loadBudgetState(s.centre.id))?.committed).toBe(0)
  })
})

describe('committed spend includes what has only been asked for', () => {
  it('counts a pending order, which the cost report does not', async () => {
    /*
     * The decision this pins: `costs.ts` counts provisioning and completed —
     * what was actually built. A gate using that rule would let an approval
     * queue full of pending orders each see budget left, and they would blow it
     * together the moment they were approved.
     */
    const s = await scene('100.00')
    await db.update(projects).set({ costCenterId: s.centre.id }).where(eq(projects.id, s.project.id))
    await setBudget(s.centre.id, { amount: '150.00', currency: 'EUR', period: 'total', behaviour: 'block' })
    await placeOrder(s, { status: 'pending' })

    expect((await loadBudgetState(s.centre.id))?.committed).toBe(100)
  })

  it('ignores a rejected order, which was never committed to', async () => {
    const s = await scene('100.00')
    await db.update(projects).set({ costCenterId: s.centre.id }).where(eq(projects.id, s.project.id))
    await setBudget(s.centre.id, { amount: '150.00', currency: 'EUR', period: 'total', behaviour: 'block' })
    await placeOrder(s, { status: 'rejected' })

    expect((await loadBudgetState(s.centre.id))?.committed).toBe(0)
  })

  it('multiplies by quantity', async () => {
    // Twenty VMs cost twenty times one (#104), and a budget that priced the line
    // at one unit would let an order twenty times too big through.
    const s = await scene('100.00')
    await db.update(projects).set({ costCenterId: s.centre.id }).where(eq(projects.id, s.project.id))
    await setBudget(s.centre.id, { amount: '1000.00', currency: 'EUR', period: 'total', behaviour: 'block' })
    await placeOrder(s, { quantity: 3 })

    expect((await loadBudgetState(s.centre.id))?.committed).toBe(300)
  })

  /*
   * An order waiting for its deployment window (#512).
   *
   * `'scheduled'` was missing from the list above, so an order approved outside
   * a window dropped out of `committed` the moment it was scheduled and came
   * back when the window opened. In between the budget showed room that was
   * already spoken for.
   */
  it('counts an order waiting for its deployment window', async () => {
    const s = await scene('100.00')
    await db.update(projects).set({ costCenterId: s.centre.id }).where(eq(projects.id, s.project.id))
    await setBudget(s.centre.id, { amount: '150.00', currency: 'EUR', period: 'total', behaviour: 'block' })
    await placeOrder(s, { status: 'scheduled' })

    expect((await loadBudgetState(s.centre.id))?.committed).toBe(100)
  })

  it('leaves no room for the second order a waiting one has already spoken for', async () => {
    /*
     * The overspend this pins: with the waiting order invisible, a second order
     * of the same size was accepted against the same money — because the gate
     * asked "would THIS order take it over" of a `committed` that did not
     * include the order already approved and waiting for the same budget.
     */
    const s = await scene('400.00')
    await db.update(projects).set({ costCenterId: s.centre.id }).where(eq(projects.id, s.project.id))
    await setBudget(s.centre.id, { amount: '500.00', currency: 'EUR', period: 'total', behaviour: 'block' })
    await placeOrder(s, { status: 'scheduled' })

    const verdict = await checkBudget(s.centre.id, new Date(), {
      price: '400.00',
      currency: 'EUR',
      quantity: 1,
    })

    expect(verdict.outcome).toBe('block')
  })
})

describe('the window a budget applies over', () => {
  const lastMonth = () => {
    const d = new Date()
    return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() - 1, 15))
  }

  it('a monthly budget ignores what was placed before this month', async () => {
    const s = await scene('100.00')
    await db.update(projects).set({ costCenterId: s.centre.id }).where(eq(projects.id, s.project.id))
    await setBudget(s.centre.id, { amount: '150.00', currency: 'EUR', period: 'monthly', behaviour: 'block' })
    await placeOrder(s, { createdAt: lastMonth() })

    expect((await loadBudgetState(s.centre.id))?.committed).toBe(0)
  })

  it('a total budget counts it, because the pot never resets', async () => {
    const s = await scene('100.00')
    await db.update(projects).set({ costCenterId: s.centre.id }).where(eq(projects.id, s.project.id))
    await setBudget(s.centre.id, { amount: '150.00', currency: 'EUR', period: 'total', behaviour: 'block' })
    await placeOrder(s, { createdAt: lastMonth() })

    expect((await loadBudgetState(s.centre.id))?.committed).toBe(100)
  })
})

describe('the verdict', () => {
  const overspentScene = async (behaviour: 'warn' | 'block') => {
    const s = await scene('100.00')
    await db.update(projects).set({ costCenterId: s.centre.id }).where(eq(projects.id, s.project.id))
    await setBudget(s.centre.id, { amount: '50.00', currency: 'EUR', period: 'total', behaviour })
    await placeOrder(s)
    return s
  }

  it('blocks when the behaviour says block, and says what was spent', async () => {
    const s = await overspentScene('block')
    const verdict = await checkBudget(s.centre.id)
    expect(verdict.outcome).toBe('block')
    expect(verdict.message).toContain('100.00 EUR of 50.00 EUR')
    expect(verdict.message).toContain('was not placed')
  })

  it('warns rather than refusing when the behaviour says warn', async () => {
    // The whole point of the setting: over budget is not always a refusal.
    const s = await overspentScene('warn')
    const verdict = await checkBudget(s.centre.id)
    expect(verdict.outcome).toBe('warn')
    expect(verdict.message).not.toContain('was not placed')
  })

  it('is ok while there is room left', async () => {
    const s = await scene('10.00')
    await db.update(projects).set({ costCenterId: s.centre.id }).where(eq(projects.id, s.project.id))
    await setBudget(s.centre.id, { amount: '50.00', currency: 'EUR', period: 'total', behaviour: 'block' })
    await placeOrder(s)

    const verdict = await checkBudget(s.centre.id)
    expect(verdict.outcome).toBe('ok')
    expect(verdict.state?.remaining).toBe(40)
  })

  it('treats exactly spent as exhausted', async () => {
    // Off-by-one here hands out one more order than the budget allows.
    const s = await scene('50.00')
    await db.update(projects).set({ costCenterId: s.centre.id }).where(eq(projects.id, s.project.id))
    await setBudget(s.centre.id, { amount: '50.00', currency: 'EUR', period: 'total', behaviour: 'block' })
    await placeOrder(s)

    expect((await checkBudget(s.centre.id)).outcome).toBe('block')
  })
})

describe('currency', () => {
  it('converts through the rate base rather than assuming the budget currency', async () => {
    await db.insert(exchangeRates).values({ currencyCode: 'CHF', rate: '2' }).onConflictDoUpdate({
      target: exchangeRates.currencyCode, set: { rate: '2' },
    })
    const s = await scene('100.00', 'CHF')
    await db.update(projects).set({ costCenterId: s.centre.id }).where(eq(projects.id, s.project.id))
    await setBudget(s.centre.id, { amount: '100.00', currency: 'EUR', period: 'total', behaviour: 'block' })
    await placeOrder(s)

    // 100 CHF at 2 CHF per EUR is 50 EUR, not 100.
    expect((await loadBudgetState(s.centre.id))?.committed).toBe(50)
  })

  it('reports an unconvertible amount instead of counting it as the budget currency', async () => {
    // Silently treating 100 XYZ as 100 EUR would misstate the gate by whatever
    // the rate happens to be — the choice costs.ts already makes.
    await db.delete(exchangeRates).where(eq(exchangeRates.currencyCode, 'XYZ'))
    const s = await scene('100.00', 'XYZ')
    await db.update(projects).set({ costCenterId: s.centre.id }).where(eq(projects.id, s.project.id))
    await setBudget(s.centre.id, { amount: '100.00', currency: 'EUR', period: 'total', behaviour: 'block' })
    await placeOrder(s)

    const state = await loadBudgetState(s.centre.id)
    expect(state?.committed).toBe(0)
    expect(state?.unconverted).toEqual([{ currency: 'XYZ', amount: 100 }])
  })
})

describe('the order being placed counts against its own budget', () => {
  /*
   * Only "is it already spent?" was asked, and on its own that is a much weaker
   * control than the feature claims: against an untouched budget of 500 the
   * FIRST order may be for 10,000 and sail through, because nothing was
   * committed when it was checked. The budget would then refuse the second
   * order — after the money that broke it had already gone.
   */
  const line = (price: number, currency = 'EUR', quantity = 1) => ({
    price: price.toFixed(2), currency, quantity,
  })

  it('blocks an order that would take an untouched budget over on its own', async () => {
    const s = await scene()
    await setBudget(s.centre.id, { amount: '500.00', currency: 'EUR', period: 'total', behaviour: 'block' })

    const verdict = await checkBudget(s.centre.id, undefined, line(10_000))
    expect(verdict.outcome).toBe('block')
    expect(verdict.message).toMatch(/over the 500\.00 EUR budget/i)
  })

  it('multiplies the incoming line by its quantity', async () => {
    // 20 x 30 is 600 against a 500 budget; one of them is not.
    const s = await scene()
    await setBudget(s.centre.id, { amount: '500.00', currency: 'EUR', period: 'total', behaviour: 'block' })

    expect((await checkBudget(s.centre.id, undefined, line(30, 'EUR', 1))).outcome).toBe('ok')
    expect((await checkBudget(s.centre.id, undefined, line(30, 'EUR', 20))).outcome).toBe('block')
  })

  it('lets an order that lands exactly on the limit through, and the next one not', async () => {
    // "A budget of 500" means you may spend up to 500, so 500 is inside it.
    const s = await scene('500.00')
    await db.update(projects).set({ costCenterId: s.centre.id }).where(eq(projects.id, s.project.id))
    await setBudget(s.centre.id, { amount: '500.00', currency: 'EUR', period: 'total', behaviour: 'block' })

    expect((await checkBudget(s.centre.id, undefined, line(500))).outcome).toBe('ok')
    await placeOrder(s)
    expect((await checkBudget(s.centre.id, undefined, line(1))).outcome).toBe('block')
  })

  it('still refuses a free order against a budget that is already spent', async () => {
    // `amount: 0` is how new spend is stopped deliberately, and a rule that only
    // asked "would this order take you over?" would let a zero-price one past.
    const s = await scene()
    await setBudget(s.centre.id, { amount: '0.00', currency: 'EUR', period: 'total', behaviour: 'block' })
    expect((await checkBudget(s.centre.id, undefined, line(0))).outcome).toBe('block')
  })

  it('converts the incoming line into the budget currency before comparing', async () => {
    // 900 CHF at 2 CHF per EUR is 450 EUR, which fits a 500 EUR budget; the raw
    // number would not.
    await db.insert(exchangeRates).values({ currencyCode: 'CHF', rate: '2.0' }).onConflictDoUpdate({
      target: exchangeRates.currencyCode, set: { rate: '2.0' },
    })
    const s = await scene()
    await setBudget(s.centre.id, { amount: '500.00', currency: 'EUR', period: 'total', behaviour: 'block' })

    expect((await checkBudget(s.centre.id, undefined, line(900, 'CHF'))).outcome).toBe('ok')
    expect((await checkBudget(s.centre.id, undefined, line(1100, 'CHF'))).outcome).toBe('block')
  })

  it('fails closed when the incoming line cannot be converted at all', async () => {
    /*
     * With no rate there is no way to show the order fits, and the amount is
     * unknown rather than zero. Letting it through would make "block" mean
     * "block, unless the currency is one we have no rate for".
     */
    await db.delete(exchangeRates).where(eq(exchangeRates.currencyCode, 'XYZ'))
    const s = await scene()
    await setBudget(s.centre.id, { amount: '100000.00', currency: 'EUR', period: 'total', behaviour: 'block' })

    const verdict = await checkBudget(s.centre.id, undefined, line(1, 'XYZ'))
    expect(verdict.outcome).toBe('block')
    // And it names the remedy rather than just refusing.
    expect(verdict.message).toMatch(/exchange rate/i)
  })

  it('warns rather than refusing an unconvertible line when the behaviour is warn', async () => {
    await db.delete(exchangeRates).where(eq(exchangeRates.currencyCode, 'XYZ'))
    const s = await scene()
    await setBudget(s.centre.id, { amount: '100000.00', currency: 'EUR', period: 'total', behaviour: 'warn' })
    expect((await checkBudget(s.centre.id, undefined, line(1, 'XYZ'))).outcome).toBe('warn')
  })

  it('says nothing when the order fits', async () => {
    const s = await scene()
    await setBudget(s.centre.id, { amount: '500.00', currency: 'EUR', period: 'total', behaviour: 'block' })
    const verdict = await checkBudget(s.centre.id, undefined, line(10))
    expect(verdict.outcome).toBe('ok')
    expect(verdict.message).toBeNull()
  })
})

describe('committed spend that cannot be priced is reported, not hidden', () => {
  it('counts an order with no recoverable price instead of skipping it silently', async () => {
    /*
     * An order that predates snapshots whose offering has since been withdrawn
     * has no price anywhere. Skipping it leaves `committed` under-reporting and
     * a `block` budget claiming room it may not have — the same lie as counting
     * it at zero, in a quieter form. There is no honest number to add, so it is
     * reported instead.
     */
    const s = await scene()
    await db.update(projects).set({ costCenterId: s.centre.id }).where(eq(projects.id, s.project.id))
    await setBudget(s.centre.id, { amount: '500.00', currency: 'EUR', period: 'total', behaviour: 'block' })
    await placeOrder(s)
    // Withdraw the offering, leaving the order with no snapshot and no fallback.
    await db.delete(productEnvironments).where(eq(productEnvironments.productId, s.product.id))

    const state = await loadBudgetState(s.centre.id)
    expect(state?.unpriced).toBe(1)
    expect(state?.committed).toBe(0)
  })

  it('reports none when every committed order has a price', async () => {
    const s = await scene()
    await db.update(projects).set({ costCenterId: s.centre.id }).where(eq(projects.id, s.project.id))
    await setBudget(s.centre.id, { amount: '500.00', currency: 'EUR', period: 'total', behaviour: 'block' })
    await placeOrder(s)
    expect((await loadBudgetState(s.centre.id))?.unpriced).toBe(0)
  })
})

describe('setting a budget records who did it, atomically', () => {
  it('writes the audit entry in the same transaction as the change', async () => {
    // A control that can be changed without the entry saying who changed it is
    // not auditable, and these used to be two statements.
    const actor = await createUser({ role: 'root' })
    const centre = await createCostCenter()

    const result = await setCostCentreBudget(
      centre.id,
      { amount: 250, currency: 'EUR', period: 'monthly', behaviour: 'warn' },
      actor.id,
    )
    expect(result.ok).toBe(true)

    const [row] = await db.select().from(costCenters).where(eq(costCenters.id, centre.id))
    expect(row.budgetAmount).toBe('250.00')
    const entries = await db.select().from(auditLog).where(eq(auditLog.action, 'cost_center.budget_set'))
    expect(entries).toHaveLength(1)
    expect(entries[0].entityId).toBe(centre.id)
  })

  it('records nothing for a cost centre that does not exist', async () => {
    const actor = await createUser({ role: 'root' })
    const result = await setCostCentreBudget(
      999_999, { amount: 10, currency: 'EUR', period: 'total', behaviour: 'block' }, actor.id,
    )
    expect(result.ok).toBe(false)
    expect(await db.select().from(auditLog).where(eq(auditLog.action, 'cost_center.budget_set'))).toHaveLength(0)
  })
})

describe('every cost centre at once, for the administration screen', () => {
  it('returns a state for a centre with no budget as well as one with', async () => {
    // The screen renders a row per cost centre and decides per row whether to
    // show a badge, so a centre missing from the answer would be indistinguishable
    // from one whose budget failed to load.
    const s = await scene()
    const other = await createCostCenter()
    await setBudget(s.centre.id, { amount: '500.00', currency: 'EUR', period: 'total', behaviour: 'warn' })

    const states = await loadAllBudgetStates()
    const mine = states.find((b) => b.costCenterId === s.centre.id)
    const theirs = states.find((b) => b.costCenterId === other.id)

    expect(mine?.amount).toBe(500)
    expect(theirs).toBeDefined()
    expect(theirs?.amount).toBeNull()
  })

  it('carries the committed figure, not just the limit', async () => {
    // A screen that could only show the limit would repeat what the operator
    // set; what they came for is how much of it is gone.
    const s = await scene('100.00')
    await db.update(projects).set({ costCenterId: s.centre.id }).where(eq(projects.id, s.project.id))
    await setBudget(s.centre.id, { amount: '500.00', currency: 'EUR', period: 'total', behaviour: 'block' })
    await placeOrder(s, { status: 'completed' })

    const state = (await loadAllBudgetStates()).find((b) => b.costCenterId === s.centre.id)
    expect(state?.committed).toBe(100)
    expect(state?.remaining).toBe(400)
  })
})

describe('the database refuses a half-configured budget', () => {
  /*
   * The CHECK constraints, tested against a real Postgres rather than trusted.
   *
   * They are the half of the contract TypeScript cannot hold: the enums above
   * are compile-time only, and nothing stops a migration, a psql session or a
   * future code path from writing an amount with no behaviour — which is the
   * row that turns into "why did that order go through".
   */
  const write = (id: number, patch: Record<string, unknown>) =>
    db.update(costCenters).set(patch).where(eq(costCenters.id, id))

  it('rejects an amount with no behaviour', async () => {
    const centre = await createCostCenter()
    await expect(write(centre.id, { budgetAmount: '100.00' })).rejects.toThrow()
  })

  it('rejects a behaviour with no amount', async () => {
    const centre = await createCostCenter()
    await expect(
      write(centre.id, { budgetCurrency: 'EUR', budgetPeriod: 'total', budgetBehaviour: 'block' }),
    ).rejects.toThrow()
  })

  it('rejects a negative budget', async () => {
    // Zero is how new spend is stopped deliberately; negative refuses everything
    // for a reason nobody chose.
    const centre = await createCostCenter()
    await expect(
      write(centre.id, {
        budgetAmount: '-1.00', budgetCurrency: 'EUR', budgetPeriod: 'total', budgetBehaviour: 'warn',
      }),
    ).rejects.toThrow()
  })

  it('rejects a period and a behaviour outside the two values each allows', async () => {
    const centre = await createCostCenter()
    await expect(
      db.execute(sql`UPDATE cost_centers SET budget_amount = 10, budget_currency = 'EUR',
        budget_period = 'quarterly', budget_behaviour = 'block' WHERE id = ${centre.id}`),
    ).rejects.toThrow()
    await expect(
      db.execute(sql`UPDATE cost_centers SET budget_amount = 10, budget_currency = 'EUR',
        budget_period = 'total', budget_behaviour = 'shrug' WHERE id = ${centre.id}`),
    ).rejects.toThrow()
  })

  it('accepts all four together, and accepts clearing all four together', async () => {
    const centre = await createCostCenter()
    await write(centre.id, {
      budgetAmount: '0.00', budgetCurrency: 'EUR', budgetPeriod: 'monthly', budgetBehaviour: 'warn',
    })
    expect((await loadBudgetState(centre.id))?.amount).toBe(0)

    await write(centre.id, {
      budgetAmount: null, budgetCurrency: null, budgetPeriod: null, budgetBehaviour: null,
    })
    expect((await loadBudgetState(centre.id))?.amount).toBeNull()
  })
})
