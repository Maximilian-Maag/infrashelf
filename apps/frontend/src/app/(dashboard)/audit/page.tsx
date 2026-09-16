import { auth } from '@/lib/auth'
import { redirect } from 'next/navigation'
import type { AuditEntry, PaginatedResponse, Role } from '@infrashelf/types'
import { get } from '@/lib/serverApi'
import { PageHeader } from '@/components/layout/PageHeader'
import { Table } from '@/components/ui/Table'
import { Pager } from '@/components/ui/Pager'
import { SectionError } from '@/components/ui/SectionError'
import { section } from '@/lib/section'
import { AuditFilters } from './AuditFilters'
import { AuditExport } from './AuditExport'
import { getLang } from '@/lib/getLang'
import { t } from '@/lib/i18n'

// The filters live in the URL (see AuditFilters), so every distinct filter
// combination is its own render — nothing here may be cached across them.
export const dynamic = 'force-dynamic'

/** Query parameters forwarded to the API verbatim; anything else is ignored. */
const FILTER_KEYS = ['userId', 'action', 'from', 'to'] as const

/** Rows per page. The API's own default is 50; this page has always shown 20. */
const PAGE_SIZE = 20

/** Repeat a key and the first value wins: the API expects one, and guessing between two is worse than picking. */
const first = (raw: string | string[] | undefined) => (Array.isArray(raw) ? raw[0] : raw)

/**
 * `?offset=` as a row number, or 0.
 *
 * Decimal digits and nothing else — the same bar `parseAuditFilters` sets on the
 * backend, and for the same reason: `Number()` reads `1e3`, `0x10` and `' 7 '`
 * as numbers, and a hand-edited URL that lands on a page nobody asked for is
 * worse on the audit log than anywhere else.
 */
const parseOffset = (raw: string | undefined): number => {
  if (!raw || !/^\d+$/.test(raw)) return 0
  const value = Number(raw)
  return Number.isSafeInteger(value) ? value : 0
}

interface Props {
  searchParams: Promise<Record<string, string | string[] | undefined>>
}

export default async function AuditPage({ searchParams }: Props) {
  const session = await auth()
  if (!session) redirect('/login')

  const role = (session.user as unknown as { role: Role }).role
  if (role !== 'admin' && role !== 'root') redirect('/')

  const lang = await getLang()
  const params = await searchParams

  const filters = new URLSearchParams()
  for (const key of FILTER_KEYS) {
    const value = first(params[key])
    if (value) filters.set(key, value)
  }

  // Snapped to a page boundary rather than passed through. `?offset=7` would
  // otherwise ask the API for page 1 while the pager beside it built its links
  // from 7, so Next went to 27 and the row the reader was looking at was never
  // on either page.
  const offset = Math.floor(parseOffset(first(params.offset)) / PAGE_SIZE) * PAGE_SIZE

  const query = new URLSearchParams(filters)
  query.set('page', String(offset / PAGE_SIZE + 1))
  query.set('pageSize', String(PAGE_SIZE))

  const [listRes] = await Promise.allSettled([
    get<PaginatedResponse<AuditEntry>>(`/api/audit?${query.toString()}`),
  ])

  /*
   * A rejected list is NOT an empty audit log (#221).
   *
   * "No entries match" is a statement about the record, and an administrator
   * checking who changed something reads it as evidence — so an outage must not
   * produce the same screen as a clean record. `section` carries the reason as
   * well as the fact (#415) and logs it server-side, and it rethrows the
   * redirect an expired session throws from inside `get` (#427), which this
   * `allSettled` would otherwise swallow.
   */
  const list = section<PaginatedResponse<AuditEntry> | null>(listRes, null, 'audit log')
  const entries = list.data?.data ?? []
  const total = list.data?.total ?? 0

  return (
    <div className="max-w-6xl mx-auto space-y-6">
      <PageHeader
        title={t('auditLog', lang)}
        subtitle={t('auditSubtitle', lang)}
        actions={<AuditExport lang={lang} />}
      />

      <AuditFilters lang={lang} resultCount={entries.length} />

      {/* Either the error or the rows, never both. On a client-fetched table
          there were rows already on screen worth keeping through a failed
          refresh; here a failure is a render of a URL that has no rows yet, and
          the page the reader was on is still in history behind it. What must not
          happen is the table's "no audit entries" copy underneath an error,
          which is the confusion #221 is about. */}
      {list.error ? (
        <SectionError error={list.error} lang={lang} />
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

      {/* Links, not buttons: page two of the audit log is a thing one
          administrator sends another, and the row data for it only exists after
          a request. The filters ride along, so paging does not silently drop the
          query the person is reading through. */}
      <Pager
        total={total}
        limit={PAGE_SIZE}
        offset={offset}
        basePath="/audit"
        params={Object.fromEntries(filters)}
        lang={lang}
      />
    </div>
  )
}
