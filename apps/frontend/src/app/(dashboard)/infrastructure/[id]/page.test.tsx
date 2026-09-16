import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, within } from '@testing-library/react'
import type * as Navigation from 'next/navigation'
import type { InfrastructureDetail } from '@infrashelf/types'
import { ApiError } from '@/lib/api'
import InfrastructureDetailPage from './page'

const auth = vi.fn()
vi.mock('@/lib/auth', () => ({ auth: () => auth() }))
vi.mock('@/lib/getLang', () => ({ getLang: async () => 'en' }))

const redirect = vi.fn((url: string) => { throw new Error(`NEXT_REDIRECT:${url}`) })
const notFound = vi.fn(() => { throw new Error('NEXT_NOT_FOUND') })
vi.mock('next/navigation', async (importOriginal) => ({
  ...(await importOriginal<typeof Navigation>()),
  redirect: (url: string) => redirect(url),
  notFound: () => notFound(),
  useRouter: () => ({ refresh: vi.fn(), push: vi.fn() }),
}))
vi.mock('@/components/ui/Toast', () => ({ useToast: () => ({ toast: vi.fn() }) }))

vi.mock('../InfraActions', () => ({
  InfraActions: ({ canRetry }: { canRetry: boolean }) => <div data-testid="actions" data-retry={String(canRetry)} />,
}))
vi.mock('./RereadOutputs', () => ({ RereadOutputs: () => <div data-testid="reread" /> }))
vi.mock('@/components/ui/RefreshButton', () => ({ RefreshButton: () => <button type="button">Refresh</button> }))
vi.mock('@/components/ui/AutoRefresh', () => ({
  AutoRefresh: ({ active }: { active: boolean }) => <div data-testid="autorefresh" data-active={String(active)} />,
}))

const get = vi.fn()
vi.mock('@/lib/serverApi', () => ({ get: (path: string) => get(path) }))

const element = (over: Partial<InfrastructureDetail> = {}): InfrastructureDetail =>
  ({
    id: 21, orderId: 11, productId: 2, productName: 'Managed Postgres',
    projectId: 4, projectName: 'Platform', environmentId: 3, environmentName: 'prod',
    status: 'active', displayStatus: 'active', deployedAt: '2026-01-01T00:00:00.000Z',
    outputs: {}, parameters: {}, pipelineId: [], pipelineStatus: {}, redactedParameters: [],
    ...over,
  }) as unknown as InfrastructureDetail

const answer = (v: unknown = element()) =>
  get.mockImplementation(() => (v instanceof Error ? Promise.reject(v) : Promise.resolve(v)))

const params = Promise.resolve({ id: '21' })
const signedInAs = (role: string) => auth.mockResolvedValue({ user: { id: '5', name: 'Ada', role } })
const card = (title: string) =>
  (screen.getByRole('heading', { name: title }).closest('div.rounded-xl') as HTMLElement)

beforeEach(() => {
  get.mockReset()
  redirect.mockClear()
  notFound.mockClear()
  signedInAs('project_manager')
  answer()
})

/**
 * One deployed element. The outputs are the reason the page exists — the
 * endpoint, the address, whatever the run wrote — and #215 is about saying WHY
 * they are missing rather than rendering one sentence for five different
 * failures.
 */
