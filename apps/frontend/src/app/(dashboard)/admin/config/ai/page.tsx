import { auth } from '@/lib/auth'
import { redirect, unstable_rethrow } from 'next/navigation'
import type { Role, AiConfig } from '@infrashelf/types'
import { get } from '@/lib/serverApi'
import { PageHeader } from '@/components/layout/PageHeader'
import { AiConfigForm } from './AiConfigForm'
import { t } from '@/lib/i18n'
import { getLang } from '@/lib/getLang'

export default async function AiConfigPage() {
  const session = await auth()
  if (!session) redirect('/login')
  const role = (session.user as unknown as { role: Role }).role
  if (role !== 'root') redirect('/admin')

  let config: AiConfig | null = null
  try {
    config = await get<AiConfig>('/api/admin/config/ai')
  } catch (e) {
    // A 401 redirect is not a failed fetch (#434).
    unstable_rethrow(e)
    /* use null */ }

  const lang = await getLang()

  return (
    <div className="max-w-2xl mx-auto space-y-6">
      <PageHeader title={t('aiConfiguration', lang)} subtitle={t('aiSubtitle', lang)} />
      <AiConfigForm initial={config} />
    </div>
  )
}
