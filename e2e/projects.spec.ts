import { test, expect, type APIRequestContext } from '@playwright/test'
import { loginAsRoot, expectNoServerError } from './helpers'
import { apiAsRoot, expectOk, tryDelete } from './api'

/**
 * Issue #156. Two things were wrong with how this file handled its fixtures.
 *
 * `can create a new project` left its project behind on every run, so the list it
 * and its neighbours assert against grew without limit — and the `Project detail`
 * block below depended on that residue: it read "the first row of the table",
 * which was whichever project a previous run happened to leave. Serial in CI, but
 * `fullyParallel: !process.env.CI` puts them in different workers locally, where
 * they raced or skipped.
 *
 * Now every test that needs a project makes its own and deletes it afterwards, and
 * the detail tests navigate straight to the id they created rather than clicking
 * whatever is on top.
 */

let root: APIRequestContext

test.beforeAll(async () => {
  root = await apiAsRoot()
})

test.afterAll(async () => {
  await root.dispose()
})

test.describe('Projects', () => {
  test.beforeEach(async ({ page }) => {
    await loginAsRoot(page)
    await page.goto('/projects')
  })

  test('projects page loads without error', async ({ page }) => {
    await expect(page).not.toHaveURL(/\/login/)
    await expectNoServerError(page)
  })

  test('shows page title "Projects"', async ({ page }) => {
    await expect(page.getByRole('heading', { name: /^projects$/i })).toBeVisible()
  })

  test('shows projects subtitle', async ({ page }) => {
    await expect(page.getByText(/manage your infrastructure projects/i)).toBeVisible()
  })

  test('shows New Project button', async ({ page }) => {
    await expect(page.getByRole('button', { name: /new project/i })).toBeVisible()
  })

  test('clicking New Project opens a modal with a Name field', async ({ page }) => {
    await page.getByRole('button', { name: /new project/i }).click()
    // Required inputs add "*" to the label, so accessible name is "Name *" — use getByLabel with partial match
    await expect(page.getByLabel(/name/i).first()).toBeVisible()
  })

  test('New Project modal has Description textarea', async ({ page }) => {
    await page.getByRole('button', { name: /new project/i }).click()
    await expect(page.locator('textarea').first()).toBeVisible()
  })

  test('New Project modal has Create Project and Cancel buttons', async ({ page }) => {
    await page.getByRole('button', { name: /new project/i }).click()
    await expect(page.getByRole('button', { name: /create project/i })).toBeVisible()
    await expect(page.getByRole('button', { name: /cancel/i })).toBeVisible()
  })

  test('submitting without a name keeps the modal open', async ({ page }) => {
    await page.getByRole('button', { name: /new project/i }).click()
    await page.getByRole('button', { name: /create project/i }).click()
    // Native HTML5 required validation or React error — either way the button is still visible
    await expect(page.getByRole('button', { name: /create project/i })).toBeVisible()
  })

  test('can create a new project', async ({ page }) => {
    const projectName = `E2E Created Project ${test.info().workerIndex}`
    await page.getByRole('button', { name: /new project/i }).click()
    // Fill the Name field (label includes "*" for required, so use getByLabel with partial match)
    await page.getByLabel(/^name/i).fill(projectName)
    await page.getByRole('button', { name: /create project/i }).click()
    // Modal should close after successful creation
    await expect(page.getByRole('button', { name: /create project/i })).not.toBeVisible({ timeout: 8000 })
    // Project name should appear after router.refresh() re-fetches the server component
    await expect(page.getByText(projectName)).toBeVisible({ timeout: 12000 })

    // …and then take it away again. A name derived from the worker rather than
    // from the clock also means a run that dies before this line leaves one row
    // that the next run reuses, instead of one more row every time.
    const created = ((await (
      await expectOk(await root.get('/api/projects'), 'list projects')
    ).json()) as { id: number; name: string }[]).filter((p) => p.name === projectName)
    for (const project of created) await tryDelete(root, `/api/projects/${project.id}`)
  })

  test('Cancel button closes the modal', async ({ page }) => {
    await page.getByRole('button', { name: /new project/i }).click()
    await expect(page.getByLabel(/^name/i).first()).toBeVisible()
    await page.getByRole('button', { name: /cancel/i }).click()
    await expect(page.getByRole('button', { name: /create project/i })).not.toBeVisible({ timeout: 3000 })
  })

  test('shows project table with header row', async ({ page }) => {
    await expect(page.getByRole('table')).toBeVisible()
    await expect(page.getByRole('table').getByRole('row').first()).toBeVisible()
  })

  // Issue #154. Two nested `if`s with no `else` meant that on an empty database
  // this clicked nothing and reported passed. The demo data always provides a
  // project, so the row is always there to follow.
  test('a project row links to that project', async ({ page }) => {
    const dataRows = page.getByRole('table').getByRole('row').filter({ hasNot: page.getByRole('columnheader') })
    await expect(dataRows.first()).toBeVisible({ timeout: 10000 })

    const firstLink = dataRows.first().getByRole('link').first()
    const href = await firstLink.getAttribute('href')
    expect(href).toMatch(/^\/projects\/\d+$/)

    await firstLink.click()
    // See dashboard.spec.ts: a first-request compile under `next dev` outlasts
    // the default expect timeout.
    await page.waitForURL(new RegExp(`${href}$`), { timeout: 30_000 })
    await expect(page.getByText(/project details/i)).toBeVisible({ timeout: 10000 })
  })
})

