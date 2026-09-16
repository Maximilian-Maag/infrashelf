import { auth } from '@/lib/auth'
import { get } from '@/lib/serverApi'
import { cookies, headers } from 'next/headers'
import { redirect } from 'next/navigation'
import type { InfrastructureElement, InfraFacets, Role, InfrastructurePage } from '@infrashelf/types'
import { PageHeader } from '@/components/layout/PageHeader'
import { RefreshButton } from '@/components/ui/RefreshButton'
import { AutoRefresh } from '@/components/ui/AutoRefresh'
import { hasUnsettled } from '@/lib/unsettled'
import { SectionError } from '@/components/ui/SectionError'
import { section } from '@/lib/section'
import { Card } from '@/components/ui/Card'
import { Pager } from '@/components/ui/Pager'
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

  const lang = await detectLang()
  const params = await searchParams
  // The export endpoint is admin-and-above, so don't offer a button that would
  // only ever come back 403.
  const role = (session.user as unknown as { role: Role }).role
  const canExport = role === 'admin' || role === 'root'
  // Retry re-fires CI pipelines against real infrastructure — same bar as export.
  const canRetry = canExport

  const query = new URLSearchParams()
  // Set first so it survives whatever the filters add, and so a bookmarked URL
  // that happens to carry its own `lang` cannot make the rows disagree with the
  // rest of the page.
  query.set('lang', lang)
  for (const key of FILTER_KEYS) {
    const raw = params[key]
    // Take the first value if a key was repeated: the API expects one, and
    // guessing which of two conflicting values was meant is worse than picking.
    const value = Array.isArray(raw) ? raw[0] : raw
    if (value) query.set(key, value)
  }
  // Not one of FILTER_KEYS: `isFiltered` drives the "clear filters" affordance,
  // and page two of an unfiltered list is not a filtered list.
  const rawOffset = Array.isArray(params.offset) ? params.offset[0] : params.offset
  if (rawOffset) query.set('offset', rawOffset)

  const qs = query.toString()
  // `lang` is not a filter — it is always present now, so asking whether the
  // query string is empty would report every page as filtered.
  const isFiltered = FILTER_KEYS.some((key) => query.has(key))

  const [listRes, facetsRes] = await Promise.allSettled([
    get<InfrastructurePage>(`/api/infrastructure?${qs}`),
    // Same language as the rows: the facets are the option list for the filters
    // above them, and a dropdown naming products in another language reads as a
    // list of products the user does not have.
    get<InfraFacets>(`/api/infrastructure/facets?lang=${lang}`),
  ])

  // A rejected list is NOT an empty inventory. An invalid bookmarked filter comes
  // back 400 — exactly what parseInfraFilters rejects rather than silently
  // ignores — and a backend outage rejects too; showing "nothing matches" for
  // either claims the infrastructure is gone.
  //
  // It carries the REASON, not just the fact (#415). The 400 and the 502 are
  // different problems and this page said "an unexpected error occurred" for
  // both, discarding the one line that would have told the operator which. It is
  // logged server-side as well, so a failure the user reloads past still leaves
  // a trace.
  const list = section<InfrastructurePage | null>(listRes, null, 'infrastructure list')
  const listFailed = list.error !== null
  // One window, not every element ever provisioned (#158). An installation
  // accumulates these forever — decommissioned rows stay for the history — so
  // this is the list that grows without anybody placing an order.
  const page = list.data ?? { items: [], total: 0, limit: 0, offset: 0 }
  const elements = page.items
  // Empty facets degrade to unpopulated dropdowns rather than a broken page: the
  // free-text search and date filters still work without them. A degradation the
  // page already tolerates, so this one is logged rather than shown.
  const facets = section(facetsRes, { environments: [], projects: [], products: [] } as InfraFacets, 'infrastructure facets').data

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
        actions={
          <>
            {/* `router.refresh()` and not a reload: the rows are disclosures, and
                a reload would close every one the user had opened. */}
            <RefreshButton />
            {canExport ? <InfraExport lang={lang} /> : null}
          </>
        }
      />

      {/* `displayStatus` and not `status`: an element is 'active' from the
          moment its row is written, and what says it is still being built lives
          on its order (#287). Watching the stored column would stop polling
          exactly when there is something to wait for. */}
      <AutoRefresh active={hasUnsettled(elements.map((el) => el.displayStatus ?? el.status))} />

      <InfraFilters facets={facets} lang={lang} resultCount={elements.length} />

      {listFailed ? (
        <SectionError error={list.error} lang={lang} />
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
                <InfraRow key={item.id} item={item} lang={lang} canRetry={canRetry} />
              ))}
            </div>
          </Card>
        ))
      ) : (
        <Card>
          <div className="space-y-3">
            {elements.map((item) => (
              <InfraRow key={item.id} item={item} lang={lang} canRetry={canRetry} showProject />
            ))}
          </div>
        </Card>
      )}

      {/* Below the grouping, not inside it: the project cards group ONE page of
          elements, so a project's rows can legitimately continue on the next
          page and a pager per card would claim otherwise. */}
      <Pager
        total={page.total}
        limit={page.limit}
        offset={page.offset}
        basePath="/infrastructure"
        params={Object.fromEntries(query)}
        lang={lang}
      />
    </div>
  )
}

function InfraRow({
  item,
  lang,
  canRetry = false,
  showProject = false,
}: {
  item: InfrastructureElement
  lang: string
  canRetry?: boolean
  /** Set in the flat (explicitly-sorted) view, where no Card header names it. */
  showProject?: boolean
}) {
  const outputs = Object.entries(item.outputs ?? {})
  const outputLabel = outputs.length === 1 ? t('output', lang) : t('outputs', lang)
  // The server derives what to show (#287): the stored column is 'active' from
  // the moment provisioning starts, so it cannot tell a machine still being
  // built from one that is running, nor either from one whose pipeline failed.
  // This page used to derive half of that itself and the detail page derived
  // the same half again, which is how the provisioning case stayed missing in
  // both.
  const deploymentFailed = item.displayStatus === 'failed'
  return (
    <div className="rounded-lg border border-slate-200 p-4">
      {/* Wraps, and the text column may shrink: the actions cluster beside it
          is itself several buttons wide (#168). */}
      <div className="flex flex-wrap items-start justify-between gap-y-3">
        <div className="flex-1 min-w-0">
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
            <StatusBadge status={item.displayStatus ?? item.status} lang={lang} />
            {deploymentFailed && (
              <span className="text-xs text-slate-600">
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
          <p className="text-xs text-slate-600">
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
                    <span className="font-mono text-slate-600 min-w-24">{k}:</span>
                    <span className="font-mono text-slate-900 break-all">{v}</span>
                  </div>
                ))}
              </div>
            </details>
          )}
        </div>
        <InfraActions item={item} lang={lang} canRetry={canRetry} />
      </div>
    </div>
  )
}
