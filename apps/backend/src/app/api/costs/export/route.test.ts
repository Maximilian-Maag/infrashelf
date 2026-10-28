import { describe, it, expect } from 'vitest'
import { NextRequest } from 'next/server'
import { GET } from './route'
import { db } from '@/lib/db/client'
import { exchangeRates, orders, parameters, projects } from '@/lib/db/schema'
import { eq } from 'drizzle-orm'
import type { ProductSnapshot } from '@/lib/services/snapshot'
import {
  createUser,
  makeAuthHeader,
  createCategory,
  createProduct,
  createCiSource,
  createEnvironment,
  createProject,
  createCostCenter,
  createOrder as seedOrder,
  linkProductEnvironment,
} from '@/test/helpers'

const req = (query = '', auth?: string) =>
  new NextRequest(
    `http://localhost/api/costs/export${query}`,
    auth ? { headers: { authorization: auth } } : undefined,
  )

const snapshot = (overrides: Partial<ProductSnapshot> = {}): ProductSnapshot => ({
  version: 1,
  capturedAt: '2026-06-01T00:00:00.000Z',
  productName: 'Nginx Gateway',
  productDescription: '',
  environmentName: 'AWS Frankfurt',
  price: '10.00',
  currency: 'EUR',
  costCenterMode: 'project',
  forcedCostCenter: false,
  trialEnabled: false,
  trialDurationMinutes: 30,
  parameters: [],
  ...overrides,
})

const setup = async () => {
  const admin = await createUser({ role: 'admin', email: 'ce-admin@test.dev' })
  const pm = await createUser({ role: 'project_manager', email: 'ce-pm@test.dev' })
  const otherPm = await createUser({ role: 'project_manager', email: 'ce-other@test.dev' })
  const cat = await createCategory()
  const product = await createProduct(cat.id, 'Nginx Gateway')
  const ci = await createCiSource()
  const env = await createEnvironment(ci.id, undefined, 'AWS Frankfurt')
  await linkProductEnvironment(product.id, env.id, { price: '10.00' })

  const mine = await createProject(pm.id, 'Webshop')
  const theirs = await createProject(otherPm.id, 'Hidden Project')

  // A quantity above one and a real size, deliberately: the export's line total is
  // unit price × quantity (issues #98/#104), and a fixture that ordered one of an
  // unsized offering multiplies out correctly even when the multiplication is
  // missing.
  const mineOrder = await seedOrder(mine.id, product.id, env.id, pm.id, {
    status: 'completed',
    sizeCode: 'L',
    quantity: 3,
  })
  await db
    .update(orders)
    .set({ productSnapshot: snapshot({ sizeCode: 'L', sizeLabel: 'Large' }) })
    .where(eq(orders.id, mineOrder.id))

  const theirOrder = await seedOrder(theirs.id, product.id, env.id, otherPm.id, { status: 'completed' })
  await db
    .update(orders)
    .set({ productSnapshot: snapshot({ price: '99.00' }) })
    .where(eq(orders.id, theirOrder.id))

  return {
    product,
    env,
    mine,
    theirs,
    mineOrder,
    theirOrder,
    adminAuth: await makeAuthHeader(admin),
    pmAuth: await makeAuthHeader(pm),
  }
}

const csv = async (query: string, auth: string) => {
  const res = await GET(req(query, auth))
  expect(res.status).toBe(200)
  return await res.text()
}

const dataRows = (text: string) => text.split('\n').filter(Boolean).slice(1)

