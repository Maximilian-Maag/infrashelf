'use client'

import { useState } from 'react'
import { useSearchParams } from 'next/navigation'
import { Button } from '@/components/ui/Button'
import { t } from '@/lib/i18n'

const API_URL = process.env.NEXT_PUBLIC_API_URL ?? ''

/** The filter keys the export endpoint understands — forwarded from the URL. */
const FILTER_KEYS = [
  'search', 'status', 'environmentId', 'projectId', 'productId',
  'deployedFrom', 'deployedTo', 'sort', 'direction',
] as const

interface Props {
  token: string
  lang: string
}

/**
 * CSV / PDF export of the infrastructure inventory.
 *
 * Reads the filters straight out of the URL, so the file matches the list the
 * user is looking at — the same reason the endpoint reuses the list's filter
 * parser rather than its own.
 */
export function InfraExport({ token, lang }: Props) {
  const searchParams = useSearchParams()
  const [includeParameters, setIncludeParameters] = useState(false)
  const [busy, setBusy] = useState<'csv' | 'pdf' | null>(null)
  const [error, setError] = useState<string | null>(null)

  async function handleExport(format: 'csv' | 'pdf') {
    const params = new URLSearchParams()
    for (const key of FILTER_KEYS) {
      const value = searchParams.get(key)
      if (value) params.set(key, value)
    }
    params.set('format', format)
    // Same as the cost export: the inventory has to name products the way the list
    // the user exported it from does.
    params.set('lang', lang)
    if (includeParameters) params.set('includeParameters', 'true')

    setBusy(format)
    setError(null)
    // The endpoint authenticates via the Authorization header, which a plain
    // window.open GET cannot set — fetch it and trigger the download from the
    // response blob. This also keeps the token out of the URL, history and logs.
    try {
      const res = await fetch(`${API_URL}/api/infrastructure/export?${params.toString()}`, {
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
      a.download = `infrastructure.${format}`
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
        <div className="flex items-center gap-2">
          <input
            type="checkbox"
            id="infra-export-params"
            checked={includeParameters}
            onChange={(e) => setIncludeParameters(e.target.checked)}
            className="h-4 w-4 rounded border-slate-300 text-blue-600 focus:ring-blue-500"
          />
          <label htmlFor="infra-export-params" className="text-xs text-slate-600">
            {t('includeParameters', lang)}
          </label>
        </div>
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
