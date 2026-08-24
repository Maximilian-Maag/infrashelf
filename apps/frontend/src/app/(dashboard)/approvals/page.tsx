import { auth } from '@/lib/auth'
import { get } from '@/lib/api'
import { redirect } from 'next/navigation'
import type { Order, Role, ApprovalDelegationsResponse } from '@open-hybrid-cloud/types'
import { PageHeader } from '@/components/layout/PageHeader'
import { ApprovalRow } from './ApprovalRow'
import { DelegationPanel } from './DelegationPanel'
import { getLang } from '@/lib/getLang'
import { t } from '@/lib/i18n'

const EMPTY_DELEGATIONS: ApprovalDelegationsResponse = { mine: [], grantedToMe: [], candidates: [] }

export default async function ApprovalsPage() {
  const session = await auth()
  if (!session) redirect('/login')

  const role = (session.user as unknown as { role: Role }).role
  if (role !== 'admin' && role !== 'root') redirect('/')

  const token = (session as unknown as { apiToken: string }).apiToken
  const currentUserId = Number((session.user as unknown as { id: string }).id)
  const lang = await getLang()

  let orders: Order[] = []
  try {
    const all = (await get<Order[]>(`/api/orders?lang=${lang}`, token)) ?? []
    orders = all.filter((o) => o.status === 'pending')
  } catch {
    /* empty */
  }

  // Root reaches this page but does not participate in the approval workflow
  // (issue #35), so it has no delegations to manage and the endpoint would only
  // offer it an authority it is not supposed to hold.
  let delegations = EMPTY_DELEGATIONS
  if (role === 'admin') {
    try {
      delegations =
        (await get<ApprovalDelegationsResponse>('/api/approvals/delegations', token)) ??
        EMPTY_DELEGATIONS
    } catch {
      /* empty */
    }
  }

  return (
    <div className="max-w-6xl mx-auto space-y-6">
      <PageHeader
        title={t('approvals', lang)}
        subtitle={`${orders.length} ${t('ordersPendingApproval', lang)}`}
      />

      {/* Above the queue on purpose: a substitute has to know whose authority they
          are holding before they start acting on rows that are not usually theirs. */}
      {role === 'admin' && <DelegationPanel delegations={delegations} token={token} />}

      {orders.length === 0 ? (
        <div className="text-center py-12 text-slate-600">{t('noPendingOrders', lang)}</div>
      ) : (
        <div className="space-y-3">
          {orders.map((order) => (
            <ApprovalRow
              key={order.id}
              order={order}
              token={token}
              currentUserId={currentUserId}
            />
          ))}
        </div>
      )}
    </div>
  )
}
