import { auth } from '@/lib/auth'
import { get } from '@/lib/serverApi'
import { section } from '@/lib/section'
import { redirect } from 'next/navigation'
import type { Role, Category } from '@infrashelf/types'
import { PageHeader } from '@/components/layout/PageHeader'
import { CategoriesManager } from './CategoriesManager'
import { t } from '@/lib/i18n'
import { getLang } from '@/lib/getLang'

export default async function CategoriesPage() {
  const session = await auth()
  if (!session) redirect('/login')
  const role = (session.user as unknown as { role: Role }).role
  if (role !== 'root') redirect('/admin')

  const lang = await getLang()

  /*
   * Fetched here, not by the component on mount (#456). This page is already a
   * server component — it authenticates and redirects before anything renders —
   * so the browser gets the rows with the HTML instead of after it. `section()`
   * so an outage arrives as a reason rather than as an empty list (#415).
   */
  const categories = section(
    await Promise.allSettled([get<Category[]>('/api/admin/categories')]).then(([r]) => r),
    [] as Category[],
    'categories',
  )

  return (
    <div className="max-w-3xl mx-auto space-y-6">
      <PageHeader title={t('categories', lang)} subtitle={t('categoriesSubtitle', lang)} />
      <CategoriesManager initial={categories.data} initialError={categories.error} />
    </div>
  )
}
