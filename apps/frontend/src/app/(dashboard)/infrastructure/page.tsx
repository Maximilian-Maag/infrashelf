import { auth } from '@/lib/auth'
import { get } from '@/lib/api'
import { cookies, headers } from 'next/headers'
import { redirect } from 'next/navigation'
import type { InfrastructureElement, InfraFacets, Role } from '@open-hybrid-cloud/types'
import { PageHeader } from '@/components/layout/PageHeader'
import { Card } from '@/components/ui/Card'
import { StatusBadge } from '@/components/ui/StatusBadge'
import { InfraActions } from './InfraActions'
import { InfraFilters } from './InfraFilters'
import { InfraExport } from './InfraExport'
import { t, isValidLang } from '@/lib/i18n'
import Link from 'next/link'

// Filters live in the URL (see InfraFilters), so every distinct filter
// combination is its own render — nothing here may be cached across them.
export const dynamic = 'force-dynamic'

/** Query parameters forwarded to the API verbatim; anything else is ignored. */
const FILTER_KEYS = [
  'search', 'status', 'environmentId', 'projectId', 'productId',
  'deployedFrom', 'deployedTo', 'sort', 'direction',
] as const

async function detectLang(): Promise<string> {
  const cookieStore = await cookies()
  const langCookie = cookieStore.get('lang')?.value
  if (langCookie && isValidLang(langCookie)) return langCookie
  const hdrs = await headers()
  const acceptLang = hdrs.get('accept-language') ?? ''
  const code = acceptLang.split(',')[0]?.split(';')[0]?.trim().split('-')[0].toLowerCase() ?? 'en'
  if (isValidLang(code)) return code
  return 'en'
}

interface Props {
  searchParams: Promise<Record<string, string | string[] | undefined>>
}

export default async function InfrastructurePage({ searchParams }: Props) {
  const session = await auth()
  if (!session) redirect('/login')

  const token = (session as unknown as { apiToken: string }).apiToken
  const lang = await detectLang()
  const params = await searchParams
  // The export endpoint is admin-and-above, so don't offer a button that would
  // only ever come back 403.
  const role = (session.user as unknown as { role: Role }).role
  const canExport = role === 'admin' || role === 'root'
  // Retry re-fires CI pipelines against real infrastructure — same bar as export.
  const canRetry = canExport

  const query = new URLSearchParams()
  for (const key of FILTER_KEYS) {
    const raw = params[key]
    // Take the first value if a key was repeated: the API expects one, and
    // guessing which of two conflicting values was meant is worse than picking.
    const value = Array.isArray(raw) ? raw[0] : raw
    if (value) query.set(key, value)
  }
  const qs = query.toString()
  const isFiltered = qs !== ''
  // `lang` is appended AFTER `isFiltered` is decided: it is not a filter, and
  // counting it as one would make every visit look like a narrowed list.
  const listQuery = new URLSearchParams(query)
  listQuery.set('lang', lang)

  const [listRes, facetsRes] = await Promise.allSettled([
    get<InfrastructureElement[]>(`/api/infrastructure?${listQuery.toString()}`, token),
    get<InfraFacets>(`/api/infrastructure/facets?lang=${lang}`, token),
  ])

  // A rejected list is NOT an empty inventory. An invalid bookmarked filter comes
  // back 400 — exactly what parseInfraFilters rejects rather than silently ignores —
  // and a backend outage rejects too; showing "nothing matches" for either claims
  // the infrastructure is gone.
  const listFailed = listRes.status === 'rejected'
  const elements = listRes.status === 'fulfilled' ? (listRes.value ?? []) : []
  // Empty facets degrade to unpopulated dropdowns rather than a broken page —
  // the free-text search and date filters still work.
  const facets = facetsRes.status === 'fulfilled'
    ? (facetsRes.value ?? { environments: [], projects: [], products: [] })
    : { environments: [], projects: [], products: [] }

  // Group by project — but only for the default date ordering. Bucketing by
  // project silently overrides an explicit name or status sort, since the group
  // a row lands in matters more than its position within it, so an explicit
  // sort gets a flat list that actually honours it.
  const sort = Array.isArray(params.sort) ? params.sort[0] : params.sort
  const grouped = !sort || sort === 'date'
  const byProject: Record<string, InfrastructureElement[]> = {}
  for (const el of elements) {
    const key = el.projectName ?? `Project #${el.projectId}`
    if (!byProject[key]) byProject[key] = []
    byProject[key].push(el)
  }

  return (
    <div className="max-w-6xl mx-auto space-y-6">
      <PageHeader
        title={t('infrastructureTitle', lang)}
        subtitle={t('infrastructureSubtitle', lang)}
        actions={canExport ? <InfraExport token={token} lang={lang} /> : undefined}
      />

      <InfraFilters facets={facets} lang={lang} resultCount={elements.length} />

      {listFailed ? (
        <div className="text-center py-12 text-red-600" role="alert">
          {t('unexpectedError', lang)}
        </div>
      ) : elements.length === 0 ? (
        <div className="text-center py-12 text-slate-600">
          {/* Distinguish "nothing deployed" from "nothing matches" — the first is
              a state to act on, the second means the filters are too narrow. */}
          {isFiltered ? t('noMatchingInfrastructure', lang) : t('noInfrastructure', lang)}
        </div>
      ) : grouped ? (
        Object.entries(byProject).map(([projectName, items]) => (
          <Card key={projectName} title={projectName}>
            <div className="space-y-3">
              {items.map((item) => (
                <InfraRow key={item.id} item={item} token={token} lang={lang} canRetry={canRetry} />
              ))}
            </div>
          </Card>
        ))
      ) : (
        <Card>
          <div className="space-y-3">
            {elements.map((item) => (
              <InfraRow key={item.id} item={item} token={token} lang={lang} canRetry={canRetry} showProject />
            ))}
          </div>
        </Card>
      )}
    </div>
  )
}

