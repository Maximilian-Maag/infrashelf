import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type { Order } from '@infrashelf/types'

const refresh = vi.fn()
vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh }) }))
vi.mock('@/lib/api', async () => {
  // `ApiError` stays real: the row asks `instanceof` about what the server sent, so
  // a mocked module without the class would not exercise the branch at all.
  const actual = (await vi.importActual('@/lib/api')) as { ApiError: unknown }
  return { post: vi.fn(), ApiError: actual.ApiError }
})

import { ApprovalRow } from './ApprovalRow'
import { post, ApiError } from '@/lib/api'

const mockedPost = vi.mocked(post)

/**
 * The row where an order is approved or rejected (#245 — it had no test).
 *
 * Worth covering carefully rather than for the score: this is the screen where
 * one person's decision commits money and infrastructure on somebody else's
 * behalf. Two of the assertions below are about a rule the backend also
 * enforces — that nobody approves their own order — and the point of having it
 * here as well is that the viewer finds out before clicking rather than after.
 */
const order = (over: Partial<Order> = {}): Order =>
  ({
    id: 412,
    userId: 7,
    projectId: 1,
    productId: 2,
    environmentId: 3,
    status: 'pending',
    parameters: {},
    costCenterId: null,
    rejectionNote: null,
    pipelineId: [],
    createdAt: '2026-09-01T09:00:00.000Z',
    updatedAt: '2026-09-01T09:00:00.000Z',
    productName: 'Managed Nginx Gateway',
    projectName: 'Platform',
    userName: 'A Project Manager',
    ...over,
  }) as unknown as Order

beforeEach(() => {
  vi.resetAllMocks()
  mockedPost.mockResolvedValue(undefined)
})

