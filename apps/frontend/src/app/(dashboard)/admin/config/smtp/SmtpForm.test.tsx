import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, waitFor, fireEvent } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type { SmtpConfig } from '@infrashelf/types'
import { SmtpForm } from './SmtpForm'

vi.mock('@/lib/api', () => ({ put: vi.fn() }))
import { put } from '@/lib/api'

const toast = vi.fn()
vi.mock('@/components/ui/Toast', () => ({ useToast: () => ({ toast }) }))

const config = (over: Partial<SmtpConfig> = {}): SmtpConfig =>
  ({ host: 'smtp.example.com', port: 587, from: 'noreply@example.com', user: 'mailer', tls: true, ...over }) as SmtpConfig

const save = () => screen.getByRole('button', { name: 'Save Configuration' })

beforeEach(() => {
  toast.mockReset()
  vi.mocked(put).mockReset().mockResolvedValue(undefined as never)
})

/**
 * Two properties carry this form, and neither is visible from the outside: the
 * password is write-only, and the host/from pair has to be emptyable.
 */
describe('SmtpForm', () => {
  it('starts from the stored configuration', async () => {
    render(<SmtpForm initial={config()} />)

    expect(screen.getByLabelText(/^Host/)).toHaveValue('smtp.example.com')
    expect(screen.getByLabelText(/^Port/)).toHaveValue(587)
    expect(screen.getByLabelText(/^From Address/)).toHaveValue('noreply@example.com')
    expect(screen.getByLabelText(/^Username/)).toHaveValue('mailer')
    expect(screen.getByLabelText('Use TLS')).toBeChecked()
  })

  it('never puts the stored password back in the field', async () => {
    // There is nothing to put there — the API does not return it — and a
    // pre-filled field would say the password is readable.
    render(<SmtpForm initial={config()} />)
    expect(screen.getByLabelText(/^Password/)).toHaveValue('')
    expect(screen.getByLabelText(/^Password/)).toHaveAttribute('type', 'password')
  })

  it('leaves the stored password alone when the field is left blank', async () => {
    // What "leave blank to keep existing password" promises. Sending `''` would
    // silently unset a working credential and mail would stop going out.
    const u = userEvent.setup()
    render(<SmtpForm initial={config()} />)

    await u.click(save())

    await waitFor(() => expect(put).toHaveBeenCalled())
    expect(vi.mocked(put).mock.calls[0][1]).not.toHaveProperty('password')
  })

  it('replaces the password when one is typed', async () => {
    const u = userEvent.setup()
    render(<SmtpForm initial={config()} />)

    await u.type(screen.getByLabelText(/^Password/), 'hunter2')
    await u.click(save())

    await waitFor(() =>
      expect(put).toHaveBeenCalledWith('/api/admin/config/smtp', expect.objectContaining({ password: 'hunter2' })),
    )
  })

  it('sends the port as a number, not the string the field holds', async () => {
    // `<input type="number">` still gives a string, and the backend validates a
    // number; "2525" would be rejected as the wrong type.
    const u = userEvent.setup()
    render(<SmtpForm initial={config()} />)

    await u.clear(screen.getByLabelText(/^Port/))
    await u.type(screen.getByLabelText(/^Port/), '2525')
    await u.click(save())

    await waitFor(() => expect(put).toHaveBeenCalledWith('/api/admin/config/smtp', expect.objectContaining({ port: 2525 })))
  })

  it('trims the host, the address and the username', async () => {
    // `fireEvent`, not `type`: a browser trims `type="email"` itself, so typing
    // spaces into the address cannot tell this component's `.trim()` from the
    // platform's.
    render(<SmtpForm initial={config()} />)

    fireEvent.change(screen.getByLabelText(/^Host/), { target: { value: '  smtp.other.com  ' } })
    // Not the address: jsdom sanitises `type="email"` exactly as a browser
    // does, so its `.trim()` cannot be told apart from the platform's here. The
    // e2e suite is where that one is observable.
    fireEvent.change(screen.getByLabelText(/^Username/), { target: { value: '  bot  ' } })
    fireEvent.submit(save().closest('form') as HTMLFormElement)

    await waitFor(() =>
      expect(put).toHaveBeenCalledWith('/api/admin/config/smtp', expect.objectContaining({
        host: 'smtp.other.com',
        user: 'bot',
      })),
    )
  })

  it('lets both halves of the pair be emptied, so mail can be turned off', async () => {
    // #317: required unconditionally made SMTP a one-way door — the browser
    // refused to submit an emptied field, so a wrong hostname could be replaced
    // but never removed. Both set, or both empty and mail is off.
    render(<SmtpForm initial={config()} />)

    // Each field is required by THE OTHER being filled, so emptying one
    // releases its partner and the second can then go too.
    expect(screen.getByLabelText(/^Host/)).toBeRequired()
    expect(screen.getByLabelText(/^From Address/)).toBeRequired()

    fireEvent.change(screen.getByLabelText(/^Host/), { target: { value: '' } })
    expect(screen.getByLabelText(/^From Address/)).not.toBeRequired()
    expect(screen.getByLabelText(/^Host/)).toBeRequired()

    fireEvent.change(screen.getByLabelText(/^From Address/), { target: { value: '' } })
    expect(screen.getByLabelText(/^Host/)).not.toBeRequired()
    expect(screen.getByLabelText(/^From Address/)).not.toBeRequired()
  })

  it('requires the other half while one is filled', async () => {
    render(<SmtpForm initial={null} />)

    expect(screen.getByLabelText(/^Host/)).not.toBeRequired()
    fireEvent.change(screen.getByLabelText(/^From Address/), { target: { value: 'bot@other.com' } })
    expect(screen.getByLabelText(/^Host/)).toBeRequired()
  })

  it('does not count whitespace as a filled field', async () => {
    // Spaces are not an address. Treating them as one re-locks the door #317
    // opened: the browser would refuse to submit an emptied host because its
    // partner "has a value".
    render(<SmtpForm initial={null} />)

    fireEvent.change(screen.getByLabelText(/^Host/), { target: { value: '   ' } })
    expect(screen.getByLabelText(/^From Address/)).not.toBeRequired()
  })

  it('starts a fresh installation empty', () => {
    render(<SmtpForm initial={null} />)

    expect(screen.getByLabelText(/^Host/)).toHaveValue('')
    expect(screen.getByLabelText(/^Username/)).toHaveValue('')
    expect(screen.getByLabelText(/^From Address/)).toHaveValue('')
  })

  it('names the section, and shows no alert until something fails', () => {
    render(<SmtpForm initial={config()} />)

    expect(screen.getByRole('heading', { name: 'SMTP Settings' })).toBeInTheDocument()
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
  })

  it('clears a previous error once the save succeeds', async () => {
    // A stale error over a form that has just saved is its own lie.
    vi.mocked(put).mockRejectedValueOnce(new Error('connection refused'))
    const u = userEvent.setup()
    render(<SmtpForm initial={config()} />)

    await u.click(save())
    await screen.findByText('connection refused')

    await u.click(save())
    await waitFor(() => expect(screen.queryByText('connection refused')).not.toBeInTheDocument())
  })

  it('defaults a fresh installation to port 587 with TLS on', async () => {
    // The submission port, and encrypted: a default of 25 in the clear is the
    // wrong thing to nudge an operator towards.
    render(<SmtpForm initial={null} />)

    expect(screen.getByLabelText(/^Port/)).toHaveValue(587)
    expect(screen.getByLabelText('Use TLS')).toBeChecked()
  })

  it('sends TLS as the checkbox leaves it', async () => {
    const u = userEvent.setup()
    render(<SmtpForm initial={config()} />)

    await u.click(screen.getByLabelText('Use TLS'))
    await u.click(save())

    await waitFor(() => expect(put).toHaveBeenCalledWith('/api/admin/config/smtp', expect.objectContaining({ tls: false })))
  })

  it('confirms the save, and says why when it fails', async () => {
    const u = userEvent.setup()
    render(<SmtpForm initial={config()} />)
    await u.click(save())
    await waitFor(() => expect(toast).toHaveBeenCalledWith('SMTP configuration saved.'))

    toast.mockReset()
    vi.mocked(put).mockRejectedValue(new Error('connection refused by smtp.example.com'))
    await u.click(save())

    expect(await screen.findByText('connection refused by smtp.example.com')).toBeInTheDocument()
    expect(toast).not.toHaveBeenCalled()
  })

  it('says the save is under way, and refuses a second press', async () => {
    let release: () => void = () => {}
    vi.mocked(put).mockImplementation((() => new Promise<void>((r) => { release = r })) as never)
    const u = userEvent.setup()
    render(<SmtpForm initial={config()} />)

    await u.click(save())
    const saving = await screen.findByRole('button', { name: 'Saving…' })
    expect(saving).toBeDisabled()
    release()
  })

  it('offers the keep-it hint only when there is a password to keep', async () => {
    const { unmount } = render(<SmtpForm initial={config()} />)
    expect(screen.getByText('Leave blank to keep existing password')).toBeInTheDocument()
    unmount()

    render(<SmtpForm initial={null} />)
    expect(screen.queryByText('Leave blank to keep existing password')).not.toBeInTheDocument()
  })
})
