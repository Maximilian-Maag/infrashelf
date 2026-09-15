import { describe, it, expect, vi, beforeAll, beforeEach } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type { BudgetState, CostCenter } from '@infrashelf/types'
import { BudgetModal, formatBudgetMoney } from './BudgetModal'

vi.mock('@/lib/api', () => ({ get: vi.fn(), put: vi.fn(), del: vi.fn() }))
import { get, put, del } from '@/lib/api'

// jsdom does not implement the native <dialog> methods; stub them so the
// open/close effects don't throw.
beforeAll(() => {
  HTMLDialogElement.prototype.showModal = vi.fn(function (this: HTMLDialogElement) { this.open = true })
  HTMLDialogElement.prototype.close = vi.fn(function (this: HTMLDialogElement) { this.open = false })
})

const centre = (id: number, code: string): CostCenter =>
  ({ id, code, name: `Centre ${code}` }) as CostCenter

const budget = (over: Partial<BudgetState> = {}): BudgetState =>
  ({
    amount: 1000,
    currency: 'EUR',
    period: 'total',
    behaviour: 'block',
    committed: 250,
    remaining: 750,
    exhausted: false,
    unpriced: 0,
    unconverted: [],
    ...over,
  }) as BudgetState

const open = (target: CostCenter | null, props: Partial<Parameters<typeof BudgetModal>[0]> = {}) =>
  render(
    <BudgetModal target={target} onClose={props.onClose ?? vi.fn()} onSaved={props.onSaved ?? vi.fn()} lang="en" />,
  )

beforeEach(() => {
  vi.mocked(get).mockReset().mockResolvedValue(budget() as never)
  vi.mocked(put).mockReset().mockResolvedValue(undefined as never)
  vi.mocked(del).mockReset().mockResolvedValue(undefined as never)
})

describe('formatBudgetMoney', () => {
  it('always shows two decimals, so amounts line up in a column', () => {
    expect(formatBudgetMoney(1234.5, 'EUR')).toBe('1234.50 EUR')
    expect(formatBudgetMoney(0, 'CHF')).toBe('0.00 CHF')
    // Rounds rather than truncating: 0.005 of a currency unit is not free.
    expect(formatBudgetMoney(9.999, 'EUR')).toBe('10.00 EUR')
  })
})

