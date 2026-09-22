import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type { CartItem, Project, CostCenter, Parameter, CheckoutResponse } from '@infrashelf/types'

const push = vi.fn()
const refresh = vi.fn()

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push, refresh }),
}))

vi.mock('@/lib/api', () => ({ get: vi.fn(), post: vi.fn(), del: vi.fn() }))

import { CartView } from './CartView'
import { get, post, del } from '@/lib/api'

const mockedGet = vi.mocked(get)
const mockedPost = vi.mocked(post)
const mockedDel = vi.mocked(del)

const item = (over?: Partial<CartItem>): CartItem => ({
  id: 1,
  productId: 10,
  environmentId: 2,
  parameters: {},
  createdAt: '2026-06-01T10:00:00.000Z',
  productName: 'Nginx Gateway',
  environmentName: 'AWS Frankfurt',
  price: '10.00',
  currency: 'EUR',
  stillOffered: true,
  ...over,
})

const projects: Project[] = [
  { id: 5, name: 'Webshop', description: '', ownerId: 1, costCenterId: null, createdAt: '' },
  { id: 6, name: 'Billing', description: '', ownerId: 1, costCenterId: null, createdAt: '' },
]

const costCenters: CostCenter[] = [{ id: 20, code: 'CC-1', name: 'Platform', active: true }]

const param = (over?: Partial<Parameter>): Parameter => ({
  id: 1,
  scope: 'product',
  scopeId: 10,
  environmentId: null,
  name: 'HOST',
  label: 'Hostname',
  type: 'string',
  description: '',
  defaultValue: '',
  required: false,
  sensitive: false,
  sizeValues: {},
  ...over,
})

const renderCart = (items: CartItem[], p: Project[] = projects) =>
  render(
    <CartView
      initialItems={items}
      projects={p}
      costCenters={costCenters}
     
      lang="en"
      exchangeRates={{}}
      localeCurrency="EUR"
    />,
  )

beforeEach(() => {
  push.mockReset()
  refresh.mockReset()
  mockedGet.mockReset().mockResolvedValue({ parameters: [] } as never)
  mockedPost.mockReset().mockResolvedValue({ orderIds: [1], failed: [] } as never)
  mockedDel.mockReset().mockResolvedValue(undefined as never)
})

