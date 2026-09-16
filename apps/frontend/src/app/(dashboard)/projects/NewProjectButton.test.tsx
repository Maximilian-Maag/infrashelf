import { describe, it, expect, vi, beforeAll, beforeEach } from 'vitest'
import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type { CostCenter } from '@infrashelf/types'

// jsdom does not implement the native <dialog> methods; stub them so Modal's
// open/close effects don't throw (same stub as Modal.test.tsx).
beforeAll(() => {
  HTMLDialogElement.prototype.showModal = vi.fn(function (this: HTMLDialogElement) { this.open = true })
  HTMLDialogElement.prototype.close = vi.fn(function (this: HTMLDialogElement) { this.open = false })
})

const refresh = vi.fn()
vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh, push: vi.fn() }) }))
vi.mock('@/lib/useLang', () => ({ useLang: () => 'en' }))
vi.mock('@/lib/api', () => ({ get: vi.fn(), post: vi.fn() }))

import { NewProjectButton } from './NewProjectButton'
import { get, post } from '@/lib/api'

const mockedGet = vi.mocked(get)
const mockedPost = vi.mocked(post)

const costCenters: CostCenter[] = [
  { id: 10, code: 'CC-100', name: 'Shared Platform', active: true },
  { id: 11, code: 'CC-200', name: 'Retired Account', active: false },
]

const openForm = async (user: ReturnType<typeof userEvent.setup>) => {
  await user.click(screen.getByRole('button', { name: /new project/i }))
  return screen.getByRole('dialog')
}

beforeEach(() => {
  refresh.mockReset()
  mockedGet.mockReset().mockResolvedValue(costCenters as never)
  mockedPost.mockReset().mockResolvedValue(undefined as never)
})

describe('NewProjectButton', () => {
  it('offers only the cost centres that are still active', async () => {
    // A retired account is still stored — orders placed against it have to keep
    // naming it — but it must not be assignable to something new.
    const user = userEvent.setup()
    render(<NewProjectButton />)

    const dialog = await openForm(user)
    await waitFor(() => expect(within(dialog).getByLabelText(/cost cent/i)).toBeInTheDocument())

    const options = within(dialog).getAllByRole('option').map((o) => o.textContent)
    expect(options.some((o) => o?.includes('CC-100'))).toBe(true)
    expect(options.some((o) => o?.includes('CC-200'))).toBe(false)
  })

  it('still lets a project be created when the cost centres cannot be read', async () => {
    // The picker is optional; the project is not. Documented here because the
    // catch that makes it so is silent by design.
    mockedGet.mockRejectedValue(new Error('403 Forbidden'))
    const user = userEvent.setup()
    render(<NewProjectButton />)

    const dialog = await openForm(user)
    await user.type(within(dialog).getByLabelText(/^name/i), 'Webshop Platform')
    await user.click(within(dialog).getByRole('button', { name: /create project/i }))

    await waitFor(() => expect(mockedPost).toHaveBeenCalledWith('/api/projects', expect.objectContaining({
      name: 'Webshop Platform',
    })))
  })

  it('refuses a name that is only whitespace, without asking the server', async () => {
    const user = userEvent.setup()
    render(<NewProjectButton />)

    const dialog = await openForm(user)
    await user.type(within(dialog).getByLabelText(/^name/i), '   ')
    await user.click(within(dialog).getByRole('button', { name: /create project/i }))

    expect(await within(dialog).findByRole('alert')).toBeInTheDocument()
    expect(mockedPost).not.toHaveBeenCalled()
  })

  it('trims the name, drops an empty description, and sends the chosen account as a number', async () => {
    const user = userEvent.setup()
    render(<NewProjectButton />)

    const dialog = await openForm(user)
    await waitFor(() => expect(within(dialog).getByLabelText(/cost cent/i)).toBeInTheDocument())
    await user.type(within(dialog).getByLabelText(/^name/i), '  Webshop Platform  ')
    await user.selectOptions(within(dialog).getByLabelText(/cost cent/i), '10')
    await user.click(within(dialog).getByRole('button', { name: /create project/i }))

    await waitFor(() => expect(mockedPost).toHaveBeenCalledWith('/api/projects', {
      name: 'Webshop Platform',
      description: undefined,
      // A number, not the string the <select> carries: the API takes an id.
      costCenterId: 10,
    }))
  })

  it('sends no cost centre when none was chosen', async () => {
    const user = userEvent.setup()
    render(<NewProjectButton />)

    const dialog = await openForm(user)
    await user.type(within(dialog).getByLabelText(/^name/i), 'Webshop Platform')
    await user.type(within(dialog).getByLabelText(/description/i), 'The shop')
    await user.click(within(dialog).getByRole('button', { name: /create project/i }))

    await waitFor(() => expect(mockedPost).toHaveBeenCalledWith('/api/projects', {
      name: 'Webshop Platform',
      description: 'The shop',
      costCenterId: undefined,
    }))
  })

  it('re-reads the list from the server once the project exists', async () => {
    const user = userEvent.setup()
    render(<NewProjectButton />)

    const dialog = await openForm(user)
    await user.type(within(dialog).getByLabelText(/^name/i), 'Webshop Platform')
    await user.click(within(dialog).getByRole('button', { name: /create project/i }))

    await waitFor(() => expect(refresh).toHaveBeenCalledTimes(1))
  })

  it('keeps the form and says why when the server refuses', async () => {
    // Most often the 409 for a name that is taken. Losing what was typed would
    // make the second attempt a retype rather than an edit.
    mockedPost.mockRejectedValue(new Error('A project with this name already exists'))
    const user = userEvent.setup()
    render(<NewProjectButton />)

    const dialog = await openForm(user)
    await user.type(within(dialog).getByLabelText(/^name/i), 'Webshop Platform')
    await user.click(within(dialog).getByRole('button', { name: /create project/i }))

    expect(await screen.findByRole('alert')).toHaveTextContent('A project with this name already exists')
    expect(refresh).not.toHaveBeenCalled()
    expect(within(screen.getByRole('dialog')).getByLabelText(/^name/i)).toHaveValue('Webshop Platform')
  })

  it('forgets what was typed once the project was created', async () => {
    // Reopening for the second project must not offer the first one's name.
    const user = userEvent.setup()
    render(<NewProjectButton />)

    let dialog = await openForm(user)
    await user.type(within(dialog).getByLabelText(/^name/i), 'Webshop Platform')
    await user.click(within(dialog).getByRole('button', { name: /create project/i }))
    await waitFor(() => expect(refresh).toHaveBeenCalled())

    dialog = await openForm(user)
    expect(within(dialog).getByLabelText(/^name/i)).toHaveValue('')
  })
})
