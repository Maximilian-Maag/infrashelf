import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, within } from '@testing-library/react'
import type * as Navigation from 'next/navigation'
import type { ProductDetail } from '@infrashelf/types'
import { ApiError } from '@/lib/api'
import ProductDetailPage from './page'

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

// The interactive parts fetch and navigate on their own; this file is the page.
vi.mock('./AddToCart', () => ({ AddToCart: () => <div data-testid="add-to-cart" /> }))
vi.mock('@/components/forms/OrderForm', () => ({
  OrderForm: ({ projects, costCenters }: { projects: unknown[]; costCenters: unknown[] }) =>
    <div data-testid="order-form" data-projects={projects.length} data-costcenters={costCenters.length} />,
}))
vi.mock('@/components/ui/ProductGallery', () => ({ ProductGallery: () => <div data-testid="gallery" /> }))
vi.mock('@/components/ui/ProductSpecs', () => ({
  ProductSpecs: ({ parameters }: { parameters: unknown[] }) => <div data-testid="specs" data-count={parameters.length} />,
}))
vi.mock('@/components/ui/ProductImage', () => ({ ProductImage: () => <span data-testid="thumb" /> }))

const get = vi.fn()
vi.mock('@/lib/serverApi', () => ({ get: (path: string) => get(path) }))

const size = (price: string, currency = 'EUR', code = 'small') => ({ code, label: code, price, currency })

const offering = (over: Record<string, unknown> = {}) => ({
  environmentId: 3, environmentName: 'prod', price: '100.00', currency: 'EUR', sizes: [], ...over,
})

const product = (over: Partial<ProductDetail> = {}): ProductDetail =>
  ({
    id: 2, name: 'Managed Postgres', description: 'a database', categoryId: 1,
    images: [], parameters: [], environments: [offering()], ...over,
  }) as unknown as ProductDetail

const answer = (over: Record<string, unknown> = {}) => {
  get.mockImplementation((path: string) => {
    const key = path.startsWith('/api/catalog/') ? 'product'
      : path.startsWith('/api/catalog?') ? 'related'
      : path.startsWith('/api/projects') ? 'projects'
      : path.startsWith('/api/admin/cost-centers') ? 'costCenters'
      : path.startsWith('/api/admin/exchange-rates') ? 'rates'
      : 'categories'
    const fallback: Record<string, unknown> = {
      product: product(), related: { items: [] }, projects: [{ id: 1, name: 'Platform' }],
      costCenters: [], rates: [], categories: [{ id: 1, name: 'Databases' }],
    }
    const v = key in over ? over[key] : fallback[key]
    return v instanceof Error ? Promise.reject(v) : Promise.resolve(v)
  })
}

const props = (query: Record<string, string> = {}) =>
  ({ params: Promise.resolve({ id: '2' }), searchParams: Promise.resolve(query) })

const signedInAs = (role: string) => auth.mockResolvedValue({ user: { id: '5', name: 'Ada', role } })
const envRow = (name: string) => screen.getByText(name).closest('li') as HTMLElement

beforeEach(() => {
  get.mockReset()
  redirect.mockClear()
  notFound.mockClear()
  vi.spyOn(console, 'error').mockImplementation(() => {})
  signedInAs('project_manager')
  answer()
})

/**
 * The product page, where "the price" is not one number: price moved to the size
 * (#98), each size carries its own currency, and the figure a shopper reads as
 * the price is the cheapest thing the product can be bought for.
 */
