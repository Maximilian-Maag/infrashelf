import { auth } from '@/lib/auth'
import { redirect, notFound, unstable_rethrow } from 'next/navigation'
import type {
  Role,
  ProductDetail,
  Category,
  DeploymentEnvironment,
  ProductTranslation,
  CostCenter,
  SizeMatrix,
} from '@infrashelf/types'
import { get } from '@/lib/serverApi'
import { SectionError } from '@/components/ui/SectionError'
import { section } from '@/lib/section'
import { getLang } from '@/lib/getLang'
import { t } from '@/lib/i18n'
import { PageHeader } from '@/components/layout/PageHeader'
import { Breadcrumbs } from '@/components/layout/Breadcrumbs'
import { ButtonLink } from '@/components/ui/Button'
import { ProductEditForm } from './ProductEditForm'
import { ProductImageUpload, type GalleryImage } from '../ProductImageUpload'
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
  const lang = await getLang()

  const [productRes, categoriesRes, environmentsRes, translationsRes, costCentersRes, imagesRes, sizesRes] = await Promise.allSettled([
    get<ProductDetail>(`/api/admin/products/${id}`),
    get<Category[]>('/api/admin/categories'),
    get<DeploymentEnvironment[]>('/api/admin/environments'),
    get<ProductTranslation[]>(`/api/admin/products/${id}/translations`),
    // Needed to pick the fixed account for an `overhead` offering (FA-10.4).
    get<CostCenter[]>('/api/admin/cost-centers'),
    // The gallery, which the upload control used to ask for on mount (#462).
    get<GalleryImage[]>(`/api/admin/products/${id}/images`),
    // The size/price grid, which the matrix editor used to ask for on mount (#473).
    get<SizeMatrix>(`/api/admin/products/${id}/sizes`),
  ])

  if (productRes.status === 'rejected') {
    // A 401 redirect is not a failed fetch (#434). `allSettled` collects it
    // as a rejection like any other, so without this an ended session is
    // reported as a product that does not exist.
    unstable_rethrow(productRes.reason)
    notFound()
  }

  const product = productRes.value
  // The product is already a 404 when it fails. These four seed the form, and on
  // an EDIT screen an empty one is worse than on a read-only page: a translations
  // list that silently came back empty makes the form offer "add translation" for
  // a language that already has one, and an empty environments list looks like an
  // installation with none configured. Each still degrades independently — one
  // outage must not take the whole form away — but the reason is now on the page
  // (#415).
  const categories = section(categoriesRes, [] as Category[], `categories for product ${id}`)
  const environments = section(environmentsRes, [] as DeploymentEnvironment[], `environments for product ${id}`)
  const translations = section(translationsRes, [] as ProductTranslation[], `translations for product ${id}`)
  const costCenters = section(costCentersRes, [] as CostCenter[], `cost centers for product ${id}`)
  const images = section(imagesRes, [] as GalleryImage[], `gallery for product ${id}`)
  /*
   * Not through `section` (#473): its whole job is to turn a failure into a
   * fallback, and the fallback here would be an empty grid — which is a real
   * answer meaning "no sizes priced yet", on the one screen where believing it
   * gets a product priced twice. `undefined` says nobody knows, and the editor
   * retries and reports its own outcome. `unstable_rethrow` because a redirect
   * from an ended session arrives here as a rejection like any other (#427) —
   * `section` does that for the five above; this one has to do it itself.
   */
  if (sizesRes.status === 'rejected') unstable_rethrow(sizesRes.reason)
  const sizes = sizesRes.status === 'fulfilled' ? (sizesRes.value ?? undefined) : undefined

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
      {/* Its own card, above the details form: pictures are uploaded on their own
          requests (multipart to /images), not saved with the rest of the fields. */}
      <Card title={t('productImages', lang)}>
        {imageError && (
          <div className="mb-3">
            <Alert>{t('productCreatedPrefix', lang)} {imageError}. {t('tryUploadingAgain', lang)}</Alert>
          </div>
        )}
        <ProductImageUpload productId={product.id} initial={images.data} initialError={images.error} />
      </Card>

      {/* One line for all four: they seed different parts of the same form, and
          four stacked banners would push the form itself off the screen. */}
      <SectionError
        error={categories.error ?? environments.error ?? translations.error ?? costCenters.error}
        lang={lang}
      />

      <ProductEditForm
        product={product}
        categories={categories.data}
        environments={environments.data}
        translations={translations.data}
        costCenters={costCenters.data}
        initialSizes={sizes}
        lang={lang}
      />
    </div>
  )
}
