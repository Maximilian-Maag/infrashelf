'use client'

import { useState, useEffect, useCallback, useRef } from 'react'
import type { AuditEntry, PaginatedResponse } from '@open-hybrid-cloud/types'
import { get } from '@/lib/api'
import { Table } from '@/components/ui/Table'
import { Input } from '@/components/ui/Input'
import { Button } from '@/components/ui/Button'
import { useLang } from '@/lib/useLang'
import { t } from '@/lib/i18n'

interface Props {
  token: string
}

const API_URL = process.env.NEXT_PUBLIC_API_URL ?? ''

export function AuditTable({ token }: Props) {
  const lang = useLang()
  const [entries, setEntries] = useState<AuditEntry[]>([])
  const [total, setTotal] = useState(0)
  const [page, setPage] = useState(1)
  const [loading, setLoading] = useState(true)
  const [userFilter, setUserFilter] = useState('')
  const [actionFilter, setActionFilter] = useState('')
  const [fromFilter, setFromFilter] = useState('')
  const [toFilter, setToFilter] = useState('')
  // Debounced copies of the free-text filters so typing doesn't fire a request
  // per keystroke. Date filters stay immediate.
  const [debouncedUser, setDebouncedUser] = useState('')
  const [debouncedAction, setDebouncedAction] = useState('')
  const [exportError, setExportError] = useState<string | null>(null)

  const pageSize = 20

  // Bumped on every load, so a response can tell whether it is still the
  // newest one asked for by the time it comes back. Pagination and filters
  // both refire `load()` without waiting for the previous request, and
  // clicking Next twice quickly (or a filter change while a page fetch is in
  // flight) must not let the older answer land on top of the newer one — the
  // stale `total` it carries also drives the Next/Previous disabled state
  // (#138).
  const loadGeneration = useRef(0)

  useEffect(() => {
    const id = setTimeout(() => {
      setDebouncedUser(userFilter)
      setDebouncedAction(actionFilter)
    }, 300)
    return () => clearTimeout(id)
  }, [userFilter, actionFilter])

  const load = useCallback(async () => {
    const generation = ++loadGeneration.current
    setLoading(true)
    try {
      const params = new URLSearchParams()
      params.set('page', String(page))
      params.set('pageSize', String(pageSize))
      if (debouncedUser) params.set('userId', debouncedUser)
      if (debouncedAction) params.set('action', debouncedAction)
      if (fromFilter) params.set('from', fromFilter)
      if (toFilter) params.set('to', toFilter)

      const result = await get<PaginatedResponse<AuditEntry> | AuditEntry[]>(
        `/api/audit?${params.toString()}`,
        token,
      )
      // A newer request (another page or filter change) has since gone out —
      // its answer, not this one, must decide what is on screen.
      if (loadGeneration.current !== generation) return
      if (Array.isArray(result)) {
        setEntries(result)
        setTotal(result.length)
      } else {
        setEntries(result.data ?? [])
        setTotal(result.total ?? 0)
      }
    } catch {
      /* empty */
    } finally {
      if (loadGeneration.current === generation) setLoading(false)
    }
  }, [token, page, debouncedUser, debouncedAction, fromFilter, toFilter])

  useEffect(() => { void load() }, [load])

  async function handleExport(format: 'csv' | 'pdf') {
    const params = new URLSearchParams()
    if (userFilter) params.set('userId', userFilter)
    if (actionFilter) params.set('action', actionFilter)
    if (fromFilter) params.set('from', fromFilter)
    if (toFilter) params.set('to', toFilter)
    params.set('format', format)

    setExportError(null)
    // The export endpoint authenticates via the Authorization header, which a
    // plain window.open GET cannot set — fetch it and trigger a download from
    // the response blob. This also keeps the token out of the URL/history/logs.
    try {
      const res = await fetch(`${API_URL}/api/audit/export?${params.toString()}`, {
        headers: { Authorization: `Bearer ${token}` },
        cache: 'no-store',
      })
      if (!res.ok) {
        // Prefer the server's own message. An export over the row cap comes back
        // as a 413 that names the cap and says to narrow the range — advice the
        // generic string would swallow, leaving the admin to retry the same query.
        const detail = await res.json().catch(() => null)
        setExportError(
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
      setExportError(null)
    } catch {
      setExportError(t('exportFailed', lang))
    }
  }

  const totalPages = Math.ceil(total / pageSize)

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
        <Input
          label={t('userId', lang)}
          type="number"
          value={userFilter}
          onChange={(e) => { setUserFilter(e.target.value); setPage(1) }}
          placeholder={t('any', lang)}
        />
        <Input
          label={t('action', lang)}
          value={actionFilter}
          onChange={(e) => { setActionFilter(e.target.value); setPage(1) }}
          placeholder={t('any', lang)}
        />
        <Input
          label={t('fromDate', lang)}
          type="date"
          value={fromFilter}
          onChange={(e) => { setFromFilter(e.target.value); setPage(1) }}
        />
        <Input
          label={t('toDate', lang)}
          type="date"
          value={toFilter}
          onChange={(e) => { setToFilter(e.target.value); setPage(1) }}
        />
      </div>

      <div className="flex flex-col items-end gap-2">
        <div className="flex gap-2">
          <Button variant="secondary" size="sm" onClick={() => handleExport('csv')}>
            {t('exportCsv', lang)}
          </Button>
          <Button variant="secondary" size="sm" onClick={() => handleExport('pdf')}>
            {t('exportPdf', lang)}
          </Button>
        </div>
        {exportError && (
          <p className="text-xs text-red-600" role="alert">{exportError}</p>
        )}
      </div>

      {loading ? (
        <div className="flex justify-center py-8">
          <div className="h-8 w-8 animate-spin rounded-full border-4 border-slate-200 border-t-blue-600" />
        </div>
      ) : (
        <Table<AuditEntry>
          columns={[
            { header: t('id', lang), accessor: 'id', className: 'w-16' },
            {
              header: t('user', lang),
              render: (row) => <span>{row.userName ?? (row.userId ? `#${row.userId}` : t('system', lang))}</span>,
            },
            { header: t('action', lang), accessor: 'action' },
            {
              header: t('entity', lang),
              render: (row) => <span>{row.entityId ?? '—'}</span>,
            },
            { header: t('details', lang), accessor: 'details', className: 'max-w-xs truncate' },
            {
              header: t('date', lang),
              render: (row) => (
                <span className="text-xs text-slate-500 whitespace-nowrap">
                  {new Date(row.createdAt).toLocaleString(lang)}
                </span>
              ),
            },
          ]}
          data={entries}
          emptyMessage={t('noAuditEntries', lang)}
        />
      )}

      {totalPages > 1 && (
        <div className="flex items-center justify-between">
          <p className="text-sm text-slate-500">
            Page {page} of {totalPages} ({total} entries)
          </p>
          <div className="flex gap-2">
            <Button variant="secondary" size="sm" onClick={() => setPage((p) => Math.max(1, p - 1))} disabled={page === 1}>
              {t('previous', lang)}
            </Button>
            <Button variant="secondary" size="sm" onClick={() => setPage((p) => Math.min(totalPages, p + 1))} disabled={page === totalPages}>
              {t('next', lang)}
            </Button>
          </div>
        </div>
      )}
    </div>
  )
}
