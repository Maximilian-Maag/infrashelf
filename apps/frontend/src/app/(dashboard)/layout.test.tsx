import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, within } from '@testing-library/react'
import DashboardLayout from './layout'

const auth = vi.fn()
vi.mock('@/lib/auth', () => ({ auth: () => auth() }))

const redirect = vi.fn((url: string) => { throw new Error(`NEXT_REDIRECT:${url}`) })
vi.mock('next/navigation', () => ({ redirect: (url: string) => redirect(url), useRouter: () => ({ refresh: vi.fn(), push: vi.fn() }) }))

vi.mock('@/lib/getLang', () => ({ getLang: async () => 'en' }))
// The shell's own client components fetch on mount; this file is about the
// layout's guards and the tokens it derives, not about them.
vi.mock('@/components/layout/Header', () => ({
  Header: ({ shopName, cartCount, logoDataUrl }: { shopName: string; cartCount: number; logoDataUrl: string | null }) =>
    <div data-testid="header" data-shop={shopName} data-cart={cartCount} data-logo={logoDataUrl ?? ''} />,
}))
vi.mock('@/components/layout/TopNav', () => ({ TopNav: ({ role }: { role: string }) => <nav data-role={role} /> }))

const session = (over: Record<string, unknown> = {}) => ({
  user: { name: 'Ada', role: 'admin' },
  apiToken: 'token-abc',
  apiTokenExp: Math.floor(Date.now() / 1000) + 3600,
  ...over,
})

const branding = (over: Record<string, unknown> = {}) => ({
  primaryColor: '#131921', secondaryColor: '#febd69',
  shopName: 'Acme Cloud', shopSubtitle: 'on tap', imprintText: 'Acme GmbH', ...over,
})

/** Answer the layout's three server-side fetches by URL. */
const serve = (over: { branding?: unknown; cart?: unknown; logo?: 'ok' | 'fail' } = {}) => {
  vi.stubGlobal('fetch', vi.fn(async (url: string) => {
    if (url.endsWith('/api/public/branding')) {
      const b = over.branding ?? branding()
      // A refused response still carries a DIFFERENT body, so a mutant that
      // ignores `res.ok` and reads it anyway is visible.
      return b === 'fail'
        ? { ok: false, json: async () => branding({ shopName: 'Leaked From A Refused Response' }) }
        : { ok: true, json: async () => b }
    }
    if (url.endsWith('/api/cart')) {
      const c = over.cart ?? [{ id: 1 }, { id: 2 }]
      if (c === 'throw') throw new Error('cart unreachable')
      return { ok: c !== 'fail', json: async () => (c === 'fail' ? [{ id: 9 }, { id: 8 }, { id: 7 }] : c) }
    }
    if (url.endsWith('/api/admin/branding/logo')) {
      if (over.logo === 'fail') return { ok: false }
      return { ok: true, arrayBuffer: async () => new TextEncoder().encode('PNG').buffer }
    }
    throw new Error(`unexpected fetch: ${url}`)
  }))
}

const shell = () => screen.getByTestId('header')
const root = () => shell().closest('div.min-h-screen') as HTMLElement

beforeEach(() => {
  redirect.mockClear()
  auth.mockReset().mockResolvedValue(session())
  serve()
})

/**
 * The shell every authenticated page renders inside. Its guards decide who gets
 * in, and the custom properties it sets are what every branded colour in the app
 * is derived from — a page that painted its own would have to refetch branding.
 */
