import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'

let currentParams = new URLSearchParams()
vi.mock('next/navigation', () => ({ useSearchParams: () => currentParams }))

import { AuditExport } from './AuditExport'

const renderExport = (qs = '') => {
  currentParams = new URLSearchParams(qs)
  return render(<AuditExport lang="en" />)
}

const fetchMock = vi.fn()

beforeEach(() => {
  fetchMock.mockReset()
  fetchMock.mockResolvedValue(new Response('id,action\n', { status: 200 }))
  vi.stubGlobal('fetch', fetchMock)
  // jsdom has neither, and the download path walks straight through both.
  URL.createObjectURL = vi.fn(() => 'blob:audit')
  URL.revokeObjectURL = vi.fn()
})

afterEach(() => {
  vi.unstubAllGlobals()
})

const exportUrl = () => new URL(String(fetchMock.mock.calls[0][0]), 'http://x')

describe('AuditExport', () => {
  /*
   * The file has to match the rows on screen. An export taken under different
   * filters than the list it was read from is worse than no export at all — it
   * is a document an auditor keeps, and nothing on it says which query produced
   * it.
   */
  it('exports under the filters currently in the URL', async () => {
    const user = userEvent.setup()
    renderExport('action=user.login&userId=3&from=2026-01-01&offset=40')

    await user.click(screen.getByRole('button', { name: /csv/i }))

    const params = exportUrl().searchParams
    expect(exportUrl().pathname).toBe('/api/proxy/api/audit/export')
    expect(params.get('action')).toBe('user.login')
    expect(params.get('userId')).toBe('3')
    expect(params.get('from')).toBe('2026-01-01')
    expect(params.get('format')).toBe('csv')
    // Paging is a property of the screen, not of the export: page 3 of the log
    // is not what the word "export" promises.
    expect(params.get('offset')).toBeNull()
  })

  it('asks for a PDF when the PDF button is the one pressed', async () => {
    const user = userEvent.setup()
    renderExport()

    await user.click(screen.getByRole('button', { name: /pdf/i }))
    expect(exportUrl().searchParams.get('format')).toBe('pdf')
  })

  /*
   * An export over the server's row cap comes back as a 413 that names the cap
   * and says how to narrow the query. Showing the generic "Export failed" in its
   * place leaves the admin to retry the identical request — and, before the cap
   * refused at all, to file a silently truncated CSV as a complete export.
   */
  it('shows the server’s reason when an export is refused', async () => {
    const reason =
      'This export matches more than 50,000 entries, which is more than one export can carry. Narrow it with the from/to filters.'
    fetchMock.mockResolvedValue(
      new Response(JSON.stringify({ error: reason }), {
        status: 413,
        headers: { 'Content-Type': 'application/json' },
      }),
    )
    const user = userEvent.setup()
    renderExport()

    await user.click(screen.getByRole('button', { name: /csv/i }))

    const alert = await screen.findByRole('alert')
    expect(alert).toHaveTextContent(/50,000 entries/)
    expect(alert).toHaveTextContent(/from\/to/)
  })

  it('falls back to the generic message when the failure carries no reason', async () => {
    fetchMock.mockResolvedValue(new Response('nope', { status: 500 }))
    const user = userEvent.setup()
    renderExport()

    await user.click(screen.getByRole('button', { name: /csv/i }))

    expect(await screen.findByRole('alert')).toHaveTextContent(/export failed/i)
  })

  it('reports a network failure rather than looking like a finished download', async () => {
    fetchMock.mockRejectedValue(new Error('offline'))
    const user = userEvent.setup()
    renderExport()

    await user.click(screen.getByRole('button', { name: /csv/i }))

    expect(await screen.findByRole('alert')).toHaveTextContent(/export failed/i)
  })
})
