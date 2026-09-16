'use client'

import { useState, useEffect } from 'react'
import type { BudgetState, SetCostCentreBudgetRequest, CostCenter } from '@infrashelf/types'
import { get, put, del } from '@/lib/api'
import { Alert } from '@/components/ui/Alert'
import { Input } from '@/components/ui/Input'
import { Select } from '@/components/ui/Select'
import { Button } from '@/components/ui/Button'
import { Modal } from '@/components/ui/Modal'
import { t } from '@/lib/i18n'

/** `1234.5` → `1234.50 EUR`, the same shape the cost report's caveats use. */
export function formatBudgetMoney(amount: number, currency: string): string {
  return `${amount.toFixed(2)} ${currency}`
}

interface Props {
  /** The cost centre being edited; null closes the modal. */
  target: CostCenter | null
  onClose: () => void
  /** Called after a successful save or removal, so the list can refresh. */
  onSaved: () => void
  lang: string
}

/**
 * Set, change or remove a cost centre's budget (#325).
 *
 * The state is fetched when the modal opens rather than carried in from the
 * list, because the number that decides whether a budget is sensible — what has
 * already been committed against this centre — is live, and a figure copied out
 * of a list rendered a minute ago is exactly the one a person would act on
 * wrongly. It also means the modal shows the committed total BEFORE a budget
 * exists, which is what tells the operator whether the limit they are about to
 * type is already spent.
 */
