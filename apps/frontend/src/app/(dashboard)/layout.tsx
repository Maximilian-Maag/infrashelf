import { redirect } from 'next/navigation'
import Link from 'next/link'
import { auth } from '@/lib/auth'
import { Header } from '@/components/layout/Header'
import { LangProvider } from '@/components/layout/LangProvider'
import { TopNav } from '@/components/layout/TopNav'
import type { Branding } from '@open-hybrid-cloud/types'
import { getLang } from '@/lib/getLang'
import { isApiTokenExpired, expiredLoginUrl } from '@/lib/session'
import { t } from '@/lib/i18n'
import { readableInk, readableAccent, accentRamp, AA_NON_TEXT } from '@/lib/contrast'
import { CHART_STEPS } from '@/lib/chartTokens'

const API_SSR = process.env.API_URL ?? process.env.NEXT_PUBLIC_API_URL ?? ''

export default async function DashboardLayout({ children }: { children: React.ReactNode }) {
  const session = await auth()

  // Validate the session and all its required properties safely.
  // If anything is missing, the session is invalid; redirect to login.
  if (!session || !session.user || !session.apiToken || !session.user.role) {
    redirect('/login')
  }

  // The middleware catches this first for any normal navigation; this is the
  // render path's own guard, so a request that reached the layout with a dead
  // backend token does not spend the page fetching 401s (#103).
  if (isApiTokenExpired(session.apiTokenExp)) {
    redirect(expiredLoginUrl('/'))
  }

  const token = session.apiToken
  const role = session.user.role
  const lang = await getLang()

  let branding: Branding = {
    primaryColor: '#131921',
    secondaryColor: '#febd69',
    shopName: 'Open Hybrid Cloud',
    shopSubtitle: '',
    imprintText: '',
  }
  try {
    // The public route, not /api/admin/branding: this shell renders for every
    // role and that route is root-only. Same six fields.
    const res = await fetch(`${API_SSR}/api/public/branding`, { cache: 'no-store' })
    if (res.ok) branding = await res.json()
  } catch { /* use defaults */ }

  // The header badge needs the count on first paint, so it is fetched here rather
  // than by the client component. Non-fatal: a cart outage costs the badge, not
  // the whole shell.
  let cartCount = 0
  try {
    const res = await fetch(`${API_SSR}/api/cart`, {
      headers: { Authorization: `Bearer ${token}` },
      cache: 'no-store',
    })
    if (res.ok) {
      const items: unknown = await res.json()
      if (Array.isArray(items)) cartCount = items.length
    }
  } catch { /* leave the badge off */ }

  let logoDataUrl: string | null = null
  if (branding.logoMime) {
    try {
      const res = await fetch(`${API_SSR}/api/admin/branding/logo`, {
        headers: { Authorization: `Bearer ${token}` },
        cache: 'no-store',
      })
      if (res.ok) {
        const buf = await res.arrayBuffer()
        logoDataUrl = `data:${branding.logoMime};base64,${Buffer.from(buf).toString('base64')}`
      }
    } catch { /* non-fatal */ }
  }

  const {
    primaryColor = '#131921',
    secondaryColor = '#febd69',
    shopName = 'Open Hybrid Cloud',
    shopSubtitle = '',
    imprintText = '',
  } = branding

  // Chart fills, derived here for the same reason --bp-text is: a page that painted
  // its own segments would have to refetch the branding, and a ramp mixed in CSS
  // could not guarantee the 3:1 (1.4.11) floor on an operator's pale colour.
  const chartRamp = accentRamp(primaryColor, CHART_STEPS)

  return (
    <div
      className="min-h-screen flex flex-col bg-slate-50 text-slate-900 antialiased"
      style={{
        '--bp': primaryColor,
        '--bs': secondaryColor,
        ...Object.fromEntries(chartRamp.map((tone, i) => [`--chart-${i + 1}`, tone])),
        // Foreground for anything painted ON the branding colours. Derived from
        // each colour's luminance instead of hardcoded white, which only stayed
        // legible while the operator happened to pick something dark.
        '--bp-ink': readableInk(primaryColor).ink,
        '--bs-ink': readableInk(secondaryColor).ink,
        // The brand colour used AS text on a card — darkened until it clears
        // readableAccent's default target (now 7:1, AAA) against the app's own
        // surfaces (see contrast.SURFACE; tuning against pure white left 12px
        // links at 4.3:1 on the slate-50 body).
        '--bp-text': readableAccent(primaryColor),
        // Boundary for filled controls painted in the secondary colour. A near-white
        // secondary is otherwise invisible against the page — a button that reads as
        // disabled, and a 1.4.11 failure.
        '--bs-edge': readableAccent(secondaryColor, undefined, AA_NON_TEXT),
        // Overlay colour for hover/active states on the branding colour. It is
        // the OPPOSITE pole of --bp-ink: tinting with the ink itself darkens the
        // background toward the text and costs contrast (a 25 % ink overlay took
        // the active nav pill to 3.89:1). The opposite pole moves the background
        // away from the text, so contrast only improves.
        '--bp-tint': readableInk(primaryColor).ink === '#ffffff' ? '#000000' : '#ffffff',
      } as React.CSSProperties}
    >
      <a
        href="#main"
        className="sr-only focus:not-sr-only focus:absolute focus:z-[100] focus:top-2 focus:left-2 focus:rounded-md focus:bg-white focus:px-4 focus:py-2 focus:text-sm focus:shadow-lg focus:ring-2 focus:ring-blue-500"
      >
        {t('skipToContent', lang)}
      </a>
      <Header
        userName={session.user?.name}
        shopName={shopName}
        logoDataUrl={logoDataUrl}
        lang={lang}
        cartCount={cartCount}
      />
      <TopNav role={role} lang={lang} />
      <main id="main" tabIndex={-1} className="flex-1">
        <div className="max-w-screen-2xl mx-auto px-4 py-6 animate-page-in">
          {/* So a client component inside a page renders in the same language the
              page around it was rendered in. */}
          <LangProvider lang={lang}>{children}</LangProvider>
        </div>
      </main>
      {imprintText && (
        <footer className="mt-10 border-t border-current/25" style={{ backgroundColor: 'var(--bp)' }}>
          <div className="max-w-screen-2xl mx-auto px-4 py-4 flex flex-col sm:flex-row items-center justify-between gap-2">
            <span className="text-xs" style={{ color: 'var(--bp-ink)' }}>
              © {shopName}{shopSubtitle ? ` — ${shopSubtitle}` : ''}
            </span>
            <div className="flex gap-4">
              <Link href="/catalog" className="text-xs rounded px-1 brand-state focus:outline-none focus-visible:ring-2 focus-visible:ring-current" style={{ color: 'var(--bp-ink)' }}>{t('catalog', lang)}</Link>
              <Link href="/orders" className="text-xs rounded px-1 brand-state focus:outline-none focus-visible:ring-2 focus-visible:ring-current" style={{ color: 'var(--bp-ink)' }}>{t('orders', lang)}</Link>
              <Link href="/impressum" className="text-xs rounded px-1 brand-state focus:outline-none focus-visible:ring-2 focus-visible:ring-current" style={{ color: 'var(--bp-ink)' }}>{t('imprint', lang)}</Link>
            </div>
          </div>
        </footer>
      )}
    </div>
  )
}
