'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { post, ApiError } from '@/lib/api'
import { Button } from '@/components/ui/Button'
import { Alert } from '@/components/ui/Alert'
import { useLang } from '@/lib/useLang'
import { t } from '@/lib/i18n'

/** The two commit refusals that have an escape, and the flag each one needs. */
type RefusalCode = 'budget_blocked' | 'policy_denied'

const flagFor = (code: RefusalCode): { overrideBudget?: boolean; overridePolicy?: boolean } =>
  code === 'budget_blocked' ? { overrideBudget: true } : { overridePolicy: true }

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
 * A refusal is one exception to that (#519): the gates are re-asked before the
 * window is overridden (#511), and root — the only person who can act on a spent
 * ceiling or a policy — reads *Place anyway* beside the button, carrying the
 * waiver the refusal names. The waivers accumulate for the same reason they do in
 * `ApprovalRow`: the budget gate is asked before the policy one, so waiving the
 * budget can uncover a policy refusal underneath it, and a retry carrying only
 * the newest flag would alternate between the two for ever.
 */
export function DeployNow({ orderId }: { orderId: number }) {
  const router = useRouter()
  const lang = useLang()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [refusal, setRefusal] = useState<RefusalCode | null>(null)
  const [waived, setWaived] = useState<{ overrideBudget?: boolean; overridePolicy?: boolean }>({})

  async function deployNow(overrides: { overrideBudget?: boolean; overridePolicy?: boolean } = {}) {
    setBusy(true)
    setError(null)
    setRefusal(null)
    setWaived(overrides)
    try {
      await post(`/api/orders/${orderId}/deploy-now`, overrides)
      router.refresh()
    } catch (e) {
      // The server's own words: it is the only thing that knows the sweep got
      // there first, or that CI would not answer.
      setError(e instanceof Error ? e.message : t('deployNowFailed', lang))
      const code = e instanceof ApiError ? e.code : undefined
      // Only the two refusals that have an escape, and only the ones this
      // component can offer a flag for — anything else is the server's sentence
      // and nothing to do about it.
      setRefusal(code === 'budget_blocked' || code === 'policy_denied' ? code : null)
    } finally {
      setBusy(false)
    }
  }

  return (
    <>
      <Button size="sm" onClick={() => deployNow()} disabled={busy} title={t('deployNowHint', lang)}>
        {busy ? t('saving', lang) : t('deployNow', lang)}
      </Button>
      {refusal && (
        <>
          <Button
            size="sm"
            variant="secondary"
            onClick={() => deployNow({ ...waived, ...flagFor(refusal) })}
            disabled={busy}
          >
            {t('placeAnyway', lang)}
          </Button>
          <p className="text-xs text-slate-600">{t('placeAnywayHint', lang)}</p>
        </>
      )}
      {error && <Alert tone="error">{error}</Alert>}
    </>
  )
}
