'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import type { BudgetState, Order, Role } from '@infrashelf/types'
import { post, ApiError } from '@/lib/api'
import { Button } from '@/components/ui/Button'
import { Alert } from '@/components/ui/Alert'
import { StatusBadge } from '@/components/ui/StatusBadge'
import { TrialBadge } from '@/components/ui/TrialBadge'
import { useLang } from '@/lib/useLang'
import { t } from '@/lib/i18n'

interface Props {
  order: Order
  /**
   * The viewer. Needed because nobody approves their own order (issue #35) —
   * the backend refuses it, and hiding the button is how the viewer finds that
   * out before clicking rather than after.
   */
  currentUserId: number
  /**
   * Whether this viewer is offered the escapes from a refusal (#514).
   *
   * Passed in rather than read from a session hook: the page is a server
   * component that already has the role, and a client-side session lookup here
   * would be a second, weaker answer to a question the server has. The backend
   * re-checks the role — this decides only whether the control is rendered.
   * Defaulted to the role that gets nothing, so a caller that forgets it fails
   * closed.
   */
  role?: Role
}

/**
 * What this order's cost centre has left, when it has a budget at all (#325).
 *
 * Only rendered once the budget is exhausted. A line on every row saying how
 * much room is left would be read past within a day, and the approver does not
 * need it: the decision only changes when there is none.
 *
 * Which behaviour applies is the point. Approving a `warn` order goes through
 * and is recorded; approving a `block` one is refused at the gate, with the
 * approver's click wasted — so the row says which of the two it is before they
 * spend it.
 */
function BudgetNotice({ budget, lang }: { budget?: BudgetState | null; lang: string }) {
  if (!budget || budget.amount === null || budget.currency === null || !budget.exhausted) return null
  return (
    <p className="mt-1 text-sm font-medium text-amber-700">
      {t('budgetOverspent', lang)}: {budget.costCenterLabel} —{' '}
      {`${budget.committed.toFixed(2)} / ${budget.amount.toFixed(2)} ${budget.currency}`}
      {' · '}
      {t(budget.behaviour === 'block' ? 'budgetApprovalBlocked' : 'budgetApprovalWarned', lang)}
    </p>
  )
}

