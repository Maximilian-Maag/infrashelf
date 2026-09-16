'use client'

import {useState } from 'react'
import { put } from '@/lib/api'
import { Card } from '@/components/ui/Card'
import { Alert } from '@/components/ui/Alert'
import { Input } from '@/components/ui/Input'
import { Button } from '@/components/ui/Button'
import { useLang } from '@/lib/useLang'
import { t } from '@/lib/i18n'

export interface WindowRow {
  startMinute: number
  durationMinutes: number
}

export interface Settings {
  timeZone: string
  windows: WindowRow[]
}

/** Minutes past midnight ⇄ the `HH:MM` an `<input type="time">` speaks. */
const toClock = (minute: number) =>
  `${String(Math.floor(minute / 60)).padStart(2, '0')}:${String(minute % 60).padStart(2, '0')}`

const fromClock = (clock: string): number | null => {
  const m = /^(\d{2}):(\d{2})$/.exec(clock)
  if (!m) return null
  const minutes = Number(m[1]) * 60 + Number(m[2])
  return minutes >= 0 && minutes <= 1439 ? minutes : null
}

/** `08:00–10:00`, so root can read back what the two numbers mean. */
const spanOf = (w: WindowRow) => `${toClock(w.startMinute)}–${toClock((w.startMinute + w.durationMinutes) % 1440)}`

/**
 * Root defines when provisioning may run (#330).
 *
 * The whole set is sent on save, never a row at a time, because the rule that
 * can fail is a property of the collection: two windows overlap, and neither is
 * wrong on its own. That also makes a rearrangement — moving 08:00 to 13:00
 * while 13:00 still exists — one legal save rather than an illegal intermediate.
 */
interface Props {
  /**
   * The window policy the SERVER already fetched (#460).
   *
   * `null` means the fetch failed — distinct from a policy with no windows in
   * it, which reads "provisioning runs at any time" and is a claim about how the
   * installation behaves rather than an empty list (#415).
   */
  initial: Settings | null
  /** Why the server could not fetch it, if it could not. */
  initialError?: string | null
}

