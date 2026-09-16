'use client'

import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react'
import type { SessionInfo, RevokeSessionsResponse } from '@infrashelf/types'
import { del, get } from '@/lib/api'
import { Card } from '@/components/ui/Card'
import { Alert } from '@/components/ui/Alert'
import { Button } from '@/components/ui/Button'
import { Table } from '@/components/ui/Table'
import { useLang } from '@/lib/useLang'
import { t } from '@/lib/i18n'

/**
 * The session list, and the two ways to end one (issue #37).
 *
 * Rendered on the settings page from a server-side fetch, so the first paint has
 * the real list rather than a spinner. After a revocation it re-fetches instead of
 * splicing the row out locally: "sign out everywhere else" changes several rows at
 * once, and the server is the only thing that knows which.
 *
 * The current session is labelled and has no button. Offering "sign out" on the
 * row you are sitting in reads as a way to log yourself out, which is what the
 * menu item is for, and clicking it here would 401 the page out from under you
 * with no explanation.
 */

interface Props {
  /**
   * The list to render immediately. Omit it and the component fetches on mount
   * instead — which is right inside a dialog that was not open when the page
   * rendered, and wrong on the settings page, where a server-side fetch means the
   * first paint already has the real list.
   */
  initialSessions?: SessionInfo[]
  /** Whose sessions these are. Omitted means the caller's own. */
  userId?: number
}

/**
 * A User-Agent as something a person can recognise.
 *
 * Deliberately shallow: the point is "is this my phone or not", and a full
 * UA-parsing library for one table column is not worth the dependency. The raw
 * string is kept as the title so nothing is actually hidden.
 */
const describeDevice = (userAgent: string | null): string => {
  if (!userAgent) return '—'
  const os =
    /Windows/i.test(userAgent) ? 'Windows'
    : /Android/i.test(userAgent) ? 'Android'
    : /iPhone|iPad|iOS/i.test(userAgent) ? 'iOS'
    : /Mac OS X|Macintosh/i.test(userAgent) ? 'macOS'
    : /Linux/i.test(userAgent) ? 'Linux'
    : null
  const browser =
    /Edg\//i.test(userAgent) ? 'Edge'
    : /OPR\/|Opera/i.test(userAgent) ? 'Opera'
    : /Chrome\//i.test(userAgent) ? 'Chrome'
    : /Safari\//i.test(userAgent) ? 'Safari'
    : /Firefox\//i.test(userAgent) ? 'Firefox'
    : null
  if (browser && os) return `${browser} · ${os}`
  return browser ?? os ?? userAgent.slice(0, 40)
}

/** Nothing can change whether the page has hydrated, so there is nothing to subscribe to. */
const subscribeToNothing = () => () => {}

