'use client'

import {useState, useCallback } from 'react'
import type {
  DeploymentEnvironment,
  CiSource,
  CreateEnvironmentRequest,
  UpdateEnvironmentRequest,
  CallbackSecretResponse,
} from '@infrashelf/types'
import { get, post, put, del } from '@/lib/api'
import { Card } from '@/components/ui/Card'
import { Alert } from '@/components/ui/Alert'
import { Input } from '@/components/ui/Input'
import { Select } from '@/components/ui/Select'
import { Button } from '@/components/ui/Button'
import { Modal } from '@/components/ui/Modal'
import { useLang } from '@/lib/useLang'
import { t } from '@/lib/i18n'

interface Props {
  ciSources: CiSource[]
  /**
   * The environments the SERVER already fetched (#458).
   *
   * `ciSources` beside it has always come from the page — this is the same
   * arrangement, applied to the list the component used to ask for on mount.
   * `load()` below stays for the reload after a create, an edit or a delete: a
   * response to an action rather than to mounting.
   */
  initial: DeploymentEnvironment[]
  /** Why the server could not fetch them, if it could not (#415). */
  initialError?: string | null
}

const emptyForm = () => ({
  name: '', description: '', ciSourceId: '', webhookUrl: '', webhookToken: '',
  // #330, and false is the default that matters: turning this on for every
  // environment at upgrade would strand every sandbox deploy after 18:00.
  respectsDeploymentWindows: false,
})

