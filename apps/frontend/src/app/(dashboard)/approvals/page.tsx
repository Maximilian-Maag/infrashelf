import { auth } from '@/lib/auth'
import { get } from '@/lib/serverApi'
import { redirect } from 'next/navigation'
import type { Role, ApprovalDelegationsResponse, OrderPage } from '@infrashelf/types'
import { PageHeader } from '@/components/layout/PageHeader'
import { SectionError } from '@/components/ui/SectionError'
import { section } from '@/lib/section'
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

  const currentUserId = Number((session.user as unknown as { id: string }).id)
  const lang = await getLang()

  const [queueRes, delegationsRes] = await Promise.allSettled([
    // Asked for by status rather than fetched whole and filtered here (#158).
    // This page is admin-only, so "every order" was every order in the
    // installation — downloaded in full to keep the handful still awaiting a
    // decision.
    get<OrderPage>(`/api/orders?lang=${lang}&status=pending`),
    // Root reaches this page but does not participate in the approval workflow
    // (issue #35), so it has no delegations to manage and the endpoint would only
    // offer it an authority it is not supposed to hold. Resolved rather than
    // skipped so the pair below always has two results to read.
    role === 'admin'
      ? get<ApprovalDelegationsResponse>('/api/approvals/delegations')
      : Promise.resolve(EMPTY_DELEGATIONS),
  ])

  /*
   * A queue that could not be READ is not an empty queue (#478, #415).
   *
   * The catch this replaces set `orders = []`, so a backend that was down
   * rendered "0 orders pending approval" over "No pending orders" — a statement
   * about the queue, and the one an administrator acts on, by closing the tab.
   * The orders that were actually waiting kept waiting and nothing said the page
   * had failed to ask. This is the page where believing "there is nothing here"
   * has the clearest consequence: an approvals queue is a to-do list, and an
   * empty one means you are done.
   *
   * `section` also carries the reason and logs it server-side, and rethrows the
   * redirect an ended session throws from inside `get` — which the hand-written
   * `unstable_rethrow` was doing here by hand (#427, #434).
   */
  const queue = section<OrderPage | null>(queueRes, null, 'approval queue')
  const orders = queue.data?.items ?? []
  // Degrades to an empty panel rather than taking the queue down with it — but
  // not silently: "you hold no delegated authority" is a claim somebody might
  // rely on before deciding not to act on a row, so the reason goes on screen
  // beside the queue's.
  const delegations = section(delegationsRes, EMPTY_DELEGATIONS, 'approval delegations')

  return (
    <div className="max-w-6xl mx-auto space-y-6">
      <PageHeader
        title={t('approvals', lang)}
        /* No count when the number is unknown: "0 orders pending approval" is
           the most reassuring thing this page can say and the worst to say
           without having asked successfully. */
        subtitle={queue.error ? undefined : `${orders.length} ${t('ordersPendingApproval', lang)}`}
      />

      {/* One line for both: they are two reads of the same screen, and two
          stacked banners would push the queue itself down. */}
      <SectionError error={queue.error ?? delegations.error} lang={lang} />

      {/* Above the queue on purpose: a substitute has to know whose authority they
          are holding before they start acting on rows that are not usually theirs. */}
      {role === 'admin' && <DelegationPanel delegations={delegations.data} />}

      {/* The empty state is a statement about the queue, so it is rendered only
          when the queue was actually read. A failure shows the banner above and
          nothing here — there is no list to be empty. */}
      {queue.error ? null : orders.length === 0 ? (
        <div className="text-center py-12 text-slate-600">{t('noPendingOrders', lang)}</div>
      ) : (
        <div className="space-y-3">
          {orders.map((order) => (
            <ApprovalRow
              key={order.id}
              order={order}
              currentUserId={currentUserId}
              role={role}
            />
          ))}
        </div>
      )}
    </div>
  )
}
