'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import type { ApprovalDelegation, ApprovalDelegationsResponse } from '@infrashelf/types'
import { post, del } from '@/lib/api'
import { Button } from '@/components/ui/Button'
import { Alert } from '@/components/ui/Alert'
import { Input } from '@/components/ui/Input'
import { Select } from '@/components/ui/Select'
import { useLang } from '@/lib/useLang'
import { t } from '@/lib/i18n'

interface Props {
  delegations: ApprovalDelegationsResponse
}

/**
 * ISO date for today in the browser's own calendar — the `min` for both inputs
 * and the cutoff that decides whether a given delegation is still worth showing.
 *
 * Built from the local getters rather than `toISOString()`, which is UTC and so
 * named the wrong day for anyone east or west of it for part of every day.
 *
 * This still cannot be exact against the server: `createDelegation` compares the
 * start date with Postgres's `CURRENT_DATE`, in the database's timezone. When the
 * browser's calendar is a day behind the database's, `min` offers a date the API
 * answers with 400 'A delegation cannot start in the past'. The alternative is a
 * round trip before the form can render; the local date is right for the user
 * almost always, and the server still refuses what it must.
 */
const today = (): string => {
  const now = new Date()
  const month = String(now.getMonth() + 1).padStart(2, '0')
  const day = String(now.getDate()).padStart(2, '0')
  return `${now.getFullYear()}-${month}-${day}`
}

const period = (d: ApprovalDelegation, lang: string): string =>
  `${new Date(`${d.startsOn}T00:00:00`).toLocaleDateString(lang)} – ${new Date(
    `${d.endsOn}T00:00:00`,
  ).toLocaleDateString(lang)}`

/**
 * Self-service approval delegation (issue #35).
 *
 * Two things sit here, and they are deliberately different shapes. The authority
 * the admin HOLDS is read-only and stated as a sentence — "you are approving on
 * behalf of Alice" — because that is the fact a substitute needs before they start
 * clearing a queue that is not usually theirs. The authority they have GIVEN AWAY
 * is the thing they manage, so it gets the form and the revoke button.
 *
 * `active` is computed by the server at read time; nothing here decides whether a
 * delegation has expired, so the panel cannot disagree with the API about it.
 */
export function DelegationPanel({ delegations }: Props) {
  const router = useRouter()
  const lang = useLang()
  const [toUserId, setToUserId] = useState('')
  const [startsOn, setStartsOn] = useState(today())
  const [endsOn, setEndsOn] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const held = delegations.grantedToMe.filter((d) => d.active)
  // Revoked rows stay in the API response so the audit trail keeps resolving, but
  // they are not something the admin has to look at. Neither is one whose period
  // has already ended: `mine` carries every delegation ever created, so filtering
  // on `revokedAt` alone left an expired row here forever — labelled as if it were
  // still scheduled, and, because the form is hidden whenever `given` is
  // non-empty, permanently preventing a second delegation. The API allows one;
  // only this filter did not.
  const given = delegations.mine.filter((d) => !d.revokedAt && d.endsOn >= today())

  async function handleCreate(e: React.FormEvent) {
    e.preventDefault()
    setBusy(true)
    setError(null)
    try {
      await post('/api/approvals/delegations', { toUserId: Number(toUserId), startsOn, endsOn })
      setToUserId('')
      setEndsOn('')
      router.refresh()
    } catch (err) {
      setError(err instanceof Error ? err.message : t('unexpectedError', lang))
    } finally {
      setBusy(false)
    }
  }

  async function handleRevoke(id: number) {
    setBusy(true)
    setError(null)
    try {
      await del(`/api/approvals/delegations/${id}`)
      router.refresh()
    } catch (err) {
      setError(err instanceof Error ? err.message : t('unexpectedError', lang))
    } finally {
      setBusy(false)
    }
  }

  return (
    <section
      aria-labelledby="delegation-heading"
      className="rounded-xl border border-slate-200 bg-white p-5 shadow-sm space-y-4"
    >
      <div>
        <h2 id="delegation-heading" className="font-semibold text-slate-900">
          {t('approvalDelegation', lang)}
        </h2>
        <p className="text-sm text-slate-600">{t('delegationHint', lang)}</p>
      </div>

      {held.length > 0 && (
        <Alert tone="info">
          <ul className="space-y-1">
            {held.map((d) => (
              <li key={d.id} data-testid={`held-delegation-${d.id}`}>
                {t('actingOnBehalfOf', lang)} <strong>{d.fromUserName}</strong> · {period(d, lang)}
              </li>
            ))}
          </ul>
        </Alert>
      )}

      {error && <Alert>{error}</Alert>}

      {given.length > 0 ? (
        <ul className="space-y-2">
          {given.map((d) => (
            <li
              key={d.id}
              data-testid={`given-delegation-${d.id}`}
              className="flex flex-wrap items-center justify-between gap-3 rounded-lg bg-slate-50 px-3 py-2"
            >
              <span className="text-sm text-slate-700">
                <strong>{d.toUserName}</strong> · {period(d, lang)}
                {' · '}
                {d.active ? t('statusActive', lang) : t('scheduledFor', lang)}
              </span>
              <Button
                size="sm"
                variant="secondary"
                disabled={busy}
                onClick={() => handleRevoke(d.id)}
                aria-label={`${t('remove', lang)} — ${d.toUserName}`}
              >
                {t('remove', lang)}
              </Button>
            </li>
          ))}
        </ul>
      ) : delegations.candidates.length === 0 ? (
        <p className="text-sm text-slate-600">{t('noEligibleSubstitutes', lang)}</p>
      ) : (
        // Only one live delegation per admin is allowed, so the form disappears
        // once one exists rather than offering a create the API would reject.
        <form onSubmit={handleCreate} className="grid gap-3 sm:grid-cols-4 sm:items-end">
          <Select
            label={t('substitute', lang)}
            placeholder={t('selectSubstitute', lang)}
            value={toUserId}
            onChange={(e) => setToUserId(e.target.value)}
            required
            options={delegations.candidates.map((c) => ({ value: c.id, label: c.name }))}
          />
          <Input
            label={t('fromDate', lang)}
            type="date"
            value={startsOn}
            min={today()}
            onChange={(e) => setStartsOn(e.target.value)}
            required
          />
          <Input
            label={t('toDate', lang)}
            type="date"
            value={endsOn}
            min={startsOn || today()}
            onChange={(e) => setEndsOn(e.target.value)}
            required
          />
          <Button type="submit" disabled={busy || !toUserId || !endsOn}>
            {busy ? t('creating', lang) : t('createDelegation', lang)}
          </Button>
        </form>
      )}

      {given.length === 0 && delegations.candidates.length > 0 && (
        <p className="text-sm text-slate-600">{t('noDelegation', lang)}</p>
      )}
    </section>
  )
}