export function EnvironmentsManager({ ciSources, initial, initialError = null }: Props) {
  const lang = useLang()
  const [envs, setEnvs] = useState<DeploymentEnvironment[]>(initial)
  // The server already has them, so nothing is pending on arrival.
  const [loading, setLoading] = useState(false)
  const [addOpen, setAddOpen] = useState(false)
  const [editTarget, setEditTarget] = useState<DeploymentEnvironment | null>(null)
  const [deleteTarget, setDeleteTarget] = useState<DeploymentEnvironment | null>(null)
  const [form, setForm] = useState(emptyForm())
  const [saving, setSaving] = useState(false)
  const [formError, setFormError] = useState<string | null>(null)
  const [loadError, setLoadError] = useState<string | null>(initialError)

  const load = useCallback(async () => {
    setLoading(true)
    try {
      setEnvs((await get<DeploymentEnvironment[]>('/api/admin/environments')) ?? [])
      setLoadError(null)
    } catch (err) {
      // Without this, an admin-API outage left `envs` empty and rendered
      // "no environments yet" — telling an administrator their environments do
      // not exist, at the moment they are least able to check. Every sibling
      // manager on this page already reports its load failure; this one did not.
      setLoadError(err instanceof Error ? err.message : t('failedToLoadEnvironments', lang))
    } finally {
      setLoading(false)
    }
  }, [lang])

  // Value typed per field rather than as `string`: the form gained a boolean
  // with #330, and widening to `string | boolean` would let a checkbox be set
  // to a string without tsc noticing.
  function setField<K extends keyof ReturnType<typeof emptyForm>>(
    k: K,
    v: ReturnType<typeof emptyForm>[K],
  ) {
    setForm((f) => ({ ...f, [k]: v }))
  }

  function openAdd() {
    setForm(emptyForm())
    setFormError(null)
    setAddOpen(true)
  }

  function openEdit(env: DeploymentEnvironment) {
    setForm({
      name: env.name,
      description: env.description ?? '',
      ciSourceId: String(env.ciSourceId),
      webhookUrl: '',
      webhookToken: '',
      respectsDeploymentWindows: env.respectsDeploymentWindows ?? false,
    })
    setFormError(null)
    setEditTarget(env)
  }

  async function handleAdd(e: React.FormEvent) {
    e.preventDefault()
    setSaving(true)
    setFormError(null)
    try {
      const body: CreateEnvironmentRequest = {
        name: form.name.trim(),
        description: form.description.trim() || undefined,
        ciSourceId: Number(form.ciSourceId),
        webhookUrl: form.webhookUrl.trim(),
        webhookToken: form.webhookToken.trim(),
      }
      await post('/api/admin/environments', body)
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
      const body: UpdateEnvironmentRequest = {
        name: form.name.trim(),
        description: form.description.trim() || undefined,
        ciSourceId: Number(form.ciSourceId),
        ...(form.webhookUrl ? { webhookUrl: form.webhookUrl.trim() } : {}),
        ...(form.webhookToken ? { webhookToken: form.webhookToken.trim() } : {}),
        // Always sent, unlike the two above: those are "leave unchanged when
        // blank" secrets, while a checkbox cleared on purpose has to reach the
        // server as false or it could never be turned back off.
        respectsDeploymentWindows: form.respectsDeploymentWindows,
      }
      await put(`/api/admin/environments/${editTarget.id}`, body)
      closeEdit()
      void load()
    } catch (err) {
      setFormError(err instanceof Error ? err.message : t('failedToUpdateGeneric', lang))
    } finally {
      setSaving(false)
    }
  }

  const [deleteError, setDeleteError] = useState<string | null>(null)
  const [callbackSecret, setCallbackSecret] = useState<string | null>(null)
  const [secretBusy, setSecretBusy] = useState(false)
  const [secretError, setSecretError] = useState<string | null>(null)
  const [regenConfirmOpen, setRegenConfirmOpen] = useState(false)
  const [copied, setCopied] = useState(false)

  function closeEdit() {
    setEditTarget(null)
    setCallbackSecret(null)
    setSecretError(null)
    setCopied(false)
  }

  async function revealCallbackSecret() {
    if (!editTarget) return
    setSecretBusy(true)
    setSecretError(null)
    try {
      const res = await get<CallbackSecretResponse>(`/api/admin/environments/${editTarget.id}/callback-secret`)
      setCallbackSecret(res?.callbackSecret ?? null)
    } catch (e) {
      setCallbackSecret(null)
      setSecretError(e instanceof Error ? e.message : t('failedToLoadSecret', lang))
    } finally {
      setSecretBusy(false)
    }
  }

  async function doRegenerateCallbackSecret() {
    if (!editTarget) return
    setRegenConfirmOpen(false)
    setSecretBusy(true)
    setSecretError(null)
    try {
      const res = await post<CallbackSecretResponse>(`/api/admin/environments/${editTarget.id}/callback-secret`, {})
      setCallbackSecret(res?.callbackSecret ?? null)
    } catch (e) {
      setSecretError(e instanceof Error ? e.message : t('failedToRegenerateSecret', lang))
    } finally {
      setSecretBusy(false)
    }
  }

  async function copyCallbackSecret() {
    if (!callbackSecret) return
    try {
      await navigator.clipboard.writeText(callbackSecret)
      setCopied(true)
      setTimeout(() => setCopied(false), 2000)
    } catch (e) {
      setSecretError(e instanceof Error ? e.message : t('failedToCopyClipboard', lang))
    }
  }

  async function handleDelete() {
    if (!deleteTarget) return
    setSaving(true)
    setDeleteError(null)
    try {
      await del(`/api/admin/environments/${deleteTarget.id}`)
      setDeleteTarget(null)
      void load()
    } catch (e) {
      setDeleteError(e instanceof Error ? e.message : t('failedToDeleteEnvironment', lang))
    } finally {
      setSaving(false)
    }
  }

  const ciOptions = ciSources.map((c) => ({ value: c.id, label: c.name }))

  return (
    <>
      <Card title={t('environments', lang)} action={<Button size="sm" onClick={openAdd}>{t('addEnvironment', lang)}</Button>}>
        {loading ? (
          <div className="flex justify-center py-8"><div className="h-8 w-8 animate-spin rounded-full border-4 border-slate-200 border-t-blue-600" /></div>
        ) : loadError ? (
          <Alert>{loadError}</Alert>
        ) : envs.length === 0 ? (
          <p className="text-center py-6 text-slate-600">{t('noEnvironmentsYet', lang)}</p>
        ) : (
          <div className="space-y-2">
            {envs.map((env) => (
              <div key={env.id} className="flex items-center justify-between rounded-lg border border-slate-100 px-4 py-3">
                <div>
                  <p className="font-medium text-slate-900">{env.name}</p>
                  {env.description && <p className="text-xs text-slate-600">{env.description}</p>}
                </div>
                <div className="flex gap-2">
                  <Button size="sm" variant="secondary" onClick={() => openEdit(env)}>{t('edit', lang)}</Button>
                  <Button size="sm" variant="danger" onClick={() => setDeleteTarget(env)}>{t('delete', lang)}</Button>
                </div>
              </div>
            ))}
          </div>
        )}
      </Card>

      <Modal open={addOpen} onClose={() => setAddOpen(false)} title={t('addEnvironment', lang)} size="md">
        <form onSubmit={handleAdd} className="space-y-4">
          {formError && <Alert>{formError}</Alert>}
          <Input label={t('name', lang)} value={form.name} onChange={(e) => setField('name', e.target.value)} required />
          <Input label={t('description', lang)} value={form.description} onChange={(e) => setField('description', e.target.value)} />
          <Select label={t('ciSourceLabel', lang)} required value={form.ciSourceId} onChange={(e) => setField('ciSourceId', e.target.value)}
            placeholder={t('selectCiSourcePlaceholder', lang)} options={ciOptions} />
          <Input label={t('webhookUrl', lang)} type="url" value={form.webhookUrl} onChange={(e) => setField('webhookUrl', e.target.value)} required />
          <Input label={t('webhookToken', lang)} value={form.webhookToken} onChange={(e) => setField('webhookToken', e.target.value)} required />
          <div className="flex justify-end gap-3 pt-2">
            <Button type="button" variant="secondary" onClick={() => { setAddOpen(false); setEditTarget(null) }}>{t('cancel', lang)}</Button>
            <Button type="submit" disabled={saving}>{saving ? t('saving', lang) : t('save', lang)}</Button>
          </div>
        </form>
      </Modal>
      <Modal open={!!editTarget} onClose={closeEdit} title={t('editEnvironment', lang)} size="md">
        <form onSubmit={handleEdit} className="space-y-4">
          {formError && <Alert>{formError}</Alert>}
          <Input label={t('name', lang)} value={form.name} onChange={(e) => setField('name', e.target.value)} required />
          <Input label={t('description', lang)} value={form.description} onChange={(e) => setField('description', e.target.value)} />
          <Select label={t('ciSourceLabel', lang)} required value={form.ciSourceId} onChange={(e) => setField('ciSourceId', e.target.value)}
            placeholder={t('selectCiSourcePlaceholder', lang)} options={ciOptions} />
          <Input label={t('webhookUrlKeepHint', lang)} type="url" value={form.webhookUrl} onChange={(e) => setField('webhookUrl', e.target.value)} />
          <Input label={t('webhookTokenOutbound', lang)} value={form.webhookToken} onChange={(e) => setField('webhookToken', e.target.value)} hint={t('webhookTokenOutboundHint', lang)} />
          {/* #330's second switch. The windows themselves are defined once, by
              root, under Admin → Deployment windows; this says which
              environments honour them. */}
          <label className="flex items-start gap-2 text-sm text-slate-700">
            <input
              type="checkbox"
              className="mt-0.5"
              checked={form.respectsDeploymentWindows}
              onChange={(e) => setField('respectsDeploymentWindows', e.target.checked)}
            />
            <span>{t('respectsWindows', lang)}</span>
          </label>
          <div className="rounded-lg border border-slate-200 p-3 space-y-2">
            <div className="flex items-center justify-between">
              <div>
                <p className="text-sm font-medium text-slate-700">{t('callbackSecretLabel', lang)}</p>
                <p className="text-xs text-slate-600">{t('callbackSecretHint', lang)}</p>
              </div>
            </div>
            {secretError && (
              <Alert>{secretError}</Alert>
            )}
            {callbackSecret ? (
              <div className="flex items-center gap-2">
                <input readOnly value={callbackSecret} className="min-h-11 flex-1 rounded border border-slate-300 px-2 py-1 text-xs font-mono text-slate-700 bg-slate-50" />
                <Button type="button" size="sm" variant="secondary" onClick={copyCallbackSecret}>{copied ? t('copied', lang) : t('copy', lang)}</Button>
              </div>
            ) : (
              <Button type="button" size="sm" variant="secondary" onClick={revealCallbackSecret} disabled={secretBusy}>
                {secretBusy ? t('loading', lang) : t('revealCurrent', lang)}
              </Button>
            )}
            <div>
              <Button type="button" size="sm" variant="danger" onClick={() => setRegenConfirmOpen(true)} disabled={secretBusy}>
                {secretBusy ? t('regenerating', lang) : t('regenerate', lang)}
              </Button>
            </div>
          </div>
          <div className="flex justify-end gap-3 pt-2">
            <Button type="button" variant="secondary" onClick={closeEdit}>{t('cancel', lang)}</Button>
            <Button type="submit" disabled={saving}>{saving ? t('saving', lang) : t('save', lang)}</Button>
          </div>
        </form>
      </Modal>
      <Modal open={!!deleteTarget} onClose={() => { setDeleteTarget(null); setDeleteError(null) }} title={t('deleteEnvironmentTitle', lang)} size="sm">
        <p className="text-sm text-slate-600 mb-4">{t('delete', lang)} <strong>{deleteTarget?.name}</strong>?</p>
        {deleteError && (
          <Alert className="mb-4">{deleteError}</Alert>
        )}
        <div className="flex justify-end gap-3">
          <Button variant="secondary" onClick={() => { setDeleteTarget(null); setDeleteError(null) }}>{t('cancel', lang)}</Button>
          <Button variant="danger" onClick={handleDelete} disabled={saving}>{saving ? t('deleting', lang) : t('delete', lang)}</Button>
        </div>
      </Modal>
      <Modal open={regenConfirmOpen} onClose={() => setRegenConfirmOpen(false)} title={t('regenerateSecretTitle', lang)} size="sm">
        <p className="text-sm text-slate-600 mb-4">
          {t('regenerateSecretConfirm', lang)}
        </p>
        <div className="flex justify-end gap-3">
          <Button type="button" variant="secondary" onClick={() => setRegenConfirmOpen(false)}>{t('cancel', lang)}</Button>
          <Button type="button" variant="danger" onClick={doRegenerateCallbackSecret} disabled={secretBusy}>
            {secretBusy ? t('regenerating', lang) : t('regenerate', lang)}
          </Button>
        </div>
      </Modal>
    </>
  )
}
