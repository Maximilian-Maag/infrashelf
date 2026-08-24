import { test, expect, type APIRequestContext } from '@playwright/test'
import { loginAsRoot, expectNoServerError } from './helpers'
import {
  apiAs,
  apiAsRoot,
  ensureUser,
  expectOk,
  plainOffering,
  tryDelete,
  type FixtureUser,
  type Offering,
} from './api'

/**
 * Issue #154. Three of these tests used to be `if (await approveBtn.isVisible())
 * { … }` with no `else` and no `test.skip()`, and the two below them skipped on an
 * empty queue. On CI's empty database the queue was always empty, so all five
 * reported green having checked nothing.
 *
 * Seeding the database (#152) does not fix that on its own, because the queue is
 * still whatever the run happens to find: the demo catalogue's one pending order
 * belongs to ROOT, and `ApprovalRow` deliberately hides Approve from the person
 * who placed the order (#35) — so "click the first Approve button" would still
 * find nothing to click.
 *
 * So each test builds the thing it is about: a project manager's order, which is
 * the only kind that is ever `pending` (an admin's or root's order is written
 * straight to `provisioning` — services/orders.ts createPreparedOrder). It is
 * scoped to that order's own card, so the demo queue entry sitting next to it
 * changes nothing, and the project it lives in is deleted afterwards — which
 * cascades to the order and to any element the approval provisioned (#156).
 */

const FIXTURE_PROJECT = 'E2E Approvals Project'

let root: APIRequestContext
let pmApi: APIRequestContext
let pm: FixtureUser
let offering: Offering

/** The order under test, and the project whose deletion takes it away again. */
let projectId: number
let orderId: number

test.beforeAll(async () => {
  root = await apiAsRoot()
  pm = await ensureUser(root, 'project_manager', 'approvals-pm')
  pmApi = await apiAs(pm.email, pm.password)
  offering = await plainOffering(root)
})

test.afterAll(async () => {
  await pmApi.dispose()
  await root.dispose()
})

