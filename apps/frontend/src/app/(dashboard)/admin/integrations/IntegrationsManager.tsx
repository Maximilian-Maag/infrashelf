'use client'

import { useState, useCallback } from 'react'
import type {
  Integration,
  IntegrationKind,
  IntegrationAuthType,
  IntegrationFailureMode,
  IntegrationProbeResult,
  CreateIntegrationRequest,
  UpdateIntegrationRequest,
  DeploymentEnvironment,
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

// Product names, not translated — same rule as the CI providers.
const KINDS: { value: IntegrationKind; label: string }[] = [
  { value: 'foreman', label: 'Foreman' },
  { value: 'ansible', label: 'Ansible' },
  { value: 'nexus', label: 'Nexus' },
  { value: 'pulp', label: 'Pulp' },
  { value: 'loki', label: 'Loki' },
  { value: 'grafana', label: 'Grafana' },
]

/*
 * Auth types are the wire values the API takes, and they are shown as they are.
 * "bearer", "basic" and "token_header" name a mechanism a reader either knows or
 * looks up; a translated paraphrase would be a second name for the same thing
 * and would not match what the integration's own documentation calls it.
 */
const AUTH_TYPES: { value: IntegrationAuthType; label: string }[] = [
  { value: 'none', label: 'none' },
  { value: 'bearer', label: 'bearer' },
  { value: 'basic', label: 'basic' },
  { value: 'token_header', label: 'token_header' },
]

/** What "portal-wide" is worth as a select value — see `toEnvironmentId`. */
const PORTAL_WIDE = ''

const emptyForm = () => ({
  kind: 'foreman' as IntegrationKind,
  name: '',
  baseUrl: '',
  authType: 'bearer' as IntegrationAuthType,
  username: '',
  credential: '',
  environmentId: PORTAL_WIDE,
  enabled: true,
  // No default worth having: the API refuses a create without it on purpose, and
  // pre-selecting one here would put the decision back where it was — nowhere.
  failureMode: '' as IntegrationFailureMode | '',
})

const toEnvironmentId = (value: string): number | null =>
  value === PORTAL_WIDE ? null : Number(value)

interface Props {
  /** The rows the SERVER already fetched (#452). */
  initial: Integration[]
  /** Why it could not, if it could not (#415) — never the same as "none exist". */
  initialError?: string | null
  /**
   * For naming a binding and for offering one. An integration bound to
   * environment 4 should say which environment that is; when this list failed to
   * load, the id is still shown rather than nothing.
   */
  environments: DeploymentEnvironment[]
}

export function IntegrationsManager({ initial, initialError = null, environments }: Props) {
  const lang = useLang()
  const [items, setItems] = useState<Integration[]>(initial)
  const [loading, setLoading] = useState(false)
  const [addOpen, setAddOpen] = useState(false)
  const [editTarget, setEditTarget] = useState<Integration | null>(null)
  const [deleteTarget, setDeleteTarget] = useState<Integration | null>(null)
  const [form, setForm] = useState(emptyForm())
  const [saving, setSaving] = useState(false)
  const [formError, setFormError] = useState<string | null>(null)
  const [listError, setListError] = useState<string | null>(initialError)
  /** Kept apart from `listError` so an outage never renders beside "there are none" (#415). */
  const [loadFailed, setLoadFailed] = useState(initialError !== null)
  /** Which row is being probed, so only its own button says so. */
  const [probing, setProbing] = useState<number | null>(null)
  /**
   * The answer to the last probe, per integration.
   *
   * Kept beside the row rather than folded into it: `lastContactedAt` answers
   * "when did this last work", and a probe that has just FAILED must not be
   * allowed to look like one that just succeeded. The refreshed health fields
   * from the response are written back to the row; this holds the verdict.
   */
  const [probeResult, setProbeResult] = useState<Record<number, IntegrationProbeResult>>({})

  const load = useCallback(async () => {
    setLoading(true)
    try {
      setLoadFailed(false)
      setItems((await get<Integration[]>('/api/admin/integrations')) ?? [])
      setListError(null)
    } catch (e) {
      setLoadFailed(true)
      setListError(e instanceof Error ? e.message : t('failedToLoadIntegrations', lang))
    } finally {
      setLoading(false)
    }
  }, [lang])

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

  function openEdit(row: Integration) {
    setForm({
      kind: row.kind,
      name: row.name,
      baseUrl: row.baseUrl,
      authType: row.authType,
      username: row.username,
      // Never prefilled: the stored one is not readable, and an empty field is
      // what "leave it alone" means on the way back out.
      credential: '',
      environmentId: row.environmentId === null ? PORTAL_WIDE : String(row.environmentId),
      enabled: row.enabled,
      failureMode: row.failureMode,
    })
    setFormError(null)
    setEditTarget(row)
  }

  async function handleAdd(e: React.FormEvent) {
    e.preventDefault()
    setSaving(true)
    setFormError(null)
    try {
      const body: CreateIntegrationRequest = {
        kind: form.kind,
        name: form.name.trim(),
        baseUrl: form.baseUrl.trim(),
        authType: form.authType,
        environmentId: toEnvironmentId(form.environmentId),
        enabled: form.enabled,
        failureMode: form.failureMode as IntegrationFailureMode,
        ...(form.username ? { username: form.username.trim() } : {}),
        ...(form.credential ? { credential: form.credential.trim() } : {}),
      }
      await post('/api/admin/integrations', body)
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
      // `kind` is not sent: the API refuses to change it, and a Foreman that
      // became a Nexus would keep the credential and health of neither.
      const body: UpdateIntegrationRequest = {
        name: form.name.trim(),
        baseUrl: form.baseUrl.trim(),
        authType: form.authType,
        username: form.username.trim(),
        environmentId: toEnvironmentId(form.environmentId),
        enabled: form.enabled,
        failureMode: form.failureMode as IntegrationFailureMode,
        ...(form.credential ? { credential: form.credential.trim() } : {}),
      }
      await put(`/api/admin/integrations/${editTarget.id}`, body)
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
    setSaving(true)
    setListError(null)
    try {
      await del(`/api/admin/integrations/${deleteTarget.id}`)
      setDeleteTarget(null)
      void load()
    } catch (e) {
      setListError(e instanceof Error ? e.message : t('failedToDeleteGeneric', lang))
    } finally {
      setSaving(false)
    }
  }

  /*
   * Ask the system whether it is there, now.
   *
   * An unreachable integration answers 200 with `ok: false` — that is the
   * successful answer to the question the admin asked — so the catch below is
   * for a probe that could not be MADE (the row is gone, it is disabled, the
   * portal itself is down), which is a different sentence.
   */
  async function handleProbe(row: Integration) {
    setProbing(row.id)
    setListError(null)
    try {
      const result = await post<IntegrationProbeResult>(`/api/admin/integrations/${row.id}/probe`, {})
      if (!result) return
      setProbeResult((r) => ({ ...r, [row.id]: result }))
      setItems((rows) =>
        rows.map((r) =>
          r.id === row.id
            ? { ...r, lastContactedAt: result.lastContactedAt, lastError: result.lastError }
            : r,
        ),
      )
    } catch (e) {
      setListError(e instanceof Error ? e.message : t('probeFailed', lang))
    } finally {
      setProbing(null)
    }
  }

  const environmentLabel = (environmentId: number | null): string => {
    if (environmentId === null) return t('portalWide', lang)
    const match = environments.find((env) => env.id === environmentId)
    // The id rather than nothing: the environments list is allowed to fail on
    // its own, and a binding that renders as blank reads as "portal-wide".
    return match ? match.name : `#${environmentId}`
  }

  const environmentOptions = [
    { value: PORTAL_WIDE, label: t('portalWide', lang) },
    ...environments.map((env) => ({ value: String(env.id), label: env.name })),
  ]

  const failureModes: { value: IntegrationFailureMode | ''; label: string }[] = [
    { value: 'blocking', label: t('failureBlocking', lang) },
    { value: 'best_effort', label: t('failureBestEffort', lang) },
  ]

  const kindLabel = (kind: IntegrationKind) => KINDS.find((k) => k.value === kind)?.label ?? kind

  const fields = (mode: 'add' | 'edit') => (
    <>
      {mode === 'add' && (
        <Select
          label={t('integrationKind', lang)}
          value={form.kind}
          onChange={(e) => setField('kind', e.target.value as IntegrationKind)}
          options={KINDS}
        />
      )}
      <Input label={t('name', lang)} value={form.name} onChange={(e) => setField('name', e.target.value)} required />
      <Input label={t('url', lang)} type="url" value={form.baseUrl} onChange={(e) => setField('baseUrl', e.target.value)} required />
      <Select
        label={t('environment', lang)}
        value={form.environmentId}
        onChange={(e) => setField('environmentId', e.target.value)}
        options={environmentOptions}
      />
      <Select
        label={t('authentication', lang)}
        value={form.authType}
        onChange={(e) => setField('authType', e.target.value as IntegrationAuthType)}
        options={AUTH_TYPES}
      />
      {/* `basic` is the only mechanism that sends a username, and the API
          refuses a create without one. Hidden rather than disabled for the
          others: a field that cannot matter is noise on a form that already
          carries a credential. */}
      {form.authType === 'basic' && (
        <Input label={t('username', lang)} value={form.username} onChange={(e) => setField('username', e.target.value)} required />
      )}
      {form.authType !== 'none' && (
        <Input
          label={mode === 'add' ? t('credential', lang) : t('credentialKeepLabel', lang)}
          type="password"
          value={form.credential}
          onChange={(e) => setField('credential', e.target.value)}
          required={mode === 'add'}
        />
      )}
      <Select
        label={t('failureMode', lang)}
        value={form.failureMode}
        onChange={(e) => setField('failureMode', e.target.value as IntegrationFailureMode)}
        options={failureModes}
        placeholder={t('selectPlaceholder', lang)}
        required
      />
      <label className="flex items-start gap-2 text-sm text-slate-700">
        <input
          type="checkbox"
          className="mt-0.5"
          checked={form.enabled}
          onChange={(e) => setField('enabled', e.target.checked)}
        />
        <span>{t('enable', lang)}</span>
      </label>
    </>
  )

  return (
    <>
      <Card
        title={t('integrations', lang)}
        action={<Button size="sm" onClick={openAdd}>{t('addIntegration', lang)}</Button>}
      >
        {listError && !deleteTarget && <Alert className="mb-3">{listError}</Alert>}
        {loading ? (
          <div className="flex justify-center py-8">
            <div className="h-8 w-8 animate-spin rounded-full border-4 border-slate-200 border-t-blue-600" />
          </div>
        ) : items.length === 0 && !loadFailed ? (
          <p className="text-center py-6 text-slate-600">{t('noIntegrationsYet', lang)}</p>
        ) : (
          <div className="space-y-2">
            {items.map((row) => {
              const probe = probeResult[row.id]
              return (
                <div
                  key={row.id}
                  className="flex flex-wrap items-center justify-between gap-y-2 rounded-lg border border-slate-100 px-4 py-3"
                >
                  {/* `min-w-0` so this column may shrink below its content —
                      a base URL is long enough to keep a flex row from wrapping
                      at all otherwise. */}
                  <div className="min-w-0">
                    <div className="flex flex-wrap items-center gap-2 mb-0.5">
                      <p className="font-medium text-slate-900">{row.name}</p>
                      <span className="rounded-full bg-slate-100 px-2 py-0.5 text-xs font-medium text-slate-700">
                        {kindLabel(row.kind)}
                      </span>
                      {!row.enabled && (
                        <span className="rounded-full bg-amber-100 px-2 py-0.5 text-xs font-medium text-amber-800">
                          {t('disabledBadge', lang)}
                        </span>
                      )}
                      {row.failureMode === 'blocking' && (
                        <span className="rounded-full bg-red-100 px-2 py-0.5 text-xs font-medium text-red-800">
                          {t('failureBlocking', lang)}
                        </span>
                      )}
                    </div>
                    <p className="text-xs text-slate-600 font-mono break-words">{row.baseUrl}</p>
                    <p className="text-xs text-slate-600">
                      {environmentLabel(row.environmentId)}
                      {' · '}
                      {row.lastContactedAt
                        ? `${t('lastContacted', lang)}: ${new Date(row.lastContactedAt).toLocaleString(lang)}`
                        : t('neverContacted', lang)}
                    </p>
                    {/* The verdict of the probe just run, and otherwise the
                        stored reason the last one failed. Both are shown: a
                        `last_error` alongside a `last_contacted_at` is the
                        "worked at T, broken since" the column pair exists for. */}
                    {probe && (
                      <p className={`text-xs ${probe.ok ? 'text-green-700' : 'text-red-700'}`}>
                        {probe.ok
                          ? t('probeSucceeded', lang)
                          : `${t('probeFailed', lang)} ${probe.error ?? probe.detail ?? ''}`.trim()}
                      </p>
                    )}
                    {!probe && row.lastError && (
                      <p className="text-xs text-red-700">{row.lastError}</p>
                    )}
                  </div>
                  <div className="flex flex-wrap gap-2">
                    <Button
                      size="sm"
                      variant="secondary"
                      onClick={() => handleProbe(row)}
                      disabled={probing === row.id}
                    >
                      {probing === row.id ? t('testing', lang) : t('testConnection', lang)}
                    </Button>
                    <Button size="sm" variant="secondary" onClick={() => openEdit(row)}>
                      {t('edit', lang)}
                    </Button>
                    <Button
                      size="sm"
                      variant="danger"
                      onClick={() => {
                        setListError(null)
                        setDeleteTarget(row)
                      }}
                    >
                      {t('delete', lang)}
                    </Button>
                  </div>
                </div>
              )
            })}
          </div>
        )}
      </Card>

      <Modal open={addOpen} onClose={() => setAddOpen(false)} title={t('addIntegration', lang)} size="md">
        <form onSubmit={handleAdd} className="space-y-4">
          {formError && <Alert>{formError}</Alert>}
          {fields('add')}
          <div className="flex justify-end gap-3 pt-2">
            <Button type="button" variant="secondary" onClick={() => setAddOpen(false)}>
              {t('cancel', lang)}
            </Button>
            <Button type="submit" disabled={saving}>
              {saving ? t('saving', lang) : t('save', lang)}
            </Button>
          </div>
        </form>
      </Modal>

      <Modal open={!!editTarget} onClose={() => setEditTarget(null)} title={t('editIntegration', lang)} size="md">
        <form onSubmit={handleEdit} className="space-y-4">
          {formError && <Alert>{formError}</Alert>}
          {fields('edit')}
          <div className="flex justify-end gap-3 pt-2">
            <Button type="button" variant="secondary" onClick={() => setEditTarget(null)}>
              {t('cancel', lang)}
            </Button>
            <Button type="submit" disabled={saving}>
              {saving ? t('saving', lang) : t('save', lang)}
            </Button>
          </div>
        </form>
      </Modal>

      <Modal
        open={!!deleteTarget}
        onClose={() => setDeleteTarget(null)}
        title={t('deleteIntegrationTitle', lang)}
        size="sm"
      >
        {listError && <Alert className="mb-4">{listError}</Alert>}
        <p className="text-sm text-slate-600 mb-6">
          {t('delete', lang)} <strong>{deleteTarget?.name}</strong>?
        </p>
        <div className="flex justify-end gap-3">
          <Button variant="secondary" onClick={() => setDeleteTarget(null)}>
            {t('cancel', lang)}
          </Button>
          <Button variant="danger" onClick={handleDelete} disabled={saving}>
            {saving ? t('deleting', lang) : t('delete', lang)}
          </Button>
        </div>
      </Modal>
    </>
  )
}