describe('BudgetModal', () => {
  it('asks the backend for THIS centre’s budget when it opens', async () => {
    open(centre(7, 'CC-7'))
    await waitFor(() => expect(get).toHaveBeenCalledWith('/api/admin/cost-centers/7/budget'))
  })

  it('fetches nothing while it is closed', () => {
    open(null)
    expect(get).not.toHaveBeenCalled()
  })

  it('shows what is already committed, and what is left', async () => {
    open(centre(7, 'CC-7'))
    // The number that says whether the limit below is already spent — which is
    // why it is fetched live rather than copied out of the list behind.
    expect(await screen.findByText('250.00 EUR')).toBeInTheDocument()
    expect(screen.getByText('750.00 EUR')).toBeInTheDocument()
  })

  it('shows what is committed even before a budget exists', async () => {
    vi.mocked(get).mockResolvedValue(budget({ amount: null, remaining: 0 }) as never)
    open(centre(7, 'CC-7'))

    expect(await screen.findByText('250.00 EUR')).toBeInTheDocument()
    // No budget yet, so there is no "remaining" to speak of.
    expect(screen.queryByText('0.00 EUR')).not.toBeInTheDocument()
  })

  it('does not carry one centre’s budget over to another', async () => {
    // The documented failure: open A, open B, B's GET fails, and the form still
    // holds A's amount — so saving wrote A's limit onto B under B's own heading.
    const { rerender } = open(centre(1, 'CC-1'))
    expect(await screen.findByDisplayValue('1000')).toBeInTheDocument()

    vi.mocked(get).mockRejectedValue(new Error('backend unreachable'))
    rerender(<BudgetModal target={centre(2, 'CC-2')} onClose={vi.fn()} onSaved={vi.fn()} lang="en" />)

    await screen.findByText('backend unreachable')
    expect(screen.queryByDisplayValue('1000')).not.toBeInTheDocument()
    // And there is nothing to save it against, so the button cannot be pressed.
    expect(screen.getByRole('button', { name: 'Save' })).toBeDisabled()
  })

  it('uppercases and trims the currency before sending it', async () => {
    // The backend compares against `exchange_rates.currency_code`, which is
    // upper case; a lower-case 'eur' lands as an unconvertible currency.
    const user = userEvent.setup()
    open(centre(7, 'CC-7'))
    const currency = await screen.findByLabelText(/currency/i)

    await user.clear(currency)
    await user.type(currency, '  chf  ')
    await user.click(screen.getByRole('button', { name: 'Save' }))

    await waitFor(() =>
      expect(put).toHaveBeenCalledWith('/api/admin/cost-centers/7/budget', {
        amount: 1000,
        currency: 'CHF',
        period: 'total',
        behaviour: 'block',
      }),
    )
  })

  it('tells the list to refresh and closes, but only after the save landed', async () => {
    const onSaved = vi.fn()
    const onClose = vi.fn()
    const user = userEvent.setup()
    open(centre(7, 'CC-7'), { onSaved, onClose })

    await screen.findByDisplayValue('1000')
    await user.click(screen.getByRole('button', { name: 'Save' }))

    await waitFor(() => expect(onSaved).toHaveBeenCalled())
    expect(onClose).toHaveBeenCalled()
  })

  it('keeps the modal open when the save fails', async () => {
    // Closing on a failed save would lose what the operator typed and tell them
    // it worked.
    const onSaved = vi.fn()
    const onClose = vi.fn()
    vi.mocked(put).mockRejectedValue(new Error('budget below committed spend'))
    const user = userEvent.setup()
    open(centre(7, 'CC-7'), { onSaved, onClose })

    await screen.findByDisplayValue('1000')
    await user.click(screen.getByRole('button', { name: 'Save' }))

    expect(await screen.findByText('budget below committed spend')).toBeInTheDocument()
    expect(onSaved).not.toHaveBeenCalled()
    expect(onClose).not.toHaveBeenCalled()
  })

  it('asks before removing a budget, and only then removes it', async () => {
    // It undoes a control on spending, and the list behind is not where the
    // consequence is written down.
    const onSaved = vi.fn()
    const user = userEvent.setup()
    open(centre(7, 'CC-7'), { onSaved })

    await user.click(await screen.findByRole('button', { name: 'Remove budget' }))
    expect(del).not.toHaveBeenCalled()

    // Two buttons now carry that name; the one inside the confirmation is the
    // one that acts.
    const confirm = screen.getByRole('alert').querySelector('button')
    await user.click(confirm as HTMLElement)

    await waitFor(() => expect(del).toHaveBeenCalledWith('/api/admin/cost-centers/7/budget'))
    expect(onSaved).toHaveBeenCalled()
  })

  it('offers no removal when there is no budget to remove', async () => {
    vi.mocked(get).mockResolvedValue(budget({ amount: null }) as never)
    open(centre(7, 'CC-7'))

    await screen.findByText('250.00 EUR')
    expect(screen.queryByRole('button', { name: 'Remove budget' })).not.toBeInTheDocument()
  })

  it('defaults an unset enforcement to block, not warn', async () => {
    // A budget nobody enforces is a note, and the operator who typed a limit
    // meant it.
    vi.mocked(get).mockResolvedValue(budget({ behaviour: null } as Partial<BudgetState>) as never)
    const user = userEvent.setup()
    open(centre(7, 'CC-7'))

    await screen.findByDisplayValue('1000')
    await user.click(screen.getByRole('button', { name: 'Save' }))

    await waitFor(() =>
      expect(put).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ behaviour: 'block' })),
    )
  })

  it('says when spend is missing from the committed figure', async () => {
    // A caveat nobody sees is not a caveat: these orders' spend is absent from
    // `committed` and there is no number to add — the price is unknown, not
    // small.
    vi.mocked(get).mockResolvedValue(budget({ unpriced: 3, unconverted: [{ amount: 40, currency: 'GBP' }] }) as never)
    open(centre(7, 'CC-7'))

    expect(await screen.findByText(/3/)).toBeInTheDocument()
    expect(screen.getByText(/40\.00 GBP/)).toBeInTheDocument()
  })
})
