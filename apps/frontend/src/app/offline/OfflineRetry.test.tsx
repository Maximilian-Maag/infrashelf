import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { OfflineRetry } from './OfflineRetry'

/**
 * The offline page's one control (#245).
 *
 * The whole point is that it RELOADS rather than routes: a `<Link href="/">` is
 * handled by the router, which has nothing to route to while the network is down,
 * so the click would appear to do nothing. That is the behaviour worth pinning —
 * a swap back to a link would still render a button labelled "try again" and
 * silently stop working exactly when it is needed.
 */
describe('OfflineRetry', () => {
  const reload = vi.fn()

  beforeEach(() => {
    reload.mockReset()
    // jsdom has no navigation; the component's contract is only that it asks for
    // a reload, not where it goes.
    vi.stubGlobal('location', { reload })
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('shows the label it is given', () => {
    render(<OfflineRetry label="Try again" />)
    expect(screen.getByRole('button', { name: 'Try again' })).toBeInTheDocument()
  })

  it('reloads the page when pressed', async () => {
    const user = userEvent.setup()
    render(<OfflineRetry label="Try again" />)

    await user.click(screen.getByRole('button', { name: 'Try again' }))

    expect(reload).toHaveBeenCalledTimes(1)
  })
})
