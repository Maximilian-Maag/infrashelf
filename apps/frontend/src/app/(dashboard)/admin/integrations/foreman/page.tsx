import { auth } from '@/lib/auth'
import { get } from '@/lib/serverApi'
import { section } from '@/lib/section'
import { redirect } from 'next/navigation'
import type { Role, DeploymentEnvironment } from '@infrashelf/types'
import { PageHeader } from '@/components/layout/PageHeader'
import { ForemanReconcile } from './ForemanReconcile'
import { t } from '@/lib/i18n'
import { getLang } from '@/lib/getLang'

export default async function ForemanReconcilePage() {
  const session = await auth()
  if (!session) redirect('/login')
  const role = (session.user as unknown as { role: Role }).role
  if (role !== 'root') redirect('/admin')

  const lang = await getLang()

  /*
   * The environments, and only those. The report itself is NOT fetched here.
   *
   * Every other admin page fetches its rows server-side (#452) because they are
   * what the page is. This one makes an outbound call to somebody else's
   * inventory — slow, and occasionally a timeout — so it waits to be asked. A
   * page that reconciled on load would also do it again on every refresh, and
   * Foreman would be the one paying for that.
   */
  const environments = section(
    await Promise.allSettled([get<DeploymentEnvironment[]>('/api/admin/environments')]).then(
      ([r]) => r,
    ),
    [] as DeploymentEnvironment[],
    'environments',
  )

  return (
    <div className="max-w-4xl mx-auto space-y-6">
      <PageHeader
        title={t('foremanReconciliation', lang)}
        subtitle={t('foremanReconciliationSubtitle', lang)}
      />
      <ForemanReconcile environments={environments.data} environmentsError={environments.error} />
    </div>
  )
}
