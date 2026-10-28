import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type { ExchangeRate } from '@infrashelf/types'
import { ExchangeRatesTable } from './ExchangeRatesTable'

vi.mock('@/lib/api', () => ({ get: vi.fn(), post: vi.fn(), put: vi.fn() }))
import { get, post, put } from '@/lib/api'

const rate = (over: Partial<ExchangeRate> = {}): ExchangeRate =>
  ({ currencyCode: 'SEK', rate: '11.234567', updatedAt: '2026-01-01T09:00:00.000Z', ...over }) as ExchangeRate

const refresh = () => screen.getByRole('button', { name: 'Refresh Rates' })
const row = (code: string) => screen.getByText(code).closest('tr') as HTMLElement

beforeEach(() => {
  vi.mocked(get).mockReset().mockResolvedValue([rate()] as never)
  vi.mocked(post).mockReset().mockResolvedValue(undefined as never)
  vi.mocked(put).mockReset().mockResolvedValue({ baseCurrency: 'USD' } as never)
})

/**
 * Every price in the app is converted with these, so a wrong or stale rate is
 * wrong everywhere at once — the catalogue, the cart, the cost report and the
 * budgets all read the same table.
 */
describe('ExchangeRatesTable', () => {
  it('lists each currency with its rate and when it was last updated', async () => {
    render(<ExchangeRatesTable initial={[rate()]} />)

    expect(screen.getByText('SEK')).toBeInTheDocument()
    expect(within(row('SEK')).getByText(/11\.234567/)).toBeInTheDocument()
    expect(within(row('SEK')).getByText(new RegExp(new Date('2026-01-01T09:00:00.000Z').getFullYear().toString())))
      .toBeInTheDocument()
  })

  it('shows six decimal places, because a rate is not money', async () => {
    // Two would collapse currencies that differ in the fourth, and every
    // converted figure in the app inherits that error.
    render(<ExchangeRatesTable initial={[rate({ rate: '0.0000105' }), rate({ currencyCode: 'CHF', rate: '0.93' })]} />)

    // `0.0000105` keeps its sixth place rather than collapsing to `0.00`, and a
    // whole-ish rate is padded out so the column lines up. (Binary rounding puts
    // the boundary case down, which is the platform's answer, not a choice this
    // component makes.)
    expect(await screen.findByText('0.000010')).toBeInTheDocument()
    expect(screen.getByText('0.930000')).toBeInTheDocument()
  })

  it('identifies a row by its currency code, which is what the table has', async () => {
    // There is no id column on this table — the code is the key, and two rows
    // sharing a React key would silently drop one.
    render(<ExchangeRatesTable initial={[rate({ currencyCode: 'SEK' }), rate({ currencyCode: 'NOK' })]} />)

    expect(screen.getByText('SEK')).toBeInTheDocument()
    expect(screen.getByText('NOK')).toBeInTheDocument()
  })

  it('says there are none rather than showing an empty frame', async () => {
    render(<ExchangeRatesTable initial={[]} />)
    expect(screen.getByText('No exchange rates configured.')).toBeInTheDocument()
  })

  it('reloads the table after a refresh', async () => {
    // A refresh that leaves the old figures on screen is worse than none: the
    // operator believes the new ones are what they are looking at.
    const u = userEvent.setup()
    render(<ExchangeRatesTable initial={[rate()]} />)
    expect(screen.getByText('SEK')).toBeInTheDocument()

    vi.mocked(get).mockResolvedValue([rate({ rate: '12.000000' })] as never)
    await u.click(refresh())

    expect(await screen.findByText('12.000000')).toBeInTheDocument()
    expect(post).toHaveBeenCalledWith('/api/admin/exchange-rates/refresh', {})
  })

  it('refuses a second refresh while one is running', async () => {
    let release: (v: unknown) => void = () => {}
    vi.mocked(post).mockImplementation((() => new Promise((r) => { release = r })) as never)
    const u = userEvent.setup()
    render(<ExchangeRatesTable initial={[rate()]} />)
    expect(screen.getByText('SEK')).toBeInTheDocument()

    await u.click(refresh())
    const busy = await screen.findByRole('button', { name: 'Refreshing…' })
    expect(busy).toBeDisabled()

    release(undefined)
    await waitFor(() => expect(screen.getByRole('button', { name: 'Refresh Rates' })).toBeEnabled())
  })

  it('says why a refresh failed, and leaves the previous rates standing', async () => {
    // Stale rates the operator knows are stale beat an empty table.
    vi.mocked(post).mockRejectedValue(new Error('the rate provider refused the request'))
    const u = userEvent.setup()
    render(<ExchangeRatesTable initial={[rate()]} />)
    expect(screen.getByText('SEK')).toBeInTheDocument()

    await u.click(refresh())

    expect(await screen.findByText('the rate provider refused the request')).toBeInTheDocument()
    expect(screen.getByText('11.234567')).toBeInTheDocument()
  })
})

