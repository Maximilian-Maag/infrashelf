import { auth } from '@/lib/auth'
import { get } from '@/lib/serverApi'
import { redirect, notFound, unstable_rethrow } from 'next/navigation'
import type { Project, Order, CostCenter, OrderPage } from '@infrashelf/types'
import { PageHeader } from '@/components/layout/PageHeader'
import { Breadcrumbs } from '@/components/layout/Breadcrumbs'
import { Card } from '@/components/ui/Card'
import { StatusBadge } from '@/components/ui/StatusBadge'
import { Table } from '@/components/ui/Table'
import { ProjectEditForm } from './ProjectEditForm'
import Link from 'next/link'
import { ButtonLink } from '@/components/ui/Button'
import { SectionError } from '@/components/ui/SectionError'
import { section } from '@/lib/section'
import { getLang } from '@/lib/getLang'
import { t } from '@/lib/i18n'

interface Props {
  params: Promise<{ id: string }>
}

export default async function ProjectDetailPage({ params }: Props) {
  const { id } = await params
  const session = await auth()
  if (!session) redirect('/login')

  const lang = await getLang()

  let project: Project
  try {
    project = await get<Project>(`/api/projects/${id}`)
  } catch (e) {
    // A 401 redirect is not a failed fetch (#434).
    unstable_rethrow(e)
    notFound()
  }

  const [ordersRes, costCentersRes] = await Promise.allSettled([
    // The filter was already in this URL and the backend ignored it, so this
    // card listed every order the viewer could see — for an administrator, the
    // whole installation, each row linking off into somebody else's project
    // (#158). It is honoured now. One page of it: a project with more orders
    // than that has its own list, and this is a summary card.
    get<OrderPage>(`/api/orders?projectId=${id}`),
    get<CostCenter[]>('/api/admin/cost-centers'),
  ])

  // Two independent panels, each now carrying why it is empty (#415). "This
  // project has no orders" and "the order list could not be fetched" are
  // different facts, and the card said the first for both.
  const orders = section<OrderPage | null>(ordersRes, null, `orders for project ${id}`)
  const costCenters = section(costCentersRes, [] as CostCenter[], 'cost centers')

  return (
    <div className="max-w-4xl mx-auto space-y-6">
      <Breadcrumbs
        label={t('breadcrumb', lang)}
        items={[
          { label: t('projects', lang), href: '/projects' },
          { label: project.name },
        ]}
      />
      <PageHeader
        title={project.name}
        actions={
          <ButtonLink href="/projects" variant="secondary" size="sm">
            {t('backToProjects', lang)}
          </ButtonLink>
        }
      />

      {/* The cost centers are the dropdown inside the form, so their failure is
          said above it rather than replacing a form the user can still use for
          everything else. */}
      <SectionError error={costCenters.error} lang={lang} />
      <ProjectEditForm project={project} costCenters={costCenters.data} />

      {/* Rendered unconditionally. The card used to be hidden when the project
          had no orders, which made the empty message below unreachable — and
          left a project page that says nothing at all about orders, so a reader
          cannot tell "none yet" from "this page does not show them" (#186). */}
      <Card title={t('ordersInProject', lang)}>
        {/* The error goes IN PLACE of the table: an empty row reading "no
            orders" is exactly the claim that would be false (#415). The card
            itself stays, so the page still says what it is about. */}
        {orders.error ? (
          <SectionError error={orders.error} lang={lang} />
        ) : (
          <Table<Order>
            emptyMessage={t('noOrders', lang)}
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
                render: (row) => row.productName ?? `#${row.productId}`,
              },
              { header: t('environment', lang), accessor: 'environmentName' },
              {
                header: t('status', lang),
                render: (row) => <StatusBadge status={row.status} lang={lang} />,
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
            data={orders.data?.items ?? []}
          />
        )}
      </Card>
    </div>
  )
}
