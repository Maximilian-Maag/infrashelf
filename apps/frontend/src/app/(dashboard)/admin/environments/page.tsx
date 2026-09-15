import { auth } from '@/lib/auth'
import { redirect, unstable_rethrow } from 'next/navigation'
import type { Role, CiSource } from '@infrashelf/types'
import { PageHeader } from '@/components/layout/PageHeader'
import { EnvironmentsManager } from './EnvironmentsManager'
import { get } from '@/lib/serverApi'
import { t } from '@/lib/i18n'
import { getLang } from '@/lib/getLang'

export default async function EnvironmentsPage() {
  const session = await auth()
  if (!session) redirect('/login')
  const role = (session.user as unknown as { role: Role }).role
  if (role !== 'root') redirect('/admin')

  let ciSources: CiSource[] = []
  try {
    ciSources = (await get<CiSource[]>('/api/admin/ci-sources')) ?? []
  } catch (e) {
    // A 401 redirect is not a failed fetch (#434).
    unstable_rethrow(e)
    /* empty */ }

  const lang = await getLang()

  return (
    <div className="max-w-4xl mx-auto space-y-6">
      <PageHeader title={t('environments', lang)} subtitle={t('environmentsSubtitle', lang)} />
      <EnvironmentsManager ciSources={ciSources} />
    </div>
  )
}
