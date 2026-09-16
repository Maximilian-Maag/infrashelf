'use client'

import {useState, useCallback } from 'react'
import type {
  BudgetState,
  CostCenter,
  CreateCostCenterRequest,
  UpdateCostCenterRequest,
} from '@infrashelf/types'
import { get, post, put, del } from '@/lib/api'
import { Card } from '@/components/ui/Card'
import { Alert } from '@/components/ui/Alert'
import { Input } from '@/components/ui/Input'
import { Button } from '@/components/ui/Button'
import { Modal } from '@/components/ui/Modal'
import { useLang } from '@/lib/useLang'
import { t } from '@/lib/i18n'
import { BudgetModal, formatBudgetMoney } from './BudgetModal'

interface Props {
  /** The cost centres the SERVER already fetched (#458). */
  initial: CostCenter[]
  /**
   * The budget badges, keyed by cost-centre id.
   *
   * A separate request on the server too, and its failure is deliberately NOT
   * the list's failure: this page is how a cost centre is renamed or retired,
   * and none of that should become unreachable because the budget endpoint is
   * unhappy. An absent badge and an unknown budget look the same, and neither
   * claims a limit that is not there.
   */
  initialBudgets?: Record<number, BudgetState>
  /** Why the server could not fetch the cost centres, if it could not (#415). */
  initialError?: string | null
}

