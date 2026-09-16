'use client'

import { useState } from 'react'
import { useSearchParams } from 'next/navigation'
import { Button } from '@/components/ui/Button'
import { PROXY_PREFIX } from '@/lib/api'
import { t } from '@/lib/i18n'

/** The filter keys the export endpoint understands — forwarded from the URL. */
const FILTER_KEYS = ['userId', 'action', 'from', 'to'] as const

interface Props {
  lang: string
}

/**
 * CSV / PDF export of the audit log.
 *
 * Reads the filters straight out of the URL, so the file matches the rows the
 * reader is looking at — the same reason the endpoint reuses the list's filter
 * parser rather than having its own, and the reason these moved into the URL at
 * all (#471).
 */
export function AuditExport({ lang }: Props) {
  const searchParams = useSearchParams()
  const [busy, setBusy] = useState<'csv' | 'pdf' | null>(null)
  const [error, setError] = useState<string | null>(null)

  async function handleExport(format: 'csv' | 'pdf') {
    const params = new URLSearchParams()
    for (const key of FILTER_KEYS) {
      const value = searchParams.get(key)
      if (value) params.set(key, value)
    }
    params.set('format', format)

    setBusy(format)
    setError(null)
    // Fetched as a blob rather than opened in a tab, so nothing that identifies
    // the caller ever lands in a URL, in history or in a proxy log. It goes
    // through /api/proxy like every other call: the session cookie rides along
    // and the bearer token is attached on the server, out of script's reach
    // (#146).
    try {
      const res = await fetch(`${PROXY_PREFIX}/api/audit/export?${params.toString()}`, {
        cache: 'no-store',
      })
      if (!res.ok) {
        // Prefer the server's own message. An export over the row cap comes back
        // as a 413 that names the cap and says to narrow the range — advice the
        // generic string would swallow, leaving the admin to retry the same query.
        const detail = await res.json().catch(() => null)
        setError(
          typeof detail?.error === 'string' && detail.error !== ''
            ? detail.error
            : t('exportFailed', lang),
        )
        return
      }
      const blob = await res.blob()
      const url = URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = url
      a.download = `audit.${format}`
      document.body.appendChild(a)
      a.click()
      a.remove()
      URL.revokeObjectURL(url)
    } catch {
      setError(t('exportFailed', lang))
    } finally {
      setBusy(null)
    }
  }

  return (
    <div className="flex flex-col items-end gap-1">
      <div className="flex gap-2">
        <Button variant="secondary" size="sm" disabled={busy !== null} onClick={() => handleExport('csv')}>
          {busy === 'csv' ? t('loading', lang) : t('exportCsv', lang)}
        </Button>
        <Button variant="secondary" size="sm" disabled={busy !== null} onClick={() => handleExport('pdf')}>
          {busy === 'pdf' ? t('loading', lang) : t('exportPdf', lang)}
        </Button>
      </div>
      {error && <p className="text-xs text-red-600" role="alert">{error}</p>}
    </div>
  )
}
