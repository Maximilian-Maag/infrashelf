import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'

const refresh = vi.fn()
vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh, push: vi.fn() }) }))
vi.mock('@/lib/useLang', () => ({ useLang: () => 'en' }))
vi.mock('@/lib/api', () => ({ post: vi.fn() }))

import { RereadOutputs } from './RereadOutputs'
import { post } from '@/lib/api'

const mockedPost = vi.mocked(post)

beforeEach(() => {
  refresh.mockReset()
  mockedPost.mockReset().mockResolvedValue(undefined as never)
})

/**
 * The second chance at a log that has not changed (#218).
 *
 * Outputs are parsed once, when the order settles. If anything was wrong at that
 * instant — a revoked CI token, a log the parser could not read — the element was
 * blank for ever, and the only remedies were a database script or redeploying
 * real infrastructure.
 */
describe('RereadOutputs', () => {
  it('asks the server to read this element’s outputs again', async () => {
    const user = userEvent.setup()
    render(<RereadOutputs elementId={42} />)

    await user.click(screen.getByRole('button', { name: /read outputs again/i }))

    expect(mockedPost).toHaveBeenCalledWith('/api/infrastructure/42/outputs', {})
  })

  it('re-renders from the server rather than trusting the response', async () => {
    // The server has stored whatever it read; rendering the response instead
    // would let the page and the database disagree.
    const user = userEvent.setup()
    render(<RereadOutputs elementId={42} />)

    await user.click(screen.getByRole('button', { name: /read outputs again/i }))

    await waitFor(() => expect(refresh).toHaveBeenCalledTimes(1))
  })

  it('says why when the server refuses, and does not refresh', async () => {
    // The 409 for an element whose pipeline log is gone says so; the generic
    // string would send the operator to look in the wrong place.
    mockedPost.mockRejectedValue(new Error('The pipeline log is no longer available'))
    const user = userEvent.setup()
    render(<RereadOutputs elementId={42} />)

    await user.click(screen.getByRole('button', { name: /read outputs again/i }))

    expect(await screen.findByRole('alert')).toHaveTextContent('The pipeline log is no longer available')
    expect(refresh).not.toHaveBeenCalled()
  })

  it('clears a previous failure when tried again', async () => {
    // Otherwise the banner from the first attempt sits above a second one that
    // succeeded.
    mockedPost.mockRejectedValueOnce(new Error('CI unreachable'))
    const user = userEvent.setup()
    render(<RereadOutputs elementId={42} />)

    const button = screen.getByRole('button', { name: /read outputs again/i })
    await user.click(button)
    expect(await screen.findByRole('alert')).toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: /read outputs again/i }))
    await waitFor(() => expect(screen.queryByRole('alert')).not.toBeInTheDocument())
  })

  it('announces that it is working, and refuses a second press meanwhile', async () => {
    // One press, one read: this re-fetches a pipeline log, and a double click
    // would ask for it twice.
    let release: () => void = () => {}
    mockedPost.mockImplementation(() => new Promise<never>((resolve) => { release = resolve as () => void }))
    const user = userEvent.setup()
    render(<RereadOutputs elementId={42} />)

    await user.click(screen.getByRole('button', { name: /read outputs again/i }))

    const busy = screen.getByRole('button', { name: /^reading/i })
    expect(busy).toBeDisabled()
    expect(busy).toHaveAttribute('aria-busy', 'true')

    release()
    await waitFor(() => expect(screen.getByRole('button', { name: /read outputs again/i })).toBeEnabled())
  })
})