export function DeploymentWindowsManager({ initial, initialError = null }: Props) {
  const lang = useLang()
  const [windows, setWindows] = useState<WindowRow[]>(initial?.windows ?? [])
  const [timeZone, setTimeZone] = useState(initial?.timeZone ?? 'UTC')
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(initialError)
  /*
   * Whether the policy is actually known (#415, #460).
   *
   * "No windows defined — provisioning runs at any time" is a statement about
   * how the installation behaves, not an empty list; rendering it over a failed
   * fetch tells an operator their restrictions are gone.
   *
   * A plain value rather than state: the page fetches once and a save takes its
   * answer from the PUT's response, so nothing can change it afterwards.
   */
  const loadFailed = initial === null
  const [saved, setSaved] = useState(false)

  /*
   * No `load` here, unlike its siblings (#460).
   *
   * The page fetches the policy, and a save takes its new state straight from
   * the PUT's own response — the server returns the settings it stored, so
   * asking for them again would be a second round trip to learn what the first
   * one just said. There is no other path that needs a reload.
   */

  const update = (index: number, patch: Partial<WindowRow>) => {
    setSaved(false)
    setWindows((rows) => rows.map((row, i) => (i === index ? { ...row, ...patch } : row)))
  }

  /**
   * The first free hour at or after 09:00, wrapping to whatever is free.
   *
   * A fixed 09:00 default was wrong the moment a window already covered it: the
   * save came back 400 "two windows overlap", and the button that is supposed
   * to be the easy path produced an error the user did not ask for. The set is
   * validated as a whole on save, so the default has to respect the rest of it.
   */
  const nextFreeHour = (rows: WindowRow[]): WindowRow | null => {
    /*
     * Each window as one or two linear intervals, split at midnight.
     *
     * A saved window can never cross midnight — `validateWindows` refuses it and
     * the table's CHECK constraint refuses it again — but one being TYPED can:
     * set 23:30 and then a two-hour duration and, for the moment before saving,
     * the set on screen runs to 01:30. Comparing that as a single linear
     * interval leaves 00:00 and 01:00 looking free, so `Add window` would offer
     * a slot underneath it. The save would still be rejected, but for the wrong
     * reason and after the click.
     */
    const intervals = rows.flatMap(({ startMinute, durationMinutes }) => {
      const end = startMinute + durationMinutes
      return end <= 1440
        ? [[startMinute, end]]
        : [[startMinute, 1440], [0, end - 1440]]
    })
    const taken = (start: number) => intervals.some(([from, to]) => start < to && from < start + 60)
    /*
     * From 09:00 FORWARD through the day, then wrapping to the early hours.
     *
     * Scanning from midnight would answer 00:00 for a schedule that already
     * covers the morning, which is a legal window and an absurd suggestion —
     * this feature exists so deployments happen while somebody is watching.
     * Working hours first, night-time only if there is nothing else left.
     */
    const hours = [...Array.from({ length: 15 }, (_, i) => (9 + i) * 60), ...Array.from({ length: 9 }, (_, h) => h * 60)]
    for (const start of hours) {
      if (start + 60 <= 1440 && !taken(start)) return { startMinute: start, durationMinutes: 60 }
    }
    return null
  }

  const addWindow = () => {
    setSaved(false)
    setWindows((rows) => {
      const slot = nextFreeHour(rows)
      // A day with no free hour left. Saying so beats appending a row that
      // cannot be saved and letting the server explain it.
      if (!slot) {
        setError(t('windowsNoRoom', lang))
        return rows
      }
      setError(null)
      return [...rows, slot]
    })
  }

  const removeWindow = (index: number) => {
    setSaved(false)
    setWindows((rows) => rows.filter((_, i) => i !== index))
  }

  async function save(e: React.FormEvent) {
    e.preventDefault()
    setSaving(true); setError(null); setSaved(false)
    try {
      const settings = await put<Settings>('/api/admin/deployment-windows', { timeZone, windows })
      setWindows(settings?.windows ?? [])
      setTimeZone(settings?.timeZone ?? timeZone)
      setSaved(true)
    } catch (saveError) {
      // The server's own words: it is the only thing that knows which two
      // windows overlap, or that the zone is not a zone.
      setError(saveError instanceof Error ? saveError.message : String(saveError))
    } finally {
      setSaving(false)
    }
  }


  return (
    <form onSubmit={save} className="space-y-4">
      {error && <Alert tone="error">{error}</Alert>}
      {saved && <Alert tone="success">{t('saved', lang)}</Alert>}

      <Card>
        <p className="text-sm text-slate-600 mb-4">{t('deploymentWindowsIntro', lang)}</p>

        <div className="max-w-xs mb-6">
          <Input
            label={t('timeZoneLabel', lang)}
            value={timeZone}
            onChange={(e) => { setSaved(false); setTimeZone(e.target.value) }}
            placeholder="Europe/Berlin"
            required
          />
        </div>

        {windows.length === 0 && !loadFailed ? (
          <p className="text-sm text-slate-600 mb-4">{t('windowsNone', lang)}</p>
        ) : (
          <ul className="space-y-3 mb-4">
            {windows.map((w, i) => (
              // Index as key: these rows have no identity of their own — the
              // set is replaced wholesale on save, and reordering is done by
              // editing a time rather than by moving a row.
              <li key={i} className="flex flex-wrap items-end gap-3">
                <Input
                  label={t('windowStart', lang)}
                  type="time"
                  value={toClock(w.startMinute)}
                  onChange={(e) => {
                    const minute = fromClock(e.target.value)
                    if (minute !== null) update(i, { startMinute: minute })
                  }}
                  required
                />
                <Input
                  label={t('windowDurationMinutes', lang)}
                  type="number"
                  min={1}
                  max={1440}
                  value={String(w.durationMinutes)}
                  onChange={(e) => update(i, { durationMinutes: Number(e.target.value) })}
                  required
                />
                <span className="pb-2 text-sm text-slate-600 tabular-nums">{spanOf(w)}</span>
                <Button type="button" variant="secondary" onClick={() => removeWindow(i)} className="mb-0.5">
                  {t('remove', lang)}
                </Button>
              </li>
            ))}
          </ul>
        )}

        <div className="flex gap-2">
          <Button type="button" variant="secondary" onClick={addWindow}>{t('windowAdd', lang)}</Button>
          <Button type="submit" disabled={saving}>{saving ? t('saving', lang) : t('save', lang)}</Button>
        </div>
      </Card>
    </form>
  )
}
