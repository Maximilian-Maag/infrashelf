'use client'

import {useState, useCallback } from 'react'
import type { CiSource, CiProvider, CreateCiSourceRequest, UpdateCiSourceRequest } from '@infrashelf/types'
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

const emptyForm = () => ({ name: '', url: '', accessToken: '', provider: 'gitlab' as CiProvider })

interface Props {
  /**
   * The rows the SERVER already fetched (#452).
   *
   * This component used to ask for them on mount, which meant the page arrived
   * with a spinner and then asked — a waterfall the server was in a position to
   * resolve before it sent anything. `load()` below is still here, because a
   * reload after a create, an edit or a delete is a response to an action rather
   * than to mounting.
   */
  initial: CiSource[]
  /**
   * Why the server could not fetch them, if it could not (#415). Carried through
   * rather than recomputed: an empty list and a failed fetch are different facts,
   * and the one the reader acts on is the wrong one when they look the same.
   */
  initialError?: string | null
}

export function CiSourcesManager({ initial, initialError = null }: Props) {
  const lang = useLang()
  const [sources, setSources] = useState<CiSource[]>(initial)
  // The server already has the rows, so nothing is pending on arrival.
  const [loading, setLoading] = useState(false)
  const [addOpen, setAddOpen] = useState(false)
  const [editTarget, setEditTarget] = useState<CiSource | null>(null)
  const [deleteTarget, setDeleteTarget] = useState<CiSource | null>(null)
  const [form, setForm] = useState(emptyForm())
  const [saving, setSaving] = useState(false)
  const [formError, setFormError] = useState<string | null>(null)
  const [deleteError, setDeleteError] = useState<string | null>(initialError)
  /*
   * Whether the LAST load failed, kept apart from `deleteError` (#415).
   *
   * Without it an outage rendered the error and "there are none" together: two
   * claims on one screen, one of which is false and is the one a person acts on.
   * `deleteError` cannot answer this on its own — it also carries a failed
   * delete, where the list really is what it says.
   */
  const [loadFailed, setLoadFailed] = useState(initialError !== null)

  const load = useCallback(async () => {
    setLoading(true)
    try {
      setLoadFailed(false)
      setSources((await get<CiSource[]>('/api/admin/ci-sources')) ?? [])
      setDeleteError(null)
    } catch (e) {
      setLoadFailed(true)
      setDeleteError(e instanceof Error ? e.message : t('failedToLoadCiSources', lang))
    } finally {
      setLoading(false)
    }
  }, [lang])

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
      await post('/api/admin/ci-sources', body)
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
      await put(`/api/admin/ci-sources/${editTarget.id}`, body)
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
      await del(`/api/admin/ci-sources/${deleteTarget.id}`)
      setDeleteTarget(null)
      void load()
    } catch (e) {
      setDeleteError(e instanceof Error ? e.message : t('failedToDeleteGeneric', lang))
    } finally {
      setSaving(false)
    }
  }

  // Stryker disable next-line all: the badge palette is appearance only — the
  // provider NAME beside it is what carries the meaning, and that is asserted.
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
        ) : sources.length === 0 && !loadFailed ? (
          <p className="text-center py-6 text-slate-600">{t('noCiSourcesYet', lang)}</p>
        ) : (
          <div className="space-y-2">
            {sources.map((src) => (
              <div key={src.id} className="flex flex-wrap items-center justify-between gap-y-2 rounded-lg border border-slate-100 px-4 py-3">
                {/* `min-w-0` because a flex child defaults to `min-width: auto`
                    and so refuses to shrink below its content — wrapping the ROW
                    does nothing while this column is still as wide as the URL
                    inside it. `break-all` on the URL itself for the same reason:
                    a repository path can outgrow a 320px phone. `break-words`
                    rather than `break-all`: a URL already breaks at its slashes
                    and hyphens, and measured at 320px a 130-character one wraps
                    on its own — this is the fallback for the one that cannot,
                    not a licence to split every path mid-token. */}
                <div className="min-w-0">
                  <div className="flex flex-wrap items-center gap-2 mb-0.5">
                    <p className="font-medium text-slate-900">{src.name}</p>
                    <span className={`rounded-full px-2 py-0.5 text-xs font-medium ${providerBadge[src.provider]}`}>
                      {src.provider}
                    </span>
                  </div>
                  <p className="text-xs text-slate-600 font-mono break-words">{src.url}</p>
                </div>
                <div className="flex flex-wrap gap-2">
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