export function CostCentersManager({ initial, initialBudgets = {}, initialError = null }: Props) {
  const lang = useLang()
  const [ccs, setCcs] = useState<CostCenter[]>(initial)
  // The server already has them, so nothing is pending on arrival.
  const [loading, setLoading] = useState(false)
  const [addOpen, setAddOpen] = useState(false)
  const [editTarget, setEditTarget] = useState<CostCenter | null>(null)
  const [deleteTarget, setDeleteTarget] = useState<CostCenter | null>(null)
  const [budgetTarget, setBudgetTarget] = useState<CostCenter | null>(null)
  /** Budget state by cost-centre id, for the badges on the rows. */
  const [budgets, setBudgets] = useState<Record<number, BudgetState>>(initialBudgets)
  const [formCode, setFormCode] = useState('')
  const [formName, setFormName] = useState('')
  const [formActive, setFormActive] = useState(true)
  const [saving, setSaving] = useState(false)
  const [formError, setFormError] = useState<string | null>(null)
  const [deleteError, setDeleteError] = useState<string | null>(initialError)
  /*
   * Whether the LAST load failed, kept apart from `deleteError` (#415, #458).
   *
   * Without it an outage rendered the error and "no cost centres yet" together:
   * two claims on one screen, one of them false, and the false one is what an
   * operator acts on. `deleteError` cannot answer this alone — it also carries a
   * failed delete, where the list really is what it says.
   *
   * `EnvironmentsManager` beside this one has said so since its own outage; this
   * is the same fix.
   */
  const [loadFailed, setLoadFailed] = useState(initialError !== null)

  const load = useCallback(async () => {
    setLoading(true)
    try {
      setLoadFailed(false)
      setCcs((await get<CostCenter[]>('/api/admin/cost-centers')) ?? [])
      setDeleteError(null)
      /*
       * Budgets are a second request, and its failure is deliberately not the
       * list's failure. This page is how a cost centre is renamed or retired,
       * and none of that should become unreachable because the budget endpoint
       * is unhappy — the rows simply show no badge, which is honest: an absent
       * badge and an unknown budget look the same, and neither claims a limit
       * that is not there.
       */
      try {
        const states = (await get<BudgetState[]>('/api/admin/cost-centers/budgets')) ?? []
        setBudgets(Object.fromEntries(states.map((b) => [b.costCenterId, b])))
      } catch {
        setBudgets({})
      }
    } catch (e) {
      setLoadFailed(true)
      setDeleteError(e instanceof Error ? e.message : t('failedToLoadCostCenters', lang))
    } finally {
      setLoading(false)
    }
  }, [lang])

  function openAdd() {
    setFormCode(''); setFormName(''); setFormActive(true); setFormError(null); setAddOpen(true)
  }

  function openEdit(cc: CostCenter) {
    setFormCode(cc.code); setFormName(cc.name); setFormActive(cc.active); setFormError(null); setEditTarget(cc)
  }

  async function handleAdd(e: React.FormEvent) {
    e.preventDefault()
    setSaving(true); setFormError(null)
    try {
      const body: CreateCostCenterRequest = { code: formCode.trim(), name: formName.trim(), active: formActive }
      await post('/api/admin/cost-centers', body)
      setAddOpen(false); void load()
    } catch (err) {
      setFormError(err instanceof Error ? err.message : t('genericFailed', lang))
    } finally {
      setSaving(false)
    }
  }

  async function handleEdit(e: React.FormEvent) {
    e.preventDefault()
    if (!editTarget) return
    setSaving(true); setFormError(null)
    try {
      const body: UpdateCostCenterRequest = { code: formCode.trim(), name: formName.trim(), active: formActive }
      await put(`/api/admin/cost-centers/${editTarget.id}`, body)
      setEditTarget(null); void load()
    } catch (err) {
      setFormError(err instanceof Error ? err.message : t('genericFailed', lang))
    } finally {
      setSaving(false)
    }
  }

  async function handleDelete() {
    if (!deleteTarget) return
    setSaving(true); setDeleteError(null)
    try {
      await del(`/api/admin/cost-centers/${deleteTarget.id}`)
      setDeleteTarget(null); void load()
    } catch (e) {
      setDeleteError(e instanceof Error ? e.message : t('failedToDeleteGeneric', lang))
    } finally {
      setSaving(false)
    }
  }

  async function toggleActive(cc: CostCenter) {
    try {
      await put(`/api/admin/cost-centers/${cc.id}`, { active: !cc.active })
      void load()
    } catch (e) {
      setDeleteError(e instanceof Error ? e.message : t('failedToUpdateGeneric', lang))
    }
  }

  return (
    <>
      <Card title={t('costCenters', lang)} action={<Button size="sm" onClick={openAdd}>{t('addCostCenter', lang)}</Button>}>
        {deleteError && !deleteTarget && (
          <Alert className="mb-3">{deleteError}</Alert>
        )}
        {loading ? (
          <div className="flex justify-center py-8"><div className="h-8 w-8 animate-spin rounded-full border-4 border-slate-200 border-t-blue-600" /></div>
        ) : ccs.length === 0 && !loadFailed ? (
          <p className="text-center py-6 text-slate-600">{t('noCostCentersYet', lang)}</p>
        ) : (
          <div className="space-y-2">
            {ccs.map((cc) => (
              <div key={cc.id} className="flex flex-wrap items-center justify-between gap-y-2 rounded-lg border border-slate-100 px-4 py-3">
                <div className="flex min-w-0 items-center gap-3">
                  <span className={`inline-block h-2 w-2 rounded-full ${cc.active ? 'bg-green-500' : 'bg-slate-300'}`} />
                  <div>
                    <span className="font-mono text-sm font-medium text-slate-700">{cc.code}</span>
                    <span className="ml-2 text-slate-900">{cc.name}</span>
                    <BudgetBadge state={budgets[cc.id]} lang={lang} />
                  </div>
                </div>
                <div className="flex flex-wrap gap-2">
                  <Button size="sm" variant="ghost" onClick={() => toggleActive(cc)}>
                    {cc.active ? t('deactivate', lang) : t('activate', lang)}
                  </Button>
                  <Button size="sm" variant="secondary" onClick={() => openEdit(cc)}>{t('edit', lang)}</Button>
                  <Button size="sm" variant="secondary" onClick={() => setBudgetTarget(cc)}>{t('budget', lang)}</Button>
                  <Button size="sm" variant="danger" onClick={() => { setDeleteError(null); setDeleteTarget(cc) }}>{t('delete', lang)}</Button>
                </div>
              </div>
            ))}
          </div>
        )}
      </Card>

      <Modal open={addOpen} onClose={() => setAddOpen(false)} title={t('addCostCenter', lang)} size="sm">
        <form onSubmit={handleAdd} className="space-y-4">
          {formError && <Alert>{formError}</Alert>}
          <Input label={t('code', lang)} value={formCode} onChange={(e) => setFormCode(e.target.value)} required placeholder={t('codePlaceholder', lang)} />
          <Input label={t('name', lang)} value={formName} onChange={(e) => setFormName(e.target.value)} required />
          <div className="flex items-center gap-2">
            <input type="checkbox" id="add-active" checked={formActive} onChange={(e) => setFormActive(e.target.checked)}
              className="h-4 w-4 rounded border-slate-300 text-blue-600 focus:ring-blue-500" />
            <label htmlFor="add-active" className="text-sm font-medium text-slate-700">{t('statusActive', lang)}</label>
          </div>
          <div className="flex justify-end gap-3 pt-2">
            <Button type="button" variant="secondary" onClick={() => { setAddOpen(false); setEditTarget(null) }}>{t('cancel', lang)}</Button>
            <Button type="submit" disabled={saving}>{saving ? t('saving', lang) : t('save', lang)}</Button>
          </div>
        </form>
      </Modal>
      <Modal open={!!editTarget} onClose={() => setEditTarget(null)} title={t('editCostCenter', lang)} size="sm">
        <form onSubmit={handleEdit} className="space-y-4">
          {formError && <Alert>{formError}</Alert>}
          <Input label={t('code', lang)} value={formCode} onChange={(e) => setFormCode(e.target.value)} required placeholder={t('codePlaceholder', lang)} />
          <Input label={t('name', lang)} value={formName} onChange={(e) => setFormName(e.target.value)} required />
          <div className="flex items-center gap-2">
            <input type="checkbox" id="edit-active" checked={formActive} onChange={(e) => setFormActive(e.target.checked)}
              className="h-4 w-4 rounded border-slate-300 text-blue-600 focus:ring-blue-500" />
            <label htmlFor="edit-active" className="text-sm font-medium text-slate-700">{t('statusActive', lang)}</label>
          </div>
          <div className="flex justify-end gap-3 pt-2">
            <Button type="button" variant="secondary" onClick={() => { setAddOpen(false); setEditTarget(null) }}>{t('cancel', lang)}</Button>
            <Button type="submit" disabled={saving}>{saving ? t('saving', lang) : t('save', lang)}</Button>
          </div>
        </form>
      </Modal>
      <Modal open={!!deleteTarget} onClose={() => setDeleteTarget(null)} title={t('deleteCostCenterTitle', lang)} size="sm">
        {deleteError && <Alert className="mb-4">{deleteError}</Alert>}
        <p className="text-sm text-slate-600 mb-6">{t('deleteCostCenterPrompt', lang)} <strong>{deleteTarget?.code}</strong> — {deleteTarget?.name}?</p>
        <div className="flex justify-end gap-3">
          <Button variant="secondary" onClick={() => setDeleteTarget(null)}>{t('cancel', lang)}</Button>
          <Button variant="danger" onClick={handleDelete} disabled={saving}>{saving ? t('deleting', lang) : t('delete', lang)}</Button>
        </div>
      </Modal>
      <BudgetModal
        target={budgetTarget}
        onClose={() => setBudgetTarget(null)}
        onSaved={() => void load()}
        lang={lang}
      />
    </>
  )
}

/**
 * What a row says about its budget, in one line.
 *
 * Spent-over-limit rather than a bare limit: "8,400.00 / 10,000.00 EUR" answers
 * the question a person came to this screen with, where "10,000.00 EUR" only
 * repeats what they set. Amber once the budget is gone, and the colour is never
 * the only carrier — the text changes too (#185).
 */
function BudgetBadge({ state, lang }: { state: BudgetState | undefined; lang: string }) {
  if (!state || state.amount === null || state.currency === null) return null
  const tone = state.exhausted
    ? 'bg-red-50 text-red-700 border-red-200'
    : 'bg-slate-50 text-slate-600 border-slate-200'
  return (
    <span
      className={`ml-2 inline-block whitespace-nowrap rounded border px-2 py-0.5 text-xs tabular-nums ${tone}`}
    >
      {state.exhausted && <span className="mr-1 font-medium">{t('budgetOverspent', lang)}:</span>}
      {`${state.committed.toFixed(2)} / ${formatBudgetMoney(state.amount, state.currency)}`}
      <span className="ml-1 text-slate-500">
        ({t(state.period === 'monthly' ? 'budgetPeriodMonthlyShort' : 'budgetPeriodTotalShort', lang)})
      </span>
    </span>
  )
}
