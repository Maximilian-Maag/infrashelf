'use client'

import { useState, useEffect, useCallback, useRef } from 'react'
import type { AuditEntry, PaginatedResponse } from '@infrashelf/types'
import { get, PROXY_PREFIX } from '@/lib/api'
import { Table } from '@/components/ui/Table'
import { Input } from '@/components/ui/Input'
import { Button } from '@/components/ui/Button'
import { Alert } from '@/components/ui/Alert'
import { useLang } from '@/lib/useLang'
import { t } from '@/lib/i18n'


export function AuditTable() {
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
  const [loadError, setLoadError] = useState<string | null>(null)

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
      setLoadError(null)
    } catch (err) {
      // The failure used to be dropped here, and the table then rendered "no
      // audit entries" — which for the audit log specifically is the wrong
      // default. "No entries match" is a statement about the record, and an
      // administrator checking who changed something reads it as evidence. An
      // outage produced the same screen as a clean record.
      //
      // Guarded by the same generation check as the success path: a stale
      // FAILURE must not overwrite a newer success either. The rows are left
      // alone rather than cleared, so a filter change that fails does not also
      // destroy the answer the operator was reading.
      if (loadGeneration.current !== generation) return
      setLoadError(err instanceof Error ? err.message : t('failedToLoadAuditEntries', lang))
    } finally {
      if (loadGeneration.current === generation) setLoading(false)
    }
  }, [page, debouncedUser, debouncedAction, fromFilter, toFilter, lang])

  useEffect(() => { void load() }, [load])

  async function handleExport(format: 'csv' | 'pdf') {
    const params = new URLSearchParams()
    if (userFilter) params.set('userId', userFilter)
    if (actionFilter) params.set('action', actionFilter)
    if (fromFilter) params.set('from', fromFilter)
    if (toFilter) params.set('to', toFilter)
    params.set('format', format)

    setExportError(null)
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
        <>
          {/* Above the rows, not instead of them. A refresh that fails must not
              also take away the answer the operator was reading — but on a first
              load there is nothing to keep, and rendering the table's "no audit
              entries" copy underneath an error is the very confusion #221 is
              about: it reads as a statement that the record is empty. */}
          {loadError && <Alert className="mb-4">{loadError}</Alert>}
          {(!loadError || entries.length > 0) && (
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
                    <span className="text-xs text-slate-600 whitespace-nowrap">
                      {new Date(row.createdAt).toLocaleString(lang)}
                    </span>
                  ),
                },
              ]}
              data={entries}
              emptyMessage={t('noAuditEntries', lang)}
            />
          )}
        </>
      )}

      {totalPages > 1 && (
        // Named so a test can scope to it. `getByRole('button', { name: /next/i })`
        // at document level also matches the dev-tools button `next dev` injects,
        // which is always on the page — audit.spec.ts read that instead of this
        // pager for months and never ran the assertion underneath it.
        <div data-testid="audit-pager" className="flex items-center justify-between">
          <p className="text-sm text-slate-600">
            {t('page', lang)} {page} / {totalPages} · {total} {t('entriesLower', lang)}
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
