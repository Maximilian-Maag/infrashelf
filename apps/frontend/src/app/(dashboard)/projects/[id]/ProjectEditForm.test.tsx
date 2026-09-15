import { describe, it, expect, vi, beforeAll, beforeEach } from 'vitest'
import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'

const refresh = vi.fn()
const push = vi.fn()
const toast = vi.fn()
vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh, push }) }))
vi.mock('@/lib/useLang', () => ({ useLang: () => 'en' }))
vi.mock('@/lib/api', () => ({ put: vi.fn(), del: vi.fn() }))
vi.mock('@/components/ui/Toast', () => ({ useToast: () => ({ toast }) }))

import { ProjectEditForm } from './ProjectEditForm'
import { put, del } from '@/lib/api'

const mockedPut = vi.mocked(put)
const mockedDel = vi.mocked(del)

/**
 * Editing a project, which had no test.
 *
 * The interesting part is what the form sends rather than what it shows: an
 * untouched optional field has to arrive as `undefined` and not as an empty
 * string, or saving a project with no description would overwrite a real one
 * with "".
 */
beforeAll(() => {
  HTMLDialogElement.prototype.showModal = vi.fn(function (this: HTMLDialogElement) {
    this.open = true
  })
  HTMLDialogElement.prototype.close = vi.fn(function (this: HTMLDialogElement) {
    this.open = false
  })
})

const project = (over?: Record<string, unknown>) =>
  ({ id: 4, name: 'Webshop', description: 'The shop', costCenterId: null, ...over }) as never

const costCenters = [{ id: 10, code: 'CC-100', name: 'Platform' }] as never

const renderForm = (p = project(), cc = costCenters) =>
  render(<ProjectEditForm project={p} costCenters={cc} />)

beforeEach(() => {
  refresh.mockReset()
  push.mockReset()
  toast.mockReset()
  mockedPut.mockReset().mockResolvedValue(undefined as never)
  mockedDel.mockReset().mockResolvedValue(undefined as never)
})

describe('what the form sends', () => {
  it('trims the name rather than saving the spaces', async () => {
    const user = userEvent.setup()
    renderForm()
    const name = screen.getByLabelText(/^name/i)
    await user.clear(name)
    await user.type(name, '  Billing  ')
    await user.click(screen.getByRole('button', { name: /save changes/i }))

    await waitFor(() => expect(mockedPut).toHaveBeenCalled())
    expect(mockedPut.mock.calls[0][1]).toMatchObject({ name: 'Billing' })
  })

  it('sends an emptied description as undefined, not as an empty string', async () => {
    /*
     * `description.trim() || undefined`. An empty string is a VALUE — it would
     * overwrite what is stored — where `undefined` leaves the field alone. The
     * difference is invisible on screen and decides whether clearing the box
     * erases the description or does nothing.
     */
    const user = userEvent.setup()
    renderForm()
    await user.clear(screen.getByLabelText(/description/i))
    await user.click(screen.getByRole('button', { name: /save changes/i }))

    await waitFor(() => expect(mockedPut).toHaveBeenCalled())
    expect(mockedPut.mock.calls[0][1]).toHaveProperty('description', undefined)
  })

  it('sends the cost centre as a number, not the string the select holds', async () => {
    const user = userEvent.setup()
    renderForm()
    await user.selectOptions(screen.getByLabelText(/cost cent/i), '10')
    await user.click(screen.getByRole('button', { name: /save changes/i }))

    await waitFor(() => expect(mockedPut).toHaveBeenCalled())
    expect(mockedPut.mock.calls[0][1]).toMatchObject({ costCenterId: 10 })
  })

  it('omits the cost centre entirely when none is chosen', async () => {
    const user = userEvent.setup()
    renderForm()
    await user.click(screen.getByRole('button', { name: /save changes/i }))

    await waitFor(() => expect(mockedPut).toHaveBeenCalled())
    expect(mockedPut.mock.calls[0][1]).toHaveProperty('costCenterId', undefined)
  })

  it('puts to that project and nothing else', async () => {
    const user = userEvent.setup()
    renderForm()
    await user.click(screen.getByRole('button', { name: /save changes/i }))
    await waitFor(() => expect(mockedPut).toHaveBeenCalledWith('/api/projects/4', expect.anything()))
  })
})

describe('after a save', () => {
  it('confirms it and refreshes', async () => {
    const user = userEvent.setup()
    renderForm()
    await user.click(screen.getByRole('button', { name: /save changes/i }))

    await waitFor(() => expect(toast).toHaveBeenCalled())
    expect(toast.mock.calls[0][0]).toMatch(/saved/i)
    expect(refresh).toHaveBeenCalled()
  })

  it('reports a refusal and confirms nothing', async () => {
    const user = userEvent.setup()
    mockedPut.mockRejectedValue(new Error('Name already taken'))
    renderForm()
    await user.click(screen.getByRole('button', { name: /save changes/i }))

    expect(await screen.findByText('Name already taken')).toBeInTheDocument()
    expect(toast).not.toHaveBeenCalled()
    expect(refresh).not.toHaveBeenCalled()
  })

  it('says it is saving, and stops saying so afterwards', async () => {
    const user = userEvent.setup()
    let release: (() => void) | undefined
    mockedPut.mockImplementation((() => new Promise<void>((r) => { release = () => r() })) as never)
    renderForm()

    await user.click(screen.getByRole('button', { name: /save changes/i }))
    expect(screen.getByRole('button', { name: /saving/i })).toBeDisabled()

    release?.()
    await waitFor(() => expect(screen.getByRole('button', { name: /save changes/i })).toBeEnabled())
  })
})

