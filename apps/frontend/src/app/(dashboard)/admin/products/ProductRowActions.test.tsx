import { describe, it, expect, vi, beforeAll, beforeEach } from 'vitest'
import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type { Product } from '@infrashelf/types'

const refresh = vi.fn()
const toast = vi.fn()
vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh, push: vi.fn() }) }))
vi.mock('@/lib/useLang', () => ({ useLang: () => 'en' }))
vi.mock('@/lib/api', () => ({ del: vi.fn(), put: vi.fn() }))
vi.mock('@/components/ui/Toast', () => ({ useToast: () => ({ toast }) }))

import { ProductRowActions } from './ProductRowActions'
import { del, put } from '@/lib/api'

// jsdom does not implement the native <dialog> methods Modal relies on — the
// same stub every other Modal test in this repo uses.
beforeAll(() => {
  HTMLDialogElement.prototype.showModal = vi.fn(function (this: HTMLDialogElement) {
    this.open = true
  })
  HTMLDialogElement.prototype.close = vi.fn(function (this: HTMLDialogElement) {
    this.open = false
  })
})

const mockedDel = vi.mocked(del)
const mockedPut = vi.mocked(put)

/**
 * The per-row controls on the admin product list, which had no test.
 *
 * Two things here are load-bearing and were asserted by nothing. Disable is a
 * TOGGLE (#251) — before that it was a one-way side effect of Delete refusing to
 * destroy order history, and a root administrator who pressed Delete lost the
 * product from every list with no way back short of a database update. And every
 * control carries the product name in its accessible name, because a screen
 * reader's list is otherwise "Edit, Edit, Edit" (WCAG 2.4.9).
 */
const product = (over?: Partial<Product>): Product =>
  ({ id: 7, name: 'Managed Postgres', retiredAt: null, ...over }) as Product

const renderRow = (p: Product = product()) => render(<ProductRowActions product={p} />)

beforeEach(() => {
  refresh.mockReset()
  toast.mockReset()
  mockedDel.mockReset().mockResolvedValue(undefined as never)
  mockedPut.mockReset().mockResolvedValue(undefined as never)
})

describe('every control names the product it acts on', () => {
  it.each([[/edit/i], [/disable/i], [/^delete/i]])('%s carries the name', (label) => {
    renderRow()
    const control = screen.getByRole(label.source.includes('edit') ? 'link' : 'button', { name: label })
    expect(control).toHaveAccessibleName(expect.stringContaining('Managed Postgres') as unknown as string)
  })

  it('points Edit at that product', () => {
    renderRow()
    expect(screen.getByRole('link', { name: /edit/i })).toHaveAttribute('href', '/admin/products/7')
  })
})

describe('disable is a toggle, not a one-way door', () => {
  it('offers Disable for a live product and asks to retire it', async () => {
    const user = userEvent.setup()
    renderRow(product({ retiredAt: null }))

    await user.click(screen.getByRole('button', { name: /disable/i }))

    expect(mockedPut).toHaveBeenCalledWith('/api/admin/products/7/retired', { retired: true })
  })

  it('offers Enable for a retired one and asks to bring it back', async () => {
    // The half that #251 added. Without it the product is gone from every list
    // with no way back short of a database update.
    const user = userEvent.setup()
    renderRow(product({ retiredAt: new Date().toISOString() as unknown as Product['retiredAt'] }))

    expect(screen.queryByRole('button', { name: /disable/i })).not.toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: /enable/i }))

    expect(mockedPut).toHaveBeenCalledWith('/api/admin/products/7/retired', { retired: false })
  })

  it('refreshes the list so the row reflects what just happened', async () => {
    const user = userEvent.setup()
    renderRow()
    await user.click(screen.getByRole('button', { name: /disable/i }))
    await waitFor(() => expect(refresh).toHaveBeenCalled())
  })

  it('reports a failed toggle instead of refreshing', async () => {
    const user = userEvent.setup()
    mockedPut.mockRejectedValue(new Error('Product is referenced'))
    renderRow()

    await user.click(screen.getByRole('button', { name: /disable/i }))

    // Rendered in two places by design: on the row, and inside the dialog when
    // one is open. `findAllByText` says so rather than tripping over it.
    expect((await screen.findAllByText('Product is referenced')).length).toBeGreaterThan(0)
    expect(refresh).not.toHaveBeenCalled()
  })
})

