'use client'

import {useState, useCallback } from 'react'
import { get, patch, put, del } from '@/lib/api'
import { Card } from '@/components/ui/Card'
import { Alert } from '@/components/ui/Alert'
import { Input } from '@/components/ui/Input'
import { Button } from '@/components/ui/Button'
import { useLang } from '@/lib/useLang'
import { t } from '@/lib/i18n'

interface HolidayRow {
  date: string
  name: string
  source: 'feed' | 'manual'
  observed: boolean
}

interface FeedStatus {
  url: string | null
  lastSuccessAt: string | null
  lastError: string | null
  ageDays: number | null
  stale: boolean
  neverSucceeded: boolean
  observedCount: number
}

export interface HolidaysPayload {
  feed: FeedStatus
  holidays: HolidayRow[]
}

/**
 * The days the company does not deploy on (#330).
 *
 * Weekends fall out of the arithmetic; this is the other half — public holidays
 * from a feed, plus the two things no public feed can know: a shutdown week
 * this company takes, and a public holiday this company works through.
 *
 * The staleness banner is not decoration. The whole design caches these so the
 * decision path never waits on a third party, and the cost of that trade is
 * that stale data looks exactly like fresh data unless something says so.
 */
interface Props {
  /** The holiday policy the SERVER already fetched (#460); null if it could not. */
  initial: HolidaysPayload | null
  /** Why it could not, if it could not. */
  initialError?: string | null
}

