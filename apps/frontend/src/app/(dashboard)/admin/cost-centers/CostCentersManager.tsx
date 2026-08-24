'use client'

import { useState, useEffect, useCallback } from 'react'
import type { CostCenter, CreateCostCenterRequest, UpdateCostCenterRequest } from '@open-hybrid-cloud/types'
import { get, post, put, del } from '@/lib/api'
import { Card } from '@/components/ui/Card'
import { Alert } from '@/components/ui/Alert'
import { Input } from '@/components/ui/Input'
import { Button } from '@/components/ui/Button'
import { Modal } from '@/components/ui/Modal'
import { useLang } from '@/lib/useLang'
import { t } from '@/lib/i18n'

interface Props { token: string }

export function CostCentersManager({ token }: Props) {
  const lang = useLang()
  const [ccs, setCcs] = useState<CostCenter[]>([])
  const [loading, setLoading] = useState(true)
  const [addOpen, setAddOpen] = useState(false)
  const [editTarget, setEditTarget] = useState<CostCenter | null>(null)
  const [deleteTarget, setDeleteTarget] = useState<CostCenter | null>(null)
  const [formCode, setFormCode] = useState('')
  const [formName, setFormName] = useState('')
  const [formActive, setFormActive] = useState(true)
  const [saving, setSaving] = useState(false)
  const [formError, setFormError] = useState<string | null>(null)
  const [deleteError, setDeleteError] = useState<string | null>(null)

  const load = useCallback(async () => {
    setLoading(true)
    try {
      setCcs((await get<CostCenter[]>('/api/admin/cost-centers', token)) ?? [])
      setDeleteError(null)
    } catch (e) {
      setDeleteError(e instanceof Error ? e.message : t('failedToLoadCostCenters', lang))
    } finally {
      setLoading(false)
    }
  }, [token, lang])

  useEffect(() => { void load() }, [load])

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
      await post('/api/admin/cost-centers', body, token)
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
      await put(`/api/admin/cost-centers/${editTarget.id}`, body, token)
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
      await del(`/api/admin/cost-centers/${deleteTarget.id}`, token)
      setDeleteTarget(null); void load()
    } catch (e) {
      setDeleteError(e instanceof Error ? e.message : t('failedToDeleteGeneric', lang))
    } finally {
      setSaving(false)
    }
  }

  async function toggleActive(cc: CostCenter) {
    try {
      await put(`/api/admin/cost-centers/${cc.id}`, { active: !cc.active }, token)
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
        ) : ccs.length === 0 ? (
          <p className="text-center py-6 text-slate-600">{t('noCostCentersYet', lang)}</p>
        ) : (
          <div className="space-y-2">
            {ccs.map((cc) => (
              <div key={cc.id} className="flex items-center justify-between rounded-lg border border-slate-100 px-4 py-3">
                <div className="flex items-center gap-3">
                  <span className={`inline-block h-2 w-2 rounded-full ${cc.active ? 'bg-green-500' : 'bg-slate-300'}`} />
                  <div>
                    <span className="font-mono text-sm font-medium text-slate-700">{cc.code}</span>
                    <span className="ml-2 text-slate-900">{cc.name}</span>
                  </div>
                </div>
                <div className="flex gap-2">
                  <Button size="sm" variant="ghost" onClick={() => toggleActive(cc)}>
                    {cc.active ? t('deactivate', lang) : t('activate', lang)}
                  </Button>
                  <Button size="sm" variant="secondary" onClick={() => openEdit(cc)}>{t('edit', lang)}</Button>
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
    </>
  )
}
