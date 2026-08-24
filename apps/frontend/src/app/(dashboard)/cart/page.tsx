import { auth } from '@/lib/auth'
import { get } from '@/lib/api'
import { redirect } from 'next/navigation'
import type { CartItem, Project, CostCenter, ExchangeRate } from '@open-hybrid-cloud/types'
import { CartView } from './CartView'
import { getLang } from '@/lib/getLang'
import { localeToCurrency } from '@/lib/locale'

// The cart is per user and changes on every add, so it must never be cached.
export const dynamic = 'force-dynamic'

export default async function CartPage() {
  const session = await auth()
  if (!session) redirect('/login')

  const token = (session as unknown as { apiToken: string }).apiToken
  const lang = await getLang()

  const [cartRes, projectsRes, costCentersRes, ratesRes] = await Promise.allSettled([
    get<CartItem[]>(`/api/cart?lang=${lang}`, token),
    get<Project[]>('/api/projects', token),
    get<CostCenter[]>('/api/admin/cost-centers', token),
    get<ExchangeRate[]>('/api/public/exchange-rates', token),
  ])

  const items = cartRes.status === 'fulfilled' ? (cartRes.value ?? []) : []
  const projects = projectsRes.status === 'fulfilled' ? (projectsRes.value ?? []) : []
  const costCenters = costCentersRes.status === 'fulfilled' ? (costCentersRes.value ?? []) : []
  // Prices are stored per offering in its own currency; the subtotal is shown in
  // the viewer's, the same conversion the catalogue and the cost report use.
  const rates: Record<string, number> =
    ratesRes.status === 'fulfilled'
      ? Object.fromEntries((ratesRes.value ?? []).map((r) => [r.currencyCode, parseFloat(r.rate)]))
      : {}

  return (
    <div className="max-w-screen-xl mx-auto">
      <CartView
        initialItems={items}
        projects={projects}
        costCenters={costCenters}
        token={token}
        lang={lang}
        exchangeRates={rates}
        localeCurrency={localeToCurrency(lang)}
      />
    </div>
  )
}
