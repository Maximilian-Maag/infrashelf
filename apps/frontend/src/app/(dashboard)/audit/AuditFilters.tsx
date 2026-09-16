'use client'

import { useEffect, useState, useTransition } from 'react'
import { useRouter, usePathname, useSearchParams } from 'next/navigation'
import { Input } from '@/components/ui/Input'
import { Button } from '@/components/ui/Button'
import { t } from '@/lib/i18n'

/** Everything this bar can set. `offset` is not one of them — see `apply`. */
const FILTER_KEYS = ['userId', 'action', 'from', 'to'] as const

interface Props {
  lang: string
  /** Rows the current filters produced, for the live-region summary. */
  resultCount: number
}

/**
 * Filter bar for the audit log.
 *
 * The filters live in the URL rather than in component state, so a filtered view
 * is something one administrator can send another (#471) — `/audit` is where the
 * answer to "who changed this" is, and before this the only way to share the
 * answer was to describe how to reproduce it. The page is a server component
 * that reads them from `searchParams`, so every control here writes to the URL
 * and lets the server re-render. `InfraFilters` is the same bar for the
 * infrastructure list.
 */
export function AuditFilters({ lang, resultCount }: Props) {
  const router = useRouter()
  const pathname = usePathname()
  const searchParams = useSearchParams()
  const [isPending, startTransition] = useTransition()

  // The two free-text fields are the ones that cannot write straight through: a
  // navigation per keystroke would both hammer the API and fight the caret. The
  // date pickers commit a whole value at a time, so they apply immediately.
  const urlUserId = searchParams.get('userId') ?? ''
  const urlAction = searchParams.get('action') ?? ''
  const [userId, setUserId] = useState(urlUserId)
  const [action, setAction] = useState(urlAction)

  /*
   * Adopt a URL value that changed from the outside — a Back, or Clear filters —
   * without clobbering what is being typed, and during render rather than in an
   * effect (#462, #469). As an effect the box shows the OLD text for a frame
   * after a Back, which on a filter bar reads as the navigation not having
   * happened.
   */
  const [shownUserId, setShownUserId] = useState(urlUserId)
  if (urlUserId !== shownUserId) {
    setShownUserId(urlUserId)
    setUserId(urlUserId)
  }
  const [shownAction, setShownAction] = useState(urlAction)
  if (urlAction !== shownAction) {
    setShownAction(urlAction)
    setAction(urlAction)
  }

  useEffect(() => {
    if (userId === urlUserId && action === urlAction) return
    const id = setTimeout(() => apply({ userId, action }), 300)
    return () => clearTimeout(id)
    // `apply` is deliberately out of this list: it is a fresh closure every
    // render, and including it would restart the timer on every unrelated
    // re-render. `searchParams` IS in it although only `apply` reads it — a date
    // picked while this timer is pending has to be in the merge when it fires,
    // or `router.replace` writes it straight back out (#138). The equality guard
    // is what stops the navigation this effect causes from looping.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [userId, action, urlUserId, urlAction, searchParams])

  function apply(changes: Record<string, string>) {
    const next = new URLSearchParams(searchParams.toString())
    for (const [key, value] of Object.entries(changes)) {
      // Drop empty values so a cleared filter leaves a clean, shareable URL
      // rather than a trail of `&action=&userId=`.
      if (value === '') next.delete(key)
      else next.set(key, value)
    }
    // Page 4 of the previous query is not page 4 of this one, and usually is not
    // a page at all — narrowing the filter is how an admin gets from 3,000 rows
    // to 12, and landing on "no entries" because the offset outlived the filter
    // reads as the search having found nothing.
    next.delete('offset')
    const qs = next.toString()
    startTransition(() => {
      // replace, not push: retyping an action name should not bury the page the
      // reader came from under a dozen history entries.
      router.replace(qs ? `${pathname}?${qs}` : pathname)
    })
  }

  const value = (key: string) => searchParams.get(key) ?? ''
  const activeCount = FILTER_KEYS.filter((key) => value(key) !== '').length

  return (
    <div className="rounded-xl border border-slate-200 bg-white p-4 space-y-3">
      <div className="flex items-center justify-between">
        <h2 className="text-sm font-semibold text-slate-900">
          {t('filters', lang)}
          {activeCount > 0 && (
            <span className="ml-2 rounded-full bg-blue-100 px-2 py-0.5 text-xs font-medium text-blue-700">
              {activeCount}
            </span>
          )}
        </h2>
        {activeCount > 0 && (
          <Button
            size="sm"
            variant="secondary"
            onClick={() => startTransition(() => router.replace(pathname))}
          >
            {t('clearFilters', lang)}
          </Button>
        )}
      </div>

      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
        <Input
          label={t('userId', lang)}
          type="number"
          value={userId}
          onChange={(e) => setUserId(e.target.value)}
          placeholder={t('any', lang)}
        />
        <Input
          label={t('action', lang)}
          value={action}
          onChange={(e) => setAction(e.target.value)}
          placeholder={t('any', lang)}
        />
        <Input
          label={t('fromDate', lang)}
          type="date"
          value={value('from')}
          onChange={(e) => apply({ from: e.target.value })}
        />
        <Input
          label={t('toDate', lang)}
          type="date"
          value={value('to')}
          onChange={(e) => apply({ to: e.target.value })}
        />
      </div>

      {/* Announced rather than merely drawn: a filter change re-renders the table
          below without moving focus, so a screen-reader user would otherwise get
          no feedback that anything happened (WCAG 4.1.3). */}
      <p className="text-xs text-slate-600" role="status" aria-live="polite" aria-busy={isPending}>
        {resultCount} {t('entriesLower', lang)}
      </p>
    </div>
  )
}
