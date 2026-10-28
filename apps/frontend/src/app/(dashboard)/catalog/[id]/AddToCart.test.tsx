import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type { ProductDetail, ProductEnvironment, OfferingSize } from '@infrashelf/types'

vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh: vi.fn(), push: vi.fn() }) }))
vi.mock('@/lib/api', () => ({ post: vi.fn(), get: vi.fn().mockResolvedValue([]) }))
vi.mock('@/components/layout/CartLink', () => ({ publishCartCount: vi.fn() }))

import { AddToCart } from './AddToCart'

const size = (over: Partial<OfferingSize>): OfferingSize => ({
  id: 1, code: 'S', label: 'Small', price: '10.00', currency: 'EUR', sortOrder: 0, active: true, ...over,
})

const offering = (over: Partial<ProductEnvironment>): ProductEnvironment => ({
  productId: 1, environmentId: 1, price: '5.00', currency: 'EUR',
  costCenterMode: 'project', forcedCostCenter: false, overheadCostCenterId: null,
  trialEnabled: false, trialDurationMinutes: 0,
  ...over,
} as ProductEnvironment)

const product = (envs: ProductEnvironment[]): ProductDetail => ({
  id: 1, categoryId: 1, baseLanguage: 'en', name: 'VM', description: '',
  createdAt: new Date().toISOString(), environments: envs, parameters: [], images: [],
  longDescription: '', owner: null, docsUrl: null,
} as unknown as ProductDetail)

beforeEach(() => vi.clearAllMocks())

/**
 * The buy box price used to be rendered by the page, server-side, as the
 * cheapest thing the product could be bought for. Since the size IS the price,
 * a figure that stays at the S price while the shopper picks XL is the one
 * thing a buy box must not do.
 */
describe('the headline price follows the choice', () => {
  const sized = [
    offering({
      environmentId: 1,
      sizes: [
        size({ id: 1, code: 'S', label: 'Small', price: '10.00' }),
        size({ id: 2, code: 'XL', label: 'Extra large', price: '80.00' }),
      ],
    } as Partial<ProductEnvironment>),
  ]

  it('starts at the cheapest, before anything is chosen', () => {
    render(<AddToCart product={product(sized)} ratesMap={{}} baseCurrency="EUR" lang="en" />)
    // Twice for the cheapest — the headline and its own swatch — and once for
    // the dearer one, which is only on its swatch.
    expect(screen.getAllByText(/10\.00 EUR/)).toHaveLength(2)
    expect(screen.getAllByText(/80\.00 EUR/)).toHaveLength(1)
  })

  it('moves to the chosen size', async () => {
    render(<AddToCart product={product(sized)} ratesMap={{}} baseCurrency="EUR" lang="en" />)

    // One offering, so the environment is preselected and the swatches show.
    await userEvent.click(screen.getByRole('radio', { name: /extra large/i }))

    // Now the dearer one is in both places and the cheaper one only on its swatch.
    expect(screen.getAllByText(/80\.00 EUR/)).toHaveLength(2)
    expect(screen.getAllByText(/10\.00 EUR/)).toHaveLength(1)
  })

  // An offering with no sizes keeps its own price, which is the case every
  // offering that predates sizing is in.
  it('uses the offering price when there are no sizes', () => {
    render(<AddToCart product={product([offering({ environmentId: 1, price: '42.00' })])} ratesMap={{}} baseCurrency="EUR" lang="en" />)
    expect(screen.getByText(/42\.00 EUR/)).toBeInTheDocument()
    expect(screen.queryByRole('radio')).toBeNull()
  })
})
