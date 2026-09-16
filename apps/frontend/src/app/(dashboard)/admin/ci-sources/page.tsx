import { auth } from '@/lib/auth'
import { get } from '@/lib/serverApi'
import { section } from '@/lib/section'
import { redirect } from 'next/navigation'
import type { Role, CiSource } from '@infrashelf/types'
import { PageHeader } from '@/components/layout/PageHeader'
import { CiSourcesManager } from './CiSourcesManager'
import { t } from '@/lib/i18n'
import { getLang } from '@/lib/getLang'

export default async function CiSourcesPage() {
  const session = await auth()
  if (!session) redirect('/login')
  const role = (session.user as unknown as { role: Role }).role
  if (role !== 'root') redirect('/admin')

  const lang = await getLang()

  /*
   * Fetched HERE, not by the manager on mount (#452).
   *
   * This page is already a server component — it authenticates and redirects
   * before anything renders — so asking for the rows costs nothing extra and the
   * browser gets them with the HTML instead of after it.
   *
   * `section()` rather than a bare await: an outage has to arrive as a reason
   * (#415), because "there are none" is a different claim and the one a reader
   * would act on.
   */
  const sources = section(
    await Promise.allSettled([get<CiSource[]>('/api/admin/ci-sources')]).then(([r]) => r),
    [] as CiSource[],
    'CI sources',
  )

  return (
    <div className="max-w-4xl mx-auto space-y-6">
      <PageHeader title={t('ciSources', lang)} subtitle={t('ciSourcesSubtitle', lang)} />
      <CiSourcesManager initial={sources.data} initialError={sources.error} />
    </div>
  )
}
