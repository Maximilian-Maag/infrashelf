import { describe, it, expect, vi, beforeAll, beforeEach } from 'vitest'
import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type { BudgetState, CostCenter } from '@infrashelf/types'

// jsdom does not implement the native <dialog> methods; stub them so Modal's
// open/close effects don't throw (same stub as CategoriesManager.test.tsx).
beforeAll(() => {
  HTMLDialogElement.prototype.showModal = vi.fn(function (this: HTMLDialogElement) {
    this.open = true
  })
  HTMLDialogElement.prototype.close = vi.fn(function (this: HTMLDialogElement) {
    this.open = false
  })
})

vi.mock('@/lib/api', () => ({
  get: vi.fn(),
  post: vi.fn(),
  put: vi.fn(),
  del: vi.fn(),
}))

import { CostCentersManager } from './CostCentersManager'
import { get, put, del } from '@/lib/api'

const mockedGet = vi.mocked(get)
const mockedPut = vi.mocked(put)
const mockedDel = vi.mocked(del)

const costCenters: CostCenter[] = [
  { id: 1, code: 'CC-100', name: 'Platform', active: true },
  { id: 2, code: 'CC-200', name: 'Research', active: true },
]

const budgetState = (over: Partial<BudgetState> = {}): BudgetState => ({
  costCenterId: 1,
  costCenterLabel: 'CC-100 — Platform',
  amount: 10_000,
  currency: 'EUR',
  period: 'total',
  behaviour: 'block',
  committed: 2_500,
  remaining: 7_500,
  exhausted: false,
  unconverted: [],
  unpriced: 0,
  ...over,
})

/**
 * The badges the SERVER would have handed over (#458).
 *
 * The list and the badges are fetched by the page now; only the per-centre
 * `/budget` read in the modal is still a client fetch, so that is all `mockApi`
 * still routes.
 */
let serverBudgets: BudgetState[] = []

/**
 * The card, excluding the dialogs behind it.
 *
 * Every `Modal` renders whether or not it is open, and the delete dialog carries
 * its own copy of `deleteError` — so a page-level query for the message matches
 * twice while only one of them is on screen.
 */
const listCard = () =>
  (screen.getByRole('heading', { name: 'Cost Centers' }).closest('div.rounded-xl') as HTMLElement)

/** Render with whatever `mockApi` was told the budgets are. */
const renderManager = () =>
  render(
    <CostCentersManager
      initial={costCenters}
      initialBudgets={Object.fromEntries(serverBudgets.map((b) => [b.costCenterId, b]))}
    />,
  )

/** Route the GETs this screen still makes; `budgets` defaults to none set. */
function mockApi(budgets: BudgetState[] = [], perCentre?: BudgetState | Error) {
  serverBudgets = budgets
  mockedGet.mockReset().mockImplementation((async (url: string) => {
    if (url === '/api/admin/cost-centers') return costCenters
    if (url === '/api/admin/cost-centers/budgets') return budgets
    if (url.endsWith('/budget')) {
      if (perCentre instanceof Error) throw perCentre
      return perCentre ?? budgetState({ amount: null, currency: null, period: null, behaviour: null, committed: 0, remaining: 0 })
    }
    throw new Error(`unexpected GET ${url}`)
  }) as never)
  mockedPut.mockReset().mockResolvedValue(undefined as never)
  mockedDel.mockReset().mockResolvedValue(undefined as never)
}

beforeEach(() => mockApi())

describe('CostCentersManager budget badges (#325)', () => {
  it('shows committed over the limit, not the limit alone', async () => {
    mockApi([budgetState()])
    renderManager()

    // The number a person came for is how much is gone, so both halves are
    // rendered; a badge showing only "10000.00 EUR" repeats what they set.
    expect(await screen.findByText('2500.00 / 10000.00 EUR')).toBeInTheDocument()
  })

  it('marks an exhausted budget in words, not only in colour', async () => {
    mockApi([budgetState({ committed: 12_000, remaining: -2_000, exhausted: true })])
    renderManager()

    // #185: colour alone is not a carrier. The badge has to SAY it.
    expect(await screen.findByText(/Over budget/)).toBeInTheDocument()
  })

  it('renders no badge for a cost centre with no budget', async () => {
    mockApi([budgetState({ costCenterId: 2, amount: null, currency: null, period: null, behaviour: null })])
    renderManager()

    await screen.findByText('Platform')
    expect(screen.queryByText(/\d+\.\d\d \/ /)).not.toBeInTheDocument()
  })

  it('does not claim there are no cost centres when the load failed', async () => {
    // The error used to render ABOVE the list while "no cost centres yet"
    // rendered below it: two claims on one screen, one of them false, and the
    // false one is what an operator acts on (#415, #458).
    render(<CostCentersManager initial={[]} initialError="backend unreachable" />)

    expect(within(listCard()).getByText('backend unreachable')).toBeInTheDocument()
    expect(within(listCard()).queryByText(/no cost cent/i)).not.toBeInTheDocument()
  })

  it('says there are none when there really are none', async () => {
    render(<CostCentersManager initial={[]} />)
    expect(screen.getByText(/no cost cent/i)).toBeInTheDocument()
  })

  it('still lists the cost centres when the budgets request fails', async () => {
    // Renaming and retiring a cost centre must not become unreachable because
    // the budget endpoint is unhappy.
    // The page hands over an empty badge map when that request failed, and the
    // list is unaffected — an absent badge and an unknown budget look the same,
    // and neither claims a limit that is not there.
    render(<CostCentersManager initial={costCenters} initialBudgets={{}} />)

    expect(screen.getByText('Platform')).toBeInTheDocument()
    expect(screen.queryByText(/budgets are down/)).not.toBeInTheDocument()
  })
})