describe('the cost centre picker only appears when there is a choice', () => {
  it('is hidden when the deployment has no cost centres', () => {
    renderForm(project(), [] as never)
    expect(screen.queryByLabelText(/cost cent/i)).not.toBeInTheDocument()
  })

  it('preselects the one the project already bills to', () => {
    renderForm(project({ costCenterId: 10 }))
    expect(screen.getByLabelText(/cost cent/i)).toHaveValue('10')
  })
})

describe('deleting the project', () => {
  it('deletes nothing until confirmed', async () => {
    const user = userEvent.setup()
    renderForm()
    await user.click(screen.getByRole('button', { name: /^delete/i }))
    expect(mockedDel).not.toHaveBeenCalled()
  })

  it('names the project in the confirmation', async () => {
    const user = userEvent.setup()
    renderForm()
    await user.click(screen.getByRole('button', { name: /^delete/i }))
    expect(within(screen.getByRole('dialog')).getByText('Webshop')).toBeInTheDocument()
  })

  it('leaves for the project list once it is gone', async () => {
    // The project page it was on no longer exists, so staying would render a 404.
    const user = userEvent.setup()
    renderForm()
    await user.click(screen.getByRole('button', { name: /^delete/i }))
    await user.click(within(screen.getByRole('dialog')).getByRole('button', { name: /^delete/i }))

    await waitFor(() => expect(mockedDel).toHaveBeenCalledWith('/api/projects/4'))
    expect(push).toHaveBeenCalledWith('/projects')
  })

  it('stays put and says why when the delete is refused', async () => {
    const user = userEvent.setup()
    mockedDel.mockRejectedValue(new Error('Project has infrastructure'))
    renderForm()
    await user.click(screen.getByRole('button', { name: /^delete/i }))
    await user.click(within(screen.getByRole('dialog')).getByRole('button', { name: /^delete/i }))

    expect(await screen.findByText('Project has infrastructure')).toBeInTheDocument()
    expect(push).not.toHaveBeenCalled()
    // The dialog closes so the error on the form behind it is readable.
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())
  })
})

describe('gaps the mutation run pointed at', () => {
  it('starts with an empty box when the project has no description', () => {
    // `project.description ?? ''` — without the fallback the textarea is handed
    // `null`, which React renders as an uncontrolled field.
    renderForm(project({ description: null }))
    expect(screen.getByLabelText(/description/i)).toHaveValue('')
  })

  it('treats a description of only spaces as no description', async () => {
    // `.trim() || undefined`. Spaces are not a description, and sending them
    // would store whitespace over whatever was there.
    const user = userEvent.setup()
    renderForm()
    await user.clear(screen.getByLabelText(/description/i))
    await user.type(screen.getByLabelText(/description/i), '   ')
    await user.click(screen.getByRole('button', { name: /save changes/i }))

    await waitFor(() => expect(mockedPut).toHaveBeenCalled())
    expect(mockedPut.mock.calls[0][1]).toHaveProperty('description', undefined)
  })

  it('closes the confirmation on Cancel without deleting', async () => {
    const user = userEvent.setup()
    renderForm()
    await user.click(screen.getByRole('button', { name: /^delete/i }))
    await user.click(within(screen.getByRole('dialog')).getByRole('button', { name: /cancel/i }))

    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())
    expect(mockedDel).not.toHaveBeenCalled()
  })

  it('titles the confirmation, so the dialog is not an unnamed box', async () => {
    const user = userEvent.setup()
    renderForm()
    await user.click(screen.getByRole('button', { name: /^delete/i }))
    expect(
      within(screen.getByRole('dialog')).getByRole('heading', { name: /delete project/i }),
    ).toBeInTheDocument()
  })

  it('says it is deleting, and shuts the button while it does', async () => {
    const user = userEvent.setup()
    let release: (() => void) | undefined
    mockedDel.mockImplementation((() => new Promise<void>((r) => { release = () => r() })) as never)
    renderForm()
    await user.click(screen.getByRole('button', { name: /^delete/i }))
    const dialog = within(screen.getByRole('dialog'))
    await user.click(dialog.getByRole('button', { name: /^delete/i }))

    expect(dialog.getByRole('button', { name: /deleting/i })).toBeDisabled()
    release?.()
    await waitFor(() => expect(push).toHaveBeenCalled())
  })

  it('labels each cost centre with its code AND its name', () => {
    // The code alone is not identifiable and the name alone is not unique; the
    // picker is unusable with either half missing.
    renderForm()
    const option = within(screen.getByLabelText(/cost cent/i)).getByRole('option', { name: /CC-100/ })
    expect(option.textContent).toContain('CC-100')
    expect(option.textContent).toContain('Platform')
  })

  it('offers a "none" placeholder so a project can bill to nothing', () => {
    renderForm()
    expect(
      within(screen.getByLabelText(/cost cent/i)).getByRole('option', { name: /none/i }),
    ).toBeInTheDocument()
  })
})
