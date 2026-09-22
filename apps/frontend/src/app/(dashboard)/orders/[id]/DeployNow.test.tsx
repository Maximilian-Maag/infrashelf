import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'

vi.mock('@/lib/api', async () => {
  // `ApiError` stays real: the button asks `instanceof` about what the server
  // sent, so a mocked module without the class would not exercise the branch.
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
   * #519. The escapes reached the approvals queue (#514) and the order form
   * (#509) and stopped short of this path — the one where the order is approved,
   * waiting for a window, and wanted now. The control offers the waiver this
   * refusal names, and only root can render it at all: the order page shows
   * `DeployNow` for root on a scheduled order, and the service checks the session
   * again, so the flag here is a request and never the waiver.
   */
  describe('the escapes from a refusal (#519)', () => {
    const refusal = (code: string) =>
      new ApiError(
        409,
        code === 'budget_blocked'
          ? 'Deploying this now would put the cost centre 120.00 EUR over its budget'
          : 'Refused by rule quota/vm-count.',
        code,
      )

    it('offers the budget escape for a budget refusal, and sends only that flag', async () => {
      const user = userEvent.setup()
      mockedPost.mockRejectedValueOnce(refusal('budget_blocked'))
      render(<DeployNow orderId={412} />)

      await user.click(screen.getByRole('button', { name: /deploy now/i }))
      await user.click(await screen.findByRole('button', { name: /deploy anyway/i }))

      await waitFor(() =>
        expect(mockedPost).toHaveBeenLastCalledWith('/api/orders/412/deploy-now', { overrideBudget: true }),
      )
      // The waiver gets what it came for, and the page follows the server.
      expect(refresh).toHaveBeenCalled()
    })

    it('offers the policy escape for a policy refusal', async () => {
      const user = userEvent.setup()
      mockedPost.mockRejectedValueOnce(refusal('policy_denied'))
      render(<DeployNow orderId={412} />)

      await user.click(screen.getByRole('button', { name: /deploy now/i }))
      await user.click(await screen.findByRole('button', { name: /deploy anyway/i }))

      await waitFor(() =>
        expect(mockedPost).toHaveBeenLastCalledWith('/api/orders/412/deploy-now', { overridePolicy: true }),
      )
    })

    it('carries an earlier waiver into the next retry, so the chain can finish', async () => {
      // The budget gate is asked before the policy one, so waiving the budget can
      // uncover a policy refusal underneath it (#514, #515). One flag at a time
      // would alternate between the two for ever.
      const user = userEvent.setup()
      mockedPost.mockRejectedValueOnce(refusal('budget_blocked'))
      mockedPost.mockRejectedValueOnce(refusal('policy_denied'))
      render(<DeployNow orderId={412} />)

      await user.click(screen.getByRole('button', { name: /deploy now/i }))
      await user.click(await screen.findByRole('button', { name: /deploy anyway/i }))
      // Waited for by its MESSAGE: the control is cleared and re-set across a retry,
      // so finding the button alone could click the previous refusal's, still
      // disabled, and pass nothing on.
      await waitFor(() =>
        expect(screen.getByRole('alert')).toHaveTextContent(/quota\/vm-count/i),
      )
      await user.click(screen.getByRole('button', { name: /deploy anyway/i }))

      await waitFor(() => expect(mockedPost).toHaveBeenCalledTimes(3))
      expect(mockedPost.mock.calls[2][1]).toEqual({ overrideBudget: true, overridePolicy: true })
    })

    it('clears the escape once the deployment goes through with it', async () => {
      const user = userEvent.setup()
      mockedPost.mockRejectedValueOnce(refusal('budget_blocked'))
      render(<DeployNow orderId={412} />)

      await user.click(screen.getByRole('button', { name: /deploy now/i }))
      await user.click(await screen.findByRole('button', { name: /deploy anyway/i }))
      await waitFor(() => expect(refresh).toHaveBeenCalled())

      // A later refuse from the next order must not inherit this waiver.
      mockedPost.mockRejectedValueOnce(refusal('budget_blocked'))
      await user.click(screen.getByRole('button', { name: /deploy now/i }))

      await waitFor(() => expect(mockedPost).toHaveBeenLastCalledWith('/api/orders/412/deploy-now', {}))
    })

    it('offers nothing for a refusal with no code it knows', async () => {
      // A 409 whose prose this control cannot classify is not an invitation to
      // guess at a flag: the server would refuse the guess anyway.
      const user = userEvent.setup()
      mockedPost.mockRejectedValueOnce(new Error('Only a scheduled order can be deployed early'))
      render(<DeployNow orderId={412} />)

      await user.click(screen.getByRole('button', { name: /deploy now/i }))

      expect(await screen.findByText(/only a scheduled order/i)).toBeInTheDocument()
      expect(screen.queryByRole('button', { name: /deploy anyway/i })).not.toBeInTheDocument()
    })
  })
})
