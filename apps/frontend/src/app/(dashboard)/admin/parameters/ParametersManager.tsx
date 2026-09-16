'use client'

import {useState, useCallback } from 'react'
import type {
  Parameter,
  ParameterType,
  CreateParameterRequest,
  UpdateParameterRequest,
  DeploymentEnvironment,
  Project,
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
import { sizeValuesToText, parseSizeValues } from '@/lib/sizeValues'
import { parameterTypeLabel, parameterTypeOptions } from '@/lib/parameterTypes'

const emptyForm = () => ({
  name: '', label: '', type: 'string' as ParameterType, description: '',
  defaultValue: '', required: false, sensitive: false, sizeValues: '',
  // '' is "all environments", which is what a global parameter has always been
  // and stays the default. The column and the resolution behind it have existed
  // all along; this form was the only reason they were unreachable (#275).
  environmentId: '' as string,
  // Empty is "every project", which is what every parameter is until somebody
  // narrows it, and what an existing one already is (#275).
  projectIds: [] as number[],
})

interface Props {
  /**
   * The global parameters the SERVER already fetched (#460), with the scope
   * filter already applied — it used to happen in the browser, after asking for
   * every parameter in the installation.
   */
  initial: Parameter[]
  /** The two lists the form chooses from. Absent ones cost the dropdowns only. */
  initialEnvironments?: DeploymentEnvironment[]
  initialProjects?: Project[]
  /** Why the server could not fetch the parameters, if it could not (#415). */
  initialError?: string | null
}

export function ParametersManager({
  initial,
  initialEnvironments = [],
  initialProjects = [],
  initialError = null,
}: Props) {
  const lang = useLang()
  const TYPES = parameterTypeOptions(lang)
  const [params, setParams] = useState<Parameter[]>(initial)
  const [environments, setEnvironments] = useState<DeploymentEnvironment[]>(initialEnvironments)
  const [projects, setProjects] = useState<Project[]>(initialProjects)
  // The server already has them, so nothing is pending on arrival.
  const [loading, setLoading] = useState(false)
  const [addOpen, setAddOpen] = useState(false)
  const [editTarget, setEditTarget] = useState<Parameter | null>(null)
  const [deleteTarget, setDeleteTarget] = useState<Parameter | null>(null)
  const [form, setForm] = useState(emptyForm())
  const [saving, setSaving] = useState(false)
  const [formError, setFormError] = useState<string | null>(null)
  const [deleteError, setDeleteError] = useState<string | null>(initialError)
  /*
   * Whether the LAST load failed (#415, #460). Without it an outage rendered the
   * error and "no global parameters yet" together, and the false one is what an
   * operator acts on — by defining a parameter that already exists.
   */
  const [loadFailed, setLoadFailed] = useState(initialError !== null)

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const [all, envs, projectList] = await Promise.all([
        get<Parameter[]>('/api/admin/parameters'),
        // Degrades to "all environments only" rather than breaking the screen:
        // without the list there is nothing to choose from, but every existing
        // parameter still edits and saves.
        get<DeploymentEnvironment[]>('/api/admin/environments').catch(() => [] as DeploymentEnvironment[]),
        // Same degradation as the environments above: without the list there is
        // nothing to narrow to, but every existing parameter still edits.
        get<Project[]>('/api/projects').catch(() => [] as Project[]),
      ] as const)
      setParams((all ?? []).filter((p) => p.scope === 'global'))
      setEnvironments(envs ?? [])
      setProjects(projectList ?? [])
      setDeleteError(null)
      setLoadFailed(false)
    } catch (e) {
      setLoadFailed(true)
      setDeleteError(e instanceof Error ? e.message : t('failedToLoadParameters', lang))
    } finally {
      setLoading(false)
    }
  }, [lang])

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
      sizeValues: sizeValuesToText(param.sizeValues),
      environmentId: param.environmentId === null ? '' : String(param.environmentId),
      projectIds: param.projectIds ?? [],
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
        sizeValues: form.type === 'size' ? parseSizeValues(form.sizeValues) : {},
        ...(form.environmentId !== '' ? { environmentId: Number(form.environmentId) } : {}),
        ...(form.projectIds.length > 0 ? { projectIds: form.projectIds } : {}),
      }
      await post('/api/admin/parameters', body)
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
        sizeValues: form.type === 'size' ? parseSizeValues(form.sizeValues) : {},
        // Sent explicitly as null when cleared, not omitted: omitting it would
        // leave a parameter pinned to an environment with no way back to "all".
        environmentId: form.environmentId === '' ? null : Number(form.environmentId),
        // Always sent, including as []: omitting it means "leave the narrowing
        // alone", so a parameter cleared back to every project would silently
        // stay narrowed.
        projectIds: form.projectIds,
      }
      await put(`/api/admin/parameters/${editTarget.id}`, body)
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
      await del(`/api/admin/parameters/${deleteTarget.id}`)
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
        ) : params.length === 0 && !loadFailed ? (
          <p className="text-center py-6 text-slate-600">{t('noGlobalParametersYet', lang)}</p>
        ) : (
          <div className="space-y-2">
            {params.map((p) => (
              <div key={p.id} className="flex items-center justify-between rounded-lg border border-slate-100 px-4 py-3">
                <div>
                  <div className="flex items-center gap-2 mb-0.5">
                    <p className="font-medium text-slate-900">{p.label || p.name}</p>
                    <span className="rounded-full bg-slate-100 px-2 py-0.5 text-xs text-slate-600">{parameterTypeLabel(p.type, lang)}</span>
                    {/* red-700, not red-600: this 12px badge sits on red-100 (#ffe2e2), where
                        red-600 (#e7000b) measures 3.91:1 — below the 4.5:1 AA needs for text
                        this size. red-700 (#c10007) on the same ground is 5.27:1. */}
                    {p.required && <span className="rounded-full bg-red-100 px-2 py-0.5 text-xs text-red-700">{t('requiredBadge', lang)}</span>}
                    {p.sensitive && <span className="rounded-full bg-yellow-100 px-2 py-0.5 text-xs text-yellow-700">{t('sensitiveBadge', lang)}</span>}
                    {/* Only when it is narrowed. A badge on every row saying "all
                        environments" would be noise on the common case and would
                        stop the narrowed ones standing out, which is the whole
                        reason to show it (#275). The id is the fallback for an
                        environment that has since been deleted — better than a
                        blank where a name should be. */}
                    {/* Only on a narrowed row, for the same reason as the
                        environment badge beside it (#275). */}
                    {(p.projectIds ?? []).length > 0 && (
                      <span className="rounded-full bg-violet-100 px-2 py-0.5 text-xs text-violet-800">
                        {(p.projectIds ?? [])
                          .map((id) => projects.find((project) => project.id === id)?.name ?? `#${id}`)
                          .join(', ')}
                      </span>
                    )}
                    {p.environmentId !== null && (
                      <span className="rounded-full bg-blue-100 px-2 py-0.5 text-xs text-blue-800">
                        {environments.find((env) => env.id === p.environmentId)?.name
                          ?? `${t('environment', lang)} #${p.environmentId}`}
                      </span>
                    )}
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
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <Input label={t('variableName', lang)} value={form.name} onChange={(e) => setField('name', e.target.value)} required hint={t('variableNameHint', lang)} />
            <Input label={t('displayLabel', lang)} value={form.label} onChange={(e) => setField('label', e.target.value)} hint={t('displayLabelHint', lang)} />
          </div>
          <Select label={t('type', lang)} value={form.type} onChange={(e) => setField('type', e.target.value as ParameterType)} options={TYPES} />
          {/* Where this parameter applies. `parameters.environment_id` and the
              resolution behind it — an environment-specific row preferred over an
              all-environments one — have been implemented and correct all along;
              no form ever offered the field, so the capability was unreachable
              (#275). "All environments" is first and is what an existing global
              parameter already is. */}
          {/* Checkboxes, not a multi-select. "One or several projects" is a set,
              and a <select multiple> hides the unselected options behind a
              scroll and needs ctrl-click to build a set at all — the kind of
              control people get wrong without noticing (#275). Rendered only
              when there are projects to narrow to. */}
          {projects.length > 0 && (
            <fieldset className="rounded-lg border border-slate-200 p-3">
              <legend className="px-1 text-sm font-medium text-slate-700">{t('projects', lang)}</legend>
              <p className="mb-2 text-xs text-slate-500">{t('parameterProjectsHint', lang)}</p>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-1">
                {projects.map((project) => (
                  <label key={project.id} className="flex min-h-11 items-center gap-2 text-sm text-slate-700">
                    <input
                      type="checkbox"
                      className="h-4 w-4"
                      checked={form.projectIds.includes(project.id)}
                      onChange={(e) =>
                        setField(
                          'projectIds',
                          e.target.checked
                            ? [...form.projectIds, project.id]
                            : form.projectIds.filter((id) => id !== project.id),
                        )
                      }
                    />
                    {project.name}
                  </label>
                ))}
              </div>
            </fieldset>
          )}
          <Select
            label={t('environment', lang)}
            value={form.environmentId}
            onChange={(e) => setField('environmentId', e.target.value)}
            options={[
              { value: '', label: t('allEnvironments', lang) },
              ...environments.map((env) => ({ value: String(env.id), label: env.name })),
            ]}
          />
          <Input label={t('description', lang)} value={form.description} onChange={(e) => setField('description', e.target.value)} />
          <Input label={t('defaultValue', lang)} value={form.defaultValue} onChange={(e) => setField('defaultValue', e.target.value)}
            hint={form.type === 'dropdown' ? t('commaSeparatedOptions', lang) : undefined} />
          {/* A `size` variable is not typed in by the customer: the size they
              pick decides it. One size can drive several variables, so the map
              lives on the variable. */}
          {form.type === 'size' && (
            <div className="flex flex-col gap-1">
              <label htmlFor={`add-size-values`} className="text-sm font-medium text-slate-700">
                {t('valuePerSize', lang)}
              </label>
              <p className="text-xs text-slate-500">{t('valuePerSizeHint', lang)}</p>
              <textarea
                id={`add-size-values`}
                rows={4}
                value={form.sizeValues}
                onChange={(e) => setField('sizeValues', e.target.value)}
                placeholder={'S=t3.micro\nM=t3.large\nXL=m6i.2xlarge'}
                className="rounded-lg border border-slate-300 px-3 py-2 font-mono text-sm text-slate-900 focus:outline-none focus:ring-2 focus:ring-blue-500"
              />
            </div>
          )}
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
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <Input label={t('variableName', lang)} value={form.name} onChange={(e) => setField('name', e.target.value)} required hint={t('variableNameHint', lang)} />
            <Input label={t('displayLabel', lang)} value={form.label} onChange={(e) => setField('label', e.target.value)} hint={t('displayLabelHint', lang)} />
          </div>
          <Select label={t('type', lang)} value={form.type} onChange={(e) => setField('type', e.target.value as ParameterType)} options={TYPES} />
          {/* Where this parameter applies. `parameters.environment_id` and the
              resolution behind it — an environment-specific row preferred over an
              all-environments one — have been implemented and correct all along;
              no form ever offered the field, so the capability was unreachable
              (#275). "All environments" is first and is what an existing global
              parameter already is. */}
          {/* Checkboxes, not a multi-select. "One or several projects" is a set,
              and a <select multiple> hides the unselected options behind a
              scroll and needs ctrl-click to build a set at all — the kind of
              control people get wrong without noticing (#275). Rendered only
              when there are projects to narrow to. */}
          {projects.length > 0 && (
            <fieldset className="rounded-lg border border-slate-200 p-3">
              <legend className="px-1 text-sm font-medium text-slate-700">{t('projects', lang)}</legend>
              <p className="mb-2 text-xs text-slate-500">{t('parameterProjectsHint', lang)}</p>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-1">
                {projects.map((project) => (
                  <label key={project.id} className="flex min-h-11 items-center gap-2 text-sm text-slate-700">
                    <input
                      type="checkbox"
                      className="h-4 w-4"
                      checked={form.projectIds.includes(project.id)}
                      onChange={(e) =>
                        setField(
                          'projectIds',
                          e.target.checked
                            ? [...form.projectIds, project.id]
                            : form.projectIds.filter((id) => id !== project.id),
                        )
                      }
                    />
                    {project.name}
                  </label>
                ))}
              </div>
            </fieldset>
          )}
          <Select
            label={t('environment', lang)}
            value={form.environmentId}
            onChange={(e) => setField('environmentId', e.target.value)}
            options={[
              { value: '', label: t('allEnvironments', lang) },
              ...environments.map((env) => ({ value: String(env.id), label: env.name })),
            ]}
          />
          <Input label={t('description', lang)} value={form.description} onChange={(e) => setField('description', e.target.value)} />
          <Input label={t('defaultValue', lang)} value={form.defaultValue} onChange={(e) => setField('defaultValue', e.target.value)}
            hint={form.type === 'dropdown' ? t('commaSeparatedOptions', lang) : undefined} />
          {/* A `size` variable is not typed in by the customer: the size they
              pick decides it. One size can drive several variables, so the map
              lives on the variable. */}
          {form.type === 'size' && (
            <div className="flex flex-col gap-1">
              <label htmlFor={`edit-size-values`} className="text-sm font-medium text-slate-700">
                {t('valuePerSize', lang)}
              </label>
              <p className="text-xs text-slate-500">{t('valuePerSizeHint', lang)}</p>
              <textarea
                id={`edit-size-values`}
                rows={4}
                value={form.sizeValues}
                onChange={(e) => setField('sizeValues', e.target.value)}
                placeholder={'S=t3.micro\nM=t3.large\nXL=m6i.2xlarge'}
                className="rounded-lg border border-slate-300 px-3 py-2 font-mono text-sm text-slate-900 focus:outline-none focus:ring-2 focus:ring-blue-500"
              />
            </div>
          )}
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