describe('DashboardLayout', () => {
  it('sends a caller with no session to the login page', async () => {
    auth.mockResolvedValue(null)
    await expect(DashboardLayout({ children: null })).rejects.toThrow('NEXT_REDIRECT')
    expect(redirect).toHaveBeenCalledWith('/login')
  })

  it('refuses a session that is missing any part it needs', async () => {
    // A half-built session is not a session. Each of these reached the render
    // and failed there instead, which is a 500 where a login page belongs.
    for (const broken of [{ user: undefined }, { apiToken: undefined }, { user: { name: 'Ada' } }]) {
      redirect.mockClear()
      auth.mockResolvedValue(session(broken))
      await expect(DashboardLayout({ children: null })).rejects.toThrow('NEXT_REDIRECT')
      expect(redirect).toHaveBeenCalledWith('/login')
    }
  })

  it('sends an expired token to the login page, saying it expired', async () => {
    // #103: the cookie outliving the backend token left a page that looks logged
    // in, holds no data and explains nothing. This is the render path's own
    // guard, so such a request does not spend the page collecting 401s.
    auth.mockResolvedValue(session({ apiTokenExp: Math.floor(Date.now() / 1000) - 60 }))

    await expect(DashboardLayout({ children: null })).rejects.toThrow('NEXT_REDIRECT')
    expect(redirect).toHaveBeenCalledWith('/login?expired=1&callbackUrl=%2F')
  })

  it('lets a session with no recorded expiry through', async () => {
    // "No expiry known" is not "expired" — a session issued before `apiTokenExp`
    // existed still works, and the backend gets to be the one that refuses it.
    auth.mockResolvedValue(session({ apiTokenExp: undefined }))

    render(await DashboardLayout({ children: <p>page</p> }))
    expect(screen.getByText('page')).toBeInTheDocument()
  })

  it('renders the operator’s branding around the page', async () => {
    render(await DashboardLayout({ children: <p>page</p> }))

    expect(shell()).toHaveAttribute('data-shop', 'Acme Cloud')
    expect(screen.getByText('page')).toBeInTheDocument()
    expect(root().style.getPropertyValue('--bp')).toBe('#131921')
    expect(root().style.getPropertyValue('--bs')).toBe('#febd69')
  })

  it('derives the ink from each colour rather than assuming white', async () => {
    // Hardcoded white only stayed legible while the operator happened to pick
    // something dark.
    render(await DashboardLayout({ children: null }))

    // Near-black rather than pure black on a light colour: it reads as
    // deliberate typography instead of a harsh default, and still clears AA
    // wherever pure black would.
    expect(root().style.getPropertyValue('--bp-ink')).toBe('#ffffff')  // dark navy
    expect(root().style.getPropertyValue('--bs-ink')).toBe('#101827')  // light amber
  })

  it('tints with the OPPOSITE pole of the ink, so contrast can only improve', async () => {
    // Tinting with the ink itself darkens the background toward the text: a 25%
    // ink overlay took the active nav pill to 3.89:1.
    render(await DashboardLayout({ children: null }))
    expect(root().style.getPropertyValue('--bp-tint')).toBe('#000000')

    vi.mocked(auth).mockResolvedValue(session())
    serve({ branding: branding({ primaryColor: '#ffffff' }) })
    const { container } = render(await DashboardLayout({ children: null }))
    const light = container.querySelector('div.min-h-screen') as HTMLElement
    expect(light.style.getPropertyValue('--bp-ink')).toBe('#101827')
    expect(light.style.getPropertyValue('--bp-tint')).toBe('#ffffff')
  })

  it('paints a chart ramp, so a page does not have to refetch the branding', async () => {
    render(await DashboardLayout({ children: null }))
    expect(root().style.getPropertyValue('--chart-1')).toMatch(/^#[0-9a-f]{6}$/)
    expect(root().style.getPropertyValue('--chart-2')).toMatch(/^#[0-9a-f]{6}$/)
  })

  it('falls back to the default branding when the record cannot be read', async () => {
    // The shell renders for every role and must not depend on a request that
    // can fail. Defaults, not a broken page.
    serve({ branding: 'fail' })
    render(await DashboardLayout({ children: <p>page</p> }))

    expect(shell()).toHaveAttribute('data-shop', 'InfraShelf')
    expect(screen.getByText('page')).toBeInTheDocument()
  })

  it('counts the cart for the badge, and drops the badge rather than the shell', async () => {
    render(await DashboardLayout({ children: null }))
    expect(shell()).toHaveAttribute('data-cart', '2')

    serve({ cart: 'throw' })
    const { container } = render(await DashboardLayout({ children: null }))
    expect(container.querySelector('[data-testid="header"]')).toHaveAttribute('data-cart', '0')
  })

  it('does not read the body of a refused response', async () => {
    // `res.ok` is the guard. Without it an error payload becomes the branding,
    // and a 403 cart becomes a badge count.
    serve({ cart: 'fail' })
    render(await DashboardLayout({ children: null }))
    expect(shell()).toHaveAttribute('data-cart', '0')
  })

  it('sends the caller’s token with the requests that need one', async () => {
    // The cart and the logo are per-caller. Without the header they come back
    // 401 and the badge and the logo silently vanish for everybody.
    serve({ branding: branding({ logoMime: 'image/png' }) })
    render(await DashboardLayout({ children: null }))

    const calls = vi.mocked(fetch).mock.calls as unknown as [string, RequestInit][]
    const authOf = (suffix: string) => {
      const call = calls.find((c) => c[0].endsWith(suffix))
      expect(call, suffix).toBeDefined()
      return (call?.[1].headers as Record<string, string> | undefined)?.Authorization
    }
    expect(authOf('/api/cart')).toBe('Bearer token-abc')
    expect(authOf('/api/admin/branding/logo')).toBe('Bearer token-abc')
    // And the public one deliberately carries none.
    expect(authOf('/api/public/branding')).toBeUndefined()
  })

  it('never serves a cached copy of any of them', async () => {
    // The shell is rendered per request and every one of these is per-operator
    // or per-caller state; a cached branding record is one operator's colours on
    // another's portal.
    serve({ branding: branding({ logoMime: 'image/png' }) })
    render(await DashboardLayout({ children: null }))

    const calls = vi.mocked(fetch).mock.calls as unknown as [string, RequestInit][]
    expect(calls).toHaveLength(3)
    for (const [url, init] of calls) expect(init.cache, url).toBe('no-store')
  })

  it('falls back to the documented defaults, field by field', async () => {
    // Not just "some branding": these five are what an installation that has
    // never been configured looks like, and the shell has to render.
    serve({ branding: {} })
    render(await DashboardLayout({ children: <p>page</p> }))

    expect(shell()).toHaveAttribute('data-shop', 'InfraShelf')
    expect(root().style.getPropertyValue('--bp')).toBe('#131921')
    expect(root().style.getPropertyValue('--bs')).toBe('#febd69')
    // No subtitle and no imprint text, so no footer at all.
    expect(root().querySelector('footer')).toBeNull()
  })

  it('fetches the logo only when there is one, and inlines it', async () => {
    serve({ branding: branding({ logoMime: 'image/png' }) })
    render(await DashboardLayout({ children: null }))

    expect(shell()).toHaveAttribute('data-logo', expect.stringContaining('data:image/png;base64,'))
  })

  it('asks for no logo when the record has no mime type', async () => {
    render(await DashboardLayout({ children: null }))

    expect(shell()).toHaveAttribute('data-logo', '')
    const urls = vi.mocked(fetch).mock.calls.map((c) => String(c[0]))
    expect(urls.some((u) => u.endsWith('/api/admin/branding/logo'))).toBe(false)
  })

  it('offers a skip link before anything else in the page', async () => {
    // First tab stop, or a keyboard user walks the whole navigation on every
    // page (WCAG 2.4.1).
    render(await DashboardLayout({ children: null }))

    const skip = screen.getByRole('link', { name: 'Skip to content' })
    expect(skip).toHaveAttribute('href', '#main')
    expect(root().firstElementChild).toBe(skip)
  })

  it('shows the imprint footer only when there is imprint text', async () => {
    render(await DashboardLayout({ children: null }))
    expect(screen.getByRole('contentinfo')).toHaveTextContent('Acme Cloud — on tap')

    serve({ branding: branding({ imprintText: '' }) })
    const { container } = render(await DashboardLayout({ children: null }))
    expect(container.querySelector('footer')).toBeNull()
  })

  it('ignores a cart body that is not a list', async () => {
    // `Array.isArray` is the guard. Without it an error object becomes
    // `undefined.length` and the whole shell throws on a bad response.
    serve({ cart: { error: 'nope' } as unknown as unknown[] })
    render(await DashboardLayout({ children: <p>page</p> }))

    expect(shell()).toHaveAttribute('data-cart', '0')
    expect(screen.getByText('page')).toBeInTheDocument()
  })

  it('makes the skip link land somewhere focusable', async () => {
    // `tabIndex={-1}` is what lets `#main` take focus when the link is followed;
    // without it the browser scrolls and focus stays where it was, so the next
    // Tab walks the navigation again (WCAG 2.4.1).
    render(await DashboardLayout({ children: null }))

    const main = screen.getByRole('main')
    expect(main).toHaveAttribute('id', 'main')
    expect(main).toHaveAttribute('tabindex', '-1')
  })

  it('puts the subtitle beside the shop name, and only when there is one', async () => {
    render(await DashboardLayout({ children: null }))
    expect(screen.getByRole('contentinfo')).toHaveTextContent('© Acme Cloud — on tap')

    serve({ branding: branding({ shopSubtitle: '' }) })
    const { container } = render(await DashboardLayout({ children: null }))
    expect(container.querySelector('footer')).toHaveTextContent('© Acme Cloud')
    expect(container.querySelector('footer')).not.toHaveTextContent('—')
  })

  it('offers the three footer destinations', async () => {
    render(await DashboardLayout({ children: null }))
    const footer = screen.getByRole('contentinfo')

    expect(within(footer).getByRole('link', { name: 'Catalog' })).toHaveAttribute('href', '/catalog')
    expect(within(footer).getByRole('link', { name: 'Orders' })).toHaveAttribute('href', '/orders')
    // The imprint is a legal requirement in the market this ships into, so its
    // link is not decoration.
    expect(within(footer).getByRole('link', { name: 'Imprint' })).toHaveAttribute('href', '/impressum')
  })

  it('tells the navigation which role is looking at it', async () => {
    auth.mockResolvedValue(session({ user: { name: 'Ada', role: 'root' } }))
    const { container } = render(await DashboardLayout({ children: null }))
    expect(container.querySelector('nav')).toHaveAttribute('data-role', 'root')
  })
})
