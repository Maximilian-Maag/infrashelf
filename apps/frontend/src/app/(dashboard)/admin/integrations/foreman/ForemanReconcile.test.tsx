import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type { DeploymentEnvironment, ForemanReconciliation } from '@infrashelf/types'
import { ForemanReconcile } from './ForemanReconcile'

vi.mock('@/lib/api', () => ({ get: vi.fn() }))
import { get } from '@/lib/api'

const environments: DeploymentEnvironment[] = [
  { id: 4, name: 'Production', description: '', ciSourceId: 1 },
  { id: 5, name: 'Staging', description: '', ciSourceId: 1 },
] as DeploymentEnvironment[]

const report = (over: Partial<ForemanReconciliation> = {}): ForemanReconciliation => ({
  integration: { id: 1, name: 'House Foreman', baseUrl: 'https://foreman.example.com' },
  environmentId: 4,
  checkedAt: '2026-09-17T10:00:00.000Z',
  matched: [{ elementId: 1, hostName: 'web-01', foremanHostId: 10, status: 'OK' }],
  ghosts: [{ elementId: 2, orderId: 20, productId: 3, hostName: 'db-07' }],
  orphans: [{ id: 11, name: 'legacy-01.dc.example.com', status: 'OK', lastReportAt: null }],
  unidentified: [],
  ...over,
})

beforeEach(() => {
  vi.mocked(get).mockReset().mockResolvedValue(report() as never)
})

const runFor = async (name: string) => {
  const u = userEvent.setup()
  await u.selectOptions(screen.getByLabelText(/^Environment/), name)
  await u.click(screen.getByRole('button', { name: 'Run reconciliation' }))
}

/**
 * The comparison screen (#111).
 *
 * What it must not do is let one bucket read as another. A ghost is not proof a
 * machine is gone and an orphan is not a fault, so each list carries the
 * sentence that says so — and a failed run must never leave the previous
 * report on screen underneath the error that replaced it.
 */
describe('ForemanReconcile', () => {
  it('asks for nothing until an environment is chosen and the run is asked for', async () => {
    render(<ForemanReconcile environments={environments} />)

    // Foreman pays for every run, so the page waits to be asked rather than
    // reconciling on load (and again on every refresh).
    expect(get).not.toHaveBeenCalled()
    expect(screen.getByText('Choose an environment and run the comparison.')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Run reconciliation' })).toBeDisabled()
  })

  it('runs against the environment that was chosen', async () => {
    render(<ForemanReconcile environments={environments} />)

    await runFor('5')

    await waitFor(() =>
      expect(get).toHaveBeenCalledWith('/api/admin/integrations/foreman/reconcile?environmentId=5'),
    )
  })

  it('shows the four counts and names the Foreman it asked', async () => {
    render(<ForemanReconcile environments={environments} />)

    await runFor('4')

    expect(await screen.findByText('House Foreman', { exact: false })).toBeInTheDocument()
    const summary = screen.getByText('Matched').closest('div')?.parentElement as HTMLElement
    expect(within(summary).getByText('Matched')).toBeInTheDocument()
    expect(within(summary).getByText('Missing from Foreman')).toBeInTheDocument()
    expect(within(summary).getByText('Not ordered here')).toBeInTheDocument()
    expect(within(summary).getByText('No host name recorded')).toBeInTheDocument()
  })

  it('lists the ghosts under the sentence saying what they do not prove', async () => {
    render(<ForemanReconcile environments={environments} />)

    await runFor('4')

    const card = (await screen.findByRole('heading', { name: /Missing from Foreman \(1\)/ }))
      .closest('div.rounded-xl') as HTMLElement
    expect(within(card).getByText('db-07')).toBeInTheDocument()
    expect(
      within(card).getByText(/A host removed by hand looks the same from here/),
    ).toBeInTheDocument()
  })

  it('lists the orphans as unmanaged rather than as a fault', async () => {
    render(<ForemanReconcile environments={environments} />)

    await runFor('4')

    const card = (await screen.findByRole('heading', { name: /Not ordered here \(1\)/ }))
      .closest('div.rounded-xl') as HTMLElement
    expect(within(card).getByText('legacy-01.dc.example.com')).toBeInTheDocument()
    expect(within(card).getByText(/Not a fault on its own/)).toBeInTheDocument()
  })

  it('keeps the unidentified section off the screen when there is nothing in it', async () => {
    // The other three are facts about the estate and worth seeing as zeroes.
    // This one is a fact about the portal's own records, and an empty section
    // under that heading is a question nobody asked.
    render(<ForemanReconcile environments={environments} />)

    await runFor('4')

    await screen.findByRole('heading', { name: /Not ordered here/ })
    expect(screen.queryByRole('heading', { name: /No host name recorded \(/ })).not.toBeInTheDocument()
  })

  it('shows the unidentified elements when there are some', async () => {
    vi.mocked(get).mockResolvedValue(
      report({ unidentified: [{ elementId: 9, orderId: 90, productId: 3 }] }) as never,
    )
    render(<ForemanReconcile environments={environments} />)

    await runFor('4')

    const card = (await screen.findByRole('heading', { name: /No host name recorded \(1\)/ }))
      .closest('div.rounded-xl') as HTMLElement
    expect(within(card).getByText('#9')).toBeInTheDocument()
  })

  it('says why a run failed, and does not leave the old report under it', async () => {
    // 409 (no Foreman configured) and 502 (Foreman unreachable) both arrive as
    // errors that already say which they are. A stale report beside one of them
    // reads as the run having produced it.
    render(<ForemanReconcile environments={environments} />)
    await runFor('4')
    await screen.findByRole('heading', { name: /Not ordered here/ })

    vi.mocked(get).mockRejectedValue(new Error('No Foreman integration is available'))
    await runFor('5')

    expect(await screen.findByText('No Foreman integration is available')).toBeInTheDocument()
    expect(screen.queryByRole('heading', { name: /Not ordered here/ })).not.toBeInTheDocument()
  })

  it('says the environments could not be read rather than offering none silently', () => {
    render(
      <ForemanReconcile environments={[]} environmentsError="HTTP 500: Internal Server Error" />,
    )

    expect(screen.getByText('HTTP 500: Internal Server Error')).toBeInTheDocument()
  })
})