describe('ProductDetailPage', () => {
  it('sends a caller with no session to the login page', async () => {
    auth.mockResolvedValue(null)
    await expect(ProductDetailPage(props())).rejects.toThrow('NEXT_REDIRECT')
    expect(redirect).toHaveBeenCalledWith('/login')
  })

  it('is a 404 when the product does not exist', async () => {
    answer({ product: new ApiError(404, 'Product not found') })
    await expect(ProductDetailPage(props())).rejects.toThrow('NEXT_NOT_FOUND')
  })

  it('sends an ended session to the login page, not to a 404', async () => {
    const { redirect: realRedirect } = await vi.importActual<typeof Navigation>('next/navigation')
    let thrown: unknown
    try { realRedirect('/login?expired=1') } catch (e) { thrown = e }
    answer({ product: thrown })

    await expect(ProductDetailPage(props())).rejects.toThrow()
    expect(notFound, 'the redirect was swallowed and became a 404').not.toHaveBeenCalled()
  })

  it('does not let the RELATED fetch swallow the login redirect either', async () => {
    // `.catch(() => null)` on that call is the shape #434 was about, one line
    // rather than a block.
    const { redirect: realRedirect } = await vi.importActual<typeof Navigation>('next/navigation')
    let thrown: unknown
    try { realRedirect('/login?expired=1') } catch (e) { thrown = e }
    answer({ related: thrown })

    await expect(ProductDetailPage(props())).rejects.toThrow()
  })

  it('picks the cheapest offering by VALUE, not by the digits', async () => {
    // Each size carries its own currency, so the smallest number is not the
    // cheapest offer. 100 SEK is far less than 50 EUR.
    answer({
      rates: [{ currencyCode: 'SEK', rate: '11.00' }],
      product: product({ environments: [
        offering({ environmentId: 3, environmentName: 'prod', price: '50.00', currency: 'EUR' }),
        offering({ environmentId: 4, environmentName: 'dev', price: '100.00', currency: 'SEK' }),
      ] } as never),
    })
    render(await ProductDetailPage(props()))

    // The buy box exists, which means a cheapest was found at all.
    expect(screen.getByTestId('add-to-cart')).toBeInTheDocument()
    // And both offerings are listed with their own prices.
    expect(within(envRow('prod')).getByText(/50\.00 EUR/)).toBeInTheDocument()
    expect(within(envRow('dev')).getByText(/9\.09 EUR/)).toBeInTheDocument()
  })

  it('shows a range when an offering’s sizes differ, and one figure when they do not', async () => {
    answer({ product: product({ environments: [
      offering({ environmentId: 3, environmentName: 'prod', sizes: [size('10.00'), size('90.00', 'EUR', 'large')] }),
      offering({ environmentId: 4, environmentName: 'dev', sizes: [size('10.00'), size('10.00', 'EUR', 'large')] }),
    ] } as never) })
    render(await ProductDetailPage(props()))

    expect(within(envRow('prod')).getByText('10.00 EUR – 90.00 EUR')).toBeInTheDocument()
    expect(within(envRow('dev')).getByText('10.00 EUR')).toBeInTheDocument()
  })

  it('does not collapse two sizes that share a number but not a currency', async () => {
    // "10" and "10" are two different prices when one is EUR and one is SEK, and
    // collapsing them to one figure hides that.
    answer({
      rates: [{ currencyCode: 'SEK', rate: '11.00' }],
      product: product({ environments: [
        offering({ environmentName: 'prod', sizes: [size('10.00', 'SEK'), size('10.00', 'EUR', 'large')] }),
      ] } as never),
    })
    render(await ProductDetailPage(props()))

    expect(within(envRow('prod')).getByText(/–/)).toBeInTheDocument()
  })

  it('falls back to the offering’s own price when it defines no sizes', async () => {
    // Every offering that predates sizing.
    render(await ProductDetailPage(props()))
    expect(within(envRow('prod')).getByText('100.00 EUR')).toBeInTheDocument()
  })

  it('shows the original alongside a converted price', async () => {
    answer({
      rates: [{ currencyCode: 'SEK', rate: '11.00' }],
      product: product({ environments: [offering({ environmentName: 'prod', price: '110.00', currency: 'SEK' })] } as never),
    })
    render(await ProductDetailPage(props()))

    const row = envRow('prod')
    expect(within(row).getByText('10.00 EUR')).toBeInTheDocument()
    expect(within(row).getByText('(110.00 SEK)')).toBeInTheDocument()
  })

  it('names an offering with no environment name by its id', async () => {
    answer({ product: product({ environments: [offering({ environmentId: 9, environmentName: null })] } as never) })
    render(await ProductDetailPage(props()))
    expect(screen.getByText('Env 9')).toBeInTheDocument()
  })

  it('omits the buy box outright when the product is offered nowhere', async () => {
    // A price box with no price and no working button is worse than none.
    answer({ product: product({ environments: [] } as never) })
    render(await ProductDetailPage(props()))

    expect(screen.queryByTestId('add-to-cart')).not.toBeInTheDocument()
    expect(screen.queryByText('Available Environments')).not.toBeInTheDocument()
    // The order form below is still there — the page is not an error page.
    expect(screen.getByTestId('order-form')).toBeInTheDocument()
  })

  it('says whether ordering needs approval, per the VIEWER’s role', async () => {
    // A property of the role, not of the product: `createOrder` branches on
    // exactly this.
    const pm = render(await ProductDetailPage(props()))
    expect(within(pm.container).getByText('Needs approval before it is provisioned.')).toBeInTheDocument()
    pm.unmount()

    for (const role of ['admin', 'root']) {
      signedInAs(role)
      const { container, unmount } = render(await ProductDetailPage(props()))
      expect(within(container).getByText('Provisioned as soon as you order it.'), role).toBeInTheDocument()
      unmount()
    }
  })

  it('renders the long description as paragraphs, never as markup', async () => {
    // Splitting on blank lines rather than rendering HTML: the alternative is
    // injecting operator-supplied markup into the page.
    answer({ product: product({ longDescription: 'First para.\n\n  \n\nSecond <b>para</b>.' } as never) })
    render(await ProductDetailPage(props()))

    expect(screen.getByText('First para.')).toBeInTheDocument()
    // The tag is text, not an element.
    expect(screen.getByText('Second <b>para</b>.')).toBeInTheDocument()
    expect(document.querySelector('b')).toBeNull()
  })

  it('leaves the long-description section out when nobody wrote one', async () => {
    render(await ProductDetailPage(props()))
    expect(screen.queryByText('About this product')).not.toBeInTheDocument()
  })

  it('shows the owner and the docs link only when they exist', async () => {
    answer({ product: product({ owner: 'Platform team', docsUrl: 'https://docs.example.com/pg' } as never) })
    const withBoth = render(await ProductDetailPage(props()))
    expect(within(withBoth.container).getByText('Platform team')).toBeInTheDocument()
    const link = within(withBoth.container).getByRole('link', { name: 'https://docs.example.com/pg' })
    // Underlined at rest: colour alone is not enough (WCAG 1.4.1). And it leaves
    // the app, so it carries the opener guard.
    expect(link).toHaveClass('underline')
    expect(link).toHaveAttribute('rel', 'noopener noreferrer')
    withBoth.unmount()

    answer()
    render(await ProductDetailPage(props()))
    expect(screen.queryByText('Owner')).not.toBeInTheDocument()
    expect(screen.queryByText('Documentation')).not.toBeInTheDocument()
  })

  it('locates the product in the catalogue without linking the category', async () => {
    // The catalogue's category filter is client state, not a URL parameter, so
    // there is nothing to link to — and a crumb that is not a link is still a
    // location.
    render(await ProductDetailPage(props()))

    expect(screen.getByRole('link', { name: 'Catalog' })).toHaveAttribute('href', '/catalog')
    // Twice on purpose: the crumb locates the product, the eyebrow under the
    // heading labels it. Neither is a link.
    expect(screen.getAllByText('Databases')).toHaveLength(2)
    expect(screen.queryByRole('link', { name: 'Databases' })).not.toBeInTheDocument()
  })

  it('leaves the category crumb out when the product has none', async () => {
    answer({ categories: [] })
    render(await ProductDetailPage(props()))
    expect(screen.queryByText('Databases')).not.toBeInTheDocument()
    expect(screen.getByRole('link', { name: 'Catalog' })).toBeInTheDocument()
  })

  it('shows the specifications only when the product takes parameters', async () => {
    answer({ product: product({ parameters: [{ name: 'db_name', label: 'Database' }] } as never) })
    const withSpecs = render(await ProductDetailPage(props()))
    expect(within(withSpecs.container).getByTestId('specs')).toHaveAttribute('data-count', '1')
    withSpecs.unmount()

    answer()
    render(await ProductDetailPage(props()))
    expect(screen.queryByTestId('specs')).not.toBeInTheDocument()
  })

  it('offers other products in the category, never the one being viewed', async () => {
    answer({ related: { items: [{ id: 2, name: 'Managed Postgres' }, { id: 7, name: 'Managed Redis' }] } })
    render(await ProductDetailPage(props()))

    expect(screen.getByRole('link', { name: 'Managed Redis' })).toHaveAttribute('href', '/catalog/7')
    expect(screen.queryByRole('link', { name: 'Managed Postgres' })).not.toBeInTheDocument()
  })

  it('leaves the related section out when the category holds nothing else', async () => {
    answer({ related: { items: [{ id: 2, name: 'Managed Postgres' }] } })
    render(await ProductDetailPage(props()))
    expect(screen.queryByText('Other products in this category')).not.toBeInTheDocument()
  })

  it('says why the order form is short of options, without taking the form away', async () => {
    // A user who sees an empty project list with no explanation reports it as
    // "I cannot order this" (#415).
    answer({ projects: new ApiError(403, 'Forbidden') })
    render(await ProductDetailPage(props()))

    expect(screen.getByRole('alert')).toHaveTextContent('HTTP 403: Forbidden')
    expect(screen.getByTestId('order-form')).toBeInTheDocument()
    expect(screen.getByTestId('order-form')).toHaveAttribute('data-projects', '0')
  })

  it('carries a quick-reorder’s context into the form', async () => {
    // The infrastructure list links here with the element and project it was
    // reordering from (#39).
    render(await ProductDetailPage(props({ fromInfra: '21', projectId: '4' })))
    expect(screen.getByTestId('order-form')).toBeInTheDocument()
  })
})
