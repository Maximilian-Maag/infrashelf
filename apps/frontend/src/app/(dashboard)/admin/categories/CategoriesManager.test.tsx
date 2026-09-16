import { describe, it, expect, vi, beforeAll, beforeEach } from 'vitest'
import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type { Category } from '@infrashelf/types'

// jsdom does not implement the native <dialog> methods; stub them so Modal's
// open/close effects don't throw (same stub as ProductEditForm.test.tsx).
beforeAll(() => {
  HTMLDialogElement.prototype.showModal = vi.fn(function (this: HTMLDialogElement) {
    this.open = true
  })
  HTMLDialogElement.prototype.close = vi.fn(function (this: HTMLDialogElement) {
    this.open = false
  })
})

const toast = vi.fn()
vi.mock('@/components/ui/Toast', () => ({ useToast: () => ({ toast }) }))

vi.mock('@/lib/api', () => ({
  get: vi.fn(),
  post: vi.fn(),
  put: vi.fn(),
  del: vi.fn(),
}))

import { CategoriesManager } from './CategoriesManager'
import { get, post, put } from '@/lib/api'

const mockedGet = vi.mocked(get)
const mockedPost = vi.mocked(post)
const mockedPut = vi.mocked(put)

const categories: Category[] = [
  { id: 1, name: 'Databases', displayOrder: 40 },
  { id: 2, name: 'Networking', displayOrder: 0 },
]

beforeEach(() => {
  toast.mockReset()
  mockedGet.mockReset().mockResolvedValue(categories as never)
  mockedPost.mockReset().mockResolvedValue(undefined as never)
  mockedPut.mockReset().mockResolvedValue(undefined as never)
})

describe('CategoriesManager display order', () => {
  it('keeps the category\'s own order when Display Order is cleared on edit (#146)', async () => {
    // `Number('')` is `0`, not `NaN` — clearing the field on a category
    // ordered 40 must not silently save it as 0 and jump it to the top of
    // every catalogue sidebar.
    const user = userEvent.setup()
    render(<CategoriesManager initial={categories} />)

    await user.click((await screen.findAllByRole('button', { name: 'Edit' }))[0])
    const dialog = screen.getByRole('dialog', { name: 'Edit Category' })
    const orderInput = within(dialog).getByLabelText(/display order/i)
    expect(orderInput).toHaveValue(40)

    await user.clear(orderInput)
    await user.click(within(dialog).getByRole('button', { name: 'Save' }))

    await waitFor(() => expect(mockedPut).toHaveBeenCalled())
    expect(mockedPut).toHaveBeenCalledWith('/api/admin/categories/1', { name: 'Databases', displayOrder: 40 })
  })

  it('still saves a genuine 0 typed for a new category', async () => {
    // The fallback must trigger only on an empty field, not treat every 0 as
    // "unset" — Networking's own order really is 0.
    const user = userEvent.setup()
    render(<CategoriesManager initial={categories} />)

    await user.click(await screen.findByRole('button', { name: 'Add Category' }))
    const dialog = screen.getByRole('dialog', { name: 'Add Category' })
    await user.type(within(dialog).getByLabelText(/^name/i), 'Storage')
    // Display Order already defaults to '0' in the Add form.
    await user.click(within(dialog).getByRole('button', { name: 'Save' }))

    await waitFor(() => expect(mockedPost).toHaveBeenCalled())
    expect(mockedPost).toHaveBeenCalledWith('/api/admin/categories', { name: 'Storage', displayOrder: 0 })
  })

  it('saves a newly typed order normally', async () => {
    const user = userEvent.setup()
    render(<CategoriesManager initial={categories} />)

    await user.click((await screen.findAllByRole('button', { name: 'Edit' }))[0])
    const dialog = screen.getByRole('dialog', { name: 'Edit Category' })
    const orderInput = within(dialog).getByLabelText(/display order/i)
    await user.clear(orderInput)
    await user.type(orderInput, '5')
    await user.click(within(dialog).getByRole('button', { name: 'Save' }))

    await waitFor(() => expect(mockedPut).toHaveBeenCalled())
    expect(mockedPut).toHaveBeenCalledWith('/api/admin/categories/1', { name: 'Databases', displayOrder: 5 })
  })

/**
 * The card, excluding the dialogs behind it.
 *
 * Every `Modal` renders whether or not it is open, and the delete dialog carries
 * its own copy of `error` — so a page-level query for the message matches twice
 * while only one of them is on screen.
 */
const listCard = () =>
  (screen.getByRole('heading', { name: 'Categories' }).closest('div.rounded-xl') as HTMLElement)

describe('CategoriesManager list', () => {
  it('lists what the server sent, in the order it sent it', async () => {
    // The display order decides the catalogue's own sidebar, so this list is a
    // preview of it — re-sorting here would show an order the shop does not use.
    render(<CategoriesManager initial={categories} />)

    const names = [...document.querySelectorAll('span.font-medium')].map((n) => n.textContent)
    expect(names).toEqual(['Databases', 'Networking'])
  })

  it('says why the list could not be loaded, rather than "no categories"', async () => {
    // "No categories yet" is a state an operator acts on by creating one, and
    // creating a duplicate of something that already exists is the cost of
    // getting this wrong (#415).
    // The server carries the reason over rather than the manager rediscovering
    // it for itself (#456).
    render(<CategoriesManager initial={[]} initialError="backend unreachable" />)

    expect(within(listCard()).getByText('backend unreachable')).toBeInTheDocument()
    expect(within(listCard()).queryByText('No categories yet.')).not.toBeInTheDocument()
  })

  it('says there are none when there really are none', async () => {
    render(<CategoriesManager initial={[]} />)
    expect(screen.getByText('No categories yet.')).toBeInTheDocument()
  })

  it('reloads after a create, so the new category appears', async () => {
    const user = userEvent.setup()
    render(<CategoriesManager initial={categories} />)
    await screen.findByText('Databases')
    mockedGet.mockClear()

    await user.click(screen.getByRole('button', { name: 'Add Category' }))
    const dialog = screen.getByRole('dialog', { name: 'Add Category' })
    await user.type(within(dialog).getByLabelText(/^name/i), 'Storage')
    await user.click(within(dialog).getByRole('button', { name: 'Save' }))

    await waitFor(() => expect(mockedGet).toHaveBeenCalledWith('/api/admin/categories'))
  })

  it('keeps the form open and says why when a create is refused', async () => {
    mockedPost.mockRejectedValue(new Error('a category with that name exists'))
    const user = userEvent.setup()
    render(<CategoriesManager initial={categories} />)
    await screen.findByText('Databases')

    await user.click(screen.getByRole('button', { name: 'Add Category' }))
    const dialog = screen.getByRole('dialog', { name: 'Add Category' })
    await user.type(within(dialog).getByLabelText(/^name/i), 'Databases')
    await user.click(within(dialog).getByRole('button', { name: 'Save' }))

    expect(await within(dialog).findByText('a category with that name exists')).toBeInTheDocument()
  })

  it('clears a load error once the list comes back', async () => {
    const user = userEvent.setup()
    render(<CategoriesManager initial={[]} initialError="backend unreachable" />)
    expect(within(listCard()).getByText('backend unreachable')).toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: 'Add Category' }))
    const dialog = screen.getByRole('dialog', { name: 'Add Category' })
    await user.type(within(dialog).getByLabelText(/^name/i), 'Storage')
    await user.click(within(dialog).getByRole('button', { name: 'Save' }))

    await waitFor(() =>
      expect(within(listCard()).queryByText('backend unreachable')).not.toBeInTheDocument(),
    )
  })
})
})
