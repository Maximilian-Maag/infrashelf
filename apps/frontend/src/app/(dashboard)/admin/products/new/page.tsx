import { auth } from '@/lib/auth'
import { redirect, unstable_rethrow } from 'next/navigation'
import type { Role, Category, DeploymentEnvironment } from '@infrashelf/types'
import { get } from '@/lib/serverApi'
import { getLang } from '@/lib/getLang'
import { t } from '@/lib/i18n'
import { PageHeader } from '@/components/layout/PageHeader'
import { Breadcrumbs } from '@/components/layout/Breadcrumbs'
import { NewProductForm } from './NewProductForm'
import { ButtonLink } from '@/components/ui/Button'

export default async function NewProductPage() {
  const session = await auth()
  if (!session) redirect('/login')
  const role = (session.user as unknown as { role: Role }).role
  if (role !== 'root') redirect('/admin')
  const lang = await getLang()

  let categories: Category[] = []
  try {
    categories = (await get<Category[]>('/api/admin/categories')) ?? []
  } catch (e) {
    // A 401 redirect is not a failed fetch (#434).
    unstable_rethrow(e)
    /* empty */ }

  // For the optional template import below the form. An empty list degrades to
  // "import the parameters only" rather than to a broken page — the import still
  // works, it just has no environment to build a pipeline stack for.
  let environments: DeploymentEnvironment[] = []
  try {
    environments = (await get<DeploymentEnvironment[]>('/api/admin/environments')) ?? []
  } catch (e) {
    // A 401 redirect is not a failed fetch (#434).
    unstable_rethrow(e)
    /* empty */ }

  return (
    <div className="max-w-2xl mx-auto space-y-6">
      <Breadcrumbs
        label={t('breadcrumb', lang)}
        items={[
          { label: t('admin', lang), href: '/admin' },
          { label: t('productsTitle', lang), href: '/admin/products' },
          { label: t('newProduct', lang) },
        ]}
      />
      <PageHeader
        title={t('newProduct', lang)}
        actions={
          <ButtonLink href="/admin/products" variant="secondary" size="sm">
            {t('backToProducts', lang)}
          </ButtonLink>
        }
      />
      <NewProductForm categories={categories} environments={environments} />
    </div>
  )
}
