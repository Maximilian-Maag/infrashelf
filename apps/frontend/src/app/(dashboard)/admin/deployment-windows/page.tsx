import { auth } from '@/lib/auth'
import { get } from '@/lib/serverApi'
import { section } from '@/lib/section'
import { redirect } from 'next/navigation'
import type { Role } from '@infrashelf/types'
import { PageHeader } from '@/components/layout/PageHeader'
import { DeploymentWindowsManager, type Settings as WindowSettings } from './DeploymentWindowsManager'
import { HolidaysManager, type HolidaysPayload } from './HolidaysManager'
import { t } from '@/lib/i18n'
import { getLang } from '@/lib/getLang'

export default async function DeploymentWindowsPage() {
  const session = await auth()
  if (!session) redirect('/login')
  const role = (session.user as unknown as { role: Role }).role
  if (role !== 'root') redirect('/admin')

  const lang = await getLang()

  /*
   * Both policies fetched here (#460). They are one policy on the page — the
   * windows say when, the holidays say which days are excluded from it entirely
   * — but two requests, and a holidays outage must not take the windows editor
   * away or the reverse.
   *
   * `null` rather than an empty policy on failure: "no windows defined —
   * provisioning runs at any time" is a claim about how the installation
   * behaves, not an empty list, and it must not be made over a failed fetch.
   */
  const [windowsRes, holidaysRes] = await Promise.allSettled([
    get<WindowSettings>('/api/admin/deployment-windows'),
    get<HolidaysPayload>('/api/admin/holidays'),
  ])
  const windows = section<WindowSettings | null>(windowsRes, null, 'deployment windows')
  const holidays = section<HolidaysPayload | null>(holidaysRes, null, 'holidays')

  return (
    <div className="max-w-3xl mx-auto space-y-6">
      <PageHeader title={t('deploymentWindows', lang)} subtitle={t('deploymentWindowsSubtitle', lang)} />
      <DeploymentWindowsManager initial={windows.data} initialError={windows.error} />
      {/* Same page, because they are one policy: the windows say when, the
          holidays say which days are excluded from it entirely. */}
      <HolidaysManager initial={holidays.data} initialError={holidays.error} />
    </div>
  )
}
