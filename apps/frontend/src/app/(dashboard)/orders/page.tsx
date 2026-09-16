import { auth } from '@/lib/auth'
import { get } from '@/lib/serverApi'
import { redirect } from 'next/navigation'
import Link from 'next/link'
import type { Order, OrderPage } from '@infrashelf/types'
import { PageHeader } from '@/components/layout/PageHeader'
import { RefreshButton } from '@/components/ui/RefreshButton'
import { AutoRefresh } from '@/components/ui/AutoRefresh'
import { hasUnsettled } from '@/lib/unsettled'
import { StatusBadge } from '@/components/ui/StatusBadge'
import { TrialBadge } from '@/components/ui/TrialBadge'
import { Table } from '@/components/ui/Table'
import { Pager } from '@/components/ui/Pager'
import { getLang } from '@/lib/getLang'
import { t } from '@/lib/i18n'

interface Props {
  searchParams: Promise<{ offset?: string }>
}

export default async function OrdersPage({ searchParams }: Props) {
  const session = await auth()
  if (!session) redirect('/login')

  const lang = await getLang()
  const { offset } = await searchParams

  // Let a genuine fetch failure throw to the (dashboard) error boundary so an
  // outage is not mistaken for an empty list. A successful empty response
  // still renders the empty state below.
  //
  // One page, not the whole history: this endpoint used to return every order
  // the viewer could see, each carrying two jsonb columns (#158). The offset is
  // passed through as the browser sent it — the backend clamps it, and a page
  // that second-guessed it here would only disagree with the count it renders.
  const page = (await get<OrderPage>(
    `/api/orders?lang=${lang}${offset ? `&offset=${encodeURIComponent(offset)}` : ''}`,
  )) ?? { items: [], total: 0, limit: 0, offset: 0 }
  const orders = page.items

  return (
    <div className="max-w-6xl mx-auto space-y-6">
      <PageHeader
        title={t('orders', lang)}
        subtitle={t('ordersSubtitle', lang)}
        /* The page checkout lands on, showing a status that arrives from CI
           minutes later — and until #314 it had no refresh control at all. The
           log has an operator pressing F5 ten times in two minutes on it. */
        actions={<RefreshButton />}
      />
      <AutoRefresh active={hasUnsettled(orders.map((o) => o.status))} />

      <Table<Order>
        columns={[
          {
            header: t('id', lang),
            render: (row) => (
              <Link href={`/orders/${row.id}`} className="font-mono text-blue-600 hover:underline text-xs">
                #{row.id}
              </Link>
            ),
          },
          {
            header: t('product', lang),
            render: (row) => (
              <span className="font-medium text-slate-900">
                {row.productName ?? `Product #${row.productId}`}
              </span>
            ),
          },
          { header: t('environment', lang), accessor: 'environmentName' },
          { header: t('project', lang), accessor: 'projectName' },
          {
            header: t('status', lang),
            render: (row) => (
              <div className="flex flex-wrap items-center gap-2">
                <StatusBadge status={row.status} lang={lang} />
                {row.isTrial && <TrialBadge lang={lang} />}
              </div>
            ),
          },
          {
            header: t('date', lang),
            render: (row) => (
              <span className="text-xs text-slate-600">
                {new Date(row.createdAt).toLocaleDateString(lang)}
              </span>
            ),
          },
        ]}
        data={orders}
        emptyMessage={t('noOrders', lang)}
      />

      <Pager
        total={page.total}
        limit={page.limit}
        offset={page.offset}
        basePath="/orders"
        lang={lang}
      />
    </div>
  )
}
