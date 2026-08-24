'use client'

import { useState, useEffect, useCallback } from 'react'
import type { Parameter, ParameterType, CreateParameterRequest, UpdateParameterRequest } from '@open-hybrid-cloud/types'
import { get, post, put, del } from '@/lib/api'
import { Card } from '@/components/ui/Card'
import { Alert } from '@/components/ui/Alert'
import { Input } from '@/components/ui/Input'
import { Select } from '@/components/ui/Select'
import { Button } from '@/components/ui/Button'
import { Modal } from '@/components/ui/Modal'
import { useLang } from '@/lib/useLang'
import { t } from '@/lib/i18n'

interface Props { token: string }

const TYPE_KEYS: Record<ParameterType, 'typeString' | 'typeNumber' | 'typeBoolean' | 'typeDropdown'> = {
  string: 'typeString',
  number: 'typeNumber',
  bool: 'typeBoolean',
  dropdown: 'typeDropdown',
}

const emptyForm = () => ({
  name: '', label: '', type: 'string' as ParameterType, description: '',
  defaultValue: '', required: false, sensitive: false,
})

export function ParametersManager({ token }: Props) {
  const lang = useLang()
  const TYPES: { value: ParameterType; label: string }[] = (Object.keys(TYPE_KEYS) as ParameterType[]).map((value) => ({
    value, label: t(TYPE_KEYS[value], lang),
  }))
  const [params, setParams] = useState<Parameter[]>([])
  const [loading, setLoading] = useState(true)
  const [addOpen, setAddOpen] = useState(false)
  const [editTarget, setEditTarget] = useState<Parameter | null>(null)
  const [deleteTarget, setDeleteTarget] = useState<Parameter | null>(null)
  const [form, setForm] = useState(emptyForm())
  const [saving, setSaving] = useState(false)
  const [formError, setFormError] = useState<string | null>(null)
  const [deleteError, setDeleteError] = useState<string | null>(null)

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const all = (await get<Parameter[]>('/api/admin/parameters', token)) ?? []
      setParams(all.filter((p) => p.scope === 'global'))
      setDeleteError(null)
    } catch (e) {
      setDeleteError(e instanceof Error ? e.message : t('failedToLoadParameters', lang))
    } finally {
      setLoading(false)
    }
  }, [token, lang])

  useEffect(() => { void load() }, [load])

  function setField<K extends keyof typeof form>(k: K, v: typeof form[K]) {
    setForm((f) => ({ ...f, [k]: v }))
  }

  function openAdd() {
    setForm(emptyForm()); setFormError(null); setAddOpen(true)
  }

  function openEdit(param: Parameter) {
    setForm({
      name: param.name, label: param.label ?? '', type: param.type, description: param.description,
      defaultValue: param.defaultValue, required: param.required, sensitive: param.sensitive,
    })
    setFormError(null); setEditTarget(param)
  }

  async function handleAdd(e: React.FormEvent) {
    e.preventDefault()
    setSaving(true); setFormError(null)
    try {
      const body: CreateParameterRequest = {
        scope: 'global', scopeId: 0,
        name: form.name.trim(), label: form.label.trim() || undefined, type: form.type,
        description: form.description.trim() || undefined,
        defaultValue: form.defaultValue.trim() || undefined,
        required: form.required, sensitive: form.sensitive,
      }
      await post('/api/admin/parameters', body, token)
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
      const body: UpdateParameterRequest = {
        name: form.name.trim(), label: form.label.trim() || undefined, type: form.type,
        description: form.description.trim() || undefined,
        defaultValue: form.defaultValue.trim() || undefined,
        required: form.required, sensitive: form.sensitive,
      }
      await put(`/api/admin/parameters/${editTarget.id}`, body, token)
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
      await del(`/api/admin/parameters/${deleteTarget.id}`, token)
      setDeleteTarget(null); void load()
    } catch (e) {
      setDeleteError(e instanceof Error ? e.message : t('failedToDeleteGeneric', lang))
    } finally {
      setSaving(false)
    }
  }

  return (
    <>
      <Card title={t('globalParameters', lang)} action={<Button size="sm" onClick={openAdd}>{t('addParameter', lang)}</Button>}>
        {deleteError && !deleteTarget && (
          <Alert className="mb-3">{deleteError}</Alert>
        )}
        {loading ? (
          <div className="flex justify-center py-8"><div className="h-8 w-8 animate-spin rounded-full border-4 border-slate-200 border-t-blue-600" /></div>
        ) : params.length === 0 ? (
          <p className="text-center py-6 text-slate-600">{t('noGlobalParametersYet', lang)}</p>
        ) : (
          <div className="space-y-2">
            {params.map((p) => (
              <div key={p.id} className="flex items-center justify-between rounded-lg border border-slate-100 px-4 py-3">
                <div>
                  <div className="flex items-center gap-2 mb-0.5">
                    <p className="font-medium text-slate-900">{p.label || p.name}</p>
                    <span className="rounded-full bg-slate-100 px-2 py-0.5 text-xs text-slate-600">{t(TYPE_KEYS[p.type], lang)}</span>
                    {/* red-700, not red-600: this 12px badge sits on red-100 (#ffe2e2), where
                        red-600 (#e7000b) measures 3.91:1 — below the 4.5:1 AA needs for text
                        this size. red-700 (#c10007) on the same ground is 5.27:1. */}
                    {p.required && <span className="rounded-full bg-red-100 px-2 py-0.5 text-xs text-red-700">{t('requiredBadge', lang)}</span>}
                    {p.sensitive && <span className="rounded-full bg-yellow-100 px-2 py-0.5 text-xs text-yellow-700">{t('sensitiveBadge', lang)}</span>}
                  </div>
                  <p className="text-xs font-mono text-slate-600">{p.name}</p>
                  {p.description && <p className="text-xs text-slate-500">{p.description}</p>}
                </div>
                <div className="flex gap-2">
                  <Button size="sm" variant="secondary" onClick={() => openEdit(p)}>{t('edit', lang)}</Button>
                  <Button size="sm" variant="danger" onClick={() => { setDeleteError(null); setDeleteTarget(p) }}>{t('delete', lang)}</Button>
                </div>
              </div>
            ))}
          </div>
        )}
      </Card>

      <Modal open={addOpen} onClose={() => setAddOpen(false)} title={t('addParameter', lang)} size="md">
        <form onSubmit={handleAdd} className="space-y-4">
          {formError && <Alert>{formError}</Alert>}
          <div className="grid grid-cols-2 gap-4">
            <Input label={t('variableName', lang)} value={form.name} onChange={(e) => setField('name', e.target.value)} required hint={t('variableNameHint', lang)} />
            <Input label={t('displayLabel', lang)} value={form.label} onChange={(e) => setField('label', e.target.value)} hint={t('displayLabelHint', lang)} />
          </div>
          <Select label={t('type', lang)} value={form.type} onChange={(e) => setField('type', e.target.value as ParameterType)} options={TYPES} />
          <Input label={t('description', lang)} value={form.description} onChange={(e) => setField('description', e.target.value)} />
          <Input label={t('defaultValue', lang)} value={form.defaultValue} onChange={(e) => setField('defaultValue', e.target.value)}
            hint={form.type === 'dropdown' ? t('commaSeparatedOptions', lang) : undefined} />
          <div className="flex gap-6">
            <div className="flex items-center gap-2">
              <input type="checkbox" id="add-required" checked={form.required} onChange={(e) => setField('required', e.target.checked)}
                className="h-4 w-4 rounded border-slate-300 text-blue-600 focus:ring-blue-500" />
              <label htmlFor="add-required" className="text-sm font-medium text-slate-700">{t('required', lang)}</label>
            </div>
            <div className="flex items-center gap-2">
              <input type="checkbox" id="add-sensitive" checked={form.sensitive} onChange={(e) => setField('sensitive', e.target.checked)}
                className="h-4 w-4 rounded border-slate-300 text-blue-600 focus:ring-blue-500" />
              <label htmlFor="add-sensitive" className="text-sm font-medium text-slate-700">{t('sensitive', lang)}</label>
            </div>
          </div>
          <div className="flex justify-end gap-3 pt-2">
            <Button type="button" variant="secondary" onClick={() => { setAddOpen(false); setEditTarget(null) }}>{t('cancel', lang)}</Button>
            <Button type="submit" disabled={saving}>{saving ? t('saving', lang) : t('save', lang)}</Button>
          </div>
        </form>
      </Modal>
      <Modal open={!!editTarget} onClose={() => setEditTarget(null)} title={t('editParameter', lang)} size="md">
        <form onSubmit={handleEdit} className="space-y-4">
          {formError && <Alert>{formError}</Alert>}
          <div className="grid grid-cols-2 gap-4">
            <Input label={t('variableName', lang)} value={form.name} onChange={(e) => setField('name', e.target.value)} required hint={t('variableNameHint', lang)} />
            <Input label={t('displayLabel', lang)} value={form.label} onChange={(e) => setField('label', e.target.value)} hint={t('displayLabelHint', lang)} />
          </div>
          <Select label={t('type', lang)} value={form.type} onChange={(e) => setField('type', e.target.value as ParameterType)} options={TYPES} />
          <Input label={t('description', lang)} value={form.description} onChange={(e) => setField('description', e.target.value)} />
          <Input label={t('defaultValue', lang)} value={form.defaultValue} onChange={(e) => setField('defaultValue', e.target.value)}
            hint={form.type === 'dropdown' ? t('commaSeparatedOptions', lang) : undefined} />
          <div className="flex gap-6">
            <div className="flex items-center gap-2">
              <input type="checkbox" id="edit-required" checked={form.required} onChange={(e) => setField('required', e.target.checked)}
                className="h-4 w-4 rounded border-slate-300 text-blue-600 focus:ring-blue-500" />
              <label htmlFor="edit-required" className="text-sm font-medium text-slate-700">{t('required', lang)}</label>
            </div>
            <div className="flex items-center gap-2">
              <input type="checkbox" id="edit-sensitive" checked={form.sensitive} onChange={(e) => setField('sensitive', e.target.checked)}
                className="h-4 w-4 rounded border-slate-300 text-blue-600 focus:ring-blue-500" />
              <label htmlFor="edit-sensitive" className="text-sm font-medium text-slate-700">{t('sensitive', lang)}</label>
            </div>
          </div>
          <div className="flex justify-end gap-3 pt-2">
            <Button type="button" variant="secondary" onClick={() => { setAddOpen(false); setEditTarget(null) }}>{t('cancel', lang)}</Button>
            <Button type="submit" disabled={saving}>{saving ? t('saving', lang) : t('save', lang)}</Button>
          </div>
        </form>
      </Modal>
      <Modal open={!!deleteTarget} onClose={() => setDeleteTarget(null)} title={t('deleteParameterTitle', lang)} size="sm">
        {deleteError && <Alert className="mb-4">{deleteError}</Alert>}
        <p className="text-sm text-slate-600 mb-6">{t('deleteParameterPrompt', lang)} <strong>{deleteTarget?.name}</strong>?</p>
        <div className="flex justify-end gap-3">
          <Button variant="secondary" onClick={() => setDeleteTarget(null)}>{t('cancel', lang)}</Button>
          <Button variant="danger" onClick={handleDelete} disabled={saving}>{saving ? t('deleting', lang) : t('delete', lang)}</Button>
        </div>
      </Modal>
    </>
  )
}