describe('ApprovalRow', () => {
  it('approves through the approvals resource, not the orders one', async () => {
    const user = userEvent.setup()
    render(<ApprovalRow order={order()} currentUserId={99} />)

    await user.click(screen.getByRole('button', { name: /^approve$/i }))

    // The path is the assertion. It once pointed at /api/orders/:id/approve,
    // which the backend has never served — every approval failed, and the row
    // reported it as a generic error.
    await waitFor(() => expect(mockedPost).toHaveBeenCalledWith('/api/approvals/412/approve', {}))
  })

  /*
   * Issue #35. The backend refuses this too; the button is hidden so the viewer
   * learns it before committing to a click, and because an approval queue that
   * offers an impossible action on your own order reads as a broken queue.
   */
  it('offers no Approve button on the viewer’s own order', () => {
    render(<ApprovalRow order={order({ userId: 7 })} currentUserId={7} />)

    expect(screen.queryByRole('button', { name: /^approve$/i })).not.toBeInTheDocument()
    expect(screen.getByText(/cannot approve your own order/i)).toBeInTheDocument()
  })

  // Rejecting your own order is allowed — withdrawing a request you placed is
  // not the same act as approving it.
  it('still offers Reject on the viewer’s own order', () => {
    render(<ApprovalRow order={order({ userId: 7 })} currentUserId={7} />)
    expect(screen.getByRole('button', { name: /^reject$/i })).toBeInTheDocument()
  })

  it('asks for a note before rejecting, and sends it', async () => {
    const user = userEvent.setup()
    render(<ApprovalRow order={order()} currentUserId={99} />)

    await user.click(screen.getByRole('button', { name: /^reject$/i }))
    await user.type(screen.getByLabelText(/rejection note/i), 'Out of budget')
    await user.click(screen.getByRole('button', { name: /confirm/i }))

    // The note is the whole point of the second step: the orderer reads it.
    await waitFor(() => expect(mockedPost).toHaveBeenCalledWith('/api/approvals/412/reject', {
      rejectionNote: 'Out of budget',
    }))
  })

  /*
   * `required` on the textarea, so the browser refuses an empty submit. A
   * rejection with no reason is the one an orderer cannot act on.
   */
  it('will not reject with an empty note', async () => {
    const user = userEvent.setup()
    render(<ApprovalRow order={order()} currentUserId={99} />)

    await user.click(screen.getByRole('button', { name: /^reject$/i }))
    await user.click(screen.getByRole('button', { name: /confirm/i }))

    expect(mockedPost).not.toHaveBeenCalled()
  })

  it('disappears once the decision is made, so it cannot be taken twice', async () => {
    const user = userEvent.setup()
    render(<ApprovalRow order={order()} currentUserId={99} />)

    await user.click(screen.getByRole('button', { name: /^approve$/i }))

    // The row removes itself rather than waiting for the refresh to arrive: a
    // second click on a decided order is a 400 the viewer cannot explain.
    await waitFor(() => expect(screen.queryByRole('button', { name: /^approve$/i })).not.toBeInTheDocument())
    expect(refresh).toHaveBeenCalled()
  })

  /*
   * A failed decision must NOT remove the row. The order is still pending, and
   * a row that vanished would tell the approver the opposite of the truth.
   */
  it('keeps the row and shows why when the approval is refused', async () => {
    const user = userEvent.setup()
    mockedPost.mockRejectedValue(new Error('Order is not pending'))
    render(<ApprovalRow order={order()} currentUserId={99} />)

    await user.click(screen.getByRole('button', { name: /^approve$/i }))

    expect(await screen.findByText(/order is not pending/i)).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /^approve$/i })).toBeInTheDocument()
    expect(refresh).not.toHaveBeenCalled()
  })

  it('keeps the rejection form open when the rejection is refused', async () => {
    const user = userEvent.setup()
    mockedPost.mockRejectedValue(new Error('Order is not pending'))
    render(<ApprovalRow order={order()} currentUserId={99} />)

    await user.click(screen.getByRole('button', { name: /^reject$/i }))
    await user.type(screen.getByLabelText(/rejection note/i), 'No')
    await user.click(screen.getByRole('button', { name: /confirm/i }))

    expect(await screen.findByText(/order is not pending/i)).toBeInTheDocument()
    // The typed note survives, so the approver does not write it twice.
    expect(screen.getByLabelText(/rejection note/i)).toHaveValue('No')
  })

  /*
   * The reject path removes the row too. Only the approve path was covered, and
   * a reject that leaves the row behind lets the same order be rejected twice —
   * the second attempt being a 400 the approver cannot explain.
   */
  it('disappears after a rejection as well, not only an approval', async () => {
    const user = userEvent.setup()
    render(<ApprovalRow order={order()} currentUserId={99} />)

    await user.click(screen.getByRole('button', { name: /^reject$/i }))
    await user.type(screen.getByLabelText(/rejection note/i), 'Out of budget')
    await user.click(screen.getByRole('button', { name: /confirm/i }))

    await waitFor(() => expect(screen.queryByRole('button', { name: /^reject$/i })).not.toBeInTheDocument())
    // And the list is re-read, or the decided order sits there until a reload.
    expect(refresh).toHaveBeenCalled()
  })

  /*
   * Disabled in flight, both paths. Without it a double click sends two
   * decisions for one order; the backend refuses the second, so what the
   * approver sees is an error immediately after succeeding.
   */
  it('disables the buttons while a decision is in flight', async () => {
    const user = userEvent.setup()
    let release: (() => void) | undefined
    mockedPost.mockImplementation(() => new Promise((resolve) => { release = () => resolve(undefined) }))
    render(<ApprovalRow order={order()} currentUserId={99} />)

    await user.click(screen.getByRole('button', { name: /^approve$/i }))

    await waitFor(() => expect(screen.getByRole('button', { name: /^approve$/i })).toBeDisabled())
    expect(screen.getByRole('button', { name: /^reject$/i })).toBeDisabled()
    release?.()
  })

  /*
   * And enabled again afterwards. A refusal that left the buttons disabled would
   * strand the approver on a row they can see, cannot act on, and cannot clear
   * without reloading.
   */
  it('re-enables the buttons after a refusal, so the decision can be retried', async () => {
    const user = userEvent.setup()
    mockedPost.mockRejectedValue(new Error('CI unreachable'))
    render(<ApprovalRow order={order()} currentUserId={99} />)

    await user.click(screen.getByRole('button', { name: /^approve$/i }))

    expect(await screen.findByText(/ci unreachable/i)).toBeInTheDocument()
    await waitFor(() => expect(screen.getByRole('button', { name: /^approve$/i })).toBeEnabled())
  })

  // An order whose product has since been renamed away still has to be
  // identifiable; `??` falls back to the id, `&&` would render nothing.
  it('names the product by id when the join gave no name', () => {
    render(<ApprovalRow order={order({ productName: undefined })} currentUserId={99} />)
    expect(screen.getByText(/Product #2/)).toBeInTheDocument()
  })

  /*
   * What the row SAYS about the order, which is what the decision is made on.
   *
   * These are display conditionals, and getting one inverted is not cosmetic:
   * a trial badge on a permanent order, or a missing one on a trial, changes
   * what the approver believes they are agreeing to pay for and for how long.
   */
  it('badges a trial, and only a trial', () => {
    const { unmount } = render(<ApprovalRow order={order({ isTrial: true })} currentUserId={99} />)
    expect(screen.getByText(/trial/i)).toBeInTheDocument()
    unmount()

    render(<ApprovalRow order={order({ isTrial: false })} currentUserId={99} />)
    expect(screen.queryByText(/trial/i)).not.toBeInTheDocument()
  })

  // One is the default and says nothing; twenty is the number the approver
  // needs to see before agreeing to it.
  it('shows the quantity only when it is more than one', () => {
    const { unmount } = render(<ApprovalRow order={order({ quantity: 1 })} currentUserId={99} />)
    expect(screen.queryByText(/quantity/i)).not.toBeInTheDocument()
    unmount()

    render(<ApprovalRow order={order({ quantity: 20 })} currentUserId={99} />)
    expect(screen.getByText(/quantity/i)).toBeInTheDocument()
    expect(screen.getByText(/20/)).toBeInTheDocument()
  })

  it('shows the size only when the offering has one', () => {
    const { unmount } = render(<ApprovalRow order={order({ sizeCode: null })} currentUserId={99} />)
    expect(screen.queryByText(/size/i)).not.toBeInTheDocument()
    unmount()

    render(<ApprovalRow order={order({ sizeCode: 'large' })} currentUserId={99} />)
    expect(screen.getByText(/large/)).toBeInTheDocument()
  })

  // One row per order on this page, so a fixed id would tie every label to the
  // first textarea and typing into the second would focus the wrong one.
  it('gives each row’s note field an id of its own', () => {
    const { container } = render(
      <>
        <ApprovalRow order={order({ id: 1 })} currentUserId={99} />
        <ApprovalRow order={order({ id: 2 })} currentUserId={99} />
      </>,
    )
    expect(container.querySelectorAll('[data-order-id]')).toHaveLength(2)
    expect(container.querySelector('[data-order-id="1"]')).toBeTruthy()
    expect(container.querySelector('[data-order-id="2"]')).toBeTruthy()
  })
})

