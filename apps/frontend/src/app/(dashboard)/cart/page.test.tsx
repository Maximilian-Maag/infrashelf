import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen } from '@testing-library/react'
import type * as Navigation from 'next/navigation'
import { ApiError } from '@/lib/api'
import CartPage from './page'

const auth = vi.fn()
vi.mock('@/lib/auth', () => ({ auth: () => auth() }))
let lang = 'en'
vi.mock('@/lib/getLang', () => ({ getLang: async () => lang }))

const redirect = vi.fn((url: string) => { throw new Error(`NEXT_REDIRECT:${url}`) })
vi.mock('next/navigation', async (importOriginal) => ({
  ...(await importOriginal<typeof Navigation>()),
  redirect: (url: string) => redirect(url),
}))

// The checkout is its own component with its own fetches; this file is about
// what the page hands it, because every one of those props is a decision.
vi.mock('./CartView', () => ({
  CartView: (props: {
    initialItems: unknown[]
    projects: unknown[]
    costCenters: unknown[]
    exchangeRates: Record<string, number>
    localeCurrency: string
  }) => (
    <div
      data-testid="cart"
      data-items={props.initialItems.length}
      data-projects={props.projects.length}
      data-costcenters={props.costCenters.length}
      data-rates={JSON.stringify(props.exchangeRates)}
      data-currency={props.localeCurrency}
    />
  ),
}))

const get = vi.fn()
vi.mock('@/lib/serverApi', () => ({ get: (path: string) => get(path) }))

const answer = (over: Record<string, unknown> = {}) => {
  get.mockImplementation((path: string) => {
    const key = path.startsWith('/api/cart') ? 'cart'
      : path.startsWith('/api/projects') ? 'projects'
      : path.includes('cost-centers') ? 'costCenters'
      : 'rates'
    const fallback: Record<string, unknown> = {
      cart: [{ id: 1 }, { id: 2 }],
      projects: [{ id: 4 }],
      costCenters: [{ id: 9 }],
      rates: [{ currencyCode: 'CHF', rate: '0.95' }],
    }
    const v = key in over ? over[key] : fallback[key]
    return v instanceof Error ? Promise.reject(v) : Promise.resolve(v)
  })
}

const cart = () => screen.getByTestId('cart')

beforeEach(() => {
  get.mockReset()
  redirect.mockClear()
  lang = 'en'
  vi.spyOn(console, 'error').mockImplementation(() => {})
  auth.mockResolvedValue({ user: { id: '3', role: 'user' } })
  answer()
})

/**
 * An empty cart and a cart that could not be fetched look identical, and the
 * second is the one that makes somebody think their basket was thrown away
 * (#415). Four independent reads, three of which are allowed to fail without
 * taking the checkout down — but none of them silently.
 */
describe('CartPage', () => {
  it('sends a caller with no session to the login page', async () => {
    auth.mockResolvedValue(null)
    await expect(CartPage()).rejects.toThrow('NEXT_REDIRECT')
    expect(redirect).toHaveBeenCalledWith('/login')
  })

  it('asks for the cart in the language the page renders in', async () => {
    lang = 'de'
    render(await CartPage())
    expect(get).toHaveBeenCalledWith('/api/cart?lang=de')
  })

  it('hands the checkout what it read', async () => {
    render(await CartPage())
    expect(cart()).toHaveAttribute('data-items', '2')
    expect(cart()).toHaveAttribute('data-projects', '1')
    expect(cart()).toHaveAttribute('data-costcenters', '1')
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
  })

  it('reports a cart it could not read rather than showing an empty one', async () => {
    answer({ cart: new ApiError(502, 'Bad Gateway') })
    render(await CartPage())

    expect(screen.getByRole('alert')).toHaveTextContent('HTTP 502: Bad Gateway')
    expect(console.error).toHaveBeenCalledWith('[page] could not load cart: HTTP 502: Bad Gateway')
  })

  it('says so when the project list is missing, rather than offering an empty picker', async () => {
    // A checkout form with an empty project list is unusable, and "there are no
    // projects" is the wrong reason to give for it.
    answer({ projects: new ApiError(403, 'Forbidden') })
    render(await CartPage())

    expect(screen.getByRole('alert')).toHaveTextContent('HTTP 403: Forbidden')
    // The cart itself is still there: one failed read must not take the others.
    expect(cart()).toHaveAttribute('data-items', '2')
  })

  it('turns the rates into a lookup the checkout can use', async () => {
    render(await CartPage())
    expect(cart()).toHaveAttribute('data-rates', JSON.stringify({ CHF: 0.95 }))
  })

  it('loses the rates quietly, because the figure stays true without them', async () => {
    // Without rates `convertPrice` returns the amount in the currency it is
    // stored in, LABELLED with that currency — so there is nothing to warn the
    // user about. The trace is for whoever wonders why the totals came back in
    // EUR.
    answer({ rates: new ApiError(500, 'boom') })
    render(await CartPage())

    expect(cart()).toHaveAttribute('data-rates', '{}')
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
    expect(console.error).toHaveBeenCalledWith('[page] could not load exchange rates: HTTP 500: boom')
  })

  it('sends an ended session to the login page, not into an empty basket', async () => {
    const { redirect: realRedirect } = await vi.importActual<typeof Navigation>('next/navigation')
    let thrown: unknown
    try { realRedirect('/login?expired=1') } catch (e) { thrown = e }
    answer({ cart: thrown })

    await expect(CartPage()).rejects.toThrow()
  })
})