export function BudgetModal({ target, onClose, onSaved, lang }: Props) {
  const [state, setState] = useState<BudgetState | null>(null)
  const [loading, setLoading] = useState(false)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [confirmingRemove, setConfirmingRemove] = useState(false)

  const [amount, setAmount] = useState('')
  const [currency, setCurrency] = useState('EUR')
  const [period, setPeriod] = useState<'total' | 'monthly'>('total')
  const [behaviour, setBehaviour] = useState<'warn' | 'block'>('block')

  const id = target?.id ?? null

  /*
   * The one fetch on this screen that must NOT move to the server (#462, #418).
   *
   * It is a response to the operator opening this dialog, not to a page
   * mounting, and the figure it reads has to be live: what has already been
   * committed against this centre is what decides whether the limit about to be
   * typed is sensible, and a figure copied out of the list rendered a minute ago
   * is exactly the one a person would act on wrongly.
   *
   * The page does hand down a budget map for the row badges. That is not a
   * substitute — a badge may be a minute stale without consequence; a limit
   * being set may not.
   *
   * So this one keeps its effect, with the directive below naming that reason
   * now that `react-hooks/set-state-in-effect` is back on (#418).
   */
  useEffect(() => {
    if (id === null) return
    let cancelled = false
    // eslint-disable-next-line react-hooks/set-state-in-effect -- opening the dialog must read the live figure; see above
    setLoading(true)
    setError(null)
    setConfirmingRemove(false)
    /*
     * Clear the PREVIOUS centre's answer before asking about this one.
     *
     * `cancelled` handles the race — a late response for a centre the user has
     * already navigated away from. It does nothing about a FAILURE: open centre
     * A, open centre B, B's GET fails, and the catch below sets an error while
     * `state` and the form still hold A's budget. Saving then wrote A's amount
     * onto B under B's own heading.
     *
     * `state: null` is also what disables the save below, so the form cannot be
     * submitted against a centre whose budget never arrived.
     */
    setState(null)
    setAmount('')
    setCurrency('EUR')
    setPeriod('total')
    setBehaviour('block')
    void (async () => {
      try {
        const loaded = await get<BudgetState>(`/api/admin/cost-centers/${id}/budget`)
        // The modal may already have been closed and reopened on another row by
        // the time this lands; applying a stale response would show one centre's
        // budget under another centre's name.
        if (cancelled) return
        setState(loaded)
        setAmount(loaded.amount === null ? '' : String(loaded.amount))
        setCurrency(loaded.currency ?? 'EUR')
        setPeriod(loaded.period ?? 'total')
        // `block` by default: a budget nobody enforces is a note, and the
        // operator who typed a limit meant it. `warn` stays one click away.
        setBehaviour(loaded.behaviour ?? 'block')
      } catch (e) {
        if (!cancelled) setError(e instanceof Error ? e.message : t('failedToLoadBudget', lang))
      } finally {
        if (!cancelled) setLoading(false)
      }
    })()
    return () => {
      cancelled = true
    }
  }, [id, lang])

  async function handleSave(e: React.FormEvent) {
    e.preventDefault()
    // Guarded here as well as on the button: Enter in a text field submits a
    // form without going near it.
    if (id === null || !state) return
    setSaving(true)
    setError(null)
    try {
      const body: SetCostCentreBudgetRequest = {
        amount: Number(amount),
        // Uppercased here rather than trusting the field: the backend compares
        // against `exchange_rates.currency_code`, which is upper case, and a
        // lower-case 'eur' would land as an unconvertible currency.
        currency: currency.trim().toUpperCase(),
        period,
        behaviour,
      }
      await put(`/api/admin/cost-centers/${id}/budget`, body)
      onSaved()
      onClose()
    } catch (err) {
      setError(err instanceof Error ? err.message : t('failedToSaveBudget', lang))
    } finally {
      setSaving(false)
    }
  }

  async function handleRemove() {
    if (id === null) return
    setSaving(true)
    setError(null)
    try {
      await del(`/api/admin/cost-centers/${id}/budget`)
      onSaved()
      onClose()
    } catch (err) {
      setError(err instanceof Error ? err.message : t('failedToSaveBudget', lang))
    } finally {
      setSaving(false)
    }
  }

  const hasBudget = state?.amount !== null && state?.amount !== undefined

  return (
    <Modal
      open={target !== null}
      onClose={onClose}
      title={`${t(hasBudget ? 'budgetEdit' : 'budgetSet', lang)} — ${target?.code ?? ''}`}
      size="sm"
    >
      {loading ? (
        <div className="flex justify-center py-8">
          <div
            className="h-8 w-8 animate-spin rounded-full border-4 border-slate-200 border-t-blue-600"
            role="status"
            aria-label={t('loading', lang)}
          />
        </div>
      ) : (
        <form onSubmit={handleSave} className="space-y-4">
          {error && <Alert>{error}</Alert>}

          {/* Committed first, and shown whether or not a budget exists: it is the
              number that says whether the limit below is already spent. */}
          {state && (
            <div className="rounded-lg bg-slate-50 px-4 py-3 text-sm">
              <div className="flex justify-between gap-4">
                <span className="text-slate-600">{t('budgetCommitted', lang)}</span>
                <span className="tabular-nums font-medium text-slate-900">
                  {formatBudgetMoney(state.committed, state.currency ?? (currency.trim().toUpperCase() || 'EUR'))}
                </span>
              </div>
              {hasBudget && (
                <div className="mt-1 flex justify-between gap-4">
                  <span className="text-slate-600">{t('budgetRemaining', lang)}</span>
                  <span
                    className={`tabular-nums font-medium ${state.exhausted ? 'text-red-700' : 'text-slate-900'}`}
                  >
                    {formatBudgetMoney(state.remaining, state.currency ?? 'EUR')}
                  </span>
                </div>
              )}
              <p className="mt-2 text-xs text-slate-600">{t('budgetCommittedHint', lang)}</p>
              {/* A caveat nobody sees is not a caveat: `committed` is missing
                  these orders' spend entirely, and there is no number to add —
                  the price is unknown, not small. */}
              {state.unpriced > 0 && (
                <p className="mt-1 text-xs text-amber-700">
                  {t('budgetUnpriced', lang)} {state.unpriced}
                </p>
              )}
              {state.unconverted.length > 0 && (
                <p className="mt-1 text-xs text-amber-700">
                  {t('budgetUnconverted', lang)}{' '}
                  {state.unconverted.map((u) => formatBudgetMoney(u.amount, u.currency)).join(', ')}
                </p>
              )}
            </div>
          )}

          <div className="grid grid-cols-2 gap-3">
            <Input
              label={t('budgetAmount', lang)}
              type="number"
              min="0"
              step="0.01"
              value={amount}
              onChange={(e) => setAmount(e.target.value)}
              required
              placeholder="0.00"
            />
            <Input
              label={t('budgetCurrency', lang)}
              value={currency}
              onChange={(e) => setCurrency(e.target.value)}
              required
              placeholder="EUR"
            />
          </div>

          <Select
            label={t('budgetPeriod', lang)}
            value={period}
            onChange={(e) => setPeriod(e.target.value as 'total' | 'monthly')}
            options={[
              { value: 'total', label: t('budgetPeriodTotal', lang) },
              { value: 'monthly', label: t('budgetPeriodMonthly', lang) },
            ]}
            hint={period === 'monthly' ? t('budgetMonthlyCaveat', lang) : undefined}
          />

          <Select
            label={t('budgetBehaviour', lang)}
            value={behaviour}
            onChange={(e) => setBehaviour(e.target.value as 'warn' | 'block')}
            options={[
              { value: 'block', label: t('budgetBehaviourBlock', lang) },
              { value: 'warn', label: t('budgetBehaviourWarn', lang) },
            ]}
          />

          {/* Removal asks first, in the same modal rather than a second one: it
              undoes a control on spending, and the list behind is not where the
              consequence is written down. */}
          {confirmingRemove ? (
            // `warning`, not the default `error`: nothing has gone wrong. It is
            // still role="alert" — a confirmation that appears after a click has
            // to interrupt, or a screen reader user clicks Remove and hears
            // nothing happen.
            <Alert tone="warning">
              <p className="mb-3">{t('budgetRemoveConfirm', lang)}</p>
              <div className="flex gap-2">
                <Button type="button" size="sm" variant="danger" onClick={handleRemove} disabled={saving}>
                  {saving ? t('deleting', lang) : t('budgetRemove', lang)}
                </Button>
                <Button type="button" size="sm" variant="secondary" onClick={() => setConfirmingRemove(false)}>
                  {t('cancel', lang)}
                </Button>
              </div>
            </Alert>
          ) : null}

          <div className="flex flex-wrap justify-end gap-3 pt-2">
            {hasBudget && !confirmingRemove && (
              <Button
                type="button"
                variant="ghost"
                className="mr-auto"
                onClick={() => setConfirmingRemove(true)}
                disabled={saving}
              >
                {t('budgetRemove', lang)}
              </Button>
            )}
            <Button type="button" variant="secondary" onClick={onClose}>
              {t('cancel', lang)}
            </Button>
            {/* `!state` means this centre's budget never arrived, so there is
                nothing to save it against — see the reset in the effect. */}
            <Button type="submit" disabled={saving || !state}>
              {saving ? t('saving', lang) : t('save', lang)}
            </Button>
          </div>
        </form>
      )}
    </Modal>
  )
}
