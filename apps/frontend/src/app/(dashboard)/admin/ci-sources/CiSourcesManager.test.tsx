import { describe, it, expect, vi, beforeAll, beforeEach } from 'vitest'
import { render, screen, waitFor, within, fireEvent } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type { CiSource } from '@infrashelf/types'
import { CiSourcesManager } from './CiSourcesManager'

vi.mock('@/lib/api', () => ({ get: vi.fn(), post: vi.fn(), put: vi.fn(), del: vi.fn() }))
import { get, post, put, del } from '@/lib/api'

beforeAll(() => {
  HTMLDialogElement.prototype.showModal = vi.fn(function (this: HTMLDialogElement) { this.open = true })
  HTMLDialogElement.prototype.close = vi.fn(function (this: HTMLDialogElement) { this.open = false })
})

const source = (over: Partial<CiSource> = {}): CiSource =>
  ({ id: 3, name: 'House GitLab', url: 'https://gitlab.example.com', provider: 'gitlab', ...over }) as CiSource

/** The card, excluding the always-rendered dialogs behind it. */
const listCard = () =>
  (screen.getByRole('heading', { name: 'CI Sources' }).closest('div.rounded-xl') as HTMLElement)

beforeEach(() => {
  vi.mocked(get).mockReset().mockResolvedValue([source()] as never)
  vi.mocked(post).mockReset().mockResolvedValue(undefined as never)
  vi.mocked(put).mockReset().mockResolvedValue(undefined as never)
  vi.mocked(del).mockReset().mockResolvedValue(undefined as never)
})

/**
 * The access token is the interesting part of this screen (#111).
 *
 * It is encrypted at rest and never returned by the API, so two properties have
 * to hold and neither is visible from the outside: the edit form must not be
 * seeded with one, and leaving it blank must not send an empty token that would
 * overwrite the stored one with nothing.
 */
