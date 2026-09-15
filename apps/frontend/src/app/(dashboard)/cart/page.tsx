import { auth } from '@/lib/auth'
import { get } from '@/lib/serverApi'
import { redirect } from 'next/navigation'
import type { CartItem, Project, CostCenter, ExchangeRate } from '@infrashelf/types'
import { CartView } from './CartView'
import { SectionError } from '@/components/ui/SectionError'
import { section } from '@/lib/section'
import { getLang } from '@/lib/getLang'
import { localeToCurrency } from '@/lib/locale'

// The cart is per user and changes on every add, so it must never be cached.
export const dynamic = 'force-dynamic'

export default async function CartPage() {
  const session = await auth()
  if (!session) redirect('/login')

  const lang = await getLang()

  const [cartRes, projectsRes, costCentersRes, ratesRes] = await Promise.allSettled([
    get<CartItem[]>(`/api/cart?lang=${lang}`),
    get<Project[]>('/api/projects'),
    get<CostCenter[]>('/api/admin/cost-centers'),
    get<ExchangeRate[]>('/api/public/exchange-rates'),
  ])

  // An empty cart and a cart that could not be fetched look identical, and the
  // second is the one that makes a user think their basket was thrown away
  // (#415). The dropdowns beside it degrade on their own, but not silently: a
  // checkout form with an empty project list is unusable, and "there are no
  // projects" is the wrong reason to give for it.
  const items = section(cartRes, [] as CartItem[], 'cart')
  const projects = section(projectsRes, [] as Project[], 'projects for the cart')
  const costCenters = section(costCentersRes, [] as CostCenter[], 'cost centers for the cart')
  // Prices are stored per offering in its own currency; the subtotal is shown in
  // the viewer's, the same conversion the catalogue and the cost report use.
  // Logged but not shown. Without rates `convertPrice` returns the amount in the
  // currency it is stored in, LABELLED with that currency — the figure stays
  // true, so there is nothing to warn the user about; the trace is for whoever
  // wonders why the totals came back in EUR.
  const ratesSection = section(ratesRes, [] as ExchangeRate[], 'exchange rates')
  const rates: Record<string, number> = Object.fromEntries(
    ratesSection.data.map((r) => [r.currencyCode, parseFloat(r.rate)]),
  )

  return (
    <div className="max-w-screen-xl mx-auto space-y-4">
      <SectionError error={items.error ?? projects.error ?? costCenters.error} lang={lang} />
      <CartView
        initialItems={items.data}
        projects={projects.data}
        costCenters={costCenters.data}
        lang={lang}
        exchangeRates={rates}
        localeCurrency={localeToCurrency(lang)}
      />
    </div>
  )
}