test.describe('Approvals', () => {
  test.beforeEach(async ({ page }) => {
    // A project of the manager's own: `prepareOrder` refuses an order into a
    // project a project_manager does not own.
    projectId = (
      (await (
        await expectOk(
          await pmApi.post('/api/projects', { data: { name: FIXTURE_PROJECT } }),
          'create the fixture project',
        )
      ).json()) as { id: number }
    ).id

    orderId = (
      (await (
        await expectOk(
          await pmApi.post('/api/orders', {
            data: {
              projectId,
              productId: offering.productId,
              environmentId: offering.environmentId,
              parameters: {},
            },
          }),
          'place the pending order',
        )
      ).json()) as { id: number }
    ).id

    await loginAsRoot(page)
    await page.goto('/approvals')
  })

  test.afterEach(async () => {
    // orders.project_id and infrastructure_elements.project_id are both ON DELETE
    // CASCADE, so this is what removes the order — the API offers no DELETE for
    // one, and leaving them behind is how the queue grew a little on every run.
    await tryDelete(root, `/api/projects/${projectId}`)
  })

  type Page = import('@playwright/test').Page

  /**
   * The decision row of the order this test placed — the block holding its id and
   * its Approve/Reject buttons, and nothing else on the page.
   *
   * Only ever used while this order still HAS its buttons. `.last()` means
   * "innermost div matching both filters", and once the buttons are swapped for
   * the note form the innermost match becomes the list container — which holds
   * this order's id and a neighbouring order's Reject button. So this must not be
   * used to assert the absence of anything; see the rejection test for how that
   * is scoped instead.
   */
  const decisionRow = (page: Page) =>
    page
      .locator('div')
      .filter({ has: page.getByText(`#${orderId}`, { exact: true }) })
      .filter({ has: page.getByRole('button', { name: /^reject$/i }) })
      .last()

  /** This order's rejection form. Its textarea id is per-order, so it is unique. */
  const rejectionForm = (page: Page) =>
    page.locator('form').filter({ has: page.locator(`#rejection-note-${orderId}`) })

  /** Whether this order is in the queue at all. */
  const queueEntry = (page: Page) => page.getByText(`#${orderId}`, { exact: true })

  test('approvals page loads without error', async ({ page }) => {
    await expect(page).not.toHaveURL(/\/login/)
    await expectNoServerError(page)
  })

  test('shows page title "Approvals"', async ({ page }) => {
    await expect(page.getByRole('heading', { name: /^approvals$/i })).toBeVisible()
  })

  test('the subtitle counts the queue rather than just naming it', async ({ page }) => {
    // There is at least the order this test placed, so a subtitle reading "0" is
    // a real failure rather than an empty stack. The old assertion matched the
    // words alone and passed on "0 orders pending approval".
    const subtitle = page.getByText(/\d+ orders pending approval/i)
    await expect(subtitle).toBeVisible()
    const pending = Number(/(\d+)/.exec((await subtitle.textContent()) ?? '')?.[1])
    expect(pending).toBeGreaterThanOrEqual(1)
  })

  test('a pending order appears in the queue with its product and who asked for it', async ({
    page,
  }) => {
    const row = decisionRow(page)
    await expect(row).toBeVisible({ timeout: 10000 })
    await expect(row).toContainText(offering.productName)
    // Who asked for it, which is the whole basis on which an approver decides.
    await expect(row).toContainText(pm.name)
  })

  test('an order placed by someone else offers both Approve and Reject', async ({ page }) => {
    const row = decisionRow(page)
    await expect(row).toBeVisible({ timeout: 10000 })
    await expect(row.getByRole('button', { name: /^approve$/i })).toBeVisible()
    await expect(row.getByRole('button', { name: /^reject$/i })).toBeVisible()
  })

  test('clicking Reject shows the rejection note form', async ({ page }) => {
    await expect(decisionRow(page)).toBeVisible({ timeout: 10000 })
    await decisionRow(page).getByRole('button', { name: /^reject$/i }).click()

    // Per-order ids: the list renders one of these per row, so the note field is
    // addressed by the order it belongs to.
    const form = rejectionForm(page)
    await expect(form).toBeVisible()
    await expect(form.getByPlaceholder(/explain why/i)).toBeVisible()
    await expect(form.getByRole('button', { name: /confirm rejection/i })).toBeVisible()
    await expect(form.getByRole('button', { name: /cancel/i })).toBeVisible()
    // The decision buttons gave way to the form, so there is one action in flight.
    // Scoped to the card via the form's own parent, NOT by re-running
    // `decisionRow`: with the queue holding more than one order, a `.last()` that
    // no longer matches inside this card silently walks outward until it finds a
    // div holding both this id and *some other row's* Reject button — the list
    // container. That reads as "still showing Reject" and is the same
    // accidental-scope mistake that made these tests vacuous to begin with.
    const card = rejectionForm(page).locator('xpath=..')
    await expect(card.getByRole('button', { name: /^approve$/i })).toHaveCount(0)
    await expect(card.getByRole('button', { name: /^reject$/i })).toHaveCount(0)
  })

  test('cancel on the rejection form puts the decision buttons back', async ({ page }) => {
    await expect(decisionRow(page)).toBeVisible({ timeout: 10000 })
    await decisionRow(page).getByRole('button', { name: /^reject$/i }).click()
    await expect(rejectionForm(page)).toBeVisible()

    await rejectionForm(page).getByRole('button', { name: /cancel/i }).click()

    // THIS order's form is gone and THIS order's buttons are back. The old test
    // asserted that an Approve button was visible somewhere on the page, which is
    // true of any other row in the queue.
    await expect(rejectionForm(page)).toHaveCount(0)
    await expect(decisionRow(page).getByRole('button', { name: /^approve$/i })).toBeVisible()
  })

  test('approving an order provisions it and takes it out of the queue', async ({ page }) => {
    await expect(decisionRow(page)).toBeVisible({ timeout: 10000 })
    await decisionRow(page).getByRole('button', { name: /^approve$/i }).click()

    await expect(queueEntry(page)).toHaveCount(0, { timeout: 15000 })

    // The state change, not the button count. Counting Approve buttons before and
    // after says nothing about what the click did to the order — and approval is
    // the moment a request becomes a deployment.
    await expect
      .poll(
        async () =>
          (
            (await (await root.get(`/api/orders/${orderId}`)).json()) as { status: string }
          ).status,
        { timeout: 15000, message: 'the approved order never left pending' },
      )
      .toBe('provisioning')

    const elements = (await (
      await expectOk(await root.get('/api/infrastructure'), 'list infrastructure')
    ).json()) as { orderId: number }[]
    expect(
      elements.filter((e) => e.orderId === orderId),
      'approving an order must create the infrastructure element it stands for',
    ).toHaveLength(1)
  })

  test('rejecting an order records the note and takes it out of the queue', async ({ page }) => {
    const note = 'Rejected by the e2e approvals spec'
    await expect(decisionRow(page)).toBeVisible({ timeout: 10000 })
    await decisionRow(page).getByRole('button', { name: /^reject$/i }).click()
    await page.locator(`#rejection-note-${orderId}`).fill(note)
    await rejectionForm(page).getByRole('button', { name: /confirm rejection/i }).click()

    await expect(queueEntry(page)).toHaveCount(0, { timeout: 15000 })

    await expect
      .poll(
        async () =>
          (await (await root.get(`/api/orders/${orderId}`)).json()) as {
            status: string
            rejectionNote: string | null
          },
        { timeout: 15000, message: 'the rejected order never left pending' },
      )
      .toMatchObject({ status: 'rejected', rejectionNote: note })

    // A rejected order is a decision, not a deployment.
    const elements = (await (
      await expectOk(await root.get('/api/infrastructure'), 'list infrastructure')
    ).json()) as { orderId: number }[]
    expect(elements.filter((e) => e.orderId === orderId)).toHaveLength(0)
  })
})
