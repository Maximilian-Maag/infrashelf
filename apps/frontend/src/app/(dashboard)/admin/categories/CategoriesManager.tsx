'use client'

import { useState, useEffect, useCallback } from 'react'
import type { Category, CreateCategoryRequest, UpdateCategoryRequest } from '@open-hybrid-cloud/types'
import { get, post, put, del } from '@/lib/api'
import { Card } from '@/components/ui/Card'
import { Alert } from '@/components/ui/Alert'
import { Input } from '@/components/ui/Input'
import { Button } from '@/components/ui/Button'
import { Modal } from '@/components/ui/Modal'
import { useToast } from '@/components/ui/Toast'
import { SkeletonListItem } from '@/components/ui/Skeleton'
import { useLang } from '@/lib/useLang'
import { t } from '@/lib/i18n'

interface Props { token: string }

/**
 * `Number('')` is `0`, not `NaN` — so clearing the Display Order field on a
 * category ordered 40 would silently save it as 0 and jump it to the top of
 * every catalogue sidebar (#146). Falls back to `fallback` (the category's
 * own previous order when editing, `0` for a new one) for anything that is
 * not a genuine number, the same way `ProductEditForm.tsx`'s trial duration
 * field does for its analogous cleared-field case.
 */
function parseDisplayOrder(raw: string, fallback: number): number {
  const trimmed = raw.trim()
  if (trimmed === '') return fallback
  const parsed = Number(trimmed)
  return Number.isFinite(parsed) ? parsed : fallback
}

