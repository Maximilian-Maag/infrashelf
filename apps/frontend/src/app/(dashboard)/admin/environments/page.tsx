import { auth } from '@/lib/auth'
import { redirect } from 'next/navigation'
import type { Role, CiSource, DeploymentEnvironment } from '@infrashelf/types'
import { PageHeader } from '@/components/layout/PageHeader'
import { EnvironmentsManager } from './EnvironmentsManager'
import { get } from '@/lib/serverApi'
import { section } from '@/lib/section'
import { t } from '@/lib/i18n'
import { getLang } from '@/lib/getLang'

export default async function EnvironmentsPage() {
  const session = await auth()
  if (!session) redirect('/login')
  const role = (session.user as unknown as { role: Role }).role
  if (role !== 'root') redirect('/admin')

  /*
   * Both fetched here, not one here and one on mount (#458).
   *
   * `ciSources` already came from this page; the environments now do too, so the
   * browser gets them with the HTML rather than after it. `section()` for both
   * rather than a `try`/`catch`: it keeps the reason (#415) and it cannot swallow
   * the login redirect `serverApi` throws for an ended session (#434), which the
   * catch this replaces had to rethrow by hand.
   */
  const [envsRes, ciRes] = await Promise.allSettled([
    get<DeploymentEnvironment[]>('/api/admin/environments'),
    get<CiSource[]>('/api/admin/ci-sources'),
  ])
  const envs = section(envsRes, [] as DeploymentEnvironment[], 'deployment environments')
  // An empty CI-source list costs the dropdown, not the page: an environment can
  // still be renamed or retired without one.
  const ciSources = section(ciRes, [] as CiSource[], 'CI sources for the environments form').data

  const lang = await getLang()

  return (
    <div className="max-w-4xl mx-auto space-y-6">
      <PageHeader title={t('environments', lang)} subtitle={t('environmentsSubtitle', lang)} />
      <EnvironmentsManager ciSources={ciSources} initial={envs.data} initialError={envs.error} />
    </div>
  )
}