test.describe('Project detail', () => {
  // Each test owns its project. The block used to read "the first data row",
  // which was whatever the `can create a new project` test above had left behind
  // — an ordering dependency that held only because CI runs with workers: 1.
  let projectId: number

  test.beforeEach(async ({ page }) => {
    projectId = (
      (await (
        await expectOk(
          await root.post('/api/projects', {
            data: { name: `E2E Detail Project ${test.info().workerIndex}`, description: 'fixture' },
          }),
          'create the fixture project',
        )
      ).json()) as { id: number }
    ).id

    await loginAsRoot(page)
    await page.goto(`/projects/${projectId}`)
  })

  test.afterEach(async () => {
    await tryDelete(root, `/api/projects/${projectId}`)
  })

  test('project detail page shows the edit form', async ({ page }) => {
    await expect(page.getByText(/project details/i)).toBeVisible({ timeout: 30_000 })
    // Required name field: label shows "Name *"
    await expect(page.getByLabel(/^name/i).first()).toBeVisible()
    await expect(page.getByRole('button', { name: /save changes/i })).toBeVisible()
    await expect(page.getByRole('button', { name: /^delete$/i })).toBeVisible()
  })

  test('saving project changes shows success and the change survives a reload', async ({ page }) => {
    await expect(page.getByRole('button', { name: /save changes/i })).toBeVisible({
      timeout: 30_000,
    })

    const description = `E2E edit ${test.info().workerIndex}`
    await page.getByLabel(/description/i).first().fill(description)
    await page.getByRole('button', { name: /save changes/i }).click()
    await expect(page.getByText(/project saved/i)).toBeVisible({ timeout: 8000 })

    // "Saved" is a toast; whether anything was stored is a different question.
    await page.reload()
    await expect(page.getByLabel(/description/i).first()).toHaveValue(description, {
      timeout: 15000,
    })
  })

  test('Delete button opens a confirmation modal', async ({ page }) => {
    await expect(page.getByRole('button', { name: /^delete$/i })).toBeVisible({ timeout: 30_000 })
    await page.getByRole('button', { name: /^delete$/i }).click()

    await expect(page.getByRole('heading', { name: /delete project/i })).toBeVisible()
    await expect(page.getByText(/this action cannot be undone/i)).toBeVisible()
    await expect(page.getByRole('button', { name: /cancel/i })).toBeVisible()
  })

  test('confirming the deletion removes the project and returns to the list', async ({ page }) => {
    await expect(page.getByRole('button', { name: /^delete$/i })).toBeVisible({ timeout: 30_000 })
    await page.getByRole('button', { name: /^delete$/i }).click()
    await expect(page.getByRole('heading', { name: /delete project/i })).toBeVisible()
    // The modal has a Cancel and a Delete button; click the danger Delete button
    await page.getByRole('button', { name: /^delete$/i }).last().click()

    await expect(page).toHaveURL(/\/projects$/, { timeout: 15000 })
    // Gone from the server, not merely off this page.
    await expect
      .poll(async () => (await root.get(`/api/projects/${projectId}`)).status(), {
        timeout: 10000,
        message: 'the project survived its own deletion',
      })
      .toBe(404)
  })
})
