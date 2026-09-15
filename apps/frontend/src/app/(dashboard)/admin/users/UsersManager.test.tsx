import { describe, it, expect, vi, beforeAll, beforeEach } from 'vitest'
import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type { User } from '@infrashelf/types'
import { UsersManager } from './UsersManager'

vi.mock('@/lib/api', () => ({ get: vi.fn(), post: vi.fn(), put: vi.fn(), del: vi.fn() }))
import { get, post, put, del } from '@/lib/api'

const toast = vi.fn()
vi.mock('@/components/ui/Toast', () => ({ useToast: () => ({ toast }) }))
// The sessions dialog fetches on its own; this file is about the manager around it.
vi.mock('@/components/forms/ActiveSessions', () => ({
  ActiveSessions: ({ userId }: { userId: number }) => <div>sessions for {userId}</div>,
}))

beforeAll(() => {
  HTMLDialogElement.prototype.showModal = vi.fn(function (this: HTMLDialogElement) { this.open = true })
  HTMLDialogElement.prototype.close = vi.fn(function (this: HTMLDialogElement) { this.open = false })
})

const user = (over: Partial<User> = {}): User =>
  ({ id: 1, email: 'ada@test.dev', name: 'Ada', role: 'project_manager', active: true, ...over }) as User

/**
 * The card, excluding the dialogs.
 *
 * Every Modal is rendered whether or not it is open, and the role <Select>
 * inside the Add and Edit dialogs carries every role name as an <option> — so a
 * page-level query for "Root" or "Admin" matches the option as well as the
 * badge. Scoping to the card is what makes those queries mean the list.
 */
const listCard = () =>
  (screen.getByRole('heading', { name: 'Users' }).closest('div.rounded-xl') as HTMLElement)

/** One account's row, by the name shown in it. */
const rowOf = (name: string) =>
  (within(listCard()).getByText(name).closest('div.justify-between') as HTMLElement)

beforeEach(() => {
  toast.mockReset()
  vi.mocked(get).mockReset().mockResolvedValue([user()] as never)
  vi.mocked(post).mockReset().mockResolvedValue(undefined as never)
  vi.mocked(put).mockReset().mockResolvedValue(undefined as never)
  vi.mocked(del).mockReset().mockResolvedValue(undefined as never)
})

