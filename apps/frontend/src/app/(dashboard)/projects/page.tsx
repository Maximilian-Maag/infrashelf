import { auth } from '@/lib/auth'
import { get } from '@/lib/serverApi'
import { redirect } from 'next/navigation'
import Link from 'next/link'
import type { Project } from '@infrashelf/types'
import { PageHeader } from '@/components/layout/PageHeader'
import { Table } from '@/components/ui/Table'
import { NewProjectButton } from './NewProjectButton'
import { getLang } from '@/lib/getLang'
import { t } from '@/lib/i18n'

export default async function ProjectsPage() {
  const session = await auth()
  if (!session) redirect('/login')

  const lang = await getLang()

  // Let a genuine fetch failure throw to the (dashboard) error boundary so an
  // outage is not mistaken for an empty list. A successful empty response
  // still renders the empty state below.
  const projects = (await get<Project[]>('/api/projects')) ?? []

  return (
    <div className="max-w-6xl mx-auto space-y-6">
      <PageHeader
        title={t('projects', lang)}
        subtitle={t('projectsSubtitle', lang)}
        actions={<NewProjectButton />}
      />

      <Table<Project>
        columns={[
          {
            header: t('name', lang),
            render: (row) => (
              <Link href={`/projects/${row.id}`} className="font-medium text-blue-600 hover:underline">
                {row.name}
              </Link>
            ),
          },
          { header: t('description', lang), accessor: 'description' },
          { header: t('owner', lang), accessor: 'ownerName' },
          {
            header: t('costCenter', lang),
            render: (row) => <span>{row.costCenterName ?? '—'}</span>,
          },
          {
            header: t('created', lang),
            render: (row) => (
              <span className="text-xs text-slate-600">
                {new Date(row.createdAt).toLocaleDateString(lang)}
              </span>
            ),
          },
        ]}
        data={projects}
        emptyMessage={t('noProjects', lang)}
      />
    </div>
  )
}
