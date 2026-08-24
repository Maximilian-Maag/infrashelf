import { auth } from '@/lib/auth'
import { redirect, notFound } from 'next/navigation'
import type {
  Role,
  ProductDetail,
  Category,
  DeploymentEnvironment,
  ProductTranslation,
  CostCenter,
} from '@open-hybrid-cloud/types'
import { get } from '@/lib/api'
import { getLang } from '@/lib/getLang'
import { t } from '@/lib/i18n'
import { PageHeader } from '@/components/layout/PageHeader'
import { Breadcrumbs } from '@/components/layout/Breadcrumbs'
import { ButtonLink } from '@/components/ui/Button'
import { ProductEditForm } from './ProductEditForm'
import { ProductImageUpload } from '../ProductImageUpload'
import { Card } from '@/components/ui/Card'
import { Alert } from '@/components/ui/Alert'

interface Props {
  params: Promise<{ id: string }>
  searchParams: Promise<Record<string, string | string[] | undefined>>
}

export default async function AdminProductDetailPage({ params, searchParams }: Props) {
  const { id } = await params
  // Set by the create form when the product was created but its image was not:
  // the product must not be lost over a failed upload, so the failure is carried
  // here instead of aborting creation.
  const imageErrorRaw = (await searchParams).imageError
  const imageError = Array.isArray(imageErrorRaw) ? imageErrorRaw[0] : imageErrorRaw
  const session = await auth()
  if (!session) redirect('/login')
  const role = (session.user as unknown as { role: Role }).role
  if (role !== 'root') redirect('/admin')
  const token = (session as unknown as { apiToken: string }).apiToken
  const lang = await getLang()

  const [productRes, categoriesRes, environmentsRes, translationsRes, costCentersRes] = await Promise.allSettled([
    get<ProductDetail>(`/api/admin/products/${id}?lang=${lang}`, token),
    get<Category[]>('/api/admin/categories', token),
    get<DeploymentEnvironment[]>('/api/admin/environments', token),
    get<ProductTranslation[]>(`/api/admin/products/${id}/translations`, token),
    // Needed to pick the fixed account for an `overhead` offering (FA-10.4).
    get<CostCenter[]>('/api/admin/cost-centers', token),
  ])

  if (productRes.status === 'rejected') notFound()

  const product = productRes.value
  const categories = categoriesRes.status === 'fulfilled' ? (categoriesRes.value ?? []) : []
  const environments = environmentsRes.status === 'fulfilled' ? (environmentsRes.value ?? []) : []
  const translations = translationsRes.status === 'fulfilled' ? (translationsRes.value ?? []) : []
  const costCenters = costCentersRes.status === 'fulfilled' ? (costCentersRes.value ?? []) : []

  return (
    <div className="max-w-4xl mx-auto space-y-6">
      {/* Two levels deep, so this is the page 2.4.8 is really about: reached from
          /admin/products, which is itself reached from /admin. The product's own
          name is not translated — it is the record's name, and the same string the
          heading and the products table show. */}
      <Breadcrumbs
        label={t('breadcrumb', lang)}
        items={[
          { label: t('admin', lang), href: '/admin' },
          { label: t('productsTitle', lang), href: '/admin/products' },
          { label: product.name },
        ]}
      />
      <PageHeader
        title={product.name}
        subtitle={t('editProductDetailsSubtitle', lang)}
        actions={
          <ButtonLink href="/admin/products" variant="secondary" size="sm">
            {t('backToProducts', lang)}
          </ButtonLink>
        }
      />
      {/* Its own card, above the details form: the picture is uploaded on its own
          request (multipart to /image), not saved with the rest of the fields. */}
      <Card title={t('productImage', lang)}>
        {imageError && (
          <div className="mb-3">
            <Alert>{t('productCreatedPrefix', lang)} {imageError}. {t('tryUploadingAgain', lang)}</Alert>
          </div>
        )}
        <ProductImageUpload productId={product.id} token={token} initialAlt={product.imageAlt} />
      </Card>

      <ProductEditForm
        product={product}
        categories={categories}
        environments={environments}
        translations={translations}
        costCenters={costCenters}
        token={token}
        lang={lang}
      />
    </div>
  )
}
