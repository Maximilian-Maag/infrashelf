import { auth } from '@/lib/auth'
import { get } from '@/lib/serverApi'
import { redirect, notFound, unstable_rethrow } from 'next/navigation'
import Link from 'next/link'
import type {
  ProductDetail,
  Project,
  CostCenter,
  ExchangeRate,
  Category,
  CatalogPage,
  Role,
} from '@infrashelf/types'
import { Card } from '@/components/ui/Card'
import { OrderForm } from '@/components/forms/OrderForm'
import { AddToCart } from './AddToCart'
import { ProductGallery } from '@/components/ui/ProductGallery'
import { ProductSpecs } from '@/components/ui/ProductSpecs'
import { ProductImage } from '@/components/ui/ProductImage'
import { Breadcrumbs } from '@/components/layout/Breadcrumbs'
import { SectionError } from '@/components/ui/SectionError'
import { section } from '@/lib/section'
import { getLang } from '@/lib/getLang'
import { t } from '@/lib/i18n'
import { localeToCurrency, convertPrice, sortByValue } from '@/lib/locale'

interface Props {
  params: Promise<{ id: string }>
  searchParams: Promise<Record<string, string | string[] | undefined>>
}

/** First value only — a repeated key has no meaningful "both". */
const one = (raw: string | string[] | undefined): string | undefined =>
  Array.isArray(raw) ? raw[0] : raw

/**
 * Product detail, laid out the way a shopper expects a shop to be laid out:
 * picture on the left, what it is in the middle, and the buy box — price, what it
 * costs where, and the two calls to action — pinned on the right. The ordering
 * form itself sits below, because it asks for parameters and a project and that is
 * a form, not a buy box.
 */