describe('CostCentersManager budget modal (#325)', () => {
  it('saves the amount, currency, period and behaviour that were chosen', async () => {
    const user = userEvent.setup()
    mockApi([], budgetState({ amount: null, currency: null, period: null, behaviour: null, committed: 400, remaining: 0 }))
    renderManager()

    await user.click((await screen.findAllByRole('button', { name: 'Budget' }))[0])
    const dialog = await screen.findByRole('dialog')

    // Committed is shown before a budget exists — that is what says whether the
    // limit about to be typed is already spent.
    expect(within(dialog).getByText('400.00 EUR')).toBeInTheDocument()

    await user.type(within(dialog).getByLabelText(/Amount/), '5000')
    // Lower case on purpose: exchange_rates stores upper-case codes, so a
    // currency that reaches the backend as 'chf' would never convert.
    await user.clear(within(dialog).getByLabelText(/Currency/))
    await user.type(within(dialog).getByLabelText(/Currency/), 'chf')
    await user.selectOptions(within(dialog).getByLabelText(/Period/), 'monthly')
    await user.selectOptions(within(dialog).getByLabelText(/When the budget is spent/), 'warn')
    await user.click(within(dialog).getByRole('button', { name: 'Save' }))

    await waitFor(() =>
      expect(mockedPut).toHaveBeenCalledWith('/api/admin/cost-centers/1/budget', {
        amount: 5000,
        currency: 'CHF',
        period: 'monthly',
        behaviour: 'warn',
      }),
    )
  })

  it('defaults a new budget to block rather than warn', async () => {
    const user = userEvent.setup()
    mockApi([], budgetState({ amount: null, currency: null, period: null, behaviour: null, committed: 0, remaining: 0 }))
    renderManager()

    await user.click((await screen.findAllByRole('button', { name: 'Budget' }))[0])
    const dialog = await screen.findByRole('dialog')
    // A budget nobody enforces is a note. The operator who typed a limit meant it.
    expect(within(dialog).getByLabelText(/When the budget is spent/)).toHaveValue('block')
  })

  it('prefills the existing budget when there is one', async () => {
    const user = userEvent.setup()
    mockApi([budgetState()], budgetState())
    renderManager()

    await user.click((await screen.findAllByRole('button', { name: 'Budget' }))[0])
    const dialog = await screen.findByRole('dialog')

    expect(within(dialog).getByLabelText(/Amount/)).toHaveValue(10000)
    expect(within(dialog).getByLabelText(/Currency/)).toHaveValue('EUR')
    expect(within(dialog).getByText('7500.00 EUR')).toBeInTheDocument()
  })

  it('asks before removing a budget, and removes it when confirmed', async () => {
    const user = userEvent.setup()
    mockApi([budgetState()], budgetState())
    renderManager()

    await user.click((await screen.findAllByRole('button', { name: 'Budget' }))[0])
    const dialog = await screen.findByRole('dialog')

    await user.click(within(dialog).getByRole('button', { name: 'Remove budget' }))
    // The first click must not have removed anything — this undoes a control on
    // spending, and it says what that means before it happens.
    expect(mockedDel).not.toHaveBeenCalled()
    expect(within(dialog).getByText(/stop being checked against a limit/)).toBeInTheDocument()

    // The standing button is hidden while the confirmation is up, so the one
    // left is the confirmation's own.
    const confirm = within(dialog).getAllByRole('button', { name: 'Remove budget' })
    expect(confirm).toHaveLength(1)
    await user.click(confirm[0])
    await waitFor(() => expect(mockedDel).toHaveBeenCalledWith('/api/admin/cost-centers/1/budget'))
  })

  it('offers no removal for a cost centre that has no budget', async () => {
    const user = userEvent.setup()
    mockApi([], budgetState({ amount: null, currency: null, period: null, behaviour: null }))
    renderManager()

    await user.click((await screen.findAllByRole('button', { name: 'Budget' }))[0])
    const dialog = await screen.findByRole('dialog')
    expect(within(dialog).queryByRole('button', { name: 'Remove budget' })).not.toBeInTheDocument()
  })

  it('does not carry one cost centre\'s budget into another whose load failed', async () => {
    /*
     * `cancelled` handles a late response. It does nothing about a FAILED one:
     * open A, open B, B's GET fails, and the form still held A's amount — so
     * Save would have written A's budget onto B, under B's own heading.
     */
    const user = userEvent.setup()
    mockedGet.mockReset().mockImplementation((async (url: string) => {
      if (url === '/api/admin/cost-centers') return costCenters
      if (url === '/api/admin/cost-centers/budgets') return []
      if (url === '/api/admin/cost-centers/1/budget') return budgetState({ amount: 9999, committed: 12 })
      throw new Error('the budget service is down')
    }) as never)
    renderManager()

    const buttons = await screen.findAllByRole('button', { name: 'Budget' })
    await user.click(buttons[0])
    let dialog = await screen.findByRole('dialog')
    expect(within(dialog).getByLabelText(/Amount/)).toHaveValue(9999)
    await user.click(within(dialog).getByRole('button', { name: 'Cancel' }))

    await user.click((await screen.findAllByRole('button', { name: 'Budget' }))[1])
    dialog = await screen.findByRole('dialog')

    expect(await within(dialog).findByText(/the budget service is down/)).toBeInTheDocument()
    // Not 9999 — the previous centre's figure is gone.
    expect(within(dialog).getByLabelText(/Amount/)).toHaveValue(null)
    // And there is nothing to save it against, so saving is refused outright.
    expect(within(dialog).getByRole('button', { name: 'Save' })).toBeDisabled()
    expect(mockedPut).not.toHaveBeenCalled()
  })

  it('says when committed spend is missing orders it could not price', async () => {
    // `committed` excludes them entirely and there is no number to add, so the
    // only honest thing is to say the figure beside it is incomplete.
    const user = userEvent.setup()
    const state = budgetState({ unpriced: 3 })
    mockApi([state], state)
    renderManager()

    await user.click((await screen.findAllByRole('button', { name: 'Budget' }))[0])
    const dialog = await screen.findByRole('dialog')
    expect(within(dialog).getByText(/no recoverable price/i)).toBeInTheDocument()
    expect(within(dialog).getByText(/no recoverable price[^]*3|3/)).toBeInTheDocument()
  })

  it('names the currencies it could not convert instead of folding them into the total', async () => {
    const user = userEvent.setup()
    const state = budgetState({ unconverted: [{ currency: 'JPY', amount: 90_000 }] })
    mockApi([state], state)
    renderManager()

    await user.click((await screen.findAllByRole('button', { name: 'Budget' }))[0])
    const dialog = await screen.findByRole('dialog')
    expect(within(dialog).getByText(/90000.00 JPY/)).toBeInTheDocument()
  })

  it('warns what monthly actually measures, and only for monthly', async () => {
    const user = userEvent.setup()
    mockApi([], budgetState({ amount: null, currency: null, period: null, behaviour: null }))
    renderManager()

    await user.click((await screen.findAllByRole('button', { name: 'Budget' }))[0])
    const dialog = await screen.findByRole('dialog')

    // A price here carries no billing period. Saying so is the difference
    // between a limit and a run rate the data cannot support.
    expect(within(dialog).queryByText(/counts orders placed in the month/i)).not.toBeInTheDocument()
    await user.selectOptions(within(dialog).getByLabelText(/Period/), 'monthly')
    expect(within(dialog).getByText(/counts orders placed in the month/i)).toBeInTheDocument()
  })

  it('reports a failed save without closing the modal', async () => {
    const user = userEvent.setup()
    mockApi([], budgetState())
    mockedPut.mockRejectedValue(new Error('Not found'))
    renderManager()

    await user.click((await screen.findAllByRole('button', { name: 'Budget' }))[0])
    const dialog = await screen.findByRole('dialog')
    await user.click(within(dialog).getByRole('button', { name: 'Save' }))

    expect(await within(dialog).findByText('Not found')).toBeInTheDocument()
    expect(within(dialog).getByLabelText(/Amount/)).toBeInTheDocument()
  })

  it('does not show one cost centre\'s budget under another\'s name', async () => {
    // The modal fetches on open. Opening a second row before the first response
    // lands must not paint the first row's figures under the second row's code.
    const user = userEvent.setup()
    let resolveFirst: ((v: BudgetState) => void) | undefined
    mockedGet.mockReset().mockImplementation((async (url: string) => {
      if (url === '/api/admin/cost-centers') return costCenters
      if (url === '/api/admin/cost-centers/budgets') return []
      if (url === '/api/admin/cost-centers/1/budget') {
        return new Promise<BudgetState>((resolve) => { resolveFirst = resolve })
      }
      return budgetState({ costCenterId: 2, amount: 50, currency: 'EUR', committed: 7, remaining: 43 })
    }) as never)
    renderManager()

    const buttons = await screen.findAllByRole('button', { name: 'Budget' })
    await user.click(buttons[0])
    await user.click(buttons[1])
    resolveFirst?.(budgetState({ committed: 999_999 }))

    const dialog = await screen.findByRole('dialog')
    await waitFor(() => expect(within(dialog).getByText('7.00 EUR')).toBeInTheDocument())
    expect(within(dialog).queryByText(/999999/)).not.toBeInTheDocument()
  })
})
