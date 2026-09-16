import { describe, it, expect, vi, beforeAll, beforeEach } from 'vitest'
import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'

// jsdom does not implement the native <dialog> methods; stub them so Modal's
// open/close effects don't throw (same stub as Modal.test.tsx).
beforeAll(() => {
  HTMLDialogElement.prototype.showModal = vi.fn(function (this: HTMLDialogElement) { this.open = true })
  HTMLDialogElement.prototype.close = vi.fn(function (this: HTMLDialogElement) { this.open = false })
})

const refresh = vi.fn()
vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh, push: vi.fn() }) }))
vi.mock('@/lib/useLang', () => ({ useLang: () => 'en' }))
vi.mock('@/lib/api', () => ({ post: vi.fn() }))

import { WriteOffOrder } from './WriteOffOrder'
import { post } from '@/lib/api'

const mockedPost = vi.mocked(post)

const openDialog = async (user: ReturnType<typeof userEvent.setup>) => {
  await user.click(screen.getAllByRole('button', { name: /write off/i })[0])
  return screen.getByRole('dialog')
}

/** The confirm button inside the dialog, not the one that opened it. */
const confirmButton = (dialog: HTMLElement) =>
  within(dialog).getAllByRole('button', { name: /write off/i }).slice(-1)[0]

beforeEach(() => {
  refresh.mockReset()
  mockedPost.mockReset().mockResolvedValue(undefined as never)
})

/**
 * Root's way out of an order whose pipeline never reported back (#206).
 *
 * An order enters `provisioning` when CI is triggered and leaves it when the
 * callback arrives. When the callback never arrives the order sits there for
 * ever, with every operator action behind a status it will never reach. This
 * writes a failure nobody observed, which is why the reason is mandatory and why
 * the audit entry has to say who decided it.
 */
describe('WriteOffOrder', () => {
  it('sends nothing from opening the dialog alone', async () => {
    const user = userEvent.setup()
    render(<WriteOffOrder orderId={37} />)

    await openDialog(user)
    expect(mockedPost).not.toHaveBeenCalled()
  })

  it('refuses to write off without a reason', async () => {
    // The whole point of the reason: this records a failure nobody observed, and
    // the audit entry is the only account of who decided that and why.
    const user = userEvent.setup()
    render(<WriteOffOrder orderId={37} />)

    const dialog = await openDialog(user)
    expect(confirmButton(dialog)).toBeDisabled()

    await user.type(within(dialog).getByLabelText(/^why/i), '   ')
    // Whitespace is not a reason.
    expect(confirmButton(dialog)).toBeDisabled()

    await user.type(within(dialog).getByLabelText(/^why/i), 'Pipeline finished; callback never arrived')
    expect(confirmButton(dialog)).toBeEnabled()
  })

  it('sends the reason to this order, and re-reads the page', async () => {
    const user = userEvent.setup()
    render(<WriteOffOrder orderId={37} />)

    const dialog = await openDialog(user)
    await user.type(within(dialog).getByLabelText(/^why/i), 'Callback never arrived')
    await user.click(confirmButton(dialog))

    await waitFor(() => expect(mockedPost).toHaveBeenCalledWith(
      '/api/orders/37/write-off',
      { reason: 'Callback never arrived' },
    ))
    // The server decided what the order now says; re-render from it.
    await waitFor(() => expect(refresh).toHaveBeenCalledTimes(1))
  })

  it('keeps the dialog open and says why when the server refuses', async () => {
    // The server checks the status again and refuses while the order could still
    // be running. That refusal is the answer, not a generic failure — and the
    // typed reason must survive it.
    mockedPost.mockRejectedValue(new Error('This order is still running'))
    const user = userEvent.setup()
    render(<WriteOffOrder orderId={37} />)

    const dialog = await openDialog(user)
    await user.type(within(dialog).getByLabelText(/^why/i), 'Callback never arrived')
    await user.click(confirmButton(dialog))

    expect(await screen.findByRole('alert')).toHaveTextContent('This order is still running')
    expect(refresh).not.toHaveBeenCalled()
    expect(within(screen.getByRole('dialog')).getByLabelText(/^why/i)).toHaveValue('Callback never arrived')
  })

  it('forgets the reason once the write-off went through', async () => {
    // Reopening the dialog on the next stuck order must not offer the previous
    // one's reason as a default.
    const user = userEvent.setup()
    render(<WriteOffOrder orderId={37} />)

    let dialog = await openDialog(user)
    await user.type(within(dialog).getByLabelText(/^why/i), 'Callback never arrived')
    await user.click(confirmButton(dialog))
    await waitFor(() => expect(refresh).toHaveBeenCalled())

    dialog = await openDialog(user)
    expect(within(dialog).getByLabelText(/^why/i)).toHaveValue('')
  })

  it('sends nothing when the dialog is cancelled', async () => {
    const user = userEvent.setup()
    render(<WriteOffOrder orderId={37} />)

    const dialog = await openDialog(user)
    await user.type(within(dialog).getByLabelText(/^why/i), 'Changed my mind')
    await user.click(within(dialog).getByRole('button', { name: /cancel/i }))

    expect(mockedPost).not.toHaveBeenCalled()
    expect(refresh).not.toHaveBeenCalled()
  })
})