export default async function ProductDetailPage({ params, searchParams }: Props) {
  const { id } = await params
  const query = await searchParams
  // Quick reorder from the infrastructure list (issue #39).
  const fromInfraId = one(query.fromInfra)
  const initialProjectId = one(query.projectId)
  const session = await auth()
  if (!session) redirect('/login')

  const lang = await getLang()
  const localeCurrency = localeToCurrency(lang)

  const [productRes, projectsRes, costCentersRes, ratesRes, categoriesRes] = await Promise.allSettled([
    get<ProductDetail>(`/api/catalog/${id}?lang=${lang}`),
    get<Project[]>('/api/projects'),
    get<CostCenter[]>('/api/admin/cost-centers'),
    get<ExchangeRate[]>('/api/admin/exchange-rates'),
    get<Category[]>('/api/admin/categories'),
  ])

  if (productRes.status === 'rejected') notFound()
  const product = productRes.value

  // Cross-selling, at the size this catalogue actually is: "other products in this
  // category" (issue #107). No new endpoint — the paged catalogue list already
  // filters by category, and asking for one more than we show covers the case
  // where this product is in the page it returns.
  const relatedRes = await get<CatalogPage>(
    `/api/catalog?lang=${lang}&categoryId=${product.categoryId}&limit=5`,
  ).catch((e: unknown) => {
    // A 401 redirect is not a failed fetch (#434): `catch` here would turn an
    // ended session into a page with no related products instead of the login
    // screen.
    unstable_rethrow(e)
    return null
  })
  const related = (relatedRes?.items ?? []).filter((item) => item.id !== product.id).slice(0, 4)
  // The product itself is the page and a rejection there is already a 404. These
  // three fill the order form beside it, and an empty project dropdown stops the
  // user ordering just as surely as a broken page — so it says why rather than
  // looking like an account with no projects (#415).
  const projects = section(projectsRes, [] as Project[], `projects for product ${id}`)
  const costCenters = section(costCentersRes, [] as CostCenter[], `cost centers for product ${id}`)
  // The category only names a breadcrumb, so its failure is logged and left at
  // that — an unnamed breadcrumb is not worth a banner over the product.
  const categories = section(categoriesRes, [] as Category[], 'categories')
  const categoryName = categories.data.find((c) => c.id === product.categoryId)?.name

  // Same as the cart: without rates the price is shown in the currency it is
  // stored in, labelled as such, so the figure stays true and only the log needs
  // to know.
  const rates = section(ratesRes, [] as ExchangeRate[], 'exchange rates')
  const ratesMap: Record<string, number> = Object.fromEntries(
    rates.data.map((r) => [r.currencyCode, parseFloat(r.rate)]),
  )

  /** One amount in the viewer's currency, with the original alongside. */
  const priceOf = (amount: { price: string; currency: string }) => {
    const converted = convertPrice(amount.price, amount.currency, localeCurrency, ratesMap, lang)
    return {
      display: `${converted.amount} ${converted.currency}`,
      original: converted.currency !== amount.currency ? `${amount.price} ${amount.currency}` : null,
    }
  }

  // Whether this viewer's order is provisioned straight away or queued for
  // approval is a property of their role, not of the product — createOrder branches
  // on exactly this. Saying so here is the honest version of "does this need
  // approval", and it needs no schema of its own.
  const role = (session.user as unknown as { role: Role }).role
  const ordersNeedApproval = role !== 'admin' && role !== 'root'

  /**
   * What an offering can cost — one amount per size, or its own single price when
   * it has no sizes (issue #98).
   *
   * Price moved to the size, so "the price of an environment" is no longer one
   * number. `product_environments.price` is still the answer for an offering that
   * defines no sizes, which is every offering that predates sizing.
   */
  type Offering = ProductDetail['environments'][number]
  const amountsOf = (env: Offering) =>
    env.sizes && env.sizes.length > 0
      ? env.sizes.map((size) => ({ price: size.price, currency: size.currency }))
      : [{ price: env.price, currency: env.currency }]

  // Compared in EUR rather than by the digits: each size carries its own
  // currency, so the smallest number is not the cheapest offer.
  const cheapestOf = (env: Offering) => sortByValue(amountsOf(env), ratesMap)[0]

  /**
   * An offering's price as a shopper reads it: one figure, or a range across its
   * sizes.
   *
   * A range rather than "from X": it is a dash between two prices, which needs no
   * word and therefore no twenty-fifth translation of one.
   */
  const rangeOf = (env: Offering): { display: string; original: string | null } => {
    const sorted = sortByValue(amountsOf(env), ratesMap)
    const cheapest = sorted[0]
    const dearest = sorted[sorted.length - 1]
    const low = priceOf(cheapest)
    // Currency as well as price: two sizes at "10" in different currencies are
    // two different prices, and collapsing them to one figure hides that.
    if (cheapest.price === dearest.price && cheapest.currency === dearest.currency) return low
    const high = priceOf(dearest)
    return { display: `${low.display} – ${high.display}`, original: null }
  }

  // The buy box leads with the cheapest thing the product can be bought for,
  // because that is the number a shopper reads as "the price" — the full list is
  // right below it.
  const cheapest = sortByValue(
    product.environments.map((env) => ({ ...cheapestOf(env), env })),
    ratesMap,
  )[0]?.env

  return (
    <div className="max-w-screen-xl mx-auto">
      {/* Was an ad-hoc <nav> named "Catalog" that stopped at the category and
          never named the product — so it read as a second nav landmark rather
          than a location. */}
      <Breadcrumbs
        label={t('breadcrumb', lang)}
        items={[
          { label: t('catalog', lang), href: '/catalog' },
          // No href: the catalogue's category filter is client state, not a URL
          // parameter, so there is nothing to link to. A crumb that is not a link
          // is still a location.
          ...(categoryName ? [{ label: categoryName }] : []),
          { label: product.name },
        ]}
      />

      <div className="grid grid-cols-1 gap-6 lg:grid-cols-12">
        {/* Pictures */}
        <div className="lg:col-span-4">
          <div className="h-96 rounded-lg border border-slate-200 bg-white p-4 lg:sticky lg:top-28">
            <ProductGallery productId={product.id} images={product.images} lang={lang} />
          </div>
        </div>

        {/* What it is */}
        <div className="lg:col-span-5">
          <h1 className="text-2xl font-bold text-slate-900">{product.name}</h1>
          {categoryName && (
            <p className="mt-1 text-xs font-semibold uppercase tracking-wide" style={{ color: 'var(--bp-text)' }}>
              {categoryName}
            </p>
          )}
          <hr className="my-4 border-slate-200" />
          <p className="leading-relaxed text-slate-600">{product.description}</p>

          {/* The short description has to fit a catalogue tile, so it was never
              going to carry the product's story. This is the long one, and it is
              simply absent when nobody has written it. */}
          {product.longDescription && (
            <>
              <h2 className="mt-6 mb-2 text-sm font-semibold text-slate-700">
                {t('aboutThisProduct', lang)}
              </h2>
              {/* Split on blank lines rather than rendering the text as HTML:
                  paragraphs are what a description needs, and the alternative is
                  injecting operator-supplied markup into the page. */}
              {product.longDescription
                .split(/\n\s*\n/)
                .map((paragraph) => paragraph.trim())
                .filter(Boolean)
                .map((paragraph, index) => (
                  <p key={index} className="mt-2 leading-relaxed text-slate-600 whitespace-pre-line">
                    {paragraph}
                  </p>
                ))}
            </>
          )}

          {/* What a shopper checks before ordering, in the order they ask: who runs
              it, whether ordering it means waiting for someone, and where the real
              documentation is. */}
          <h2 className="mt-6 mb-2 text-sm font-semibold text-slate-700">{t('goodToKnow', lang)}</h2>
          <dl className="divide-y divide-slate-200 rounded-lg border border-slate-200 bg-white text-sm">
            {product.owner && (
              <div className="flex items-baseline justify-between gap-3 px-4 py-2">
                <dt className="text-slate-500">{t('owner', lang)}</dt>
                <dd className="text-right font-medium text-slate-900">{product.owner}</dd>
              </div>
            )}
            <div className="flex items-baseline justify-between gap-3 px-4 py-2">
              {/* "Order" rather than "Approval": the row answers what happens when
                  you order this, and the sentence in the value says whether that
                  involves waiting for somebody. */}
              <dt className="text-slate-500">{t('order', lang)}</dt>
              <dd className="text-right text-slate-700">
                {ordersNeedApproval ? t('approvalRequired', lang) : t('approvalImmediate', lang)}
              </dd>
            </div>
            {product.docsUrl && (
              <div className="flex items-baseline justify-between gap-3 px-4 py-2">
                <dt className="text-slate-500">{t('documentation', lang)}</dt>
                <dd className="text-right">
                  {/* Underlined at rest, like the breadcrumb above and for the same
                      reason: colour alone is not enough (WCAG 1.4.1). */}
                  <a
                    href={product.docsUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="break-all underline"
                    style={{ color: 'var(--bp-text)' }}
                  >
                    {product.docsUrl}
                  </a>
                </dd>
              </div>
            )}
          </dl>

          {product.environments.length > 0 && (
            <>
              <h2 className="mt-6 mb-2 text-sm font-semibold text-slate-700">
                {t('availableEnvironments', lang)}
              </h2>
              <ul className="divide-y divide-slate-200 rounded-lg border border-slate-200 bg-white">
                {product.environments.map((env) => {
                  const price = rangeOf(env)
                  return (
                    <li key={env.environmentId} className="flex items-baseline justify-between gap-3 px-4 py-2">
                      <span className="text-sm text-slate-700">
                        {env.environmentName ?? `Env ${env.environmentId}`}
                      </span>
                      <span className="text-sm font-medium text-slate-900">
                        {price.display}
                        {price.original && (
                          <span className="ml-2 text-xs font-normal text-slate-500">({price.original})</span>
                        )}
                      </span>
                    </li>
                  )
                })}
              </ul>
            </>
          )}
        </div>

        {/* Buy box. Omitted outright when the product is offered nowhere: a price
            box with no price and no working button is worse than none. */}
        {cheapest && (
          <div className="lg:col-span-3">
            <div className="rounded-lg border border-slate-200 bg-white p-4 lg:sticky lg:top-28">
              <div className="space-y-3">
                {/* The price used to be rendered here, server-side, as the
                    cheapest thing the product could be bought for — a figure
                    that never moved while the shopper picked a size. Since the
                    size IS the price, it belongs with the picker: AddToCart
                    renders it and it follows the choice. */}
                {/* Environment plus one click, and nothing else: parameters are
                    what checkout is for (issue #28). */}
                <AddToCart product={product} ratesMap={ratesMap} lang={lang} />
                {/* Styled as a link, not a Button inside a Link: nested
                    interactives fail the axe gate in e2e/a11y.spec.ts. Outlined
                    rather than filled — it is the second action, and it only jumps
                    to the form below. */}
                <a
                  href="#order"
                  className="flex min-h-11 w-full items-center justify-center rounded-full border border-slate-300 bg-white px-4 py-2 text-center text-sm font-semibold text-slate-700 transition-all hover:bg-slate-50 focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-500"
                >
                  {t('orderNow', lang)}
                </a>
              </div>
            </div>
          </div>
        )}
      </div>

      {/* The specification table: the parameters this product takes, which are the
          closest thing here to "technical details" and were previously visible
          only once you had scrolled into the order form. */}
      {product.parameters.length > 0 && (
        <div className="mt-8 max-w-3xl">
          <h2 className="mb-2 text-sm font-semibold text-slate-700">{t('specifications', lang)}</h2>
          <ProductSpecs parameters={product.parameters} lang={lang} />
        </div>
      )}

      {/* The form proper, linked from the buy box above. */}
      <div id="order" className="mt-8 max-w-3xl scroll-mt-28">
        <Card title={t('placeOrder', lang)}>
          {/* Above the form, not instead of it: the fields that did load are
              still worth showing, and a user who sees an empty project list with
              no explanation reports it as "I cannot order this". */}
          <SectionError
            error={projects.error ?? costCenters.error}
            lang={lang}
            className="mb-4"
          />
          <OrderForm
            product={product}
            projects={projects.data}
            costCenters={costCenters.data}
            lang={lang}
            exchangeRates={ratesMap}
            localeCurrency={localeCurrency}
            fromInfraId={fromInfraId}
            initialProjectId={initialProjectId}
          />
        </Card>
      </div>

      {/* Cross-selling that means something in an internal catalogue: not
          "customers also bought" — there is no such signal here — but the other
          things in the same category, which is what a shopper who is comparing
          would go looking for next. */}
      {related.length > 0 && (
        <section aria-labelledby="related-heading" className="mt-10">
          <h2 id="related-heading" className="mb-3 text-sm font-semibold text-slate-700">
            {t('otherInCategory', lang)}
          </h2>
          <ul className="grid grid-cols-2 gap-4 sm:grid-cols-4">
            {related.map((item) => (
              <li key={item.id}>
                <Link
                  href={`/catalog/${item.id}`}
                  className="flex h-full flex-col overflow-hidden rounded-lg border border-slate-200 bg-white transition-shadow hover:shadow-md focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-500"
                >
                  <span
                    className="block h-28 border-b border-slate-100 p-2"
                    style={{ backgroundColor: 'color-mix(in srgb, var(--bp) 8%, white)' }}
                  >
                    {/* Decorative: the link's own text names the product, so the
                        picture would be announced twice. */}
                    <ProductImage productId={item.id} alt="" />
                  </span>
                  <span className="block p-3 text-sm font-medium text-slate-900">{item.name}</span>
                </Link>
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  )
}