describe('GET /api/costs/export', () => {
  it('returns 401 without a token', async () => {
    await setup()
    expect((await GET(req())).status).toBe(401)
  })

  it('is open to a project manager, whose export covers only the projects they own', async () => {
    // Cost visibility is not admin-only; the ownership scope is the control. An
    // export that leaked another project's spend would be worse than the report,
    // because a CSV outlives the page that produced it.
    const { pmAuth } = await setup()
    const text = await csv('', pmAuth)

    expect(text).toContain('Webshop')
    expect(text).not.toContain('Hidden Project')
    expect(dataRows(text)).toHaveLength(1)
  })

  it('shows an admin every project', async () => {
    const { adminAuth } = await setup()
    const text = await csv('', adminAuth)
    expect(text).toContain('Webshop')
    expect(text).toContain('Hidden Project')
    expect(dataRows(text)).toHaveLength(2)
  })

  it('refuses a project filter naming a project the caller may not see', async () => {
    // Without the check an unauthorised projectId would just produce an empty CSV,
    // which reads as "this project has no spend" rather than "not yours".
    const { theirs, pmAuth } = await setup()
    expect((await GET(req(`?projectId=${theirs.id}`, pmAuth))).status).toBe(403)
  })

  it('returns 404 for a project that does not exist', async () => {
    const { pmAuth } = await setup()
    expect((await GET(req('?projectId=999999', pmAuth))).status).toBe(404)
  })

  it('serves one reconcilable row per counted order', async () => {
    const { mineOrder, adminAuth } = await setup()
    const res = await GET(req(`?projectId=`, adminAuth))
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toMatch(/text\/csv/)
    expect(res.headers.get('content-disposition')).toContain('costs.csv')

    const text = await res.text()
    // Pinned exactly, including order: this file is fed to whatever the finance
    // side points at it, and a renamed or shuffled column breaks that silently.
    expect(text.split('\n')[0]).toBe(
      'orderId,createdAt,project,costCenter,product,environment,size,quantity,status,price,currency,priceBase,lineTotalBase,estimated',
    )

    const header = text.split('\n')[0].split(',')
    const row = dataRows(text).find((line) => line.startsWith(`${mineOrder.id},`))
    expect(row).toBeDefined()
    // No cell in this fixture needs quoting, so positional split is exact.
    const cells = (row ?? '').split(',')
    const col = (name: string) => cells[header.indexOf(name)]

    expect(col('project')).toBe('Webshop')
    expect(col('product')).toBe('Nginx Gateway')
    expect(col('environment')).toBe('AWS Frankfurt')
    expect(col('status')).toBe('completed')
    expect(col('size')).toBe('Large')
    expect(col('quantity')).toBe('3')

    // The property the row exists for: `price`/`priceBase` are the UNIT price and
    // `lineTotalBase` is what the order actually cost. They have to multiply out,
    // or the CSV and the cost report disagree about the same order.
    expect(col('price')).toBe('10.00')
    expect(col('currency')).toBe('EUR')
    expect(col('priceBase')).toBe('10')
    expect(col('lineTotalBase')).toBe('30')
    expect(Number(col('lineTotalBase'))).toBeCloseTo(
      Number(col('priceBase')) * Number(col('quantity')),
    )
  })

  it('counts only orders that reached provisioning', async () => {
    // A pending or rejected order never cost anything; counting it would inflate
    // every figure in the export.
    const { product, env, mine, adminAuth } = await setup()
    const pm2 = await createUser({ role: 'project_manager', email: 'ce-extra@test.dev' })
    for (const status of ['pending', 'rejected', 'failed']) {
      await seedOrder(mine.id, product.id, env.id, pm2.id, { status })
    }

    const text = await csv('', adminAuth)
    // Still only the two completed orders the fixture created.
    expect(dataRows(text)).toHaveLength(2)
  })

  it('marks an order that predates snapshots as estimated', async () => {
    // Its price came from the live offering, not from what the customer was
    // charged, so the total can be read with that in mind.
    const { product, env, mine, adminAuth } = await setup()
    const pm2 = await createUser({ role: 'project_manager', email: 'ce-old@test.dev' })
    const old = await seedOrder(mine.id, product.id, env.id, pm2.id, { status: 'completed' })

    const text = await csv('', adminAuth)
    const row = dataRows(text).find((line) => line.startsWith(`${old.id},`))
    expect(row?.endsWith(',yes')).toBe(true)
  })

  it('leaves the EUR column blank when no rate is stored, rather than writing 0', async () => {
    // A 0 would read as "free".
    const { product, env, mine, adminAuth } = await setup()
    const pm2 = await createUser({ role: 'project_manager', email: 'ce-fx@test.dev' })
    const order = await seedOrder(mine.id, product.id, env.id, pm2.id, { status: 'completed' })
    await db
      .update(orders)
      .set({ productSnapshot: snapshot({ price: '25.00', currency: 'XYZ' }) })
      .where(eq(orders.id, order.id))

    const text = await csv('', adminAuth)
    const row = dataRows(text).find((line) => line.startsWith(`${order.id},`))
    expect(row).toContain(',25.00,XYZ,,')
  })

  it('converts a foreign currency once a rate is stored', async () => {
    const { product, env, mine, adminAuth } = await setup()
    await db.insert(exchangeRates).values({ currencyCode: 'USD', rate: '2' })
    const pm2 = await createUser({ role: 'project_manager', email: 'ce-usd@test.dev' })
    const order = await seedOrder(mine.id, product.id, env.id, pm2.id, { status: 'completed' })
    await db
      .update(orders)
      .set({ productSnapshot: snapshot({ price: '20.00', currency: 'USD' }) })
      .where(eq(orders.id, order.id))

    const text = await csv('', adminAuth)
    const row = dataRows(text).find((line) => line.startsWith(`${order.id},`))
    expect(row).toContain(',20.00,USD,10,')
  })

  it('neutralises CSV formula injection in a project name', async () => {
    // Project names are user-supplied and land in a cell; a cell starting with '='
    // is executed as a formula by Excel and Sheets.
    const { mine, adminAuth } = await setup()
    await db.update(projects).set({ name: '=cmd|\'/C calc\'!A1' }).where(eq(projects.id, mine.id))

    const text = await csv('', adminAuth)
    // Prefixed with an apostrophe, and never sitting bare after a delimiter or at
    // the start of a record.
    expect(text).toContain("'=cmd")
    expect(text).not.toMatch(/(^|[\n,])=cmd/)
  })

  it('quotes a CR-prefixed project name into a single cell', async () => {
    // A bare CR would otherwise start a new CSV record whose first cell is a formula.
    const { mine, adminAuth } = await setup()
    await db.update(projects).set({ name: '\r=cmd|\'/C calc\'!A1' }).where(eq(projects.id, mine.id))

    const text = await csv('', adminAuth)
    expect(text).toContain('"\'\r=cmd')
    expect(text).not.toMatch(/(^|[\n,])=cmd/)
  })

  it('neutralises formula injection reaching the cell through a cost centre name', async () => {
    const { mine, adminAuth } = await setup()
    const cc = await createCostCenter({ code: 'CC-INJ', name: '+SUM(A1:A9)' })
    await db.update(projects).set({ costCenterId: cc.id }).where(eq(projects.id, mine.id))

    const text = await csv('', adminAuth)
    expect(text).toContain('CC-INJ')
    // The cell starts with the code, so the '+' is mid-cell — what matters is that
    // no cell begins with an unescaped formula character.
    expect(text).not.toMatch(/(^|[\n,])[=+@]/)
  })

  it('never carries a sensitive parameter value into the export', async () => {
    // The export deliberately has no parameters column: the sensitive values an
    // order was placed with must not travel in a file that outlives the session
    // (issue #131 covers the read paths that do leak them).
    const { product, env, mine, adminAuth } = await setup()
    const secret = 'top-secret-root-password'
    await db.insert(parameters).values({
      scope: 'product', scopeId: product.id, name: 'ROOT_PASSWORD', type: 'string', sensitive: true,
    })
    const pm2 = await createUser({ role: 'project_manager', email: 'ce-secret@test.dev' })
    const order = await seedOrder(mine.id, product.id, env.id, pm2.id, { status: 'completed' })
    await db
      .update(orders)
      .set({
        parameters: { ROOT_PASSWORD: secret },
        productSnapshot: snapshot({
          parameters: [
            {
              name: 'ROOT_PASSWORD', label: '', type: 'string', description: '',
              defaultValue: '[redacted]', required: false, sensitive: true,
            },
          ],
        }),
      })
      .where(eq(orders.id, order.id))

    const text = await csv('', adminAuth)
    expect(text).toContain(String(order.id))
    expect(text).not.toContain(secret)
    expect(text).not.toContain('ROOT_PASSWORD')
  })

  it('applies the same filters as the report it explains', async () => {
    const { theirs, adminAuth } = await setup()
    const text = await csv(`?projectId=${theirs.id}`, adminAuth)
    expect(dataRows(text)).toHaveLength(1)
    expect(text).toContain('Hidden Project')
    expect(text).not.toContain('Webshop')
  })

  it('honours a date range, resolved server-side', async () => {
    const { mineOrder, adminAuth } = await setup()
    await db
      .update(orders)
      .set({ createdAt: new Date('2020-01-15T12:00:00.000Z') })
      .where(eq(orders.id, mineOrder.id))

    const inRange = await csv('?from=2020-01-01&to=2020-01-31', adminAuth)
    expect(dataRows(inRange)).toHaveLength(1)
    expect(inRange).toContain('Webshop')

    const outOfRange = await csv('?from=2021-01-01&to=2021-01-31', adminAuth)
    expect(dataRows(outOfRange)).toHaveLength(0)
  })

  it('returns just the header row when nothing matches', async () => {
    const { adminAuth } = await setup()
    const text = await csv('?from=2019-01-01&to=2019-01-02', adminAuth)
    expect(text.split('\n').filter(Boolean)).toHaveLength(1)
  })

  it('accepts every range preset', async () => {
    const { adminAuth } = await setup()
    for (const range of ['currentMonth', 'last3Months', 'last12Months', 'all', 'custom']) {
      expect((await GET(req(`?range=${range}`, adminAuth))).status, range).toBe(200)
    }
  })

  it.each(['?projectId=0', '?projectId=abc', '?range=lastWeek', '?from=nonsense', '?to=nonsense', '?from=2026-06-01&to=2026-01-01'])(
    'rejects a malformed filter rather than exporting everything (%s)',
    async (query) => {
      const { adminAuth } = await setup()
      expect((await GET(req(query, adminAuth))).status).toBe(400)
    },
  )

  it('serves a PDF when asked', async () => {
    const { adminAuth } = await setup()
    const res = await GET(req('?format=pdf', adminAuth))
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toBe('application/pdf')
    expect(res.headers.get('content-disposition')).toContain('costs.pdf')

    const bytes = new Uint8Array(await res.arrayBuffer())
    expect(String.fromCharCode(...bytes.slice(0, 4))).toBe('%PDF')
  })

  it('scopes the PDF to the caller as well', async () => {
    const { theirs, pmAuth } = await setup()
    expect((await GET(req(`?projectId=${theirs.id}&format=pdf`, pmAuth))).status).toBe(403)
  })

  it.each(['xlsx', 'CSV', 'json', ''])('rejects an unknown format (%j)', async (format) => {
    // Including an explicitly empty `?format=`: the default only applies when the
    // parameter is absent, so an empty value is refused rather than silently
    // treated as csv.
    const { adminAuth } = await setup()
    expect((await GET(req(`?format=${format}`, adminAuth))).status).toBe(400)
  })
})
