import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'

vi.mock('@/lib/api', async () => {
  // `ApiError` is kept real: the component reads `code` off a refusal (#519) and
  // branches on it, so a mocked module without the class would not test that path.
  const actual = (await vi.importActual('@/lib/api')) as { ApiError: unknown }
  return { post: vi.fn(), ApiError: actual.ApiError }
})
const refresh = vi.fn()
vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh }) }))

import { DeployNow } from './DeployNow'
import { post, ApiError } from '@/lib/api'

const mockedPost = vi.mocked(post)

/**
 * Root releasing a scheduled order early (#330).
 *
 * Two things worth asserting: it refreshes rather than guessing the new status
 * locally — provisioning may have failed — and a refusal is shown in the
 * server's words, because only the server knows the sweep got there first.
 */
beforeEach(() => {
  vi.resetAllMocks()
  mockedPost.mockResolvedValue(undefined)
})

describe('DeployNow', () => {
  it('posts to the order and refreshes from the server', async () => {
    const user = userEvent.setup()
    render(<DeployNow orderId={412} />)

    await user.click(screen.getByRole('button', { name: /deploy now/i }))

    await waitFor(() => expect(mockedPost).toHaveBeenCalledWith('/api/orders/412/deploy-now', {}))
    // Not an optimistic local status: the provisioning it just started can fail.
    expect(refresh).toHaveBeenCalled()
  })

  it('shows the server’s refusal and does not refresh', async () => {
    const user = userEvent.setup()
    mockedPost.mockRejectedValue(new Error('Only a scheduled order can be deployed early; this one is provisioning'))
    render(<DeployNow orderId={412} />)

    await user.click(screen.getByRole('button', { name: /deploy now/i }))

    expect(await screen.findByText(/this one is provisioning/i)).toBeInTheDocument()
    expect(refresh).not.toHaveBeenCalled()
  })

  // Two clicks must not be two deployments; the claim would refuse the second,
  // but the button should not invite it.
  it('disables itself while the request is in flight', async () => {
    const user = userEvent.setup()
    let release: (() => void) | undefined
    mockedPost.mockImplementation(() => new Promise<undefined>((resolve) => { release = () => resolve(undefined) }))
    render(<DeployNow orderId={412} />)

    await user.click(screen.getByRole('button', { name: /deploy now/i }))

    await waitFor(() => expect(screen.getByRole('button')).toBeDisabled())
    release?.()
    await waitFor(() => expect(refresh).toHaveBeenCalled())
  })

  /*
   * Root's escape from a refusal (#519).
   *
   * The component is rendered for root alone, and root is the only role that can
   * act on a spent ceiling or a refused policy — so a refusal here, unlike on a
   * row, is always one this component can offer a waiver for.
   */
  it('offers the escape the refusal names, and sends it', async () => {
    const user = userEvent.setup()
    mockedPost.mockRejectedValueOnce(
      new ApiError(409, 'IT-4711 is over budget: 1400.00 of 1000.00 EUR committed', 'budget_blocked'),
    )
    render(<DeployNow orderId={412} />)

    await user.click(screen.getByRole('button', { name: /deploy now/i }))
    await screen.findByText(/over budget/i)
    await user.click(screen.getByRole('button', { name: /place anyway/i }))

    await waitFor(() =>
      expect(mockedPost).toHaveBeenLastCalledWith('/api/orders/412/deploy-now', {
        overrideBudget: true,
      }),
    )
  })

  it('offers nothing for a refusal that has no escape', async () => {
    // A stale claim, a CI that will not answer: a sentence, and no waiver that
    // would change it.
    const user = userEvent.setup()
    mockedPost.mockRejectedValue(
      new ApiError(409, 'Only a scheduled order can be deployed early', 'not_scheduled'),
    )
    render(<DeployNow orderId={412} />)

    await user.click(screen.getByRole('button', { name: /deploy now/i }))
    await screen.findByText(/only a scheduled order/i)

    expect(screen.queryByRole('button', { name: /place anyway/i })).not.toBeInTheDocument()
  })

  it('carries the budget waiver with the policy one when the second gate is uncovered', async () => {
    const user = userEvent.setup()
    mockedPost
      .mockRejectedValueOnce(new ApiError(409, 'IT-4711 is over budget', 'budget_blocked'))
      .mockRejectedValueOnce(new ApiError(409, 'rule: quota/vm-count', 'policy_denied'))
      .mockResolvedValueOnce(undefined)
    render(<DeployNow orderId={412} />)

    await user.click(screen.getByRole('button', { name: /deploy now/i }))
    await screen.findByText(/over budget/i)
    await user.click(screen.getByRole('button', { name: /place anyway/i }))
    await screen.findByText(/quota\/vm-count/i)
    await user.click(screen.getByRole('button', { name: /place anyway/i }))

    await waitFor(() =>
      expect(mockedPost).toHaveBeenLastCalledWith('/api/orders/412/deploy-now', {
        overrideBudget: true,
        overridePolicy: true,
      }),
    )
  })
})
