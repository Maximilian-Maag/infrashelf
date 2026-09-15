'use client'

import { useEffect, useRef, useState } from 'react'
import { useRouter } from 'next/navigation'
import Link from 'next/link'
import { signOut } from 'next-auth/react'
import { clearServiceWorkerCaches } from '@/lib/serviceWorker'
import { get, del } from '@/lib/api'
import type { SessionInfo } from '@infrashelf/types'
import { LanguageSwitcher } from './LanguageSwitcher'
import { CartLink } from './CartLink'
import { useLang } from '@/lib/useLang'
import { t } from '@/lib/i18n'

/** Ceiling on the sign-out revoke, so it can never delay the sign-out itself. */
const REVOKE_BUDGET_MS = 3_000

interface HeaderProps {
  userName?: string | null
  shopName?: string
  logoDataUrl?: string | null
  lang?: string
  /** Items in the caller's cart, rendered as the badge on the cart link. */
  cartCount?: number
}

export function Header({
  userName,
  shopName = 'InfraShelf',
  logoDataUrl,
  lang: initialLang = 'en',
  cartCount = 0,
}: HeaderProps) {
  const router = useRouter()
  const lang = useLang(initialLang)
  const [query, setQuery] = useState('')
  // A native <details> has no dismissal behaviour: Escape does nothing and a click
  // elsewhere leaves the panel open, so it only closed by clicking the summary
  // again — unlike every other overlay in the app, which is a <dialog> via Modal.
  const accountRef = useRef<HTMLDetailsElement>(null)

  useEffect(() => {
    const close = () => {
      const el = accountRef.current
      if (el?.open) el.open = false
    }

    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return
      const el = accountRef.current
      if (!el?.open) return
      close()
      // Focus goes back to the control that opened it, or the panel's closing
      // leaves the user's place in the page undefined.
      el.querySelector('summary')?.focus()
    }

    const onPointerDown = (e: PointerEvent) => {
      const el = accountRef.current
      if (el?.open && e.target instanceof Node && !el.contains(e.target)) close()
    }

    document.addEventListener('keydown', onKeyDown)
    document.addEventListener('pointerdown', onPointerDown)
    return () => {
      document.removeEventListener('keydown', onKeyDown)
      document.removeEventListener('pointerdown', onPointerDown)
    }
  }, [])

  function handleSearch(e: React.FormEvent) {
    e.preventDefault()
    const q = query.trim()
    router.push(q ? `/catalog?q=${encodeURIComponent(q)}` : '/catalog')
  }

  return (
    <header className="sticky top-0 z-50" style={{ backgroundColor: 'var(--bp)' }}>
      {/*
        Two rows on a phone, one from `md:` up.

        The single row had a 669px floor and could not shrink: the brand was
        `shrink-0` with `whitespace-nowrap`, and the search form was `flex-1`
        without `min-w-0`, so its `<input>` kept its default `size=20` intrinsic
        width. Every authenticated page therefore overflowed a 375px viewport by
        294px, and the account menu — which is where Sign out lives — sat
        entirely off-screen with no way to scroll to it (#167).

        Search moves to its own row below `md:` rather than collapsing to an
        icon: this is a shop, and search is not a secondary action. The top row
        then holds only the brand and the controls, which fit.
      */}
      <div className="max-w-screen-2xl mx-auto px-4 py-2 md:py-0 md:h-14 flex flex-wrap md:flex-nowrap items-center gap-x-4 gap-y-2">
        {/* Brand. `min-w-0` + `truncate` so a long shop name yields instead of
            pinning the row open; the logo variant is already bounded. */}
        <Link href="/" className="flex items-center gap-2 min-w-0 shrink md:shrink-0 mr-2">
          {logoDataUrl ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={logoDataUrl} alt={shopName} className="h-8 max-w-[120px] object-contain" />
          ) : (
            <span className="font-bold text-lg tracking-tight truncate" style={{ color: 'var(--bp-ink)' }}>{shopName}</span>
          )}
        </Link>

        {/* Search. `order-last` puts it on the second row on a phone; from `md:`
            it returns to the middle. `min-w-0` is what lets `flex-1` actually
            shrink — without it the flex item's automatic minimum size is the
            input's intrinsic width and the row cannot narrow at all. */}
        <form onSubmit={handleSearch} className="order-last md:order-none w-full md:w-auto flex-1 min-w-0 max-w-xl">
          <div className="flex items-center bg-white rounded-md overflow-hidden">
            <input
              type="text"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder={t('searchProducts', lang)}
              aria-label={t('searchProducts', lang)}
              // min-h-11 sizes the whole search control: the submit button is
              // self-stretch, so the field is what decides whether either of them
              // clears the 44px WCAG 2.5.5 target. It was 36px.
              // `min-w-0` for the same reason as the form: an <input> defaults
              // to `size=20`, which is a ~226px floor the flex row cannot get
              // under.
              className="min-h-11 w-full min-w-0 flex-1 bg-transparent px-3 py-2 text-sm text-slate-900 placeholder-slate-500 focus:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-blue-500"
            />
            <button
              type="submit"
              aria-label={t('search', lang)}
              className="px-4 py-2 min-w-11 justify-center hover:brightness-95 transition-all flex items-center self-stretch"
              style={{ backgroundColor: 'var(--bs)', color: 'var(--bs-ink)' }}
            >
              <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" />
              </svg>
            </button>
          </div>
        </form>

        {/* Right controls, ending in the cart — the one control a shop is built
            around belongs at the far right, not among the section links below. */}
        <div className="ml-auto flex items-center gap-2 sm:gap-3 shrink-0">
          <LanguageSwitcher lang={lang} />

          {/* User dropdown */}
          <details ref={accountRef} className="relative group">
            {/* min-h-11: a <summary> is a pointer target, and two lines of small
                text came to 36px. */}
            <summary className="list-none cursor-pointer select-none flex flex-col items-end justify-center min-h-11 leading-tight rounded px-1 brand-state focus:outline-none focus-visible:ring-2 focus-visible:ring-current"
              style={{ color: 'var(--bp-ink)' }}>
              {userName && <span className="text-xs">{userName}</span>}
              <span className="text-sm font-semibold">{t('myAccount', lang)}</span>
            </summary>
            <div
              className="absolute right-0 top-full mt-1 w-52 bg-white border border-slate-200 rounded-xl shadow-xl z-50 py-1"
              onClick={() => { if (accountRef.current) accountRef.current.open = false }}
            >
              <Link href="/orders" className="flex min-h-11 items-center px-4 py-2 text-sm text-slate-700 hover:bg-slate-50">{t('orders', lang)}</Link>
              <Link href="/projects" className="flex min-h-11 items-center px-4 py-2 text-sm text-slate-700 hover:bg-slate-50">{t('projects', lang)}</Link>
              <hr className="my-1 border-slate-100" />
              <Link href="/settings" className="flex min-h-11 items-center px-4 py-2 text-sm text-slate-700 hover:bg-slate-50">{t('profile', lang)}</Link>
              <hr className="my-1 border-slate-100" />
              <button
                onClick={async () => {
                  /*
                   * Awaited before the redirect: the worker's caches hold the
                   * shell and this operator's branding, and on a shared device
                   * they must not outlive the session (#148).
                   *
                   * But never at the cost of the sign-out itself (#359). This
                   * is the only sign-out affordance in the app, and it awaited
                   * a call that could hang for ever — so the session did not
                   * end and the user was told it had. `clearServiceWorkerCaches`
                   * is time-boxed on its own side now; the `catch` here is the
                   * second half of the same rule, so a rejection cannot do what
                   * the hang did.
                   */
                  try {
                    await clearServiceWorkerCaches()
                  } catch {
                    // Tidiness failed. Ending the session is what was asked for.
                  }
                  /*
                   * End the session on the SERVER, not only in this browser.
                   *
                   * Clearing the cookie is not the same as ending the session,
                   * and #391 is the gap between them: a `/api/auth/session`
                   * read that was already in flight when sign-out landed still
                   * carries the old cookie, so NextAuth validates it and mints
                   * a FRESH one. The trace is unambiguous —
                   * `set-cookie: authjs.session-token=; Max-Age=0` from the
                   * sign-out, and a full token back from the very next read.
                   * The session came back to life, on a machine whose user had
                   * just left.
                   *
                   * A JWT cannot be un-issued, so the fix is to make the
                   * resurrected one worthless: the backend checks every token
                   * against the `sessions` table, and a revoked row fails that
                   * check whatever the browser is still holding.
                   *
                   * Best-effort, by the same rule as the caches above (#359):
                   * this must not become a second way for the only sign-out
                   * affordance in the app to do nothing. A revoke that fails
                   * leaves the old race exactly as it was and no worse.
                   */
                  try {
                    /*
                     * One deadline across both calls, and it is not optional.
                     *
                     * `catch` handles a rejection; it does nothing about a
                     * connection that is accepted and then silent, where the
                     * promise never settles and the `await` below never runs.
                     * That is #359 exactly — the only sign-out affordance in
                     * the app waiting on a call that could hang for ever — and
                     * putting a network round trip in front of `signOut`
                     * without a bound would have reintroduced it.
                     *
                     * Three seconds rather than the one the cache clearing
                     * gets: that is a local operation, this is a round trip to
                     * another host, and a revoke that would have worked on a
                     * slow connection is worth waiting a little longer for.
                     * Both are far below the point where a person stops
                     * believing the button.
                     */
                    const signal = AbortSignal.timeout(REVOKE_BUDGET_MS)
                    const current = (await get<SessionInfo[]>('/api/sessions', signal)).find((s) => s.current)
                    if (current) await del(`/api/sessions/${current.id}`, signal)
                  } catch {
                    // Timed out, refused, or offline. The cookie still goes, and
                    // the token still expires on its own.
                  }
                  /*
                   * `redirect: false`, then navigate ourselves.
                   *
                   * With `redirectTo`, next-auth starts the sign-out POST and
                   * the navigation together, and the navigation can cancel the
                   * request in flight — so the response that CLEARS the session
                   * cookie is never processed. The user lands on /login looking
                   * signed out while the cookie is still valid, which is the
                   * worst possible version of this bug: on a shared device the
                   * next person presses Back.
                   *
                   * Latent until #374 served production builds and navigation
                   * got fast enough to win that race regularly — `signout.spec`
                   * caught it as "the session survived the sign-out".
                   *
                   * Awaiting the POST first costs one round trip and makes the
                   * order guaranteed rather than lucky. `location.assign`
                   * rather than the router, because the point is to discard
                   * every bit of client state that belonged to the session.
                   */
                  await signOut({ redirect: false })
                  window.location.assign('/login')
                }}
                className="w-full text-left flex min-h-11 items-center px-4 py-2 text-sm text-slate-700 hover:text-red-600 transition-colors"
              >
                {t('signOut', lang)}
              </button>
            </div>
          </details>

          <CartLink count={cartCount} lang={lang} />
        </div>
      </div>
    </header>
  )
}