describe('CartView', () => {
  it('shows an empty state rather than a checkout form', () => {
    renderCart([])
    expect(screen.getByText(/your cart is empty/i)).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /check out/i })).not.toBeInTheDocument()
  })

  it('renders one row per item with product, environment and price', () => {
    renderCart([item(), item({ id: 2, productName: 'Managed Postgres', price: '20.00' })])

    const first = screen.getByTestId('cart-item-1')
    expect(within(first).getByText('Nginx Gateway')).toBeInTheDocument()
    expect(within(first).getByText('AWS Frankfurt')).toBeInTheDocument()
    // The price is its own element at the right of the row, as in a shop cart.
    expect(within(first).getByText('10.00 EUR')).toBeInTheDocument()
    expect(screen.getByTestId('cart-item-2')).toBeInTheDocument()
  })

  it("totals the cart in the viewer's currency", () => {
    renderCart([item(), item({ id: 2, productName: 'Managed Postgres', price: '20.00' })])
    expect(screen.getByText(/subtotal \(2 items\)/i)).toBeInTheDocument()
    expect(screen.getByText('30.00 EUR')).toBeInTheDocument()
  })

  it('reports a price it cannot convert instead of adding it at par', () => {
    // No rate is stored for SEK here, and counting 900 SEK as 900 EUR would
    // overstate the subtotal by whatever the real rate happens to be.
    renderCart([item(), item({ id: 2, price: '900.00', currency: 'SEK' })])
    // The convertible item is the whole subtotal; the rest is reported beside it.
    expect(within(screen.getByTestId('cart-item-1')).getByText('10.00 EUR')).toBeInTheDocument()
    expect(screen.getByText(/subtotal \(2 items\)/i)).toBeInTheDocument()
    expect(screen.getByText(/900.00 SEK/)).toBeInTheDocument()
  })

  it('shows no subtotal panel for an empty cart', () => {
    renderCart([])
    expect(screen.queryByText(/subtotal/i)).not.toBeInTheDocument()
  })

  it('preselects the only project, and asks when there are several', () => {
    const { unmount } = renderCart([item()], [projects[0]])
    expect(screen.getByLabelText(/^project\s*\*?$/i)).toHaveValue('5')
    unmount()

    renderCart([item()])
    expect(screen.getByLabelText(/^project\s*\*?$/i)).toHaveValue('')
  })

  it('will not check out until a project is chosen', async () => {
    const user = userEvent.setup()
    renderCart([item()])

    expect(screen.getByRole('button', { name: /check out/i })).toBeDisabled()
    await user.selectOptions(screen.getByLabelText(/^project\s*\*?$/i), '5')
    expect(screen.getByRole('button', { name: /check out/i })).toBeEnabled()
  })

  it('blocks checkout while an item is no longer offered, and says why', () => {
    // Checking out would fail the validation gate anyway; better to say so first.
    renderCart([item({ stillOffered: false })], [projects[0]])
    expect(screen.getByText(/no longer offered/i)).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /check out/i })).toBeDisabled()
  })

  it('loads the parameter definitions per item', async () => {
    mockedGet.mockResolvedValue({ parameters: [param()] } as never)
    renderCart([item(), item({ id: 2, productId: 11, environmentId: 3 })])

    // Definitions depend on the product AND environment pair, so one fetch each.
    await waitFor(() => expect(mockedGet).toHaveBeenCalledTimes(2))
    expect(mockedGet).toHaveBeenCalledWith('/api/catalog/10?lang=en&environmentId=2')
    expect(mockedGet).toHaveBeenCalledWith('/api/catalog/11?lang=en&environmentId=3')
  })

  it('renders a parameter field per applicable definition', async () => {
    mockedGet.mockResolvedValue({ parameters: [param({ label: 'Hostname' })] } as never)
    renderCart([item()], [projects[0]])

    expect(await screen.findByLabelText(/hostname/i)).toBeInTheDocument()
  })

  it('excludes a definition scoped to another environment', async () => {
    mockedGet.mockResolvedValue({
      parameters: [param({ label: 'Mine', environmentId: 2 }), param({ id: 2, name: 'OTHER', label: 'Theirs', environmentId: 99 })],
    } as never)
    renderCart([item()], [projects[0]])

    expect(await screen.findByLabelText(/mine/i)).toBeInTheDocument()
    expect(screen.queryByLabelText(/theirs/i)).not.toBeInTheDocument()
  })

  it('still lets checkout proceed when the definitions fail to load', async () => {
    // The server validates regardless, so an unlabelled card beats a dead cart.
    mockedGet.mockRejectedValue(new Error('offline'))
    renderCart([item()], [projects[0]])

    await waitFor(() => expect(mockedGet).toHaveBeenCalled())
    expect(screen.getByRole('button', { name: /check out/i })).toBeEnabled()
  })

  it('submits every item with its own parameters and cost centre', async () => {
    const user = userEvent.setup()
    mockedGet.mockResolvedValue({ parameters: [param()] } as never)
    renderCart([item(), item({ id: 2, productId: 11 })], [projects[0]])

    const first = screen.getByTestId('cart-item-1')
    await user.type(await within(first).findByLabelText(/hostname/i), 'web-01')
    await user.selectOptions(within(first).getByLabelText(/cost center/i), '20')
    await user.click(screen.getByRole('button', { name: /check out/i }))

    await waitFor(() => expect(mockedPost).toHaveBeenCalled())
    const body = mockedPost.mock.calls[0][1] as {
      projectId: number
      items: { cartItemId: number; parameters: Record<string, string>; costCenterId?: number }[]
    }
    expect(body.projectId).toBe(5)
    expect(body.items).toHaveLength(2)
    expect(body.items[0]).toMatchObject({ cartItemId: 1, parameters: { HOST: 'web-01' }, costCenterId: 20 })
    // The second item got no cost centre, so none is sent for it.
    expect(body.items[1].costCenterId).toBeUndefined()
  })

  it('merges a definition default in for an untouched parameter', async () => {
    const user = userEvent.setup()
    mockedGet.mockResolvedValue({ parameters: [param({ defaultValue: 'eu-central-1' })] } as never)
    renderCart([item()], [projects[0]])

    await screen.findByLabelText(/hostname/i)
    await user.click(screen.getByRole('button', { name: /check out/i }))

    await waitFor(() => expect(mockedPost).toHaveBeenCalled())
    const body = mockedPost.mock.calls[0][1] as { items: { parameters: Record<string, string> }[] }
    expect(body.items[0].parameters).toEqual({ HOST: 'eu-central-1' })
  })

  it('goes to the orders list on a clean checkout', async () => {
    const user = userEvent.setup()
    renderCart([item()], [projects[0]])

    await user.click(screen.getByRole('button', { name: /check out/i }))
    await waitFor(() => expect(push).toHaveBeenCalledWith('/orders'))
  })

  it('holds on the over-budget warning instead of navigating away from it (#325)', async () => {
    // The orders exist and the cart is empty either way — the only difference is
    // whether the person who placed them is told. Pushing to /orders here would
    // replace the message with rows that look like every other order, which is
    // the outcome a `warn` budget exists to prevent.
    const user = userEvent.setup()
    mockedPost.mockResolvedValue({
      orderIds: [31],
      failed: [],
      warnings: [{ orderId: 31, message: 'IT-4711 — Platform is over budget: 1400.00 of 1000.00 EUR committed' }],
    } as CheckoutResponse as never)
    renderCart([item()], [projects[0]])

    await user.click(screen.getByRole('button', { name: /check out/i }))

    expect(await screen.findByText(/went through with the cost centre over budget/i)).toBeInTheDocument()
    expect(screen.getByText(/#31/)).toBeInTheDocument()
    expect(screen.getByText(/1400\.00 of 1000\.00 EUR/)).toBeInTheDocument()
    expect(push).not.toHaveBeenCalled()
    // The orders were placed, so the cart really is empty — the notice is not a
    // failure to retry.
    expect(screen.queryByTestId('cart-item-1')).not.toBeInTheDocument()
    // And there is still a way on from here.
    expect(screen.getByRole('link', { name: /orders/i })).toHaveAttribute('href', '/orders')
  })

  it('holds on an order policy sent to the approvals queue (#110)', async () => {
    /*
     * The one case where a shopper has to be told something did not happen as
     * they expected: an admin's order provisions the moment it is placed, and a
     * `needs-approval` rule stops that. Navigating to /orders would show a row
     * that looks like every other order and says nothing about why it is not
     * building.
     */
    const user = userEvent.setup()
    mockedPost.mockResolvedValue({
      orderIds: [41],
      failed: [],
      approvalRequired: [
        { orderId: 41, message: 'Production needs a second pair of eyes. (rule: sod/production)' },
      ],
    } as CheckoutResponse as never)
    renderCart([item()], [projects[0]])

    await user.click(screen.getByRole('button', { name: /check out/i }))

    expect(await screen.findByText(/needs approval before it is provisioned/i)).toBeInTheDocument()
    expect(screen.getByText(/#41/)).toBeInTheDocument()
    expect(screen.getByText(/sod\/production/)).toBeInTheDocument()
    expect(push).not.toHaveBeenCalled()
    // And the queue they can go and look at is one click away (WCAG 2.4.4 is
    // satisfied by the nav, but a notice about a queue that does not link to it
    // is a notice that ends in a dead end).
    expect(screen.getByRole('link', { name: /approvals/i })).toHaveAttribute('href', '/approvals')
  })

  it('navigates as usual when no order went over budget', async () => {
    const user = userEvent.setup()
    mockedPost.mockResolvedValue({ orderIds: [31], failed: [], warnings: [] } as CheckoutResponse as never)
    renderCart([item()], [projects[0]])

    await user.click(screen.getByRole('button', { name: /check out/i }))
    await waitFor(() => expect(push).toHaveBeenCalledWith('/orders'))
  })

  it('keeps the budget warning when some items also failed (#325)', async () => {
    // Both at once is the case that was lost: the failure branch returned before
    // the warnings were recorded, so the orders that DID get placed — the ones
    // somebody needs telling about — went unmentioned.
    const user = userEvent.setup()
    mockedPost.mockResolvedValue({
      orderIds: [31],
      failed: [{ cartItemId: 2, message: 'CI unreachable' }],
      warnings: [{ orderId: 31, message: 'IT-4711 — Platform is over budget: 1400.00 of 1000.00 EUR committed' }],
    } as CheckoutResponse as never)
    renderCart([item(), item({ id: 2 })], [projects[0]])

    await user.click(screen.getByRole('button', { name: /check out/i }))

    expect(await screen.findByText(/some items were not ordered/i)).toBeInTheDocument()
    expect(screen.getByText(/CI unreachable/)).toBeInTheDocument()
    // And the warning for the order that went through, alongside it.
    expect(screen.getByText(/went through with the cost centre over budget/i)).toBeInTheDocument()
    expect(screen.getByText(/1400\.00 of 1000\.00 EUR/)).toBeInTheDocument()
    expect(push).not.toHaveBeenCalled()
  })

  it('keeps the failed items and names them on a partial checkout', async () => {
    // Some pipelines may already be running, so this is not an error to retry
    // wholesale — the user needs to know which items are still theirs to deal with.
    const user = userEvent.setup()
    mockedPost.mockResolvedValue({
      orderIds: [1],
      failed: [{ cartItemId: 2, message: 'CI unreachable' }],
    } as CheckoutResponse as never)
    renderCart([item(), item({ id: 2 })], [projects[0]])

    await user.click(screen.getByRole('button', { name: /check out/i }))

    expect(await screen.findByText(/some items were not ordered/i)).toBeInTheDocument()
    expect(screen.getByText(/CI unreachable/)).toBeInTheDocument()
    // Only the failed item remains.
    expect(screen.queryByTestId('cart-item-1')).not.toBeInTheDocument()
    expect(screen.getByTestId('cart-item-2')).toBeInTheDocument()
    expect(push).not.toHaveBeenCalled()
  })

  it('surfaces the validation gate\'s refusal without emptying the cart', async () => {
    const user = userEvent.setup()
    mockedPost.mockRejectedValue(new Error('Nothing was ordered. 1 item(s) need attention: #2: Missing required parameter: SIZE'))
    renderCart([item(), item({ id: 2 })], [projects[0]])

    await user.click(screen.getByRole('button', { name: /check out/i }))

    expect(await screen.findByRole('alert')).toHaveTextContent(/nothing was ordered/i)
    expect(screen.getByTestId('cart-item-1')).toBeInTheDocument()
    expect(screen.getByTestId('cart-item-2')).toBeInTheDocument()
  })

  it('removes one item', async () => {
    const user = userEvent.setup()
    renderCart([item(), item({ id: 2 })])

    await user.click(within(screen.getByTestId('cart-item-1')).getByRole('button', { name: /remove/i }))
    await waitFor(() => expect(mockedDel).toHaveBeenCalledWith('/api/cart/1'))
    await waitFor(() => expect(screen.queryByTestId('cart-item-1')).not.toBeInTheDocument())
    expect(screen.getByTestId('cart-item-2')).toBeInTheDocument()
  })

  it('names the line inside its remove control, not just "Remove" (#501)', () => {
    // A screen-reader user listing the buttons on this page would otherwise hear
    // "Remove, Remove, Remove" with nothing to choose between them (WCAG 2.4.9).
    // The accessible name keeps the visible word in front of it, so the label a
    // sighted user reads is still what the control is called (WCAG 2.5.3).
    renderCart([item(), item({ id: 2, productName: 'Managed Postgres' })])

    const first = within(screen.getByTestId('cart-item-1')).getByRole('button', {
      name: 'Remove: Nginx Gateway',
    })
    expect(first).toHaveTextContent('Remove')
    expect(
      within(screen.getByTestId('cart-item-2')).getByRole('button', { name: 'Remove: Managed Postgres' }),
    ).toBeInTheDocument()
  })

  it('puts the remove control with the price at the row edge, and keeps it a button (#501)', () => {
    // Where the issue found it: mid-row under the quantity field, with its own
    // horizontal padding zeroed so it did not read as a control at all. Every
    // shop puts per-line removal at the row's trailing edge, and that is where
    // the eye goes — the price block is that edge here.
    renderCart([item()])
    const row = screen.getByTestId('cart-item-1')

    const price = within(row).getByText('10.00 EUR')
    const remove = within(row).getByRole('button', { name: /^remove:/i })

    // The same block as the price — the row's trailing edge — and not the middle
    // of the row, which is where the quantity field and the rest of the form are.
    expect(remove.parentElement).toContainElement(price)
    expect(within(row).getByLabelText(/quantity/i).closest('div')).not.toContainElement(remove)
    expect(remove.style.paddingLeft).toBe('')
    expect(remove.style.paddingRight).toBe('')
    // And it still only removes the line — the quantity control is untouched.
    expect(within(row).getByLabelText(/quantity/i)).toBeInTheDocument()
  })

  it('empties the cart', async () => {
    const user = userEvent.setup()
    renderCart([item(), item({ id: 2 })])

    await user.click(screen.getByRole('button', { name: /empty cart/i }))
    await waitFor(() => expect(mockedDel).toHaveBeenCalledWith('/api/cart'))
    expect(await screen.findByText(/your cart is empty/i)).toBeInTheDocument()
  })

  it('keeps the item when removing it fails', async () => {
    const user = userEvent.setup()
    mockedDel.mockRejectedValue(new Error('offline'))
    renderCart([item()])

    await user.click(within(screen.getByTestId('cart-item-1')).getByRole('button', { name: /remove/i }))
    expect(await screen.findByRole('alert')).toBeInTheDocument()
    expect(screen.getByTestId('cart-item-1')).toBeInTheDocument()
  })

  it('shows the item count on the checkout button', () => {
    renderCart([item(), item({ id: 2 }), item({ id: 3 })], [projects[0]])
    expect(screen.getByRole('button', { name: /check out \(3\)/i })).toBeInTheDocument()
  })
})