/**
 * The base currency (FA-11.3, #592). It decides what every stored price MEANS, so
 * the control, the column header and the reload after a change all have to be
 * right — a header still reading "(to EUR)" after root switches to USD is the
 * screen lying about the figures underneath it.
 */
describe('ExchangeRatesTable — the base currency', () => {
  const baseField = () => screen.getByRole('textbox', { name: 'Base currency' })
  const saveBase = () => screen.getByRole('button', { name: 'Save' })

  it('shows the configured base and labels the rate column with it', () => {
    render(<ExchangeRatesTable initial={[rate()]} initialBaseCurrency="USD" />)
    expect(baseField()).toHaveValue('USD')
    expect(screen.getByText('Rate (USD)')).toBeInTheDocument()
  })

  it('defaults to EUR and labels the column accordingly when nothing is passed', () => {
    render(<ExchangeRatesTable initial={[rate()]} />)
    expect(baseField()).toHaveValue('EUR')
    expect(screen.getByText('Rate (EUR)')).toBeInTheDocument()
  })

  it('saves the code, reloads the (re-based) rates and confirms', async () => {
    // Changing the base re-bases every stored rate, so the figures on screen are
    // stale until the reload lands.
    const u = userEvent.setup()
    render(<ExchangeRatesTable initial={[rate()]} initialBaseCurrency="EUR" />)

    vi.mocked(get).mockResolvedValue([rate({ rate: '1.000000' })] as never)
    await u.clear(baseField())
    await u.type(baseField(), 'usd')
    await u.click(saveBase())

    await waitFor(() => expect(put).toHaveBeenCalledWith(
      '/api/admin/exchange-rates/base-currency',
      { baseCurrency: 'USD' },
    ))
    expect(get).toHaveBeenCalledWith('/api/admin/exchange-rates')
    expect(await screen.findByText('Base currency updated.')).toBeInTheDocument()
    // The header follows the code that was actually accepted.
    expect(screen.getByText('Rate (USD)')).toBeInTheDocument()
  })

  it('surfaces the backend refusal and leaves the configured base alone', async () => {
    // A 409 (no rate stored for that currency) says what to do about it; the
    // header must not move to a currency the backend refused.
    vi.mocked(put).mockRejectedValue(new Error('No usable exchange rate is stored for CHF'))
    const u = userEvent.setup()
    render(<ExchangeRatesTable initial={[rate()]} initialBaseCurrency="EUR" />)

    await u.clear(baseField())
    await u.type(baseField(), 'CHF')
    await u.click(saveBase())

    expect(await screen.findByText('No usable exchange rate is stored for CHF')).toBeInTheDocument()
    expect(screen.getByText('Rate (EUR)')).toBeInTheDocument()
  })

  it('will not submit an empty code', async () => {
    const u = userEvent.setup()
    render(<ExchangeRatesTable initial={[rate()]} initialBaseCurrency="EUR" />)

    await u.clear(baseField())
    expect(saveBase()).toBeDisabled()
  })
})
