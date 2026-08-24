import { auth } from '@/lib/auth'
import { get } from '@/lib/api'
import { redirect, notFound } from 'next/navigation'
import type { Project, Order, CostCenter } from '@open-hybrid-cloud/types'
import { PageHeader } from '@/components/layout/PageHeader'
import { Breadcrumbs } from '@/components/layout/Breadcrumbs'
import { Card } from '@/components/ui/Card'
import { StatusBadge } from '@/components/ui/StatusBadge'
import { Table } from '@/components/ui/Table'
import { ProjectEditForm } from './ProjectEditForm'
import Link from 'next/link'
import { ButtonLink } from '@/components/ui/Button'
import { getLang } from '@/lib/getLang'
import { t } from '@/lib/i18n'

interface Props {
  params: Promise<{ id: string }>
}

export default async function ProjectDetailPage({ params }: Props) {
  const { id } = await params
  const session = await auth()
  if (!session) redirect('/login')

  const token = (session as unknown as { apiToken: string }).apiToken
  const lang = await getLang()

  let project: Project
  try {
    project = await get<Project>(`/api/projects/${id}`, token)
  } catch {
    notFound()
  }

  const [ordersRes, costCentersRes] = await Promise.allSettled([
    get<Order[]>(`/api/orders?projectId=${id}&lang=${lang}`, token),
    get<CostCenter[]>('/api/admin/cost-centers', token),
  ])

  const orders = ordersRes.status === 'fulfilled' ? (ordersRes.value ?? []) : []
  const costCenters = costCentersRes.status === 'fulfilled' ? (costCentersRes.value ?? []) : []

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

      <ProjectEditForm project={project} costCenters={costCenters} token={token} />

      {orders.length > 0 && (
        <Card title={t('ordersInProject', lang)}>
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
                  <span className="text-xs text-slate-500">
                    {new Date(row.createdAt).toLocaleDateString(lang)}
                  </span>
                ),
              },
            ]}
            data={orders}
          />
        </Card>
      )}
    </div>
  )
}
