'use client'

import { useState, useEffect, useCallback } from 'react'
import type { CiSource, CiProvider, CreateCiSourceRequest, UpdateCiSourceRequest } from '@open-hybrid-cloud/types'
import { get, post, put, del } from '@/lib/api'
import { Card } from '@/components/ui/Card'
import { Alert } from '@/components/ui/Alert'
import { Input } from '@/components/ui/Input'
import { Select } from '@/components/ui/Select'
import { Button } from '@/components/ui/Button'
import { Modal } from '@/components/ui/Modal'
import { useLang } from '@/lib/useLang'
import { t } from '@/lib/i18n'

// Provider names are proper nouns — not translated, same as "SMTP" and "Branding".
const PROVIDERS: { value: CiProvider; label: string }[] = [
  { value: 'gitlab', label: 'GitLab' },
  { value: 'github', label: 'GitHub' },
  { value: 'bitbucket', label: 'Bitbucket' },
]

interface Props { token: string }

const emptyForm = () => ({ name: '', url: '', accessToken: '', provider: 'gitlab' as CiProvider })

export function CiSourcesManager({ token }: Props) {
  const lang = useLang()
  const [sources, setSources] = useState<CiSource[]>([])
  const [loading, setLoading] = useState(true)
  const [addOpen, setAddOpen] = useState(false)
  const [editTarget, setEditTarget] = useState<CiSource | null>(null)
  const [deleteTarget, setDeleteTarget] = useState<CiSource | null>(null)
  const [form, setForm] = useState(emptyForm())
  const [saving, setSaving] = useState(false)
  const [formError, setFormError] = useState<string | null>(null)
  const [deleteError, setDeleteError] = useState<string | null>(null)

  const load = useCallback(async () => {
    setLoading(true)
    try {
      setSources((await get<CiSource[]>('/api/admin/ci-sources', token)) ?? [])
      setDeleteError(null)
    } catch (e) {
      setDeleteError(e instanceof Error ? e.message : t('failedToLoadCiSources', lang))
    } finally {
      setLoading(false)
    }
  }, [token, lang])

  useEffect(() => { void load() }, [load])

  function setField(k: keyof typeof form, v: string) {
    setForm((f) => ({ ...f, [k]: v }))
  }

  function openAdd() {
    setForm(emptyForm())
    setFormError(null)
    setAddOpen(true)
  }

  function openEdit(src: CiSource) {
    setForm({ name: src.name, url: src.url, accessToken: '', provider: src.provider })
    setFormError(null)
    setEditTarget(src)
  }

  async function handleAdd(e: React.FormEvent) {
    e.preventDefault()
    setSaving(true)
    setFormError(null)
    try {
      const body: CreateCiSourceRequest = {
        name: form.name.trim(),
        url: form.url.trim(),
        accessToken: form.accessToken.trim(),
        provider: form.provider,
      }
      await post('/api/admin/ci-sources', body, token)
      setAddOpen(false)
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
    setSaving(true)
    setFormError(null)
    try {
      const body: UpdateCiSourceRequest = {
        name: form.name.trim(),
        url: form.url.trim(),
        provider: form.provider,
        ...(form.accessToken ? { accessToken: form.accessToken.trim() } : {}),
      }
      await put(`/api/admin/ci-sources/${editTarget.id}`, body, token)
      setEditTarget(null)
      void load()
    } catch (err) {
      setFormError(err instanceof Error ? err.message : t('failedToUpdateGeneric', lang))
    } finally {
      setSaving(false)
    }
  }

  async function handleDelete() {
    if (!deleteTarget) return
    setSaving(true); setDeleteError(null)
    try {
      await del(`/api/admin/ci-sources/${deleteTarget.id}`, token)
      setDeleteTarget(null)
      void load()
    } catch (e) {
      setDeleteError(e instanceof Error ? e.message : t('failedToDeleteGeneric', lang))
    } finally {
      setSaving(false)
    }
  }

  const providerBadge: Record<CiProvider, string> = {
    gitlab: 'bg-orange-100 text-orange-700',
    github: 'bg-slate-100 text-slate-700',
    bitbucket: 'bg-blue-100 text-blue-700',
  }

  return (
    <>
      <Card title={t('ciSources', lang)} action={<Button size="sm" onClick={openAdd}>{t('addCiSource', lang)}</Button>}>
        {deleteError && !deleteTarget && (
          <Alert className="mb-3">{deleteError}</Alert>
        )}
        {loading ? (
          <div className="flex justify-center py-8"><div className="h-8 w-8 animate-spin rounded-full border-4 border-slate-200 border-t-blue-600" /></div>
        ) : sources.length === 0 ? (
          <p className="text-center py-6 text-slate-600">{t('noCiSourcesYet', lang)}</p>
        ) : (
          <div className="space-y-2">
            {sources.map((src) => (
              <div key={src.id} className="flex items-center justify-between rounded-lg border border-slate-100 px-4 py-3">
                <div>
                  <div className="flex items-center gap-2 mb-0.5">
                    <p className="font-medium text-slate-900">{src.name}</p>
                    <span className={`rounded-full px-2 py-0.5 text-xs font-medium ${providerBadge[src.provider]}`}>
                      {src.provider}
                    </span>
                  </div>
                  <p className="text-xs text-slate-500 font-mono">{src.url}</p>
                </div>
                <div className="flex gap-2">
                  <Button size="sm" variant="secondary" onClick={() => openEdit(src)}>{t('edit', lang)}</Button>
                  <Button size="sm" variant="danger" onClick={() => { setDeleteError(null); setDeleteTarget(src) }}>{t('delete', lang)}</Button>
                </div>
              </div>
            ))}
          </div>
        )}
      </Card>

      <Modal open={addOpen} onClose={() => setAddOpen(false)} title={t('addCiSource', lang)} size="md">
        <form onSubmit={handleAdd} className="space-y-4">
          {formError && <Alert>{formError}</Alert>}
          <Input label={t('name', lang)} value={form.name} onChange={(e) => setField('name', e.target.value)} required />
          <Input label={t('url', lang)} type="url" value={form.url} onChange={(e) => setField('url', e.target.value)} required />
          <Select label={t('provider', lang)} value={form.provider} onChange={(e) => setField('provider', e.target.value)} options={PROVIDERS} />
          <Input label={t('accessToken', lang)} type="password" value={form.accessToken} onChange={(e) => setField('accessToken', e.target.value)} required />
          <div className="flex justify-end gap-3 pt-2">
            <Button type="button" variant="secondary" onClick={() => { setAddOpen(false); setEditTarget(null) }}>{t('cancel', lang)}</Button>
            <Button type="submit" disabled={saving}>{saving ? t('saving', lang) : t('save', lang)}</Button>
          </div>
        </form>
      </Modal>
      <Modal open={!!editTarget} onClose={() => setEditTarget(null)} title={t('editCiSource', lang)} size="md">
        <form onSubmit={handleEdit} className="space-y-4">
          {formError && <Alert>{formError}</Alert>}
          <Input label={t('name', lang)} value={form.name} onChange={(e) => setField('name', e.target.value)} required />
          <Input label={t('url', lang)} type="url" value={form.url} onChange={(e) => setField('url', e.target.value)} required />
          <Select label={t('provider', lang)} value={form.provider} onChange={(e) => setField('provider', e.target.value)} options={PROVIDERS} />
          <Input label={t('accessTokenKeepLabel', lang)} type="password" value={form.accessToken} onChange={(e) => setField('accessToken', e.target.value)} />
          <div className="flex justify-end gap-3 pt-2">
            <Button type="button" variant="secondary" onClick={() => { setAddOpen(false); setEditTarget(null) }}>{t('cancel', lang)}</Button>
            <Button type="submit" disabled={saving}>{saving ? t('saving', lang) : t('save', lang)}</Button>
          </div>
        </form>
      </Modal>
      <Modal open={!!deleteTarget} onClose={() => setDeleteTarget(null)} title={t('deleteCiSourceTitle', lang)} size="sm">
        {deleteError && <Alert className="mb-4">{deleteError}</Alert>}
        <p className="text-sm text-slate-600 mb-6">{t('delete', lang)} <strong>{deleteTarget?.name}</strong>?</p>
        <div className="flex justify-end gap-3">
          <Button variant="secondary" onClick={() => setDeleteTarget(null)}>{t('cancel', lang)}</Button>
          <Button variant="danger" onClick={handleDelete} disabled={saving}>{saving ? t('deleting', lang) : t('delete', lang)}</Button>
        </div>
      </Modal>
    </>
  )
}
