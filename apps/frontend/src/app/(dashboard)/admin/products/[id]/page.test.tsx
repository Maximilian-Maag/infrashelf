import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen } from '@testing-library/react'
import type * as Navigation from 'next/navigation'
import { ApiError } from '@/lib/api'
import ProductEditPage from './page'

const auth = vi.fn()
vi.mock('@/lib/auth', () => ({ auth: () => auth() }))
vi.mock('@/lib/getLang', () => ({ getLang: async () => 'en' }))

const redirect = vi.fn((url: string) => { throw new Error(`NEXT_REDIRECT:${url}`) })
const notFound = vi.fn(() => { throw new Error('NEXT_NOT_FOUND') })
vi.mock('next/navigation', async (importOriginal) => ({
  ...(await importOriginal<typeof Navigation>()),
  redirect: (url: string) => redirect(url),
  notFound: () => notFound(),
}))

const get = vi.fn()
vi.mock('@/lib/serverApi', () => ({ get: (path: string) => get(path) }))

vi.mock('../ProductImageUpload', () => ({
  ProductImageUpload: ({ initial, initialError }: { initial: unknown[]; initialError: string | null }) =>
    <div data-testid="gallery" data-count={initial.length} data-error={initialError ?? ''} />,
}))
vi.mock('./ProductEditForm', () => ({
  ProductEditForm: ({ categories, environments, translations, costCenters, initialSizes }: {
    categories: unknown[]
    environments: unknown[]
    translations: unknown[]
    costCenters: unknown[]
    initialSizes?: { rows: unknown[] }
  }) =>
    <div
      data-testid="form"
      data-categories={categories.length}
      data-environments={environments.length}
      data-translations={translations.length}
      data-costcenters={costCenters.length}
      // 'unknown' and 'none' are different answers, which is the whole point of
      // the prop: one says the read failed, the other says nothing is priced.
      data-sizes={initialSizes === undefined ? 'unknown' : String(initialSizes.rows.length)}
    />,
}))

const product = { id: 7, name: 'Managed Postgres', categoryId: 1 }

const answer = (over: Record<string, unknown> = {}) => {
  get.mockImplementation((path: string) => {
    const key = /\/products\/\d+$/.test(path) ? 'product'
      : path.endsWith('/sizes') ? 'sizes'
      : path.endsWith('/images') ? 'images'
      : path.endsWith('/translations') ? 'translations'
      : path.includes('categories') ? 'categories'
      : path.includes('environments') ? 'environments'
      : 'costCenters'
    const fallback: Record<string, unknown> = {
      product, images: [{ id: 1 }, { id: 2 }], translations: [], categories: [{ id: 1 }],
      environments: [], costCenters: [], sizes: { environments: [], rows: [{ code: 'S' }] },
    }
    const v = key in over ? over[key] : fallback[key]
    return v instanceof Error ? Promise.reject(v) : Promise.resolve(v)
  })
}

const page = (query: Record<string, string> = {}) =>
  ProductEditPage({ params: Promise.resolve({ id: '7' }), searchParams: Promise.resolve(query) })

beforeEach(() => {
  get.mockReset()
  redirect.mockClear()
  notFound.mockClear()
  vi.spyOn(console, 'error').mockImplementation(() => {})
  auth.mockResolvedValue({ user: { role: 'root' } })
  answer()
})

/**
 * Seven fetches, two of which their own controls used to make on mount — the
 * gallery (#462) and the size/price grid (#473). The page is already a server
 * component that authenticates and 404s before anything renders, so asking there
 * costs nothing extra.
 */
describe('ProductEditPage', () => {
  it('sends a caller with no session to the login page', async () => {
    auth.mockResolvedValue(null)
    await expect(page()).rejects.toThrow('NEXT_REDIRECT')
    expect(redirect).toHaveBeenCalledWith('/login')
  })

  it('refuses anyone who is not root', async () => {
    auth.mockResolvedValue({ user: { role: 'admin' } })
    await expect(page()).rejects.toThrow('NEXT_REDIRECT')
    expect(redirect).toHaveBeenCalledWith('/admin')
  })

  it('is a 404 when the product does not exist', async () => {
    answer({ product: new ApiError(404, 'Product not found') })
    await expect(page()).rejects.toThrow('NEXT_NOT_FOUND')
  })

  it('sends an ended session to the login page, not to a 404', async () => {
    // The `allSettled` rejected branch collects the redirect like any other
    // failure (#445).
    const { redirect: realRedirect } = await vi.importActual<typeof Navigation>('next/navigation')
    let thrown: unknown
    try { realRedirect('/login?expired=1') } catch (e) { thrown = e }
    answer({ product: thrown })

    await expect(page()).rejects.toThrow()
    expect(notFound, 'the redirect was swallowed and became a 404').not.toHaveBeenCalled()
  })

  it('fetches the gallery and hands it to the upload control', async () => {
    render(await page())

    expect(get).toHaveBeenCalledWith('/api/admin/products/7/images')
    expect(screen.getByTestId('gallery')).toHaveAttribute('data-count', '2')
    expect(screen.getByTestId('gallery')).toHaveAttribute('data-error', '')
  })

  it('hands over the reason when the gallery could not be read', async () => {
    // An empty gallery and one that could not be read are different facts, and
    // only the first is something to act on by uploading (#415).
    answer({ images: new ApiError(502, 'Bad Gateway') })
    render(await page())

    expect(screen.getByTestId('gallery')).toHaveAttribute('data-error', 'HTTP 502: Bad Gateway')
    expect(screen.getByTestId('gallery')).toHaveAttribute('data-count', '0')
    expect(console.error).toHaveBeenCalledWith('[page] could not load gallery for product 7: HTTP 502: Bad Gateway')
  })

  it('fetches the size grid and hands it to the form', async () => {
    render(await page())

    expect(get).toHaveBeenCalledWith('/api/admin/products/7/sizes')
    expect(screen.getByTestId('form')).toHaveAttribute('data-sizes', '1')
  })

  it('hands over nothing at all when the size grid could not be read', async () => {
    /*
     * Not an empty grid — that is a real answer meaning "no sizes priced yet",
     * and on this screen believing it gets a product priced a second time.
     * `undefined` says nobody knows, and the editor retries and reports its own
     * outcome (#473).
     */
    answer({ sizes: new ApiError(502, 'Bad Gateway') })
    render(await page())

    expect(screen.getByTestId('form')).toHaveAttribute('data-sizes', 'unknown')
  })

  it('sends an ended session to the login page when it is the grid that fails', async () => {
    // This one is not routed through `section`, so it rethrows the redirect
    // itself — and without that it would be reported as a product with no sizes.
    const { redirect: realRedirect } = await vi.importActual<typeof Navigation>('next/navigation')
    let thrown: unknown
    try { realRedirect('/login?expired=1') } catch (e) { thrown = e }
    answer({ sizes: thrown })

    await expect(page()).rejects.toThrow()
  })

  it('keeps the form when only the gallery fails, and the reverse', async () => {
    // Six independent panels: one outage must not take the edit screen away.
    answer({ images: new ApiError(500, 'boom') })
    const galleryDown = render(await page())
    expect(galleryDown.container.querySelector('[data-testid="form"]')).toHaveAttribute('data-categories', '1')
    galleryDown.unmount()

    answer({ categories: new ApiError(500, 'boom') })
    render(await page())
    expect(screen.getByTestId('gallery')).toHaveAttribute('data-count', '2')
  })
})
