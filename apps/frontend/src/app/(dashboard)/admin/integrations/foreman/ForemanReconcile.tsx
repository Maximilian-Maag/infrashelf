'use client'

import { useState } from 'react'
import type { DeploymentEnvironment, ForemanReconciliation } from '@infrashelf/types'
import { get } from '@/lib/api'
import { Card } from '@/components/ui/Card'
import { Alert } from '@/components/ui/Alert'
import { Select } from '@/components/ui/Select'
import { Button } from '@/components/ui/Button'
import { useLang } from '@/lib/useLang'
import { t } from '@/lib/i18n'

interface Props {
  environments: DeploymentEnvironment[]
  /** Why they could not be read, if they could not (#415). */
  environmentsError?: string | null
}

/**
 * The Foreman comparison, run on request (#111).
 *
 * Four counts and four lists. The counts are the report — an estate where
 * `ghosts` is 0 and `orphans` is 200 is a different situation from one where
 * both are 3 — and the lists are what somebody acts on, so each carries the
 * sentence saying what its rows do and do not prove. A ghost is not evidence
 * that a machine is gone, and saying so under the heading is cheaper than
 * finding out by decommissioning one.
 */
export function ForemanReconcile({ environments, environmentsError = null }: Props) {
  const lang = useLang()
  const [environmentId, setEnvironmentId] = useState('')
  const [running, setRunning] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [report, setReport] = useState<ForemanReconciliation | null>(null)

  async function run(e: React.FormEvent) {
    e.preventDefault()
    setRunning(true)
    setError(null)
    try {
      const result = await get<ForemanReconciliation>(
        `/api/admin/integrations/foreman/reconcile?environmentId=${environmentId}`,
      )
      setReport(result ?? null)
    } catch (err) {
      // 409 (no Foreman configured) and 502 (Foreman could not be read) both
      // arrive here, and both already say which they are. The previous report is
      // cleared with them: a failed run beside a stale result reads as the run
      // having produced it.
      setReport(null)
      setError(err instanceof Error ? err.message : t('unexpectedError', lang))
    } finally {
      setRunning(false)
    }
  }

  const options = environments.map((env) => ({ value: String(env.id), label: env.name }))

  const counts: { key: string; label: string; value: number; hint?: string }[] = report
    ? [
        { key: 'matched', label: t('matchedHosts', lang), value: report.matched.length },
        {
          key: 'ghosts',
          label: t('ghostHosts', lang),
          value: report.ghosts.length,
          hint: t('ghostHostsHint', lang),
        },
        {
          key: 'orphans',
          label: t('orphanHosts', lang),
          value: report.orphans.length,
          hint: t('orphanHostsHint', lang),
        },
        {
          key: 'unidentified',
          label: t('unidentifiedElements', lang),
          value: report.unidentified.length,
          hint: t('unidentifiedElementsHint', lang),
        },
      ]
    : []

  return (
    <>
      <Card title={t('foremanReconciliation', lang)}>
        {environmentsError && <Alert className="mb-3">{environmentsError}</Alert>}
        <form onSubmit={run} className="flex flex-wrap items-end gap-3">
          <div className="min-w-56 flex-1">
            <Select
              label={t('environment', lang)}
              value={environmentId}
              onChange={(e) => setEnvironmentId(e.target.value)}
              options={options}
              placeholder={t('selectPlaceholder', lang)}
              required
            />
          </div>
          <Button type="submit" disabled={running || environmentId === ''}>
            {running ? t('reconciling', lang) : t('runReconciliation', lang)}
          </Button>
        </form>

        {error && <Alert className="mt-3">{error}</Alert>}

        {!report && !error && (
          <p className="mt-4 text-sm text-slate-600">{t('nothingReconciledYet', lang)}</p>
        )}

        {report && (
          <div className="mt-4 space-y-4">
            <p className="text-xs text-slate-600">
              {report.integration.name} · {t('checkedAt', lang)}{' '}
              {new Date(report.checkedAt).toLocaleString(lang)}
            </p>
            <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
              {counts.map((count) => (
                <div key={count.key} className="rounded-lg border border-slate-100 px-3 py-2">
                  <p className="text-2xl font-semibold text-slate-900">{count.value}</p>
                  <p className="text-xs text-slate-600">{count.label}</p>
                </div>
              ))}
            </div>
          </div>
        )}
      </Card>

      {report && (
        <>
          <Card title={`${t('ghostHosts', lang)} (${report.ghosts.length})`}>
            <p className="mb-3 text-xs text-slate-600">{t('ghostHostsHint', lang)}</p>
            {report.ghosts.length === 0 ? (
              <p className="text-sm text-slate-600">—</p>
            ) : (
              <ul className="space-y-1 text-sm">
                {report.ghosts.map((ghost) => (
                  <li key={ghost.elementId} className="flex flex-wrap gap-x-3">
                    <span className="font-mono text-slate-900">{ghost.hostName}</span>
                    <span className="text-slate-600">#{ghost.elementId}</span>
                  </li>
                ))}
              </ul>
            )}
          </Card>

          <Card title={`${t('orphanHosts', lang)} (${report.orphans.length})`}>
            <p className="mb-3 text-xs text-slate-600">{t('orphanHostsHint', lang)}</p>
            {report.orphans.length === 0 ? (
              <p className="text-sm text-slate-600">—</p>
            ) : (
              <ul className="space-y-1 text-sm">
                {report.orphans.map((host) => (
                  <li key={host.id} className="flex flex-wrap gap-x-3">
                    <span className="font-mono text-slate-900">{host.name}</span>
                    {host.status && <span className="text-slate-600">{host.status}</span>}
                  </li>
                ))}
              </ul>
            )}
          </Card>

          {/* Rendered only when it is not empty. The other three are facts about
              the estate and worth seeing as zeroes; this one is a fact about the
              portal's own records, and an empty section under a heading about
              missing data is a question nobody asked. */}
          {report.unidentified.length > 0 && (
            <Card title={`${t('unidentifiedElements', lang)} (${report.unidentified.length})`}>
              <p className="mb-3 text-xs text-slate-600">{t('unidentifiedElementsHint', lang)}</p>
              <ul className="space-y-1 text-sm">
                {report.unidentified.map((element) => (
                  <li key={element.elementId} className="flex flex-wrap gap-x-3">
                    <span className="text-slate-900">#{element.elementId}</span>
                    <span className="text-slate-600">
                      {t('orders', lang)} #{element.orderId}
                    </span>
                  </li>
                ))}
              </ul>
            </Card>
          )}
        </>
      )}
    </>
  )
}
