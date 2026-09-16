import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, within } from '@testing-library/react'
import type * as Navigation from 'next/navigation'
import type { Order } from '@infrashelf/types'
import { ApiError } from '@/lib/api'
import OrderDetailPage from './page'

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

// Three client components with their own fetching; this file is the page.
vi.mock('./OrderComments', () => ({
  OrderComments: ({ initialComments, canWriteInternal }: { initialComments: unknown[]; canWriteInternal: boolean }) =>
    <div data-testid="comments" data-count={initialComments.length} data-internal={String(canWriteInternal)} />,
}))
vi.mock('./WriteOffOrder', () => ({ WriteOffOrder: () => <div data-testid="writeoff" /> }))
vi.mock('./DeployNow', () => ({ DeployNow: () => <div data-testid="deploynow" /> }))
vi.mock('@/components/ui/RefreshButton', () => ({ RefreshButton: () => <button type="button">Refresh</button> }))
vi.mock('@/components/ui/AutoRefresh', () => ({
  AutoRefresh: ({ active }: { active: boolean }) => <div data-testid="autorefresh" data-active={String(active)} />,
}))

const get = vi.fn()
vi.mock('@/lib/serverApi', () => ({ get: (path: string) => get(path) }))

const snapshot = (over: Record<string, unknown> = {}) => ({
  productName: 'Managed Postgres (as ordered)',
  price: '100.00',
  currency: 'EUR',
  parameters: [],
  ...over,
})

const order = (over: Partial<Order> = {}): Order =>
  ({
    id: 11, productId: 2, productName: 'Managed Postgres (today)',
    environmentId: 3, environmentName: 'prod',
    projectId: 4, projectName: 'Platform',
    userId: 5, userName: 'Ada',
    status: 'active',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-02T00:00:00.000Z',
    parameters: {},
    elements: [],
    productSnapshot: snapshot(),
    ...over,
  }) as unknown as Order

const answer = (over: { order?: unknown; comments?: unknown } = {}) => {
  get.mockImplementation((path: string) => {
    const v = path.includes('/comments')
      ? ('comments' in over ? over.comments : [])
      : ('order' in over ? over.order : order())
    return v instanceof Error ? Promise.reject(v) : Promise.resolve(v)
  })
}

const params = Promise.resolve({ id: '11' })
const signedInAs = (role: string) => auth.mockResolvedValue({ user: { id: '5', name: 'Ada', role } })
const detail = (label: string) =>
  (screen.getByText(label).closest('div')?.querySelector('dd')?.textContent ?? '')

beforeEach(() => {
  get.mockReset()
  redirect.mockClear()
  notFound.mockClear()
  vi.spyOn(console, 'error').mockImplementation(() => {})
  signedInAs('project_manager')
  answer()
})

/**
 * The order page renders from the SNAPSHOT taken when the order was placed, not
 * from the live product (#38) — showing today's price on a months-old order
 * silently misreports what was approved. It is also the one place a submitted
 * parameter value is rendered back, which is why the sensitive flag matters.
 */