function InfraRow({
  item,
  token,
  lang,
  canRetry = false,
  showProject = false,
}: {
  item: InfrastructureElement
  token: string
  lang: string
  canRetry?: boolean
  /** Set in the flat (explicitly-sorted) view, where no Card header names it. */
  showProject?: boolean
}) {
  const outputs = Object.entries(item.outputs ?? {})
  const outputLabel = outputs.length === 1 ? t('output', lang) : t('outputs', lang)
  // An element whose provisioning pipeline failed is still stored as 'active' —
  // it is created when provisioning starts. Showing only that badge claims
  // infrastructure that was never successfully deployed, so say so explicitly.
  const deploymentFailed = item.orderStatus === 'failed'
  return (
    <div className="rounded-lg border border-slate-200 p-4">
      <div className="flex items-start justify-between">
        <div className="flex-1">
          <div className="flex items-center gap-3 mb-1">
            {/* The row's own heading is the way in: the outputs, parameters and
                pipeline runs are on the detail page, not in this list. */}
            <Link
              href={`/infrastructure/${item.id}`}
              className="font-medium text-slate-900 hover:underline"
            >
              {item.productName ?? `Product #${item.productId}`}
              {/* Two elements provisioned from the same product give two links with
                  the same name and different destinations (WCAG 2.4.9). The element
                  id is what distinguishes them, and it is already in the URL. */}
              <span className="sr-only"> #{item.id}</span>
            </Link>
            <StatusBadge status={deploymentFailed ? 'failed' : item.status} lang={lang} />
            {deploymentFailed && (
              <span className="text-xs text-slate-500">
                {t('deploymentFailed', lang)} · #{item.orderId}
              </span>
            )}
            {/* Scheduled teardown is a pending state change with a deadline, so it
                belongs next to the status rather than buried in the metadata line. */}
            {item.scheduledDecommissionAt && item.status === 'active' && (
              <span
                className="inline-flex items-center gap-1 rounded-full border border-amber-200 bg-amber-50 px-2.5 py-0.5 text-xs font-medium text-amber-800"
                title={new Date(item.scheduledDecommissionAt).toISOString()}
              >
                <svg className="h-3 w-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" aria-hidden="true">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z" />
                </svg>
                {t('scheduledFor', lang)} {new Date(item.scheduledDecommissionAt).toLocaleString(lang)}
              </span>
            )}
          </div>
          <p className="text-xs text-slate-500">
            {showProject && <>{item.projectName ?? `Project #${item.projectId}`} · </>}
            {item.environmentName}
            {/* The size this element runs at (issue #98) … */}
            {item.sizeCode && <> · {t('size', lang)}: {item.sizeCode}</>}
            {/* … and which of its order's N it is (issue #104). Twenty elements
                from one order are otherwise twenty identical rows, and teardown is
                per element, so knowing which one you are about to destroy is not
                cosmetic. */}
            {item.orderQuantity !== undefined && item.orderQuantity !== null && item.orderQuantity > 1 && (
              <> · {item.sequence ?? 1}/{item.orderQuantity}</>
            )}
            {' · '}
            {item.deployedAt ? new Date(item.deployedAt).toLocaleString(lang) : t('notDeployed', lang)}
          </p>
          {outputs.length > 0 && (
            <details className="mt-2">
              <summary className="inline-flex min-h-11 items-center cursor-pointer text-xs text-blue-600 hover:text-blue-700 select-none">
                {outputs.length} {outputLabel}
              </summary>
              <div className="mt-2 rounded bg-slate-50 p-2 space-y-1">
                {outputs.map(([k, v]) => (
                  <div key={k} className="flex gap-2 text-xs">
                    <span className="font-mono text-slate-500 min-w-24">{k}:</span>
                    <span className="font-mono text-slate-900 break-all">{v}</span>
                  </div>
                ))}
              </div>
            </details>
          )}
        </div>
        <InfraActions item={item} token={token} lang={lang} canRetry={canRetry} />
      </div>
    </div>
  )
}
