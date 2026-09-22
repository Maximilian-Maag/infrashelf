'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { post, ApiError } from '@/lib/api'
import { Button } from '@/components/ui/Button'
import { Alert } from '@/components/ui/Alert'
import { useLang } from '@/lib/useLang'
import { t } from '@/lib/i18n'

/**
 * Root releases a scheduled order without waiting for its window (#330).
 *
 * Root rather than admin, and the distinction is the point: approving decides
 * that an order should happen, this decides it should happen outside the hours
 * the company said it watches its own systems — which is the guarantee the
 * feature exists to make. The server checks the role and the status again.
 *
 * No confirmation dialogue, unlike WriteOffOrder. That one asks for a typed
 * reason because it records a failure nobody observed; this is reversible in
 * the only sense that matters — the deployment simply happens now instead of at
 * 08:00 — and the audit entry names who did it either way. A modal in front of
 * a one-line decision is a modal people learn to dismiss.
 *
 * A refusal from either gate comes back with the escape it names (#519): the same
 * two waivers as the approvals queue (#514), offered rather than described.
 */
export function DeployNow({ orderId }: { orderId: number }) {
  const router = useRouter()
  const lang = useLang()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  /*
   * The refusal this deploy came back with, when there is an escape from it
   * (#519). A code rather than a flag: the budget and the policy are separate
   * rights, and the one this button offers has to be the one that refused.
   */
  const [refusal, setRefusal] = useState<'budget_blocked' | 'policy_denied' | null>(null)
  /*
   * The waivers already exercised in this refusal chain, as on the approvals queue
   * (#514) and the order form (#509): the budget gate is asked before the policy
   * one, so waiving the budget can uncover a policy refusal underneath it, and
   * retrying one flag at a time would alternate between the two for ever.
   */
  const [retryOverrides, setRetryOverrides] = useState<{
    overrideBudget?: boolean
    overridePolicy?: boolean
  }>({})

  /**
   * Deploy the order now, optionally waiving the refusal that came back.
   *
   * This component is rendered only for root on a scheduled order (see the order
   * page), which is the role the escapes belong to — and the service checks the
   * session again regardless, so the flag here is a request to waive, never the
   * waiver.
   */
  async function deployNow(overrides: { overrideBudget?: boolean; overridePolicy?: boolean } = {}) {
    const carried = Object.keys(overrides).length > 0 ? { ...retryOverrides, ...overrides } : {}
    setRetryOverrides(carried)
    setBusy(true)
    setError(null)
    setRefusal(null)
    try {
      await post(`/api/orders/${orderId}/deploy-now`, carried)
      router.refresh()
    } catch (e) {
      // The server's own words: it is the only thing that knows the sweep got
      // there first, or that CI would not answer.
      setError(e instanceof Error ? e.message : t('deployNowFailed', lang))
      const code = e instanceof ApiError ? e.code : undefined
      // Root's two escapes, and nothing else: a code this control does not know is
      // not an invitation to guess at a flag.
      setRefusal(code === 'budget_blocked' || code === 'policy_denied' ? code : null)
    } finally {
      setBusy(false)
    }
  }

  /** Root's escape from the refusal just shown (#325, #110, #519). */
  async function deployAnyway() {
    await deployNow(refusal === 'budget_blocked' ? { overrideBudget: true } : { overridePolicy: true })
  }

  return (
    <>
      <Button size="sm" onClick={() => deployNow()} disabled={busy} title={t('deployNowHint', lang)}>
        {busy ? t('saving', lang) : t('deployNow', lang)}
      </Button>
      {error && (
        <Alert tone="error">
          {error}
          {/* The escape, inside the alert that announced the refusal so the live
              region carries its remedy too (#519). */}
          {refusal && (
            <div className="mt-3">
              <p className="text-sm">{t('placeAnywayHint', lang)}</p>
              <Button
                type="button"
                variant="danger"
                size="sm"
                className="mt-2"
                disabled={busy}
                onClick={deployAnyway}
              >
                {t('deployAnyway', lang)}
              </Button>
            </div>
          )}
        </Alert>
      )}
    </>
  )
}