describe('UsersManager', () => {
  it('lists each account with its role and address', async () => {
    vi.mocked(get).mockResolvedValue([
      user({ id: 1, name: 'Ada', role: 'root', email: 'ada@test.dev' }),
      user({ id: 2, name: 'Grace', role: 'admin', email: 'grace@test.dev' }),
    ] as never)
    render(<UsersManager />)

    expect(await screen.findByText('ada@test.dev')).toBeInTheDocument()
    const list = listCard()
    expect(within(list).getByText('Ada')).toBeInTheDocument()
    expect(within(list).getByText('Root')).toBeInTheDocument()
    expect(within(list).getByText('Admin')).toBeInTheDocument()
  })

  it('says the list could not be loaded rather than showing no accounts', async () => {
    // An installation always has at least a root account, so an empty list here
    // is never the truth — it is a failed fetch wearing the empty state.
    vi.mocked(get).mockRejectedValue(new Error('backend unreachable'))
    render(<UsersManager />)

    expect(await within(listCard()).findByText('backend unreachable')).toBeInTheDocument()
    // And not "there are none" beside it: two claims on one screen, one of them
    // false and the one a person acts on (#415).
    expect(within(listCard()).queryByText('No users yet.')).not.toBeInTheDocument()
  })

  it('creates an account with the form’s values, trimmed', async () => {
    const u = userEvent.setup()
    render(<UsersManager />)
    await screen.findByText('Ada')

    await u.click(screen.getByRole('button', { name: 'Add User' }))
    const dialog = screen.getByRole('dialog', { name: 'Add User' })
    await u.type(within(dialog).getByLabelText(/^Email/), 'grace@test.dev')
    await u.type(within(dialog).getByLabelText(/^Name/), '  Grace  ')
    await u.type(within(dialog).getByLabelText(/^Password/), 'hunter2hunter2')
    await u.click(within(dialog).getByRole('button', { name: 'Create' }))

    await waitFor(() =>
      expect(post).toHaveBeenCalledWith('/api/admin/users', {
        email: 'grace@test.dev',
        name: 'Grace',
        role: 'project_manager',
        // NOT trimmed: leading or trailing spaces are part of a password, and
        // silently removing them locks the account out of its own credential.
        password: 'hunter2hunter2',
      }),
    )
  })

  it('defaults a new account to the least privilege, not the most', async () => {
    const u = userEvent.setup()
    render(<UsersManager />)
    await screen.findByText('Ada')

    await u.click(screen.getByRole('button', { name: 'Add User' }))
    const dialog = screen.getByRole('dialog', { name: 'Add User' })
    expect(within(dialog).getByLabelText(/^Role/)).toHaveValue('project_manager')
  })

  it('reloads the list after a create, so the new account appears', async () => {
    const u = userEvent.setup()
    render(<UsersManager />)
    await screen.findByText('Ada')
    vi.mocked(get).mockClear()

    await u.click(screen.getByRole('button', { name: 'Add User' }))
    const dialog = screen.getByRole('dialog', { name: 'Add User' })
    await u.type(within(dialog).getByLabelText(/^Email/), 'grace@test.dev')
    await u.type(within(dialog).getByLabelText(/^Name/), 'Grace')
    await u.type(within(dialog).getByLabelText(/^Password/), 'hunter2hunter2')
    await u.click(within(dialog).getByRole('button', { name: 'Create' }))

    await waitFor(() => expect(get).toHaveBeenCalledWith('/api/admin/users'))
    expect(toast).toHaveBeenCalledWith('User created.')
  })

  it('keeps the form open and says why when a create is refused', async () => {
    vi.mocked(post).mockRejectedValue(new Error('email already registered'))
    const u = userEvent.setup()
    render(<UsersManager />)
    await screen.findByText('Ada')

    await u.click(screen.getByRole('button', { name: 'Add User' }))
    const dialog = screen.getByRole('dialog', { name: 'Add User' })
    await u.type(within(dialog).getByLabelText(/^Email/), 'ada@test.dev')
    await u.type(within(dialog).getByLabelText(/^Name/), 'Ada')
    await u.type(within(dialog).getByLabelText(/^Password/), 'hunter2hunter2')
    await u.click(within(dialog).getByRole('button', { name: 'Create' }))

    expect(await within(dialog).findByText('email already registered')).toBeInTheDocument()
    expect(toast).not.toHaveBeenCalled()
  })

  it('edits the name and role, and nothing else', async () => {
    // Not the email: it identifies the account and is how a person signs in, so
    // changing it here would be a different and much larger operation.
    const u = userEvent.setup()
    render(<UsersManager />)
    await screen.findByText('Ada')

    await u.click(within(rowOf('Ada')).getByRole('button', { name: 'Edit' }))
    const dialog = screen.getByRole('dialog', { name: 'Edit User' })
    // A required field's label renders as "Name *", so the matcher has to be a
    // prefix — an exact-text query here would pass whether or not the field
    // existed, which is no assertion at all.
    expect(within(dialog).getByLabelText(/^Name/)).toHaveValue('Ada')
    expect(within(dialog).queryByLabelText(/^Email/)).not.toBeInTheDocument()

    await u.selectOptions(within(dialog).getByLabelText(/^Role/), 'admin')
    await u.click(within(dialog).getByRole('button', { name: 'Save' }))

    await waitFor(() =>
      expect(put).toHaveBeenCalledWith('/api/admin/users/1', { name: 'Ada', role: 'admin' }),
    )
    expect(toast).toHaveBeenCalledWith('User updated.')
  })

  it('trims the name on an edit too, not only on a create', async () => {
    // Two code paths build two request bodies, and only one of them was covered
    // — a trailing space on a rename is as easy to paste as on a new account.
    const u = userEvent.setup()
    render(<UsersManager />)
    await screen.findByText('Ada')

    await u.click(within(rowOf('Ada')).getByRole('button', { name: 'Edit' }))
    const dialog = screen.getByRole('dialog', { name: 'Edit User' })
    await u.clear(within(dialog).getByLabelText(/^Name/))
    await u.type(within(dialog).getByLabelText(/^Name/), '  Ada Lovelace  ')
    await u.click(within(dialog).getByRole('button', { name: 'Save' }))

    await waitFor(() =>
      expect(put).toHaveBeenCalledWith('/api/admin/users/1', { name: 'Ada Lovelace', role: 'project_manager' }),
    )
  })

  it('says the save is under way, and refuses a second press', async () => {
    // Without this the button stays live through the round trip and a second
    // click creates the account twice.
    let release: () => void = () => {}
    vi.mocked(put).mockImplementation((() => new Promise<void>((r) => { release = r })) as never)
    const u = userEvent.setup()
    render(<UsersManager />)
    await screen.findByText('Ada')

    await u.click(within(rowOf('Ada')).getByRole('button', { name: 'Edit' }))
    const dialog = screen.getByRole('dialog', { name: 'Edit User' })
    await u.click(within(dialog).getByRole('button', { name: 'Save' }))

    const saving = await within(dialog).findByRole('button', { name: 'Saving…' })
    expect(saving).toBeDisabled()
    release()
  })

  it('deactivates an active account and reactivates an inactive one', async () => {
    // The label and the value it sends have to move together, or the button says
    // one thing and does the other.
    const u = userEvent.setup()
    render(<UsersManager />)
    await screen.findByText('Ada')

    // The reload's answer is staged BEFORE the click: `toggleActive` fires the
    // PUT and the reload together, so setting it afterwards races the fetch.
    vi.mocked(get).mockResolvedValue([user({ active: false })] as never)
    await u.click(within(rowOf('Ada')).getByRole('button', { name: 'Deactivate' }))
    await waitFor(() => expect(put).toHaveBeenCalledWith('/api/admin/users/1', { active: false }))

    vi.mocked(get).mockResolvedValue([user({ active: true })] as never)
    await waitFor(() => expect(screen.getByRole('button', { name: 'Activate' })).toBeInTheDocument())

    await u.click(screen.getByRole('button', { name: 'Activate' }))
    await waitFor(() => expect(put).toHaveBeenCalledWith('/api/admin/users/1', { active: true }))
  })

  it('asks before deleting an account, naming which one', async () => {
    const u = userEvent.setup()
    render(<UsersManager />)
    await screen.findByText('Ada')

    await u.click(within(rowOf('Ada')).getByRole('button', { name: 'Delete' }))
    expect(del).not.toHaveBeenCalled()

    const dialog = screen.getByRole('dialog', { name: /delete/i })
    // Naming the account is the whole point of the confirmation: "are you sure"
    // over a list of five rows does not say which row.
    expect(within(dialog).getByText('Ada')).toBeInTheDocument()

    await u.click(within(dialog).getByRole('button', { name: 'Delete' }))
    await waitFor(() => expect(del).toHaveBeenCalledWith('/api/admin/users/1'))
    expect(toast).toHaveBeenCalledWith('User deleted.', 'info')
  })

  it('clears a load error once the list comes back', async () => {
    // A stale error over a list that is now correct is its own lie.
    vi.mocked(get).mockRejectedValueOnce(new Error('backend unreachable'))
    const u = userEvent.setup()
    render(<UsersManager />)
    await within(listCard()).findByText('backend unreachable')

    // Any action reloads; adding is the cheapest.
    await u.click(screen.getByRole('button', { name: 'Add User' }))
    const dialog = screen.getByRole('dialog', { name: 'Add User' })
    await u.type(within(dialog).getByLabelText(/^Email/), 'grace@test.dev')
    await u.type(within(dialog).getByLabelText(/^Name/), 'Grace')
    await u.type(within(dialog).getByLabelText(/^Password/), 'hunter2hunter2')
    await u.click(within(dialog).getByRole('button', { name: 'Create' }))

    await waitFor(() => expect(within(listCard()).queryByText('backend unreachable')).not.toBeInTheDocument())
  })

  it('starts a new account from an empty form, not the last one edited', async () => {
    const u = userEvent.setup()
    render(<UsersManager />)
    await screen.findByText('Ada')

    await u.click(within(rowOf('Ada')).getByRole('button', { name: 'Edit' }))
    await u.click(within(screen.getByRole('dialog', { name: 'Edit User' })).getByRole('button', { name: 'Cancel' }))
    await u.click(screen.getByRole('button', { name: 'Add User' }))

    const add = screen.getByRole('dialog', { name: 'Add User' })
    expect(within(add).getByLabelText(/^Name/)).toHaveValue('')
    expect(within(add).getByLabelText(/^Role/)).toHaveValue('project_manager')
  })

  it('keeps the confirmation open and says why when a delete is refused', async () => {
    // The backend refuses the last root account, and that refusal is the one a
    // person most needs to read.
    vi.mocked(del).mockRejectedValue(new Error('cannot delete the last root account'))
    const u = userEvent.setup()
    render(<UsersManager />)
    await screen.findByText('Ada')

    await u.click(within(rowOf('Ada')).getByRole('button', { name: 'Delete' }))
    const dialog = screen.getByRole('dialog', { name: /delete/i })
    await u.click(within(dialog).getByRole('button', { name: 'Delete' }))

    expect(await within(dialog).findByText('cannot delete the last root account')).toBeInTheDocument()
  })

  it('names the row in each Sessions button, since the label is one word', async () => {
    // Five identical "Sessions" buttons tell a screen-reader user nothing about
    // whose sessions they are about to open.
    vi.mocked(get).mockResolvedValue([
      user({ id: 1, name: 'Ada', email: 'ada@test.dev' }),
      user({ id: 2, name: 'Grace', email: 'grace@test.dev' }),
    ] as never)
    render(<UsersManager />)
    await screen.findByText('Ada')

    expect(screen.getByRole('button', { name: 'Active sessions: Ada (ada@test.dev)' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Active sessions: Grace (grace@test.dev)' })).toBeInTheDocument()
  })

  it('opens the sessions of the row that was clicked', async () => {
    vi.mocked(get).mockResolvedValue([
      user({ id: 1, name: 'Ada' }),
      user({ id: 2, name: 'Grace', email: 'grace@test.dev' }),
    ] as never)
    const u = userEvent.setup()
    render(<UsersManager />)
    await screen.findByText('Grace')

    await u.click(screen.getByRole('button', { name: 'Active sessions: Grace (grace@test.dev)' }))
    expect(await screen.findByText('sessions for 2')).toBeInTheDocument()
  })
})
