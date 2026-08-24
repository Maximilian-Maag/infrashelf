'use client'

import { useState } from 'react'
import { useSearchParams } from 'next/navigation'
import { Button } from '@/components/ui/Button'
import { t } from '@/lib/i18n'

const API_URL = process.env.NEXT_PUBLIC_API_URL ?? ''

/** The filter keys the export endpoint understands — forwarded from the URL. */
const FILTER_KEYS = ['range', 'from', 'to', 'projectId'] as const

interface Props {
  token: string
  lang: string
}

/**
 * CSV / PDF export of the cost breakdown.
 *
 * Reads the filters straight out of the URL, so the file covers the same orders
 * as the report on screen — the same reason the endpoint shares the report's
 * filter parser.
 */
export function CostExport({ token, lang }: Props) {
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
    // The file has to name products the way the report on screen does; see the
    // route's own note on why an export that differs from its list is worse than none.
    params.set('lang', lang)

    setBusy(format)
    setError(null)
    // The endpoint authenticates via the Authorization header, which a plain
    // window.open GET cannot set — fetch it and trigger the download from the
    // response blob. This also keeps the token out of the URL, history and logs.
    try {
      const res = await fetch(`${API_URL}/api/costs/export?${params.toString()}`, {
        headers: { Authorization: `Bearer ${token}` },
        cache: 'no-store',
      })
      if (!res.ok) {
        setError(t('exportFailed', lang))
        return
      }
      const blob = await res.blob()
      const url = URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = url
      a.download = `costs.${format}`
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
      <div className="flex items-center gap-3">
        <Button size="sm" variant="secondary" disabled={busy !== null} onClick={() => handleExport('csv')}>
          {busy === 'csv' ? t('loading', lang) : t('exportCsv', lang)}
        </Button>
        <Button size="sm" variant="secondary" disabled={busy !== null} onClick={() => handleExport('pdf')}>
          {busy === 'pdf' ? t('loading', lang) : t('exportPdf', lang)}
        </Button>
      </div>
      {error && <p className="text-xs text-red-600" role="alert">{error}</p>}
    </div>
  )
}
