import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'

const replace = vi.fn()
let currentParams = new URLSearchParams()

vi.mock('next/navigation', () => ({
  useRouter: () => ({ replace, push: vi.fn() }),
  usePathname: () => '/audit',
  useSearchParams: () => currentParams,
}))

import { AuditFilters } from './AuditFilters'

const renderBar = (qs = '') => {
  currentParams = new URLSearchParams(qs)
  return render(<AuditFilters lang="en" resultCount={3} />)
}

const lastUrl = () => String(replace.mock.calls[replace.mock.calls.length - 1][0])

beforeEach(() => {
  replace.mockReset()
})

describe('AuditFilters', () => {
  it('writes a date filter into the URL as soon as it is picked', async () => {
    const user = userEvent.setup()
    renderBar()

    await user.type(screen.getByLabelText(/^from$/i), '2026-01-01')
    expect(replace).toHaveBeenCalledWith('/audit?from=2026-01-01')
  })

  it('keeps filters that are already set when adding another', async () => {
    const user = userEvent.setup()
    renderBar('action=user.login')

    await user.type(screen.getByLabelText(/^to$/i), '2026-02-01')
    const params = new URLSearchParams(lastUrl().split('?')[1])
    expect(params.get('action')).toBe('user.login')
    expect(params.get('to')).toBe('2026-02-01')
  })

  it('drops a filter from the URL rather than leaving it empty', async () => {
    const user = userEvent.setup()
    renderBar('from=2026-01-01&action=user.login')

    await user.clear(screen.getByLabelText(/^from$/i))
    expect(replace).toHaveBeenCalledWith('/audit?action=user.login')
  })

  /*
   * The two free-text fields are debounced together. A navigation per keystroke
   * would both hammer the API — which on this page reads the audit table — and
   * fight the caret, since every one of them re-renders the page underneath.
   */
  it('debounces the free-text filters instead of navigating per keystroke', async () => {
    const user = userEvent.setup()
    renderBar()

    await user.type(screen.getByLabelText(/^action$/i), 'create')

    expect(replace).not.toHaveBeenCalled()
    await waitFor(() => expect(replace).toHaveBeenCalledTimes(1))
    expect(new URLSearchParams(lastUrl().split('?')[1]).get('action')).toBe('create')
  })

  it('does not revert a date picked while the text debounce is pending (#138)', async () => {
    // Type an action, then — inside the 300ms window — pick a date. The date
    // applies immediately; the pending timer must pick that change up when it
    // fires rather than replaying the `searchParams` it captured before.
    const user = userEvent.setup()
    const { rerender } = renderBar()

    await user.type(screen.getByLabelText(/^action$/i), 'login')
    await user.type(screen.getByLabelText(/^from$/i), '2026-01-01')

    // The date's own navigation landed; the page re-renders with the new URL.
    expect(replace).toHaveBeenCalledWith('/audit?from=2026-01-01')
    currentParams = new URLSearchParams('from=2026-01-01')
    rerender(<AuditFilters lang="en" resultCount={3} />)

    await waitFor(() => {
      const params = new URLSearchParams(lastUrl().split('?')[1])
      expect(params.get('action')).toBe('login')
      expect(params.get('from')).toBe('2026-01-01')
    })
  })

  /*
   * Page 4 of the previous query is usually not a page at all: narrowing a
   * filter is how an admin gets from 3,000 rows to 12, and an offset that
   * outlives its filter lands on "no audit entries" — which on this page reads
   * as the search having found nothing.
   */
  it('returns to the first page when a filter changes', async () => {
    const user = userEvent.setup()
    renderBar('offset=120')

    await user.type(screen.getByLabelText(/^from$/i), '2026-01-01')
    expect(new URLSearchParams(lastUrl().split('?')[1]).get('offset')).toBeNull()
  })

  it('adopts a filter that changed from outside, without a stale frame', async () => {
    // A Back, or the Clear button. As an effect the box showed the OLD text for
    // a frame, which on a filter bar reads as the navigation not having happened
    // (#462, #469).
    const { rerender } = renderBar('action=user.login')
    expect(screen.getByLabelText(/^action$/i)).toHaveValue('user.login')

    currentParams = new URLSearchParams('action=user.logout')
    rerender(<AuditFilters lang="en" resultCount={3} />)

    expect(screen.getByLabelText(/^action$/i)).toHaveValue('user.logout')
    // And adopting it is not itself a change worth navigating for.
    expect(replace).not.toHaveBeenCalled()
  })

  it('counts the active filters and clears all of them at once', async () => {
    const user = userEvent.setup()
    renderBar('action=user.login&userId=3&offset=40')

    expect(screen.getByText('2')).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: /clear filters/i }))
    expect(replace).toHaveBeenCalledWith('/audit')
  })

  it('offers no clear button when nothing is filtered', () => {
    renderBar()
    expect(screen.queryByRole('button', { name: /clear filters/i })).not.toBeInTheDocument()
  })

  it('announces the result count rather than only drawing it', () => {
    renderBar()
    // A filter change re-renders the table without moving focus, so a
    // screen-reader user would otherwise get no feedback that anything happened.
    expect(screen.getByRole('status')).toHaveTextContent('3 entries')
  })
})