export function ActiveSessions({ initialSessions, userId }: Props) {
  const lang = useLang()
  const [sessions, setSessions] = useState<SessionInfo[]>(initialSessions ?? [])
  const [busy, setBusy] = useState<number | 'others' | null>(null)
  const [loading, setLoading] = useState(initialSessions === undefined)
  const [error, setError] = useState<string | null>(null)

  const query = userId === undefined ? '' : `?userId=${userId}`

  // Fetches and returns; it does not set state. Every caller decides whether the
  // component is still mounted before it writes — an unmount mid-flight otherwise
  // means a setState on a dead component, and this card is opened in a modal that
  // is closed by clicking away from it.
  const fetchSessions = useCallback(
    () => get<SessionInfo[]>(`/api/sessions${query}`),
    [query],
  )

  useEffect(() => {
    if (initialSessions !== undefined) return
    let live = true
    fetchSessions()
      .then((rows) => { if (live) setSessions(rows) })
      .catch((e: unknown) => {
        if (live) setError(e instanceof Error ? e.message : t('unexpectedError', lang))
      })
      .finally(() => { if (live) setLoading(false) })
    return () => { live = false }
    // `initialSessions` is a mount-time decision, not something to react to: a
    // parent that re-renders with a new array must not restart the fetch.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fetchSessions])

  /*
   * Whether this component is still on the page (#195, F2).
   *
   * The comment on `fetchSessions` says every caller checks before it writes,
   * and the effect above does. `run` did not: it writes three times after an
   * await, in a card rendered inside a modal that closes on a click outside it.
   *
   * Consistency with that contract, NOT a fix for an observable defect — and the
   * distinction is worth recording, because #195 filed it as the latter. React 18
   * removed the "setState on an unmounted component" warning: such a write is a
   * discarded no-op and leaks nothing, and the resolved closure is collected
   * either way. Probed before writing this — unguarded, the console says nothing
   * at all, so there is no test that could tell the two apart. What was actually
   * wrong was the comment above claiming an invariant one of its callers broke.
   *
   * Set on mount rather than only at declaration, because StrictMode runs the
   * cleanup and then re-runs the effect: a ref left false there would silence
   * every write for the rest of the component's life in development.
   */
  const mounted = useRef(true)
  useEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false
    }
  }, [])

  /*
   * Whether the browser has taken over (#195, F5).
   *
   * These timestamps arrive server-rendered through `initialSessions` and are
   * formatted with `toLocaleString`, which reads the *runtime's* time zone —
   * Node's on the server, the viewer's in the browser. Any viewer not sitting in
   * the server's zone gets a hydration mismatch and a timestamp that visibly
   * changes after load. It is the only call site in the app that is both
   * server-rendered and client-formatted; everywhere else is either a server
   * component or fetches on the client.
   *
   * So the server renders a placeholder and the browser fills it in. Rendering
   * the raw ISO string instead would agree across both, but it would also be
   * what a viewer with JavaScript disabled is left reading.
   */
  /*
   * `useSyncExternalStore`, not state set by an effect (#462).
   *
   * "Has this hydrated" is a question about the environment rather than about
   * this component, and the hook takes a SERVER snapshot and a client one — which
   * is the whole of it: false on the server, true in the browser, subscribing to
   * nothing because nothing else can change the answer.
   */
  const hydrated = useSyncExternalStore(subscribeToNothing, () => true, () => false)

  const localTime = (value: string) =>
    hydrated ? new Date(value).toLocaleString(lang) : '—'

  const run = async (key: number | 'others', action: () => Promise<RevokeSessionsResponse>) => {
    setBusy(key)
    setError(null)
    try {
      await action()
      const rows = await fetchSessions()
      if (mounted.current) setSessions(rows)
    } catch (err) {
      if (mounted.current) setError(err instanceof Error ? err.message : t('unexpectedError', lang))
    } finally {
      if (mounted.current) setBusy(null)
    }
  }

  const others = sessions.filter((s) => !s.current)

  const columns = [
    {
      header: t('device', lang),
      render: (row: SessionInfo) => (
        <span title={row.userAgent ?? undefined}>
          {describeDevice(row.userAgent)}
          {row.current && (
            <span className="ml-2 rounded-full bg-slate-100 px-2 py-0.5 text-xs font-medium text-slate-700">
              {t('currentSession', lang)}
            </span>
          )}
        </span>
      ),
    },
    {
      header: t('ipAddress', lang),
      render: (row: SessionInfo) => row.ip ?? '—',
    },
    {
      header: t('lastSeen', lang),
      render: (row: SessionInfo) => localTime(row.lastSeenAt),
    },
    {
      header: t('created', lang),
      render: (row: SessionInfo) => localTime(row.createdAt),
    },
    {
      header: t('signOut', lang),
      render: (row: SessionInfo) =>
        row.current ? null : (
          <Button
            variant="danger"
            size="sm"
            disabled={busy !== null}
            // The visible label is one word on every row, so the accessible name
            // has to say WHICH row — otherwise a screen-reader user hears "sign
            // out" five times with no way to tell them apart.
            aria-label={`${t('signOut', lang)}: ${describeDevice(row.userAgent)}${row.ip ? ` (${row.ip})` : ''}`}
            onClick={() =>
              run(row.id, () => del<RevokeSessionsResponse>(`/api/sessions/${row.id}`))
            }
          >
            {busy === row.id ? t('loading', lang) : t('signOut', lang)}
          </Button>
        ),
    },
  ]

  return (
    <Card
      title={t('activeSessions', lang)}
      action={
        others.length > 0 ? (
          <Button
            variant="secondary"
            size="sm"
            disabled={busy !== null}
            onClick={() => run('others', () => del<RevokeSessionsResponse>(`/api/sessions${query}`))}
          >
            {busy === 'others'
              ? t('loading', lang)
              : /* When root is looking at someone else's sessions the backend
                   spares nothing — including the one they are using — so
                   "everywhere else" would name the wrong action. */
                t(userId === undefined ? 'signOutOthers' : 'revokeAllSessions', lang)}
          </Button>
        ) : undefined
      }
    >
      <div className="space-y-4">
        <p className="text-sm text-slate-600">{t('activeSessionsSubtitle', lang)}</p>
        {error && <Alert>{error}</Alert>}
        <Table
          columns={columns}
          data={sessions}
          emptyMessage={loading ? t('loading', lang) : t('noActiveSessions', lang)}
        />
      </div>
    </Card>
  )
}