export function ApprovalRow({ order, currentUserId, role = 'project_manager' }: Props) {
  const router = useRouter()
  const lang = useLang()
  const [rejecting, setRejecting] = useState(false)
  const [rejectionNote, setRejectionNote] = useState('')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  /*
   * The refusal the last approval came back with, when there is an escape from it
   * (#514). A code rather than a flag, because which escape applies is which gate
   * refused — the budget and the policy are separate rights, and sending the wrong
   * one waives nothing.
   */
  const [refusal, setRefusal] = useState<'budget_blocked' | 'policy_denied' | null>(null)
  /*
   * The waivers already exercised in this refusal chain (see OrderForm, #515).
   *
   * The budget gate is asked BEFORE the policy one, so waiving the budget can
   * uncover a policy refusal underneath it — retrying with only the flag for the
   * refusal in hand would drop the waiver already made and the two would alternate
   * for ever. Cleared on a fresh Approve, which is a fresh decision.
   */
  const [retryOverrides, setRetryOverrides] = useState<{
    overrideBudget?: boolean
    overridePolicy?: boolean
  }>({})
  const [done, setDone] = useState(false)

  async function handleApprove(overrides: { overrideBudget?: boolean; overridePolicy?: boolean } = {}) {
    const carried = Object.keys(overrides).length > 0 ? { ...retryOverrides, ...overrides } : {}
    setRetryOverrides(carried)
    setLoading(true)
    setError(null)
    setRefusal(null)
    try {
      // /api/approvals, not /api/orders: the approve and reject endpoints live
      // under the approvals resource, and this pointed at a path the backend has
      // never served.
      await post(`/api/approvals/${order.id}/approve`, carried)
      setDone(true)
      router.refresh()
    } catch (err) {
      setError(err instanceof Error ? err.message : t('failedToApprove', lang))
      const code = err instanceof ApiError ? err.code : undefined
      // Root, and only for the two refusals that HAVE an escape: a code this row
      // does not know is not an invitation to guess at one.
      setRefusal(
        role === 'root' && (code === 'budget_blocked' || code === 'policy_denied') ? code : null,
      )
    } finally {
      setLoading(false)
    }
  }

  /**
   * Root's escape from the refusal just shown (#325, #110, #514).
   *
   * The flag follows the refusal that produced it; the earlier flags of the chain
   * are carried along. Both are audited server-side with the rule or the budget
   * that was waived.
   */
  async function approveAnyway() {
    await handleApprove(
      refusal === 'budget_blocked' ? { overrideBudget: true } : { overridePolicy: true },
    )
  }

  async function handleReject(e: React.FormEvent) {
    e.preventDefault()
    setLoading(true)
    setError(null)
    try {
      await post(`/api/approvals/${order.id}/reject`, { rejectionNote })
      setDone(true)
      router.refresh()
    } catch (err) {
      setError(err instanceof Error ? err.message : t('failedToReject', lang))
    } finally {
      setLoading(false)
    }
  }

  if (done) return null

  const ownOrder = order.userId === currentUserId

  return (
    /* `data-order-id` so a test can act on a SPECIFIC order rather than on
       whichever row happens to be first. The approvals queue holds other
       people's orders too, and a cross-account journey that clicks "the first
       Approve button" can approve the wrong one and still go green (#363). */
    <div data-order-id={order.id} className="rounded-xl border border-slate-200 bg-white p-5 shadow-sm">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="flex-1">
          <div className="flex items-center gap-3 mb-1">
            <span className="font-mono text-xs text-slate-600">#{order.id}</span>
            <span className="font-semibold text-slate-900">
              {order.productName ?? `Product #${order.productId}`}
            </span>
            <StatusBadge status={order.status} lang={lang} />
            {order.isTrial && <TrialBadge lang={lang} />}
          </div>
          <BudgetNotice budget={order.budget} lang={lang} />
          <p className="text-sm text-slate-600">
            {order.environmentName}
            {/* Size and quantity change what the approver is agreeing to: one
                decision covers all N elements (issues #98/#104), so "20 × XL" must
                not be something they have to open the order to discover. */}
            {order.sizeCode && <> · {t('size', lang)}: {order.sizeCode}</>}
            {order.quantity !== undefined && order.quantity > 1 && (
              <> · {t('quantity', lang)}: {order.quantity}</>
            )}
            {/* A separator rather than a translated "on": as a bare preposition
                it takes a different form with the date in several of the 25
                languages, and the rest of this line already reads as a
                separated list. */}
            {' · '}{order.projectName} · {t('orderedBy', lang)} {order.userName ?? `User #${order.userId}`}
            {' · '}{new Date(order.createdAt).toLocaleDateString(lang)}
          </p>
        </div>

        {!rejecting && (
          /* `shrink-0` on a cluster of two buttons pinned the row 70px past a
             320px viewport. It may wrap onto its own line instead (#168).

             A plain block comment: this is an expression position inside
             `{!rejecting && (…)}`, where `{/* … *\/}` is not valid JSX. */
          <div className="flex flex-wrap items-center gap-2">
            {ownOrder ? (
              <span className="text-sm text-slate-600">{t('cannotApproveOwnOrder', lang)}</span>
            ) : (
              <Button
                size="sm"
                variant="primary"
                onClick={() => handleApprove()}
                disabled={loading}
              >
                {t('approve', lang)}
              </Button>
            )}
            <Button
              size="sm"
              variant="danger"
              onClick={() => setRejecting(true)}
              disabled={loading}
            >
              {t('reject', lang)}
            </Button>
          </div>
        )}
      </div>

      {error && (
        <Alert className="mt-3">
          {error}
          {/* The escape, and only where there is one to offer (#514). Inside the
              alert rather than beside it: it answers this refusal, so the live
              region that announced the refusal carries its remedy. */}
          {refusal && (
            <div className="mt-3">
              <p className="text-sm">{t('placeAnywayHint', lang)}</p>
              <Button
                type="button"
                variant="danger"
                size="sm"
                className="mt-2"
                disabled={loading}
                onClick={approveAnyway}
              >
                {t('placeAnyway', lang)}
              </Button>
            </div>
          )}
        </Alert>
      )}

      {rejecting && (
        <form onSubmit={handleReject} className="mt-4 space-y-3">
          <div className="flex flex-col gap-1">
            {/* Per-order id: the approvals list renders one of these per row. */}
            <label htmlFor={`rejection-note-${order.id}`} className="text-sm font-medium text-slate-700">{t('rejectionNote', lang)}</label>
            <textarea
              id={`rejection-note-${order.id}`}
              value={rejectionNote}
              onChange={(e) => setRejectionNote(e.target.value)}
              rows={2}
              required
              placeholder={t('rejectionNotePlaceholder', lang)}
              className="rounded-lg border border-slate-300 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-red-500"
            />
          </div>
          {/* Wraps (#168). */}
          <div className="flex flex-wrap gap-2">
            <Button type="submit" variant="danger" size="sm" disabled={loading}>
              {loading ? t('rejecting', lang) : t('confirmRejection', lang)}
            </Button>
            <Button
              type="button"
              variant="secondary"
              size="sm"
              onClick={() => { setRejecting(false); setRejectionNote('') }}
              disabled={loading}
            >
              {t('cancel', lang)}
            </Button>
          </div>
        </form>
      )}
    </div>
  )
}
