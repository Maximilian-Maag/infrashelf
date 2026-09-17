import { auth } from '@/lib/auth'
import { get } from '@/lib/serverApi'
import { section } from '@/lib/section'
import { redirect } from 'next/navigation'
import type { Role, Integration, DeploymentEnvironment } from '@infrashelf/types'
import { PageHeader } from '@/components/layout/PageHeader'
import { IntegrationsManager } from './IntegrationsManager'
import { t } from '@/lib/i18n'
import { getLang } from '@/lib/getLang'

export default async function IntegrationsPage() {
  const session = await auth()
  if (!session) redirect('/login')
  const role = (session.user as unknown as { role: Role }).role
  // Root-only, like CI sources and for the same reason: these rows hold
  // credentials to systems that can change infrastructure.
  if (role !== 'root') redirect('/admin')

  const lang = await getLang()

  /*
   * Both lists fetched HERE (#452), and settled independently (#415).
   *
   * The environments are not decoration: an integration bound to one shows its
   * NAME rather than "environment #4", and the create form cannot offer a
   * binding it does not know about. But an environments outage must not make
   * the page claim there are no integrations — so they are two sections with
   * two reasons, not one await that fails together.
   *
   * Both reasons are carried, not just the data. A manager handed an empty list
   * and no reason would offer "portal-wide" as the only binding and rewrite one
   * on save (CodeRabbit, PR #498); with the reason it disables the field and
   * leaves the stored binding alone.
   */
  const [integrationsResult, environmentsResult] = await Promise.allSettled([
    get<Integration[]>('/api/admin/integrations'),
    get<DeploymentEnvironment[]>('/api/admin/environments'),
  ])

  const integrations = section(integrationsResult, [] as Integration[], 'integrations')
  const environments = section(environmentsResult, [] as DeploymentEnvironment[], 'environments')

  return (
    <div className="max-w-4xl mx-auto space-y-6">
      <PageHeader title={t('integrations', lang)} subtitle={t('integrationsSubtitle', lang)} />
      <IntegrationsManager
        initial={integrations.data}
        initialError={integrations.error}
        environments={environments.data}
        environmentsError={environments.error}
      />
    </div>
  )
}