export function CategoriesManager({ token }: Props) {
  const lang = useLang()
  const { toast } = useToast()
  const [categories, setCategories] = useState<Category[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [addOpen, setAddOpen] = useState(false)
  const [editTarget, setEditTarget] = useState<Category | null>(null)
  const [deleteTarget, setDeleteTarget] = useState<Category | null>(null)
  const [formName, setFormName] = useState('')
  const [formOrder, setFormOrder] = useState('0')
  const [saving, setSaving] = useState(false)
  const [formError, setFormError] = useState<string | null>(null)
  const [flashId, setFlashId] = useState<number | null>(null)

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const data = await get<Category[]>('/api/admin/categories', token)
      setCategories(data ?? [])
      setError(null)
    } catch (e) {
      setError(e instanceof Error ? e.message : t('failedToLoadCategories', lang))
    } finally {
      setLoading(false)
    }
  }, [token, lang])

  useEffect(() => { void load() }, [load])

  function openAdd() {
    setFormName('')
    setFormOrder('0')
    setFormError(null)
    setAddOpen(true)
  }

  function openEdit(cat: Category) {
    setFormName(cat.name)
    setFormOrder(String(cat.displayOrder))
    setFormError(null)
    setEditTarget(cat)
  }

  async function handleAdd(e: React.FormEvent) {
    e.preventDefault()
    setSaving(true)
    setFormError(null)
    try {
      const body: CreateCategoryRequest = { name: formName.trim(), displayOrder: parseDisplayOrder(formOrder, 0) }
      await post('/api/admin/categories', body, token)
      setAddOpen(false)
      toast(t('categoryCreatedToast', lang))
      void load()
    } catch (err) {
      setFormError(err instanceof Error ? err.message : t('failedToCreateGeneric', lang))
    } finally {
      setSaving(false)
    }
  }

  async function handleEdit(e: React.FormEvent) {
    e.preventDefault()
    if (!editTarget) return
    const id = editTarget.id
    setSaving(true)
    setFormError(null)
    try {
      const body: UpdateCategoryRequest = {
        name: formName.trim(),
        displayOrder: parseDisplayOrder(formOrder, editTarget.displayOrder),
      }
      await put(`/api/admin/categories/${id}`, body, token)
      setEditTarget(null)
      setFlashId(id)
      toast(t('categoryUpdatedToast', lang))
      void load()
    } catch (err) {
      setFormError(err instanceof Error ? err.message : t('failedToUpdateGeneric', lang))
    } finally {
      setSaving(false)
    }
  }

  async function handleDelete() {
    if (!deleteTarget) return
    setSaving(true)
    try {
      await del(`/api/admin/categories/${deleteTarget.id}`, token)
      setDeleteTarget(null)
      toast(t('categoryDeletedToast', lang), 'info')
      void load()
    } catch (e) {
      setError(e instanceof Error ? e.message : t('failedToDeleteGeneric', lang))
    } finally {
      setSaving(false)
    }
  }

  return (
    <>
      <Card
        title={t('categories', lang)}
        action={<Button size="sm" onClick={openAdd}>{t('addCategory', lang)}</Button>}
      >
        {error && !deleteTarget && (
          <Alert className="mb-4">{error}</Alert>
        )}
        {loading ? (
          <div className="space-y-2">
            {Array.from({ length: 4 }).map((_, i) => <SkeletonListItem key={i} />)}
          </div>
        ) : categories.length === 0 ? (
          <p className="text-center py-6 text-slate-600">{t('noCategoriesYet', lang)}</p>
        ) : (
          <div className="space-y-2">
            {categories.map((cat) => (
              <div key={cat.id} className={`flex items-center justify-between rounded-lg border border-slate-100 px-4 py-3 ${cat.id === flashId ? 'animate-flash-row' : ''}`}>
                <div>
                  <span className="font-medium text-slate-900">{cat.name}</span>
                  <span className="ml-2 text-xs text-slate-600">{t('displayOrder', lang)}: {cat.displayOrder}</span>
                </div>
                <div className="flex gap-2">
                  <Button size="sm" variant="secondary" onClick={() => openEdit(cat)}>{t('edit', lang)}</Button>
                  <Button size="sm" variant="danger" onClick={() => { setError(null); setDeleteTarget(cat) }}>{t('delete', lang)}</Button>
                </div>
              </div>
            ))}
          </div>
        )}
      </Card>

      <Modal open={addOpen} onClose={() => setAddOpen(false)} title={t('addCategory', lang)} size="sm">
        <form onSubmit={handleAdd} className="space-y-4">
          {formError && (
            <Alert>{formError}</Alert>
          )}
          <Input label={t('name', lang)} value={formName} onChange={(e) => setFormName(e.target.value)} required />
          <Input label={t('displayOrder', lang)} type="number" value={formOrder} onChange={(e) => setFormOrder(e.target.value)} />
          <div className="flex justify-end gap-3 pt-2">
            <Button type="button" variant="secondary" onClick={() => { setAddOpen(false); setEditTarget(null) }}>{t('cancel', lang)}</Button>
            <Button type="submit" disabled={saving}>{saving ? t('saving', lang) : t('save', lang)}</Button>
          </div>
        </form>
      </Modal>

      <Modal open={!!editTarget} onClose={() => setEditTarget(null)} title={t('editCategory', lang)} size="sm">
        <form onSubmit={handleEdit} className="space-y-4">
          {formError && (
            <Alert>{formError}</Alert>
          )}
          <Input label={t('name', lang)} value={formName} onChange={(e) => setFormName(e.target.value)} required />
          <Input label={t('displayOrder', lang)} type="number" value={formOrder} onChange={(e) => setFormOrder(e.target.value)} />
          <div className="flex justify-end gap-3 pt-2">
            <Button type="button" variant="secondary" onClick={() => { setAddOpen(false); setEditTarget(null) }}>{t('cancel', lang)}</Button>
            <Button type="submit" disabled={saving}>{saving ? t('saving', lang) : t('save', lang)}</Button>
          </div>
        </form>
      </Modal>

      <Modal open={!!deleteTarget} onClose={() => setDeleteTarget(null)} title={t('deleteCategoryTitle', lang)} size="sm">
        {error && <Alert className="mb-4">{error}</Alert>}
        <p className="text-sm text-slate-600 mb-6">
          {t('deleteCategoryPrompt', lang)} <strong>{deleteTarget?.name}</strong>? {t('cannotBeUndone', lang)}
        </p>
        <div className="flex justify-end gap-3">
          <Button variant="secondary" onClick={() => setDeleteTarget(null)}>{t('cancel', lang)}</Button>
          <Button variant="danger" onClick={handleDelete} disabled={saving}>
            {saving ? t('deleting', lang) : t('delete', lang)}
          </Button>
        </div>
      </Modal>
    </>
  )
}