export function HolidaysManager({ initial, initialError = null }: Props) {
  const lang = useLang()
  const [data, setData] = useState<HolidaysPayload | null>(initial)
  // The server already has it, so nothing is pending on arrival.
  const [loading, setLoading] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(initialError)
  const [notice, setNotice] = useState<string | null>(null)
  const [feedUrl, setFeedUrl] = useState(initial?.feed.url ?? '')
  const [preview, setPreview] = useState<{ date: string; name: string }[] | null>(null)
  const [newDate, setNewDate] = useState('')
  const [newName, setNewName] = useState('')

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const payload = await get<HolidaysPayload>('/api/admin/holidays')
      setData(payload ?? null)
      setFeedUrl(payload?.feed.url ?? '')
      setError(null)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setLoading(false)
    }
  }, [])

  const run = async (what: () => Promise<string | null>) => {
    setBusy(true); setError(null); setNotice(null)
    try {
      setNotice(await what())
      await load()
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  if (loading) return <Card><p className="text-sm text-slate-500">{t('loading', lang)}</p></Card>

  const feed = data?.feed
  const rows = data?.holidays ?? []

  return (
    <Card>
      <h2 className="font-semibold text-slate-900 mb-1">{t('holidays', lang)}</h2>
      <p className="text-sm text-slate-600 mb-4">{t('holidaysIntro', lang)}</p>

      {error && <Alert tone="error">{error}</Alert>}
      {notice && <Alert tone="success">{notice}</Alert>}

      {/* The three things worth interrupting for, most serious first. */}
      {feed?.neverSucceeded && (
        <Alert tone="error">{t('holidayFeedNeverRead', lang)}</Alert>
      )}
      {feed?.stale && !feed.neverSucceeded && (
        <Alert tone="error">
          {t('holidayFeedStale', lang)} {feed.lastSuccessAt && new Date(feed.lastSuccessAt).toLocaleDateString(lang)}
        </Alert>
      )}
      {feed?.lastError && !feed.neverSucceeded && (
        <p className="text-xs text-amber-700 mb-3">{t('holidayFeedLastError', lang)}: {feed.lastError}</p>
      )}

      <div className="flex flex-wrap items-end gap-2 mb-4">
        <Input
          label={t('holidayFeedUrl', lang)}
          value={feedUrl}
          onChange={(e) => { setPreview(null); setFeedUrl(e.target.value) }}
          placeholder="https://example.com/holidays.ics"
        />
        <Button
          type="button"
          variant="secondary"
          disabled={busy || feedUrl.trim() === ''}
          onClick={() => run(async () => {
            // Preview before saving, because saving a bad URL is what trips the
            // fail-closed rule: the portal stops applying windows until a read
            // succeeds, and the operator has to work out why.
            const dates = await patch<{ date: string; name: string }[]>('/api/admin/holidays', {
              action: 'preview', url: feedUrl.trim(),
            })
            setPreview(dates ?? [])
            return null
          })}
        >
          {t('holidayFeedPreview', lang)}
        </Button>
        <Button
          type="button"
          disabled={busy}
          onClick={() => run(async () => {
            await patch('/api/admin/holidays', { action: 'setFeed', url: feedUrl.trim() || null })
            return t('saved', lang)
          })}
        >
          {t('save', lang)}
        </Button>
        <Button
          type="button"
          variant="secondary"
          disabled={busy || !feed?.url}
          onClick={() => run(async () => {
            const out = await patch<{ refreshed: boolean; error?: string; added?: number }>(
              '/api/admin/holidays', { action: 'refresh' },
            )
            // A failed refresh is news, not an error — the cached dates are
            // untouched, which is the whole point of caching them.
            return out?.refreshed ? t('holidayFeedRefreshed', lang) : (out?.error ?? null)
          })}
        >
          {t('holidayFeedRefresh', lang)}
        </Button>
      </div>

      {preview && (
        <div className="mb-4 rounded-lg border border-slate-200 p-3">
          <p className="text-sm font-medium text-slate-700 mb-1">
            {t('holidayFeedPreviewResult', lang)} ({preview.length})
          </p>
          <p className="text-xs text-slate-500">
            {preview.slice(0, 8).map((h) => `${h.date} ${h.name}`).join(' · ')}
            {preview.length > 8 ? ' …' : ''}
          </p>
        </div>
      )}

      <div className="flex flex-wrap items-end gap-2 mb-4">
        <Input label={t('holidayDate', lang)} type="date" value={newDate} onChange={(e) => setNewDate(e.target.value)} />
        <Input label={t('holidayName', lang)} value={newName} onChange={(e) => setNewName(e.target.value)} />
        <Button
          type="button"
          variant="secondary"
          disabled={busy || newDate === '' || newName.trim() === ''}
          onClick={() => run(async () => {
            await put('/api/admin/holidays', { date: newDate, name: newName.trim(), observed: true })
            setNewDate(''); setNewName('')
            return t('saved', lang)
          })}
        >
          {t('add', lang)}
        </Button>
      </div>

      {rows.length === 0 ? (
        <p className="text-sm text-slate-500">{t('holidaysNone', lang)}</p>
      ) : (
        <ul className="divide-y divide-slate-100">
          {rows.map((h) => (
            <li key={h.date} className="flex flex-wrap items-center gap-3 py-2 text-sm">
              <span className="tabular-nums text-slate-900 w-28">{h.date}</span>
              <span className={h.observed ? 'text-slate-700' : 'text-slate-400 line-through'}>{h.name}</span>
              <span className="text-xs text-slate-400">{h.source}</span>
              <span className="ml-auto flex gap-2">
                {/* Unticking rather than deleting is the right move for a feed
                    row: a delete comes back on the next refresh, because the
                    feed is the source for those. */}
                <Button
                  type="button"
                  size="sm"
                  variant="secondary"
                  disabled={busy}
                  onClick={() => run(async () => {
                    await put('/api/admin/holidays', { date: h.date, name: h.name, observed: !h.observed })
                    return null
                  })}
                >
                  {h.observed ? t('holidayWorkThrough', lang) : t('holidayObserve', lang)}
                </Button>
                <Button
                  type="button"
                  size="sm"
                  variant="secondary"
                  disabled={busy}
                  onClick={() => run(async () => {
                    await del(`/api/admin/holidays?date=${encodeURIComponent(h.date)}`)
                    return null
                  })}
                >
                  {t('remove', lang)}
                </Button>
              </span>
            </li>
          ))}
        </ul>
      )}
    </Card>
  )
}