/**
 * The approver's half of #325.
 *
 * The gate runs when the approval is GRANTED, so without this the approver
 * learns about a `block` budget only by clicking Approve and being refused, and
 * about a `warn` one not at all.
 */
describe('ApprovalRow budget notice (#325)', () => {
  const budget = (over: Partial<NonNullable<Order['budget']>> = {}) => ({
    costCenterId: 3,
    costCenterLabel: 'IT-4711 — Platform',
    amount: 1_000,
    currency: 'EUR',
    period: 'total' as const,
    behaviour: 'block' as const,
    committed: 1_400,
    remaining: -400,
    exhausted: true,
    unconverted: [],
    unpriced: 0,
    ...over,
  })

  it('says what is spent, against which cost centre', async () => {
    render(<ApprovalRow order={order({ budget: budget() })} currentUserId={99} />)
    expect(await screen.findByText(/IT-4711 — Platform/)).toBeInTheDocument()
    expect(screen.getByText(/1400\.00 \/ 1000\.00 EUR/)).toBeInTheDocument()
  })

  it('distinguishes a block from a warn, because approving means different things', () => {
    const { unmount } = render(<ApprovalRow order={order({ budget: budget() })} currentUserId={99} />)
    expect(screen.getByText(/refused at the gate/i)).toBeInTheDocument()
    unmount()

    render(<ApprovalRow order={order({ budget: budget({ behaviour: 'warn' }) })} currentUserId={99} />)
    expect(screen.getByText(/goes through and is recorded/i)).toBeInTheDocument()
  })

  it('stays quiet while the budget still has room', () => {
    // A line on every row would be read past within a day. The decision only
    // changes when there is none left.
    render(
      <ApprovalRow
        order={order({ budget: budget({ committed: 100, remaining: 900, exhausted: false }) })}
        currentUserId={99}
      />,
    )
    expect(screen.queryByText(/Over budget/i)).not.toBeInTheDocument()
  })

  it('stays quiet when the cost centre has no budget at all', () => {
    render(<ApprovalRow order={order({ budget: null })} currentUserId={99} />)
    expect(screen.queryByText(/Over budget/i)).not.toBeInTheDocument()
  })
})

/*
 * #514. The escapes existed on the ordering path (#509) and, at the commit, only
 * in the service signature: `ApprovalRow` posted an empty body and offered
 * nothing after a refusal, so a root operator refused at the gate — on the screen
 * where the money is actually spent — had no way past it.
 */
