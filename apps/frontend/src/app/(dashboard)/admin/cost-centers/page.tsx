import { auth } from '@/lib/auth'
import { get } from '@/lib/serverApi'
import { section } from '@/lib/section'
import { redirect } from 'next/navigation'
import type { Role, CostCenter, BudgetState } from '@infrashelf/types'
import { PageHeader } from '@/components/layout/PageHeader'
import { CostCentersManager } from './CostCentersManager'
import { t } from '@/lib/i18n'
import { getLang } from '@/lib/getLang'

export default async function CostCentersPage() {
  const session = await auth()
  if (!session) redirect('/login')
  const role = (session.user as unknown as { role: Role }).role
  if (role !== 'root') redirect('/admin')

  const lang = await getLang()

  /*
   * Two requests, and their failures are deliberately not the same failure
   * (#458). This page is how a cost centre is renamed or retired, and none of
   * that should become unreachable because the budget endpoint is unhappy — an
   * absent badge and an unknown budget look the same, and neither claims a limit
   * that is not there.
   *
   * Two `section()` calls rather than a nested `try`/`catch`: a catch around a
   * `serverApi` call swallows the login redirect it throws for an ended session,
   * which is what `catch_rethrows_navigation` denies (#434).
   */
  const [ccsRes, budgetsRes] = await Promise.allSettled([
    get<CostCenter[]>('/api/admin/cost-centers'),
    get<BudgetState[]>('/api/admin/cost-centers/budgets'),
  ])
  const ccs = section(ccsRes, [] as CostCenter[], 'cost centers')
  const budgets = section(budgetsRes, [] as BudgetState[], 'cost centre budgets')

  return (
    <div className="max-w-3xl mx-auto space-y-6">
      <PageHeader title={t('costCenters', lang)} subtitle={t('costCentersSubtitle', lang)} />
      <CostCentersManager
        initial={ccs.data}
        initialBudgets={Object.fromEntries(budgets.data.map((b) => [b.costCenterId, b]))}
        initialError={ccs.error}
      />
    </div>
  )
}