describe('InfrastructureDetailPage', () => {
  it('sends a caller with no session to the login page', async () => {
    auth.mockResolvedValue(null)
    await expect(InfrastructureDetailPage({ params })).rejects.toThrow('NEXT_REDIRECT')
    expect(redirect).toHaveBeenCalledWith('/login')
  })

  it('is a 404 for an element that is gone or not yours', async () => {
    // The API answers 404 for an element outside the caller's scope as well, so
    // this covers both without distinguishing them here either.
    answer(new ApiError(404, 'Not found'))
    await expect(InfrastructureDetailPage({ params })).rejects.toThrow('NEXT_NOT_FOUND')
  })

  it('sends an ended session to the login page, not to a 404', async () => {
    const { redirect: realRedirect } = await vi.importActual<typeof Navigation>('next/navigation')
    let thrown: unknown
    try { realRedirect('/login?expired=1') } catch (e) { thrown = e }
    answer(thrown)

    await expect(InfrastructureDetailPage({ params })).rejects.toThrow()
    expect(notFound, 'the redirect was swallowed and became a 404').not.toHaveBeenCalled()
  })

  it('identifies the element and links back to its order', async () => {
    render(await InfrastructureDetailPage({ params }))

    expect(screen.getByRole('heading', { name: 'Managed Postgres', level: 1 })).toBeInTheDocument()
    expect(screen.getByRole('link', { name: '#11' })).toHaveAttribute('href', '/orders/11')
    expect(screen.getAllByRole('link', { name: 'Infrastructure' })[0]).toHaveAttribute('href', '/infrastructure')
  })

  it('falls back to ids wherever a name did not come back', async () => {
    answer(element({ productName: undefined, projectName: undefined, environmentName: undefined } as never))
    render(await InfrastructureDetailPage({ params }))

    expect(screen.getByRole('heading', { name: 'Product #2', level: 1 })).toBeInTheDocument()
    expect(screen.getByText('#4')).toBeInTheDocument()
    expect(screen.getByText('#3')).toBeInTheDocument()
  })

  it('says why the outputs are missing when the server knows', async () => {
    // Five different failures used to render as the same sentence, so "your CI
    // token expired" and "this template declares none" were the same screen
    // (#215).
    answer(element({ outputs: {}, outputsError: 'the CI token was refused (401)' } as never))
    render(await InfrastructureDetailPage({ params }))

    const outputs = card('Outputs')
    expect(within(outputs).getByText('the CI token was refused (401)')).toBeInTheDocument()
    expect(within(outputs).queryByText('No outputs recorded.')).not.toBeInTheDocument()
    // And a way to try again, because the reason is often transient.
    expect(within(outputs).getByTestId('reread')).toBeInTheDocument()
  })

  it('says plainly there are none when the server has no reason to give', async () => {
    render(await InfrastructureDetailPage({ params }))
    expect(within(card('Outputs')).getByText('No outputs recorded.')).toBeInTheDocument()
  })

  it('lists each output name beside its value', async () => {
    answer(element({ outputs: { host: 'db.example.com', port: '5432' } }))
    render(await InfrastructureDetailPage({ params }))

    const outputs = card('Outputs')
    expect(within(outputs).getByText('host')).toBeInTheDocument()
    expect(within(outputs).getByText('db.example.com')).toBeInTheDocument()
    // Nothing to re-read once they are here.
    expect(within(outputs).queryByTestId('reread')).not.toBeInTheDocument()
  })

  it('lists the parameters, and names the ones held back', async () => {
    // The values are redacted server-side; naming the keys is what tells an
    // operator the page is not simply missing them.
    answer(element({ parameters: { db_name: 'orders' }, redactedParameters: ['admin_password'] } as never))
    render(await InfrastructureDetailPage({ params }))

    const card_ = card('Parameters')
    expect(within(card_).getByText('db_name')).toBeInTheDocument()
    expect(within(card_).getByText('orders')).toBeInTheDocument()
    expect(within(card_).getByText(/Hidden sensitive values: admin_password/)).toBeInTheDocument()
  })

  it('says nothing about redaction when nothing was held back', async () => {
    answer(element({ parameters: { db_name: 'orders' } } as never))
    render(await InfrastructureDetailPage({ params }))
    expect(within(card('Parameters')).queryByText(/Hidden sensitive/)).not.toBeInTheDocument()
  })

  it('says there are no parameters rather than showing an empty list', async () => {
    render(await InfrastructureDetailPage({ params }))
    expect(within(card('Parameters')).getByText('No parameters.')).toBeInTheDocument()
  })

  it('reports each pipeline’s outcome, and pending for one that has not reported', async () => {
    answer(element({ pipelineId: ['pipe-1', 'pipe-2'], pipelineStatus: { 'pipe-1': 'success' } } as never))
    render(await InfrastructureDetailPage({ params }))

    const pipelines = card('Pipelines')
    expect(within(pipelines).getByText('success')).toBeInTheDocument()
    expect(within(pipelines).getByText('Pending')).toBeInTheDocument()
  })

  it('shows a trigger that never started at all', async () => {
    // A failed trigger leaves a `trigger-failed:<n>` sentinel with no matching
    // pipeline id. Listing only the ids hid the one case where nothing ran.
    answer(element({
      pipelineId: [],
      pipelineStatus: { 'trigger-failed:1': 'the CI source refused the request' },
    } as never))
    render(await InfrastructureDetailPage({ params }))

    const pipelines = card('Pipelines')
    expect(within(pipelines).getByText('trigger-failed:1')).toBeInTheDocument()
    expect(within(pipelines).getByText('the CI source refused the request')).toBeInTheDocument()
    expect(within(pipelines).queryByText('No pipelines recorded.')).not.toBeInTheDocument()
  })

  it('says there are none only when there is neither a run nor a failed trigger', async () => {
    render(await InfrastructureDetailPage({ params }))
    expect(within(card('Pipelines')).getByText('No pipelines recorded.')).toBeInTheDocument()
  })

  it('polls on the DERIVED status, not the stored one', async () => {
    answer(element({ status: 'active', displayStatus: 'provisioning' } as never))
    render(await InfrastructureDetailPage({ params }))

    expect(screen.getByTestId('autorefresh')).toHaveAttribute('data-active', 'true')
  })

  it('stops polling once it has settled', async () => {
    render(await InfrastructureDetailPage({ params }))
    expect(screen.getByTestId('autorefresh')).toHaveAttribute('data-active', 'false')
  })

  it('says a deployment failed, beside the status', async () => {
    answer(element({ displayStatus: 'failed' } as never))
    render(await InfrastructureDetailPage({ params }))
    expect(screen.getByText('Deployment failed')).toBeInTheDocument()
  })

  it('offers retry to an admin and root, and not to a project manager', async () => {
    // Same bar as the list's actions and the export: these re-fire or tear down
    // real infrastructure.
    const pm = render(await InfrastructureDetailPage({ params }))
    expect(within(pm.container).getByTestId('actions')).toHaveAttribute('data-retry', 'false')
    pm.unmount()

    for (const role of ['admin', 'root']) {
      signedInAs(role)
      const { container, unmount } = render(await InfrastructureDetailPage({ params }))
      expect(within(container).getByTestId('actions'), role).toHaveAttribute('data-retry', 'true')
      unmount()
    }
  })

  it('says when an element has not been deployed, and when a teardown is due', async () => {
    answer(element({ deployedAt: null, scheduledDecommissionAt: '2026-06-01T10:00:00.000Z' } as never))
    render(await InfrastructureDetailPage({ params }))

    expect(screen.getByText('Not deployed')).toBeInTheDocument()
    expect(screen.getByText('Scheduled for')).toBeInTheDocument()
  })

  it('leaves the teardown row out when none is scheduled', async () => {
    render(await InfrastructureDetailPage({ params }))
    expect(screen.queryByText('Scheduled for')).not.toBeInTheDocument()
  })

  it('shows a dash for an element charged to no cost centre', async () => {
    render(await InfrastructureDetailPage({ params }))
    expect(within(screen.getByText('Cost Center').closest('div') as HTMLElement).getByText('—')).toBeInTheDocument()
  })
})