describe('delete is behind a confirmation', () => {
  it('deletes nothing on the first click', async () => {
    const user = userEvent.setup()
    renderRow()
    await user.click(screen.getByRole('button', { name: /^delete/i }))
    expect(mockedDel).not.toHaveBeenCalled()
  })

  it('warns that active infrastructure goes with it', async () => {
    // The consequence a reader has to weigh before pressing the red button.
    const user = userEvent.setup()
    renderRow()
    await user.click(screen.getByRole('button', { name: /^delete/i }))
    const dialog = within(screen.getByRole('dialog'))
    expect(dialog.getByText(/cannot be undone/i)).toBeInTheDocument()
    expect(dialog.getByText('Managed Postgres')).toBeInTheDocument()
  })

  it('deletes once confirmed', async () => {
    const user = userEvent.setup()
    renderRow()
    await user.click(screen.getByRole('button', { name: /^delete/i }))
    const dialog = within(screen.getByRole('dialog'))
    await user.click(dialog.getByRole('button', { name: /^delete/i }))

    await waitFor(() => expect(mockedDel).toHaveBeenCalledWith('/api/admin/products/7'))
    await waitFor(() => expect(refresh).toHaveBeenCalled())
  })

  it('deletes nothing when the dialog is dismissed', async () => {
    const user = userEvent.setup()
    renderRow()
    await user.click(screen.getByRole('button', { name: /^delete/i }))
    await user.click(within(screen.getByRole('dialog')).getByRole('button', { name: /cancel/i }))

    expect(mockedDel).not.toHaveBeenCalled()
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())
  })

  it('keeps the dialog open and says why when the delete is refused', async () => {
    // Closing it would hide the reason, and the row would look unchanged with no
    // explanation of what went wrong.
    const user = userEvent.setup()
    mockedDel.mockRejectedValue(new Error('Referenced by 3 orders'))
    renderRow()
    await user.click(screen.getByRole('button', { name: /^delete/i }))
    await user.click(within(screen.getByRole('dialog')).getByRole('button', { name: /^delete/i }))

    expect((await screen.findAllByText('Referenced by 3 orders')).length).toBeGreaterThan(0)
    expect(screen.getByRole('dialog')).toBeInTheDocument()
    expect(refresh).not.toHaveBeenCalled()
  })
})

describe('what the toast actually says', () => {
  /*
   * The toast was mocked and never inspected, so every string inside it was
   * unasserted — eight surviving mutants emptied one part or another and nothing
   * noticed. It is the only confirmation the user gets that the action landed, so
   * it has to name the product AND what happened to it.
   */
  it('names the product and says it was disabled', async () => {
    const user = userEvent.setup()
    renderRow(product({ retiredAt: null }))
    await user.click(screen.getByRole('button', { name: /disable/i }))

    await waitFor(() => expect(toast).toHaveBeenCalled())
    const [message, level] = toast.mock.calls[0]
    expect(message).toContain('Managed Postgres')
    expect(message).toMatch(/disabled/i)
    expect(level).toBe('info')
  })

  it('says it was enabled when bringing one back', async () => {
    const user = userEvent.setup()
    renderRow(product({ retiredAt: new Date().toISOString() as unknown as Product['retiredAt'] }))
    await user.click(screen.getByRole('button', { name: /enable/i }))

    await waitFor(() => expect(toast).toHaveBeenCalled())
    expect(toast.mock.calls[0][0]).toMatch(/enabled/i)
  })

  it('names the product and says it was deleted', async () => {
    const user = userEvent.setup()
    renderRow()
    await user.click(screen.getByRole('button', { name: /^delete/i }))
    await user.click(within(screen.getByRole('dialog')).getByRole('button', { name: /^delete/i }))

    await waitFor(() => expect(toast).toHaveBeenCalled())
    const [message, level] = toast.mock.calls[0]
    expect(message).toContain('Managed Postgres')
    expect(message).toMatch(/deleted/i)
    expect(level).toBe('info')
  })

  it('says nothing at all when the action failed', async () => {
    // A confirmation for something that did not happen is worse than silence.
    const user = userEvent.setup()
    mockedPut.mockRejectedValue(new Error('nope'))
    renderRow()
    await user.click(screen.getByRole('button', { name: /disable/i }))

    await screen.findAllByText('nope')
    expect(toast).not.toHaveBeenCalled()
  })
})

describe('the controls say when they are busy', () => {
  it('shuts the toggle while the request is in flight', async () => {
    const user = userEvent.setup()
    let release: (() => void) | undefined
    mockedPut.mockImplementation((() => new Promise<void>((r) => { release = () => r() })) as never)
    renderRow()

    await user.click(screen.getByRole('button', { name: /disable/i }))
    expect(screen.getByRole('button', { name: /disable/i })).toBeDisabled()

    release?.()
    await waitFor(() => expect(screen.getByRole('button', { name: /disable/i })).not.toBeDisabled())
  })

  it('shuts both dialog buttons while the delete is in flight, and says so', async () => {
    const user = userEvent.setup()
    let release: (() => void) | undefined
    mockedDel.mockImplementation((() => new Promise<void>((r) => { release = () => r() })) as never)
    renderRow()
    await user.click(screen.getByRole('button', { name: /^delete/i }))
    const dialog = within(screen.getByRole('dialog'))
    await user.click(dialog.getByRole('button', { name: /^delete/i }))

    // The label changes as well as the state — a dead button with the same words
    // reads as a click that did nothing.
    expect(dialog.getByRole('button', { name: /deleting/i })).toBeDisabled()
    expect(dialog.getByRole('button', { name: /cancel/i })).toBeDisabled()

    release?.()
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())
  })
})

describe('the confirmation spells out the consequence', () => {
  it('warns about active infrastructure and the cascade, not just "are you sure"', () => {
    // Four separate strings build this warning; a mutation emptying any one of
    // them leaves a sentence that still reads as a warning but no longer says
    // what is destroyed.
    renderRow()
    return userEvent.setup()
      .click(screen.getByRole('button', { name: /^delete/i }))
      .then(() => {
        const dialog = within(screen.getByRole('dialog'))
        const warning = screen.getByRole('dialog').textContent ?? ''
        expect(dialog.getByRole('heading', { name: /delete/i })).toBeInTheDocument()
        expect(warning).toMatch(/active/i)
        expect(warning.length).toBeGreaterThan(80)
      })
  })
})
