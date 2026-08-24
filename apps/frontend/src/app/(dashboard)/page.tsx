import { auth } from '@/lib/auth'
import { get } from '@/lib/api'
import { redirect } from 'next/navigation'
import Link from 'next/link'
import type { Order, InfrastructureElement, Project, CatalogPage, Role } from '@open-hybrid-cloud/types'
import { StatusBadge } from '@/components/ui/StatusBadge'
import { CountUp } from '@/components/ui/CountUp'
import { getLang } from '@/lib/getLang'
import { t } from '@/lib/i18n'

function StatCard({ label, value, href, linkLabel }: { label: string; value: number; href?: string; linkLabel?: string }) {
  const inner = (
    <div className="bg-white border border-slate-200 rounded-lg p-5 hover:shadow-sm transition-shadow">
      <div className="text-xs font-semibold text-slate-600 uppercase tracking-wide mb-1">{label}</div>
      <div className="text-3xl font-bold text-slate-800"><CountUp value={value} /></div>
      {linkLabel && href && (
        <span className="text-xs mt-2 inline-block" style={{ color: 'var(--bp-text)' }}>{linkLabel}</span>
      )}
    </div>
  )
  if (href) {
    return <Link href={href} className="block">{inner}</Link>
  }
  return inner
}

export default async function DashboardHome() {
  const session = await auth()
  if (!session) redirect('/login')

  const token = (session as unknown as { apiToken: string }).apiToken
  const role = (session.user as unknown as { role: Role }).role
  const lang = await getLang()

  const [orders, infra, projects, products] = await Promise.allSettled([
    get<Order[]>(`/api/orders?lang=${lang}`, token),
    get<InfrastructureElement[]>(`/api/infrastructure?lang=${lang}`, token),
    get<Project[]>('/api/projects', token),
    // Eight cards, so ask for eight rows: this used to fetch the whole catalogue
    // and slice it in the browser (#91).
    get<CatalogPage>(`/api/catalog?lang=${lang}&limit=8`, token),
  ])

  const orderList = orders.status === 'fulfilled' ? (orders.value ?? []) : []
  const infraList = infra.status === 'fulfilled' ? (infra.value ?? []) : []
  const projectList = projects.status === 'fulfilled' ? (projects.value ?? []) : []
  const productList = products.status === 'fulfilled' ? (products.value?.items ?? []) : []

  const activeInfra = infraList.filter((i) => i.status === 'active').length
  const pendingOrders = orderList.filter((o) => o.status === 'pending').length
  const featuredProducts = productList
  const isAdminOrRoot = role === 'admin' || role === 'root'

  return (
    <div className="space-y-8">
      {/* Hero banner */}
      <div className="rounded-xl overflow-hidden" style={{ backgroundColor: 'var(--bp)', color: 'var(--bp-ink)' }}>
        <div className="px-8 py-10 flex flex-col sm:flex-row items-center gap-6">
          <div className="flex-1">
            <h2 className="text-2xl sm:text-3xl font-bold leading-tight mb-2">
              {t('welcomeBack', lang)}, {session.user?.name ?? 'User'}
            </h2>
            <p className="text-sm sm:text-base mb-5">
              {t('heroSubtitle', lang)}
            </p>
            <Link
              href="/catalog"
              className="inline-flex items-center gap-2 px-5 py-2.5 rounded font-semibold text-sm text-gray-900 hover:brightness-95 transition-all"
              style={{ backgroundColor: 'var(--bs)', color: 'var(--bs-ink)' }}
            >
              {t('browseCatalog', lang)}
              <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
              </svg>
            </Link>
          </div>
          <div className="hidden sm:flex items-center justify-center opacity-20 shrink-0">
            <svg className="h-28 w-28 opacity-90" aria-hidden="true" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={0.5} d="M5 12h14M5 12a2 2 0 01-2-2V6a2 2 0 012-2h14a2 2 0 012 2v4a2 2 0 01-2 2M5 12a2 2 0 00-2 2v4a2 2 0 002 2h14a2 2 0 002-2v-4a2 2 0 00-2-2" />
            </svg>
          </div>
        </div>
      </div>

      {/* Stats strip */}
      <div className={`grid gap-4 ${isAdminOrRoot ? 'grid-cols-2 lg:grid-cols-4' : 'grid-cols-2 lg:grid-cols-3'}`}>
        <StatCard label={t('totalOrders', lang)} value={orderList.length} href="/orders" linkLabel={t('viewAll', lang)} />
        <StatCard label={t('activeInfrastructure', lang)} value={activeInfra} href="/infrastructure" linkLabel={t('overview', lang)} />
        {isAdminOrRoot && (
          pendingOrders > 0 ? (
            /* amber-700, not amber-600: the two 12px lines here are body text, and
               amber-600 (#e17100) on amber-50 (#fffbeb) measures 3.08:1 against the
               4.5:1 AA needs. amber-700 (#bb4d00) on the same ground is 4.85:1, and
               it is already the pairing the rest of the app uses on amber-50. This
               has nothing to do with the operator's brand colour — it is a fixed
               palette pair, which is why it failed the gate on the default branding
               and on the hostile one alike. */
            <Link href="/approvals" className="block bg-amber-50 border border-amber-200 rounded-lg p-5 hover:shadow-sm transition-shadow">
              <div className="text-xs font-semibold text-amber-700 uppercase tracking-wide mb-1">{t('pendingApproval', lang)}</div>
              <div className="text-3xl font-bold text-amber-700"><CountUp value={pendingOrders} /></div>
              <span className="text-xs text-amber-700 mt-2 inline-block font-medium">{t('checkNow', lang)}</span>
            </Link>
          ) : (
            <StatCard label={t('pendingApprovals', lang)} value={0} />
          )
        )}
        <StatCard label={t('projects', lang)} value={projectList.length} href="/projects" linkLabel={t('manage', lang)} />
      </div>

      {/* Featured products */}
      {featuredProducts.length > 0 && (
        <div>
          <div className="flex items-center justify-between mb-3">
            <h3 className="text-base font-bold text-slate-800">{t('fromTheCatalog', lang)}</h3>
            <Link
              href="/catalog"
              className="text-xs hover:underline flex items-center gap-1"
              style={{ color: 'var(--bp-text)' }}
            >
              {t('allProducts', lang)}
              <svg className="h-3.5 w-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
              </svg>
            </Link>
          </div>
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-4">
            {featuredProducts.map((product) => (
              <Link
                key={product.id}
                href={`/catalog/${product.id}`}
                className="bg-white border border-slate-200 rounded-lg overflow-hidden flex flex-col group hover:shadow-md hover:border-[color:var(--bp)] transition-all"
              >
                <div
                  className="h-36 flex items-center justify-center border-b border-slate-100"
                  style={{ backgroundColor: 'color-mix(in srgb, var(--bp) 7%, white)' }}
                >
                  <svg className="h-12 w-12 opacity-25" style={{ color: 'var(--bp-text)' }} fill="none" viewBox="0 0 24 24" stroke="currentColor">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1} d="M5 12h14M5 12a2 2 0 01-2-2V6a2 2 0 012-2h14a2 2 0 012 2v4a2 2 0 01-2 2M5 12a2 2 0 00-2 2v4a2 2 0 002 2h14a2 2 0 002-2v-4a2 2 0 00-2-2" />
                  </svg>
                </div>
                <div className="p-3 flex flex-col flex-1">
                  <h4 className="font-semibold text-sm text-slate-800 group-hover:underline leading-snug mb-1 line-clamp-2">
                    {product.name}
                  </h4>
                  <p className="text-xs text-slate-500 line-clamp-2 flex-1">{product.description}</p>
                  <span className="text-xs font-medium mt-2" style={{ color: 'var(--bp-text)' }}>{t('orderNow', lang)}</span>
                </div>
              </Link>
            ))}
          </div>
        </div>
      )}

      {/* Recent orders */}
      {orderList.length > 0 && (
        <div>
          <div className="flex items-center justify-between mb-3">
            <h3 className="text-base font-bold text-slate-800">{t('recentOrders', lang)}</h3>
            <Link href="/orders" className="text-xs hover:underline" style={{ color: 'var(--bp-text)' }}>
              {t('viewAll', lang)}
            </Link>
          </div>
          <div className="bg-white rounded-lg border border-slate-200 divide-y divide-slate-100">
            {orderList.slice(0, 5).map((order) => (
              <Link
                key={order.id}
                href={`/orders/${order.id}`}
                className="flex items-center justify-between px-4 py-3 hover:bg-slate-50 transition-colors"
              >
                <div>
                  <p className="text-sm font-medium text-slate-900">
                    {order.productName ?? `Product #${order.productId}`}
                    {/* Two orders for the same product in the same project and
                        environment on the same day render the same accessible name
                        against different hrefs (WCAG 2.4.9). The order number is what
                        tells them apart, and it is already in the URL. */}
                    <span className="sr-only"> #{order.id}</span>
                  </p>
                  <p className="text-xs text-slate-500">
                    {order.environmentName} · {order.projectName} · {new Date(order.createdAt).toLocaleDateString(lang)}
                  </p>
                </div>
                <StatusBadge status={order.status} lang={lang} />
              </Link>
            ))}
          </div>
        </div>
      )}
    </div>
  )
}
