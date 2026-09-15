import { auth } from '@/lib/auth'
import { redirect, unstable_rethrow } from 'next/navigation'
import type { Role, Branding } from '@infrashelf/types'
import { get } from '@/lib/serverApi'
import { PageHeader } from '@/components/layout/PageHeader'
import { BrandingForm } from './BrandingForm'
import { t } from '@/lib/i18n'
import { getLang } from '@/lib/getLang'

export default async function BrandingPage() {
  const session = await auth()
  if (!session) redirect('/login')
  const role = (session.user as unknown as { role: Role }).role
  if (role !== 'root') redirect('/admin')

  let branding: Branding = {
    primaryColor: '#1e40af',
    secondaryColor: '#3b82f6',
    shopName: 'InfraShelf',
    shopSubtitle: '',
    imprintText: '',
  }

  try {
    branding = await get<Branding>('/api/admin/branding')
  } catch (e) {
    // A 401 redirect is not a failed fetch (#434).
    unstable_rethrow(e)
    /* use defaults */ }

  const lang = await getLang()

  return (
    <div className="max-w-2xl mx-auto space-y-6">
      <PageHeader title={t('branding', lang)} subtitle={t('brandingSubtitle', lang)} />
      <BrandingForm initial={branding} />
    </div>
  )
}