describe('OrderDetailPage', () => {
  it('sends a caller with no session to the login page', async () => {
    auth.mockResolvedValue(null)
    await expect(OrderDetailPage({ params })).rejects.toThrow('NEXT_REDIRECT')
    expect(redirect).toHaveBeenCalledWith('/login')
  })

  it('is a 404 when the order does not exist', async () => {
    answer({ order: new ApiError(404, 'Order not found') })
    await expect(OrderDetailPage({ params })).rejects.toThrow('NEXT_NOT_FOUND')
  })

  it('sends an ended session to the login page, not to a 404', async () => {
    // #434: the catch around this fetch used to swallow the redirect, so a
    // signed-out user pressing Back was told the order did not exist.
    const { redirect: realRedirect } = await vi.importActual<typeof Navigation>('next/navigation')
    let thrown: unknown
    try { realRedirect('/login?expired=1') } catch (e) { thrown = e }
    answer({ order: thrown })

    await expect(OrderDetailPage({ params })).rejects.toThrow()
    expect(notFound, 'the redirect was swallowed and became a 404').not.toHaveBeenCalled()
  })

  it('does not let a failed COMMENTS fetch swallow the login redirect either', async () => {
    // The second catch on this page, and the quieter one: it exists so a
    // comments outage costs the thread rather than the order, which means it
    // also catches the redirect `serverApi` throws for an ended session (#434).
    const { redirect: realRedirect } = await vi.importActual<typeof Navigation>('next/navigation')
    let thrown: unknown
    try { realRedirect('/login?expired=1') } catch (e) { thrown = e }
    answer({ comments: thrown })

    await expect(OrderDetailPage({ params }), 'the redirect was swallowed and the page rendered anyway').rejects.toThrow()
  })

  it('asks for this order in this language', async () => {
    // The language is in the URL because the product name and the parameter
    // labels come back translated; without it the page renders half in English.
    render(await OrderDetailPage({ params }))

    expect(get).toHaveBeenCalledWith('/api/orders/11?lang=en')
    expect(get).toHaveBeenCalledWith('/api/orders/11/comments')
  })

  it('names the order and offers the way back to the list', async () => {
    render(await OrderDetailPage({ params }))

    expect(screen.getByRole('heading', { name: 'Order #11', level: 1 })).toBeInTheDocument()
    expect(screen.getAllByRole('link', { name: 'Orders' })[0]).toHaveAttribute('href', '/orders')
    expect(screen.getByRole('link', { name: 'Back to Orders' })).toHaveAttribute('href', '/orders')
  })

  it('masks a parameter the snapshot marked sensitive', async () => {
    // The order page is the one place a submitted value is rendered back, and
    // the definition that says it is secret comes from the snapshot.
    answer({ order: order({
      parameters: { db_name: 'orders', admin_password: 'hunter2hunter2' },
      productSnapshot: snapshot({ parameters: [
        { name: 'db_name', label: 'Database', sensitive: false },
        { name: 'admin_password', label: 'Admin password', sensitive: true },
      ] }),
    } as never) })
    render(await OrderDetailPage({ params }))

    expect(screen.getByText('••••••')).toBeInTheDocument()
    expect(screen.queryByText('hunter2hunter2')).not.toBeInTheDocument()
    // The one beside it is not masked, or the rule would be "hide everything".
    expect(screen.getByText('orders')).toBeInTheDocument()
  })

  it('does not mask a value whose definition is gone from the snapshot', async () => {
    // It cannot: nothing says it was sensitive. Worth pinning because the
    // failure is silent either way, and this is the honest behaviour.
    answer({ order: order({ parameters: { legacy: 'plain' }, productSnapshot: snapshot({ parameters: [] }) } as never) })
    render(await OrderDetailPage({ params }))
    expect(screen.getByText('plain')).toBeInTheDocument()
  })

  it('labels a parameter as it read at order time, keeping the raw name', async () => {
    // The label is what the requester saw; the raw name is what reaches the
    // pipeline, so both stay.
    answer({ order: order({
      parameters: { db_name: 'orders' },
      productSnapshot: snapshot({ parameters: [{ name: 'db_name', label: 'Database', sensitive: false }] }),
    } as never) })
    render(await OrderDetailPage({ params }))

    expect(screen.getByText('Database')).toBeInTheDocument()
    expect(screen.getByText('db_name')).toBeInTheDocument()
  })

  it('leaves the parameters card out when the order carried none', async () => {
    render(await OrderDetailPage({ params }))
    expect(screen.queryByRole('heading', { name: 'Parameters' })).not.toBeInTheDocument()
  })

  it('shows the product as it was ordered, not as it is today', async () => {
    render(await OrderDetailPage({ params }))

    expect(detail('Product')).toBe('Managed Postgres (as ordered)')
    expect(screen.getByText(/These values are from the moment the order was placed/)).toBeInTheDocument()
  })

  it('says so when the order predates snapshots, rather than pretending', async () => {
    answer({ order: order({ productSnapshot: null } as never) })
    render(await OrderDetailPage({ params }))

    expect(detail('Product')).toBe('Managed Postgres (today)')
    expect(screen.getByText(/predates snapshots/)).toBeInTheDocument()
    // No price either: there is no recorded one to show.
    expect(screen.queryByText('Price')).not.toBeInTheDocument()
  })

  it('multiplies the unit price out for a multi-element order', async () => {
    // The snapshot price is the UNIT price that applied; the line total is the
    // number the reader is looking for (#98, #104).
    answer({ order: order({ quantity: 3 } as never) })
    render(await OrderDetailPage({ params }))

    expect(detail('Price')).toBe('300.00 EUR (3 × 100.00 EUR)')
    expect(detail('Quantity')).toBe('3')
  })

  it('shows a single-element order its plain unit price', async () => {
    render(await OrderDetailPage({ params }))
    expect(detail('Price')).toBe('100.00 EUR')
    expect(screen.queryByText('Quantity')).not.toBeInTheDocument()
  })

  it('treats a missing or nonsensical quantity as one', async () => {
    // Absent on an order placed before quantity existed, which asked for exactly
    // one.
    for (const quantity of [undefined, 0, -2]) {
      answer({ order: order({ quantity } as never) })
      const { container, unmount } = render(await OrderDetailPage({ params }))
      expect(within(container).getByText('100.00 EUR'), String(quantity)).toBeInTheDocument()
      unmount()
    }
  })

  it('names the cost centre rather than its id, and keeps the id when the row is gone', async () => {
    answer({ order: order({ costCenterId: 3, costCenterCode: 'IT-4711', costCenterName: 'Platform Networking' } as never) })
    const named = render(await OrderDetailPage({ params }))
    expect(within(named.container).getByText('IT-4711 — Platform Networking')).toBeInTheDocument()
    named.unmount()

    answer({ order: order({ costCenterId: 3, costCenterCode: null } as never) })
    render(await OrderDetailPage({ params }))
    expect(screen.getByText('#3')).toBeInTheDocument()
  })

  it('falls back to an id wherever a name did not come back', async () => {
    answer({ order: order({
      environmentName: undefined, projectName: undefined, userName: undefined, productSnapshot: null,
      productName: undefined,
    } as never) })
    render(await OrderDetailPage({ params }))

    expect(detail('Environment')).toBe('#3')
    expect(detail('Project')).toBe('#4')
    expect(detail('Ordered by')).toBe('User #5')
    expect(detail('Product')).toBe('#2')
  })

  it('says when a scheduled order will provision', async () => {
    // A badge reading "Scheduled" with no time is the complaint #330 opens with:
    // the portal knows when, and not saying so leaves the requester to ask.
    answer({ order: order({ status: 'scheduled', scheduledFor: '2026-06-01T10:00:00.000Z' } as never) })
    render(await OrderDetailPage({ params }))
    expect(screen.getByText('Provisioning starts')).toBeInTheDocument()
  })

  it('stops saying it once the order has left scheduled', async () => {
    // `scheduled_for` survives release, so gating on the status is what stops it
    // lingering on an order that already deployed.
    answer({ order: order({ status: 'active', scheduledFor: '2026-06-01T10:00:00.000Z' } as never) })
    render(await OrderDetailPage({ params }))
    expect(screen.queryByText('Provisioning starts')).not.toBeInTheDocument()
  })

  it('shows a rejection note, and only on a rejected order', async () => {
    answer({ order: order({ status: 'rejected', rejectionNote: 'no budget this quarter' } as never) })
    const rejected = render(await OrderDetailPage({ params }))
    expect(within(rejected.container).getByText('no budget this quarter')).toBeInTheDocument()
    rejected.unmount()

    answer({ order: order({ status: 'active', rejectionNote: 'no budget this quarter' } as never) })
    render(await OrderDetailPage({ params }))
    expect(screen.queryByText('no budget this quarter')).not.toBeInTheDocument()
  })

  it('offers write-off only to root, and only from provisioning', async () => {
    // The one status that has no other way out. The server checks both again;
    // this is about not offering what will be refused.
    signedInAs('root')
    answer({ order: order({ status: 'provisioning' } as never) })
    const ok = render(await OrderDetailPage({ params }))
    expect(within(ok.container).getByTestId('writeoff')).toBeInTheDocument()
    ok.unmount()

    answer({ order: order({ status: 'active' } as never) })
    const wrongStatus = render(await OrderDetailPage({ params }))
    expect(wrongStatus.container.querySelector('[data-testid="writeoff"]')).toBeNull()
    wrongStatus.unmount()

    signedInAs('admin')
    answer({ order: order({ status: 'provisioning' } as never) })
    const wrongRole = render(await OrderDetailPage({ params }))
    expect(wrongRole.container.querySelector('[data-testid="writeoff"]')).toBeNull()
  })

  it('offers deploy-now only to root, and only from scheduled', async () => {
    signedInAs('root')
    answer({ order: order({ status: 'scheduled' } as never) })
    const ok = render(await OrderDetailPage({ params }))
    expect(within(ok.container).getByTestId('deploynow')).toBeInTheDocument()
    ok.unmount()

    signedInAs('admin')
    const wrongRole = render(await OrderDetailPage({ params }))
    expect(wrongRole.container.querySelector('[data-testid="deploynow"]')).toBeNull()
    wrongRole.unmount()

    signedInAs('root')
    answer({ order: order({ status: 'active' } as never) })
    const wrongStatus = render(await OrderDetailPage({ params }))
    expect(wrongStatus.container.querySelector('[data-testid="deploynow"]')).toBeNull()
  })

  it('polls while the order OR any of its elements is unsettled', async () => {
    // A completed order can still have an element being torn down.
    answer({ order: order({ status: 'active', elements: [{ id: 1, status: 'provisioning', outputs: {} }] } as never) })
    render(await OrderDetailPage({ params }))
    expect(screen.getByTestId('autorefresh')).toHaveAttribute('data-active', 'true')
  })

  it('stops polling once everything has settled', async () => {
    render(await OrderDetailPage({ params }))
    expect(screen.getByTestId('autorefresh')).toHaveAttribute('data-active', 'false')
  })

  it('lists the infrastructure the order produced, with its outputs', async () => {
    // Terraform outputs live on the ELEMENT, and the order had no route to them
    // at all — you had to know to go to Infrastructure and find the right row.
    answer({ order: order({ elements: [
      { id: 21, status: 'active', sequence: 1, sizeCode: 'large', outputs: { host: 'db.example.com' } },
    ] } as never) })
    render(await OrderDetailPage({ params }))

    expect(screen.getByRole('link', { name: '#21' })).toHaveAttribute('href', '/infrastructure/21')
    expect(screen.getByText('host')).toBeInTheDocument()
    expect(screen.getByText('db.example.com')).toBeInTheDocument()
    expect(screen.getByText('large')).toBeInTheDocument()
  })

  it('says an element has no outputs rather than showing an empty table', async () => {
    answer({ order: order({ elements: [{ id: 21, status: 'active', outputs: {} }] } as never) })
    render(await OrderDetailPage({ params }))
    expect(screen.getByText('No outputs recorded.')).toBeInTheDocument()
  })

  it('numbers the elements of a multi-element order', async () => {
    answer({ order: order({ quantity: 3, elements: [
      { id: 21, status: 'active', sequence: 2, outputs: {} },
    ] } as never) })
    render(await OrderDetailPage({ params }))
    expect(screen.getByText('2/3')).toBeInTheDocument()
  })

  it('reports each pipeline’s outcome, and says pending for one that has not', async () => {
    // The outcome the webhook handler recorded was never selected into the
    // order, so this list read as a run that never reported.
    answer({ order: order({ pipelineId: ['pipe-1', 'pipe-2'], pipelineStatus: { 'pipe-1': 'success' } } as never) })
    render(await OrderDetailPage({ params }))

    expect(screen.getByText('success')).toBeInTheDocument()
    // "Pending" also names the ORDER's status, which is why the status cell
    // carries a testid (#363) — this assertion must read the pipeline one.
    const pipelines = screen.getByRole('heading', { name: 'Pipeline IDs' }).closest('div.rounded-xl') as HTMLElement
    expect(within(pipelines).getByText('Pending')).toBeInTheDocument()
    expect(screen.getByTestId('order-status')).not.toHaveTextContent('Pending')
  })

  it('hands the comment thread what it needs, and lets an outage cost only the thread', async () => {
    answer({ comments: [{ id: 1 }, { id: 2 }] })
    const ok = render(await OrderDetailPage({ params }))
    expect(within(ok.container).getByTestId('comments')).toHaveAttribute('data-count', '2')
    expect(within(ok.container).getByRole('heading', { name: 'Comments (2)' })).toBeInTheDocument()
    ok.unmount()

    answer({ comments: new ApiError(502, 'Bad Gateway') })
    render(await OrderDetailPage({ params }))
    expect(screen.getByTestId('comments')).toHaveAttribute('data-count', '0')
    // The order itself still rendered.
    expect(screen.getByRole('heading', { name: 'Order Details' })).toBeInTheDocument()
  })

  it('offers internal notes to an admin and not to a requester', async () => {
    signedInAs('admin')
    const adminView = render(await OrderDetailPage({ params }))
    expect(within(adminView.container).getByTestId('comments')).toHaveAttribute('data-internal', 'true')
    adminView.unmount()

    signedInAs('project_manager')
    const requesterView = render(await OrderDetailPage({ params }))
    expect(within(requesterView.container).getByTestId('comments')).toHaveAttribute('data-internal', 'false')
    requesterView.unmount()

    // Root as well as admin: root is the account a fresh installation has, and
    // an internal note it cannot write is a note nobody writes.
    signedInAs('root')
    render(await OrderDetailPage({ params }))
    expect(screen.getByTestId('comments')).toHaveAttribute('data-internal', 'true')
  })
})