describe('ApprovalRow offers root the escapes from a refusal (#514)', () => {
  it('offers the policy escape, and sends overridePolicy on the retry', async () => {
    const user = userEvent.setup()
    mockedPost.mockRejectedValueOnce(new ApiError(409, 'Refused by rule quota/vm-count.', 'policy_denied'))
    render(<ApprovalRow order={order()} currentUserId={99} role="root" />)

    await user.click(screen.getByRole('button', { name: /^approve$/i }))

    expect(await screen.findByRole('alert')).toHaveTextContent(/quota\/vm-count/i)
    await user.click(screen.getByRole('button', { name: /place anyway/i }))

    await waitFor(() => expect(mockedPost).toHaveBeenCalledTimes(2))
    expect(mockedPost.mock.calls[1]).toEqual([
      '/api/approvals/412/approve',
      { overridePolicy: true },
    ])
  })

  it('offers the budget escape for a budget refusal, and not the policy one', async () => {
    // The two are separate rights. Sending both would waive whatever the server
    // asks next as well as what it refused.
    const user = userEvent.setup()
    mockedPost.mockRejectedValueOnce(new ApiError(409, 'Over budget: 600.00 of 100.00 committed in total.', 'budget_blocked'))
    render(<ApprovalRow order={order()} currentUserId={99} role="root" />)

    await user.click(screen.getByRole('button', { name: /^approve$/i }))
    await user.click(await screen.findByRole('button', { name: /place anyway/i }))

    await waitFor(() => expect(mockedPost).toHaveBeenCalledTimes(2))
    expect(mockedPost.mock.calls[1][1]).toEqual({ overrideBudget: true })
  })

  it('carries an earlier waiver into the next retry, so the chain can finish', async () => {
    // Waiving the policy can uncover a budget refusal underneath it, because the
    // policy gate is asked first. Retrying with only the flag in hand would drop
    // the waiver already made and the two would alternate for ever.
    const user = userEvent.setup()
    mockedPost.mockRejectedValueOnce(new ApiError(409, 'Refused by rule quota/vm-count.', 'policy_denied'))
    mockedPost.mockRejectedValueOnce(new ApiError(409, 'Over budget.', 'budget_blocked'))
    render(<ApprovalRow order={order()} currentUserId={99} role="root" />)

    await user.click(screen.getByRole('button', { name: /^approve$/i }))
    await user.click(await screen.findByRole('button', { name: /place anyway/i }))
    // Waited for by its MESSAGE: the control is cleared and re-set across a retry,
    // so finding the button alone could click the previous refusal's, still
    // disabled, and pass nothing on.
    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent(/over budget/i))
    await user.click(screen.getByRole('button', { name: /place anyway/i }))

    await waitFor(() => expect(mockedPost).toHaveBeenCalledTimes(3))
    expect(mockedPost.mock.calls[2][1]).toEqual({ overridePolicy: true, overrideBudget: true })
  })

  it('offers an admin nothing, even for the same refusal', async () => {
    // The row decides what to SHOW; the backend re-checks the role. Without this
    // the queue would advertise a control that comes back 409 for an admin.
    const user = userEvent.setup()
    mockedPost.mockRejectedValueOnce(new ApiError(409, 'Over budget.', 'budget_blocked'))
    render(<ApprovalRow order={order()} currentUserId={99} role="admin" />)

    await user.click(screen.getByRole('button', { name: /^approve$/i }))

    expect(await screen.findByRole('alert')).toHaveTextContent(/over budget/i)
    expect(screen.queryByRole('button', { name: /place anyway/i })).not.toBeInTheDocument()
  })

  it('offers nothing for a refusal it has no escape for', async () => {
    const user = userEvent.setup()
    mockedPost.mockRejectedValueOnce(new ApiError(409, 'Order is not pending'))
    render(<ApprovalRow order={order()} currentUserId={99} role="root" />)

    await user.click(screen.getByRole('button', { name: /^approve$/i }))

    expect(await screen.findByRole('alert')).toHaveTextContent(/not pending/i)
    expect(screen.queryByRole('button', { name: /place anyway/i })).not.toBeInTheDocument()
  })

  it('sends no overrides on an ordinary approval', async () => {
    // The body every existing caller posts, unchanged: an empty object, not an
    // object full of undefined flags.
    const user = userEvent.setup()
    render(<ApprovalRow order={order()} currentUserId={99} role="root" />)

    await user.click(screen.getByRole('button', { name: /^approve$/i }))

    expect(mockedPost).toHaveBeenCalledWith('/api/approvals/412/approve', {})
  })
})