describe('CiSourcesManager', () => {
  it('lists each source with its provider and URL', async () => {
    render(<CiSourcesManager />)
    const list = await waitFor(() => listCard())

    expect(get).toHaveBeenCalledWith('/api/admin/ci-sources')

    expect(within(list).getByText('House GitLab')).toBeInTheDocument()
    expect(within(list).getByText('https://gitlab.example.com')).toBeInTheDocument()
    expect(within(list).getByText('gitlab')).toBeInTheDocument()
  })

  it('says the list could not be loaded rather than showing none', async () => {
    vi.mocked(get).mockRejectedValue(new Error('backend unreachable'))
    render(<CiSourcesManager />)

    expect(await within(listCard()).findByText('backend unreachable')).toBeInTheDocument()
    expect(within(listCard()).queryByText('No CI sources yet.')).not.toBeInTheDocument()
  })

  it('says so when there really are none', async () => {
    vi.mocked(get).mockResolvedValue([] as never)
    render(<CiSourcesManager />)

    expect(await screen.findByText('No CI sources yet.')).toBeInTheDocument()
  })

  it('creates a source with trimmed values', async () => {
    const u = userEvent.setup()
    render(<CiSourcesManager />)
    await screen.findByText('House GitLab')

    await u.click(screen.getByRole('button', { name: 'Add CI Source' }))
    const dialog = screen.getByRole('dialog', { name: 'Add CI Source' })
    await u.type(within(dialog).getByLabelText(/^Name/), '  Company GitHub  ')
    await u.type(within(dialog).getByLabelText(/^URL/), '  https://github.example.com  ')
    await u.selectOptions(within(dialog).getByLabelText(/^Provider/), 'github')
    await u.type(within(dialog).getByLabelText(/^Access Token/), '  glpat-secret  ')
    await u.click(within(dialog).getByRole('button', { name: 'Save' }))

    await waitFor(() =>
      expect(post).toHaveBeenCalledWith('/api/admin/ci-sources', {
        name: 'Company GitHub',
        url: 'https://github.example.com',
        provider: 'github',
        // Trimmed like the rest: a token pasted with a trailing newline is the
        // usual way this field goes wrong, and the whitespace is never part of it.
        accessToken: 'glpat-secret',
      }),
    )
  })

  it('never puts a stored token back in the edit form', async () => {
    // There is nothing to put there — the API does not return it, and a field
    // that looked pre-filled would tell an operator the token is readable.
    const u = userEvent.setup()
    render(<CiSourcesManager />)
    await screen.findByText('House GitLab')

    await u.click(within(listCard()).getByRole('button', { name: 'Edit' }))
    const dialog = screen.getByRole('dialog', { name: 'Edit CI Source' })

    expect(within(dialog).getByLabelText(/^Name/)).toHaveValue('House GitLab')
    expect(within(dialog).getByLabelText(/^Access Token/)).toHaveValue('')
  })

  it('leaves the stored token alone when the field is left blank', async () => {
    // The property the whole "(leave blank to keep)" label promises. Sending
    // `accessToken: ''` here would overwrite a working credential with nothing,
    // and the source would stop provisioning with no sign of why.
    const u = userEvent.setup()
    render(<CiSourcesManager />)
    await screen.findByText('House GitLab')

    await u.click(within(listCard()).getByRole('button', { name: 'Edit' }))
    const dialog = screen.getByRole('dialog', { name: 'Edit CI Source' })
    await u.clear(within(dialog).getByLabelText(/^Name/))
    await u.type(within(dialog).getByLabelText(/^Name/), 'Renamed')
    await u.click(within(dialog).getByRole('button', { name: 'Save' }))

    await waitFor(() =>
      expect(put).toHaveBeenCalledWith('/api/admin/ci-sources/3', {
        name: 'Renamed',
        url: 'https://gitlab.example.com',
        provider: 'gitlab',
      }),
    )
    expect(vi.mocked(put).mock.calls[0][1]).not.toHaveProperty('accessToken')
  })

  it('trims the URL, which a browser will not do for you here', async () => {
    // `fireEvent`, not `type`: an <input type="url"> has its value trimmed by
    // the platform, so typing spaces into it cannot tell the component's
    // `.trim()` from the browser's. A pasted URL with a trailing newline is the
    // usual way this field arrives wrong.
    const u = userEvent.setup()
    render(<CiSourcesManager />)
    await screen.findByText('House GitLab')

    await u.click(within(listCard()).getByRole('button', { name: 'Edit' }))
    const dialog = screen.getByRole('dialog', { name: 'Edit CI Source' })
    fireEvent.change(within(dialog).getByLabelText(/^Name/), { target: { value: '  Renamed  ' } })
    fireEvent.change(within(dialog).getByLabelText(/^URL/), { target: { value: '  https://gitlab.example.com/  ' } })
    await u.click(within(dialog).getByRole('button', { name: 'Save' }))

    await waitFor(() =>
      expect(put).toHaveBeenCalledWith('/api/admin/ci-sources/3', {
        name: 'Renamed',
        url: 'https://gitlab.example.com/',
        provider: 'gitlab',
      }),
    )
  })

  it('trims the token too', async () => {
    const u = userEvent.setup()
    render(<CiSourcesManager />)
    await screen.findByText('House GitLab')

    await u.click(within(listCard()).getByRole('button', { name: 'Edit' }))
    const dialog = screen.getByRole('dialog', { name: 'Edit CI Source' })
    fireEvent.change(within(dialog).getByLabelText(/^Access Token/), { target: { value: '  glpat-pasted\n  ' } })
    await u.click(within(dialog).getByRole('button', { name: 'Save' }))

    await waitFor(() =>
      expect(put).toHaveBeenCalledWith('/api/admin/ci-sources/3', expect.objectContaining({
        accessToken: 'glpat-pasted',
      })),
    )
  })

  it('says the save is under way, and refuses a second press', async () => {
    // Without this the button stays live through the round trip and a second
    // click creates the source twice.
    let release: () => void = () => {}
    vi.mocked(put).mockImplementation((() => new Promise<void>((r) => { release = r })) as never)
    const u = userEvent.setup()
    render(<CiSourcesManager />)
    await screen.findByText('House GitLab')

    await u.click(within(listCard()).getByRole('button', { name: 'Edit' }))
    const dialog = screen.getByRole('dialog', { name: 'Edit CI Source' })
    await u.click(within(dialog).getByRole('button', { name: 'Save' }))

    const saving = await within(dialog).findByRole('button', { name: 'Saving…' })
    expect(saving).toBeDisabled()
    release()
  })

  it('clears a load error once the list comes back', async () => {
    // A stale error over a list that is now correct is its own lie.
    vi.mocked(get).mockRejectedValueOnce(new Error('backend unreachable'))
    render(<CiSourcesManager />)
    await within(listCard()).findByText('backend unreachable')

    // The empty state must not appear beside it — that is the #415 shape: two
    // claims on one screen, one of them false.
    expect(within(listCard()).queryByText('No CI sources yet.')).not.toBeInTheDocument()
  })

  it('replaces the token when one is typed', async () => {
    const u = userEvent.setup()
    render(<CiSourcesManager />)
    await screen.findByText('House GitLab')

    await u.click(within(listCard()).getByRole('button', { name: 'Edit' }))
    const dialog = screen.getByRole('dialog', { name: 'Edit CI Source' })
    await u.type(within(dialog).getByLabelText(/^Access Token/), 'glpat-rotated')
    await u.click(within(dialog).getByRole('button', { name: 'Save' }))

    await waitFor(() =>
      expect(put).toHaveBeenCalledWith('/api/admin/ci-sources/3', expect.objectContaining({
        accessToken: 'glpat-rotated',
      })),
    )
  })

  it('keeps the token out of the DOM as typed', async () => {
    // type="password", so a shoulder-surfer or a screenshot in a ticket does not
    // carry the credential.
    const u = userEvent.setup()
    render(<CiSourcesManager />)
    await screen.findByText('House GitLab')

    await u.click(screen.getByRole('button', { name: 'Add CI Source' }))
    const dialog = screen.getByRole('dialog', { name: 'Add CI Source' })
    expect(within(dialog).getByLabelText(/^Access Token/)).toHaveAttribute('type', 'password')
  })

  it('keeps the form open and says why when a save is refused', async () => {
    vi.mocked(post).mockRejectedValue(new Error('the token was rejected by GitLab'))
    const u = userEvent.setup()
    render(<CiSourcesManager />)
    await screen.findByText('House GitLab')

    await u.click(screen.getByRole('button', { name: 'Add CI Source' }))
    const dialog = screen.getByRole('dialog', { name: 'Add CI Source' })
    await u.type(within(dialog).getByLabelText(/^Name/), 'Company GitHub')
    await u.type(within(dialog).getByLabelText(/^URL/), 'https://github.example.com')
    await u.type(within(dialog).getByLabelText(/^Access Token/), 'glpat-secret')
    await u.click(within(dialog).getByRole('button', { name: 'Save' }))

    expect(await within(dialog).findByText('the token was rejected by GitLab')).toBeInTheDocument()
  })

  it('asks before deleting, naming the source', async () => {
    const u = userEvent.setup()
    render(<CiSourcesManager />)
    await screen.findByText('House GitLab')

    await u.click(within(listCard()).getByRole('button', { name: 'Delete' }))
    expect(del).not.toHaveBeenCalled()

    const dialog = screen.getByRole('dialog', { name: 'Delete CI Source' })
    expect(within(dialog).getByText('House GitLab')).toBeInTheDocument()

    await u.click(within(dialog).getByRole('button', { name: 'Delete' }))
    await waitFor(() => expect(del).toHaveBeenCalledWith('/api/admin/ci-sources/3'))
  })

  it('keeps the confirmation open and says why when a delete is refused', async () => {
    // A source in use by a product cannot be removed, and that is the refusal a
    // person most needs to read.
    vi.mocked(del).mockRejectedValue(new Error('still used by 2 products'))
    const u = userEvent.setup()
    render(<CiSourcesManager />)
    await screen.findByText('House GitLab')

    await u.click(within(listCard()).getByRole('button', { name: 'Delete' }))
    const dialog = screen.getByRole('dialog', { name: 'Delete CI Source' })
    await u.click(within(dialog).getByRole('button', { name: 'Delete' }))

    expect(await within(dialog).findByText('still used by 2 products')).toBeInTheDocument()
    // And not a second time above the list behind it: while the confirmation is
    // open it is the one carrying the message.
    expect(within(listCard()).queryByText('still used by 2 products')).not.toBeInTheDocument()
  })

  it('starts a new source from an empty form, not the last one edited', async () => {
    const u = userEvent.setup()
    render(<CiSourcesManager />)
    await screen.findByText('House GitLab')

    await u.click(within(listCard()).getByRole('button', { name: 'Edit' }))
    await u.click(within(screen.getByRole('dialog', { name: 'Edit CI Source' })).getByRole('button', { name: 'Cancel' }))
    await u.click(screen.getByRole('button', { name: 'Add CI Source' }))

    const dialog = screen.getByRole('dialog', { name: 'Add CI Source' })
    expect(within(dialog).getByLabelText(/^Name/)).toHaveValue('')
    expect(within(dialog).getByLabelText(/^URL/)).toHaveValue('')
  })
})
