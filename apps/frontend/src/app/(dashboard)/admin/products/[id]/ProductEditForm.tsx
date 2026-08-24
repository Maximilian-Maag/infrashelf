'use client'

import { useState, useEffect, useCallback } from 'react'
import { useRouter } from 'next/navigation'
import type {
  ProductDetail,
  Category,
  DeploymentEnvironment,
  ProductTranslation,
  UpdateProductRequest,
  UpsertProductEnvironmentRequest,
  CostCenterMode,
  ProductWebhook,
  CreateProductWebhookRequest,
  PipelineStack,
  CreatePipelineStackRequest,
  UpdatePipelineStackRequest,
  StackStep,
  Parameter,
  ParameterType,
  CreateParameterRequest,
  UpdateParameterRequest,
  CostCenter,
  OfferingSize,
} from '@open-hybrid-cloud/types'
import { put, post, del, get } from '@/lib/api'
import { generatePipelineYaml } from '@/lib/pipelineStackPreview'
import { Card } from '@/components/ui/Card'
import { Alert } from '@/components/ui/Alert'
import { Input } from '@/components/ui/Input'
import { Select } from '@/components/ui/Select'
import { Button } from '@/components/ui/Button'
import { Modal } from '@/components/ui/Modal'
import { ProductVersionHistory } from './ProductVersionHistory'
import { t, LANGUAGE_OPTIONS } from '@/lib/i18n'

const COST_CENTER_MODES: { value: CostCenterMode; label: string }[] = [
  { value: 'project', label: 'From Project' },
  { value: 'select', label: 'User Selection' },
  { value: 'overhead', label: 'Overhead' },
]

interface Props {
  product: ProductDetail
  categories: Category[]
  environments: DeploymentEnvironment[]
  translations: ProductTranslation[]
  costCenters: CostCenter[]
  token: string
  /** The rest of this form is English-only admin chrome; only the new strings are translated. */
  lang?: string
}

export function ProductEditForm({ product, categories, environments, translations: initTranslations, costCenters, token, lang = 'en' }: Props) {
  const router = useRouter()

  // Basic info
  const [name, setName] = useState(product.name)
  const [description, setDescription] = useState(product.description)
  const [categoryId, setCategoryId] = useState(String(product.categoryId))
  const [baseLanguage, setBaseLanguage] = useState(product.baseLanguage)
  const [changelog, setChangelog] = useState('')
  const [saving, setSaving] = useState(false)
  // Bumped after a save so the history panel refetches and shows the entry the
  // save just created.
  const [historyKey, setHistoryKey] = useState(0)
  const [error, setError] = useState<string | null>(null)
  const [success, setSuccess] = useState(false)

  // Translations
  const [translations, setTranslations] = useState<ProductTranslation[]>(initTranslations)
  const [translationLang, setTranslationLang] = useState('de')
  const [translationName, setTranslationName] = useState('')
  const [translationDesc, setTranslationDesc] = useState('')
  const [transModal, setTransModal] = useState(false)
  const [transSaving, setTransSaving] = useState(false)
  const [transError, setTransError] = useState<string | null>(null)
  const [translating, setTranslating] = useState(false)
  const [aiError, setAiError] = useState<string | null>(null)

  // Webhooks
  const [webhooks, setWebhooks] = useState<ProductWebhook[]>([])
  const [webhookModal, setWebhookModal] = useState(false)
  const [whDeleteError, setWhDeleteError] = useState<string | null>(null)

  // Pipeline Stacks
  const [stacks, setStacks] = useState<PipelineStack[]>([])
  const [stackModal, setStackModal] = useState(false)
  const [stackDeleteError, setStackDeleteError] = useState<string | null>(null)
  const [editStack, setEditStack] = useState<PipelineStack | null>(null)
  const [psName, setPsName] = useState('')
  const [psEnvId, setPsEnvId] = useState('')
  const [psStateKey, setPsStateKey] = useState('hostname')
  type StepForm = {
    template: string
    stateSuffix: string
    execOrder: string
    upstreamRefs: { varName: string; suffix: string }[]
    fixedParams: string
  }
  const [psSteps, setPsSteps] = useState<StepForm[]>([])
  const [psSaving, setPsSaving] = useState(false)
  const [psError, setPsError] = useState<string | null>(null)
  const [previewOpen, setPreviewOpen] = useState(false)
  const [whEnvId, setWhEnvId] = useState('')
  const [whName, setWhName] = useState('')
  const [whUrl, setWhUrl] = useState('')
  const [whToken, setWhToken] = useState('')
  const [whOrder, setWhOrder] = useState('0')
  const [whSaving, setWhSaving] = useState(false)
  const [whError, setWhError] = useState<string | null>(null)

  // Parameters
  const [productParams, setProductParams] = useState<Parameter[]>(product.parameters ?? [])
  const [paramModal, setParamModal] = useState(false)
  const [paramSyncing, setParamSyncing] = useState(false)
  const [paramSyncMsg, setParamSyncMsg] = useState<string | null>(null)
  const [paramError, setParamError] = useState<string | null>(null)
  const [paramSaving, setParamSaving] = useState(false)
  const [editParam, setEditParam] = useState<Parameter | null>(null)
  const [paramForm, setParamForm] = useState({
    name: '', label: '', type: 'string' as ParameterType, description: '', defaultValue: '', required: false, sensitive: false,
  })

  async function handleSaveBasic(e: React.FormEvent) {
    e.preventDefault()
    setSaving(true)
    setError(null)
    setSuccess(false)
    try {
      const body: UpdateProductRequest = {
        name: name.trim(),
        description: description.trim(),
        categoryId: Number(categoryId),
        baseLanguage,
        // Optional, and cleared after saving: a changelog note describes one
        // change, so carrying it into the next save would misattribute it.
        ...(changelog.trim() ? { changelog: changelog.trim() } : {}),
      }
      await put(`/api/admin/products/${product.id}`, body, token)
      setChangelog('')
      setHistoryKey((k) => k + 1)
      setSuccess(true)
      router.refresh()
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to save.')
    } finally {
      setSaving(false)
    }
  }

  async function handleSaveEnv(envId: number, data: UpsertProductEnvironmentRequest) {
    // Let failures propagate so the row can show an error instead of a false
    // "Saved!" confirmation.
    await put(`/api/admin/products/${product.id}/environments/${envId}`, data, token)
  }

  async function handleDeleteEnv(envId: number) {
    // Propagates so the row surfaces the reason — most often the 409 the backend
    // returns while infrastructure is still deployed in this environment.
    await del(`/api/admin/products/${product.id}/environments/${envId}`, token)
    router.refresh()
  }

  async function handleAddTranslation(e: React.FormEvent) {
    e.preventDefault()
    setTransSaving(true)
    setTransError(null)
    try {
      await put(`/api/admin/products/${product.id}/translations/${translationLang}`, {
        name: translationName.trim(),
        description: translationDesc.trim(),
      }, token)
      const updated = await post<ProductTranslation[]>(`/api/admin/products/${product.id}/translations`, {}, token)
        .catch(() => null)
      if (updated) setTranslations(updated)
      else {
        const t: ProductTranslation = {
          productId: product.id,
          languageCode: translationLang,
          name: translationName.trim(),
          description: translationDesc.trim(),
        }
        setTranslations((prev) => {
          const idx = prev.findIndex((x) => x.languageCode === translationLang)
          if (idx >= 0) { const next = [...prev]; next[idx] = t; return next }
          return [...prev, t]
        })
      }
      setTransModal(false)
    } catch (e) {
      setTransError(e instanceof Error ? e.message : 'Failed to save translation.')
    } finally {
      setTransSaving(false)
    }
  }

  async function handleAiTranslate() {
    setTranslating(true)
    setAiError(null)
    try {
      await post(`/api/admin/products/${product.id}/translate`, {}, token)
      router.refresh()
    } catch (e) {
      setAiError(e instanceof Error ? e.message : 'AI translation failed.')
    } finally {
      setTranslating(false)
    }
  }

  async function handleAddWebhook(e: React.FormEvent) {
    e.preventDefault()
    setWhSaving(true)
    setWhError(null)
    try {
      const body: CreateProductWebhookRequest = {
        environmentId: Number(whEnvId),
        name: whName.trim(),
        webhookUrl: whUrl.trim(),
        webhookToken: whToken.trim(),
        execOrder: Number(whOrder),
      }
      const created = await post<ProductWebhook>(`/api/admin/products/${product.id}/webhooks`, body, token)
      setWebhooks((prev) => [...prev, created])
      setWebhookModal(false)
      setWhName(''); setWhUrl(''); setWhToken(''); setWhOrder('0')
    } catch (e) {
      setWhError(e instanceof Error ? e.message : 'Failed to create webhook.')
    } finally {
      setWhSaving(false)
    }
  }

  async function handleDeleteWebhook(whId: number) {
    setWhDeleteError(null)
    try {
      await del(`/api/admin/products/${product.id}/webhooks/${whId}`, token)
      setWebhooks((prev) => prev.filter((w) => w.id !== whId))
    } catch (e) {
      setWhDeleteError(e instanceof Error ? e.message : 'Failed to delete webhook.')
    }
  }

  useEffect(() => {
    get<PipelineStack[]>(`/api/admin/products/${product.id}/pipeline-stacks`, token)
      .then(setStacks)
      .catch(() => {})
  }, [product.id, token])

  // Order Callbacks, same shape as the pipeline stacks fetch above. Without
  // this, `webhooks` was only ever written by add/delete — reloading the page
  // made every existing callback invisible and its Delete button unreachable
  // (#145).
  useEffect(() => {
    get<ProductWebhook[]>(`/api/admin/products/${product.id}/webhooks`, token)
      .then(setWebhooks)
      .catch(() => {})
  }, [product.id, token])

  function openStackModal() {
    setPsError(null)
    setEditStack(null)
    setPsName(''); setPsEnvId(''); setPsStateKey('hostname'); setPsSteps([])
    setStackModal(true)
  }

  function openEditStackModal(stack: PipelineStack) {
    setPsError(null)
    setEditStack(stack)
    setPsName(stack.name)
    setPsEnvId(String(stack.environmentId))
    setPsStateKey(stack.stateKeyParam)
    setPsSteps(stack.steps.map((s) => ({
      template: s.template,
      stateSuffix: s.stateSuffix,
      execOrder: String(s.execOrder ?? 0),
      upstreamRefs: (s.upstreamRefs ?? []).map((r) => ({ varName: r.varName, suffix: r.suffix })),
      fixedParams: s.fixedParams ? Object.entries(s.fixedParams).map(([k, v]) => `${k}=${v}`).join('\n') : '',
    })))
    setStackModal(true)
  }

  function addStep() {
    setPsSteps((prev) => [
      ...prev,
      { template: '', stateSuffix: '', execOrder: String(prev.length), upstreamRefs: [], fixedParams: '' },
    ])
  }

  function removeStep(i: number) {
    setPsSteps((prev) => prev.filter((_, idx) => idx !== i))
  }

  function updateStep(i: number, field: keyof StepForm, value: string) {
    setPsSteps((prev) => prev.map((s, idx) => idx === i ? { ...s, [field]: value } : s))
  }

  function addUpstreamRef(stepIdx: number) {
    setPsSteps((prev) => prev.map((s, idx) => idx === stepIdx
      ? { ...s, upstreamRefs: [...s.upstreamRefs, { varName: '', suffix: '' }] }
      : s))
  }

  function removeUpstreamRef(stepIdx: number, refIdx: number) {
    setPsSteps((prev) => prev.map((s, idx) => idx === stepIdx
      ? { ...s, upstreamRefs: s.upstreamRefs.filter((_, ri) => ri !== refIdx) }
      : s))
  }

  function updateUpstreamRef(stepIdx: number, refIdx: number, field: 'varName' | 'suffix', value: string) {
    setPsSteps((prev) => prev.map((s, idx) => idx === stepIdx
      ? { ...s, upstreamRefs: s.upstreamRefs.map((r, ri) => ri === refIdx ? { ...r, [field]: value } : r) }
      : s))
  }

  function parseFixedParams(raw: string): Record<string, string> | undefined {
    if (!raw.trim()) return undefined
    const result: Record<string, string> = {}
    for (const line of raw.split('\n')) {
      const eq = line.indexOf('=')
      if (eq > 0) result[line.slice(0, eq).trim()] = line.slice(eq + 1).trim()
    }
    return Object.keys(result).length ? result : undefined
  }

  async function handleSaveStack(e: React.FormEvent) {
    e.preventDefault()
    setPsSaving(true)
    setPsError(null)
    try {
      const steps: StackStep[] = psSteps.map((s) => {
        const fixedParams = parseFixedParams(s.fixedParams)
        const upstreamRefs = s.upstreamRefs
          .map((r) => ({ varName: r.varName.trim(), suffix: r.suffix.trim() }))
          .filter((r) => r.varName && r.suffix)
        return {
          template: s.template.trim(),
          stateSuffix: s.stateSuffix.trim(),
          execOrder: Number(s.execOrder) || 0,
          ...(upstreamRefs.length ? { upstreamRefs } : {}),
          ...(fixedParams ? { fixedParams } : {}),
        }
      })
      if (editStack) {
        const body: UpdatePipelineStackRequest = {
          name: psName.trim(),
          stateKeyParam: psStateKey.trim() || 'hostname',
          steps,
        }
        const updated = await put<PipelineStack>(`/api/admin/products/${product.id}/pipeline-stacks/${editStack.id}`, body, token)
        setStacks((prev) => prev.map((s) => s.id === editStack.id ? updated : s))
      } else {
        const body: CreatePipelineStackRequest = {
          environmentId: Number(psEnvId),
          name: psName.trim(),
          stateKeyParam: psStateKey.trim() || 'hostname',
          steps,
        }
        const created = await post<PipelineStack>(`/api/admin/products/${product.id}/pipeline-stacks`, body, token)
        setStacks((prev) => [...prev, created])
      }
      setStackModal(false)
    } catch (e) {
      setPsError(e instanceof Error ? e.message : 'Failed to save pipeline stack.')
    } finally {
      setPsSaving(false)
    }
  }

  async function handleDeleteStack(stackId: number) {
    setStackDeleteError(null)
    try {
      await del(`/api/admin/products/${product.id}/pipeline-stacks/${stackId}`, token)
      setStacks((prev) => prev.filter((s) => s.id !== stackId))
    } catch (e) {
      setStackDeleteError(e instanceof Error ? e.message : 'Failed to delete pipeline stack.')
    }
  }

  async function handleSyncParams() {
    setParamSyncing(true)
    setParamSyncMsg(null)
    setParamError(null)
    try {
      const result = await post<{ created: number; skipped: number }>(
        `/api/admin/products/${product.id}/sync-parameters`, {}, token,
      )
      const refreshed = await get<Parameter[]>(
        `/api/admin/parameters?scope=product&scopeId=${product.id}`, token,
      )
      if (refreshed) setProductParams(refreshed)
      setParamSyncMsg(
        `Imported ${result.created} parameter${result.created !== 1 ? 's' : ''}` +
        (result.skipped ? `, ${result.skipped} already existed.` : '.'),
      )
    } catch (e) {
      setParamError(e instanceof Error ? e.message : 'Sync failed.')
    } finally {
      setParamSyncing(false)
    }
  }

  function openAddParamModal() {
    setEditParam(null)
    setParamError(null)
    setParamSyncMsg(null)
    setParamForm({ name: '', label: '', type: 'string', description: '', defaultValue: '', required: false, sensitive: false })
    setParamModal(true)
  }

  function openEditParamModal(p: Parameter) {
    setEditParam(p)
    setParamError(null)
    setParamSyncMsg(null)
    setParamForm({ name: p.name, label: p.label, type: p.type, description: p.description, defaultValue: p.defaultValue, required: p.required, sensitive: p.sensitive })
    setParamModal(true)
  }

  async function handleSaveParam(e: React.FormEvent) {
    e.preventDefault()
    setParamSaving(true)
    setParamError(null)
    try {
      if (editParam) {
        const body: UpdateParameterRequest = {
          name: paramForm.name.trim(),
          label: paramForm.label.trim(),
          type: paramForm.type,
          description: paramForm.description.trim() || undefined,
          defaultValue: paramForm.defaultValue.trim() || undefined,
          required: paramForm.required,
          sensitive: paramForm.sensitive,
        }
        const updated = await put<Parameter>(`/api/admin/parameters/${editParam.id}`, body, token)
        setProductParams((prev) => prev.map((p) => p.id === editParam.id ? updated : p))
      } else {
        const body: CreateParameterRequest = {
          scope: 'product',
          scopeId: product.id,
          name: paramForm.name.trim(),
          label: paramForm.label.trim(),
          type: paramForm.type,
          description: paramForm.description.trim() || undefined,
          defaultValue: paramForm.defaultValue.trim() || undefined,
          required: paramForm.required,
          sensitive: paramForm.sensitive,
        }
        const created = await post<Parameter>('/api/admin/parameters', body, token)
        setProductParams((prev) => [...prev, created])
      }
      setParamModal(false)
    } catch (e) {
      setParamError(e instanceof Error ? e.message : 'Failed to save parameter.')
    } finally {
      setParamSaving(false)
    }
  }

  async function handleDeleteParam(paramId: number) {
    setParamError(null)
    setParamSyncMsg(null)
    try {
      await del(`/api/admin/parameters/${paramId}`, token)
      setProductParams((prev) => prev.filter((p) => p.id !== paramId))
    } catch (e) {
      setParamError(e instanceof Error ? e.message : 'Failed to delete parameter.')
    }
  }

  return (
    <div className="space-y-6">
      {/* Basic Info */}
      <Card title="Basic Information">
        <form onSubmit={handleSaveBasic} className="space-y-4">
          {error && <Alert>{error}</Alert>}
          {success && <Alert tone="success">Saved.</Alert>}
          <div className="grid grid-cols-2 gap-4">
            <Select label="Category" value={categoryId} onChange={(e) => setCategoryId(e.target.value)} required
              options={categories.map((c) => ({ value: c.id, label: c.name }))} />
            <Select label="Base Language" value={baseLanguage} onChange={(e) => setBaseLanguage(e.target.value)}
              options={LANGUAGE_OPTIONS} />
          </div>
          <Input label="Name" value={name} onChange={(e) => setName(e.target.value)} required />
          <div className="flex flex-col gap-1">
            <label htmlFor="product-description" className="text-sm font-medium text-slate-700">Description</label>
            <textarea id="product-description" value={description} onChange={(e) => setDescription(e.target.value)} rows={4}
              className="rounded-lg border border-slate-300 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500" />
          </div>
          {/* Optional, per the issue. Cleared after saving, since a note describes
              one change and carrying it forward would misattribute it. */}
          <div className="flex flex-col gap-1">
            <label htmlFor="product-changelog" className="text-sm font-medium text-slate-700">
              {t('changelog', lang)}
            </label>
            <textarea
              id="product-changelog"
              value={changelog}
              onChange={(e) => setChangelog(e.target.value)}
              rows={2}
              maxLength={2000}
              placeholder={t('changelogHint', lang)}
              className="rounded-lg border border-slate-300 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500" />
            <p className="text-xs text-slate-500">{t('changelogHint', lang)}</p>
          </div>
          <div className="flex justify-end">
            <Button type="submit" disabled={saving}>{saving ? 'Saving…' : 'Save'}</Button>
          </div>
        </form>
      </Card>

      {/* Version history (issue #38) */}
      <Card title={t('versionHistory', lang)}>
        <ProductVersionHistory key={historyKey} productId={product.id} token={token} lang={lang} />
      </Card>

      {/* Translations */}
      <Card title="Translations" action={
        <div className="flex gap-2">
          <Button size="sm" variant="secondary" onClick={handleAiTranslate} disabled={translating}>
            {translating ? 'Translating…' : 'AI Translate'}
          </Button>
          <Button size="sm" onClick={() => { setTranslationName(''); setTranslationDesc(''); setTransError(null); setTransModal(true) }}>
            Add Translation
          </Button>
        </div>
      }>
        {aiError && (
          <Alert className="mb-3">
            {aiError}
          </Alert>
        )}
        {translations.length === 0 ? (
          <p className="text-sm text-slate-600">No translations yet.</p>
        ) : (
          <div className="space-y-2">
            {translations.map((t) => (
              <div key={t.languageCode} className="rounded-lg border border-slate-100 p-3">
                <span className="text-xs font-mono text-slate-600 uppercase">{t.languageCode}</span>
                <p className="font-medium text-slate-900">{t.name}</p>
                <p className="text-sm text-slate-500 line-clamp-2">{t.description}</p>
              </div>
            ))}
          </div>
        )}
      </Card>

      {/* Environments */}
      <Card title="Environments">
        {environments.length === 0 ? (
          <p className="text-sm text-slate-600">No environments configured.</p>
        ) : (
          <div className="space-y-4">
            {environments.map((env) => {
              const existing = product.environments.find((e) => e.environmentId === env.id)
              return (
                <EnvironmentRow
                  key={env.id}
                  env={env}
                  existing={existing}
                  costCenters={costCenters}
                  productId={product.id}
                  token={token}
                  onSave={(data) => handleSaveEnv(env.id, data)}
                  onDelete={() => handleDeleteEnv(env.id)}
                />
              )
            })}
          </div>
        )}
      </Card>

      {/* Parameters */}
      <Card title="Parameters" action={
        <div className="flex gap-2">
          <Button size="sm" variant="secondary" onClick={handleSyncParams}
            disabled={paramSyncing || stacks.length === 0}
            title={stacks.length === 0 ? 'Add a pipeline stack first' : 'Import from template variables.tf'}>
            {paramSyncing ? 'Syncing…' : 'Sync from template'}
          </Button>
          <Button size="sm" onClick={openAddParamModal}>Add Parameter</Button>
        </div>
      }>
        {paramSyncMsg && <Alert tone="success" className="mb-3">{paramSyncMsg}</Alert>}
        {/* Only when the modal is closed: the modal renders paramError itself,
            and two role="alert" regions with the same text are announced twice. */}
        {paramError && !paramModal && <Alert className="mb-3">{paramError}</Alert>}
        {productParams.length === 0 ? (
          <p className="text-sm text-slate-600">No parameters yet. Use &quot;Sync from template&quot; to import from the template&apos;s variables.tf, or add manually.</p>
        ) : (
          <div className="space-y-2">
            {productParams.map((p) => (
              <div key={p.id} className="flex items-center justify-between rounded-lg border border-slate-100 px-4 py-3">
                <div>
                  <div className="flex items-center gap-2 mb-0.5">
                    <p className="font-medium text-slate-900">{p.label || p.name}</p>
                    <span className="font-mono text-xs text-slate-600">{p.name}</span>
                    <span className="rounded-full bg-slate-100 px-2 py-0.5 text-xs text-slate-600">{p.type}</span>
                    {/* red-700, not red-600: this 12px badge sits on red-100 (#ffe2e2), where
                        red-600 (#e7000b) measures 3.91:1 — below the 4.5:1 AA needs for text
                        this size. red-700 (#c10007) on the same ground is 5.27:1. */}
                    {p.required && <span className="rounded-full bg-red-100 px-2 py-0.5 text-xs text-red-700">required</span>}
                    {p.sensitive && <span className="rounded-full bg-yellow-100 px-2 py-0.5 text-xs text-yellow-700">sensitive</span>}
                  </div>
                  {p.description && <p className="text-xs text-slate-500">{p.description}</p>}
                  {p.defaultValue && <p className="text-xs text-slate-600 font-mono">default: {p.defaultValue}</p>}
                </div>
                <div className="flex gap-2">
                  <Button size="sm" variant="secondary" onClick={() => openEditParamModal(p)}>Edit</Button>
                  <Button size="sm" variant="danger" onClick={() => handleDeleteParam(p.id)}>Delete</Button>
                </div>
              </div>
            ))}
          </div>
        )}
      </Card>

      {/* Order Callbacks */}
      <Card title="Order Callbacks" action={
        <Button size="sm" onClick={() => { setWhError(null); setWebhookModal(true) }}>Add Webhook</Button>
      }>
        <p className="text-xs text-slate-500 mb-3">Optional HTTP callbacks the platform calls after an order is processed — use these to notify external systems such as ticketing or monitoring tools. Pipeline Stacks handle the actual provisioning.</p>
        {whDeleteError && <Alert className="mb-3">{whDeleteError}</Alert>}
        {webhooks.length === 0 ? (
          <p className="text-sm text-slate-600">No callbacks configured.</p>
        ) : (
          <div className="space-y-2">
            {webhooks.map((wh) => (
              <div key={wh.id} className="flex items-center justify-between rounded-lg border border-slate-100 p-3">
                <div>
                  <p className="font-medium text-slate-900">{wh.name}</p>
                  <p className="text-xs text-slate-500 font-mono">{wh.webhookUrl}</p>
                </div>
                <Button size="sm" variant="danger" onClick={() => handleDeleteWebhook(wh.id)}>Delete</Button>
              </div>
            ))}
          </div>
        )}
      </Card>

      {/* Pipeline Stacks */}
      <Card title="Pipeline Stacks" action={
        <Button size="sm" onClick={openStackModal}>Add Stack</Button>
      }>
        {stackDeleteError && <Alert className="mb-3">{stackDeleteError}</Alert>}
        {stacks.length === 0 ? (
          <p className="text-sm text-slate-600">No pipeline stacks configured. Click &quot;Add Stack&quot; to configure one.</p>
        ) : (
          <div className="space-y-2">
            {stacks.map((s) => {
              const env = environments.find((e) => e.id === s.environmentId)
              return (
                <div key={s.id} data-testid="stack-item" className="flex items-center justify-between rounded-lg border border-slate-100 p-3">
                  <div>
                    <p className="font-medium text-slate-900">{s.name}</p>
                    <p className="text-xs text-slate-500">{env?.name ?? `env #${s.environmentId}`} &middot; {s.steps.length} step{s.steps.length !== 1 ? 's' : ''} &middot; key: <span className="font-mono">{s.stateKeyParam}</span></p>
                  </div>
                  <div className="flex gap-2">
                    <Button size="sm" variant="secondary" onClick={() => openEditStackModal(s)}>Edit</Button>
                    <Button size="sm" variant="danger" onClick={() => handleDeleteStack(s.id)}>Delete</Button>
                  </div>
                </div>
              )
            })}
          </div>
        )}
      </Card>

      {/* Translation Modal */}
      <Modal open={transModal} onClose={() => setTransModal(false)} title="Add Translation" size="md">
        <form onSubmit={handleAddTranslation} className="space-y-4">
          {transError && <Alert>{transError}</Alert>}
          <Select label="Language" value={translationLang} onChange={(e) => setTranslationLang(e.target.value)} options={LANGUAGE_OPTIONS} />
          <Input label="Name" value={translationName} onChange={(e) => setTranslationName(e.target.value)} required />
          <div className="flex flex-col gap-1">
            <label htmlFor="translation-description" className="text-sm font-medium text-slate-700">Description</label>
            <textarea id="translation-description" value={translationDesc} onChange={(e) => setTranslationDesc(e.target.value)} rows={3}
              className="rounded-lg border border-slate-300 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500" />
          </div>
          <div className="flex justify-end gap-3">
            <Button type="button" variant="secondary" onClick={() => setTransModal(false)}>Cancel</Button>
            <Button type="submit" disabled={transSaving}>{transSaving ? 'Saving…' : 'Save'}</Button>
          </div>
        </form>
      </Modal>

      {/* Pipeline Stack Modal */}
      <Modal open={stackModal} onClose={() => setStackModal(false)} title={editStack ? 'Edit Pipeline Stack' : 'Add Pipeline Stack'} size="lg">
        <form onSubmit={handleSaveStack} className="space-y-4">
          {psError && <Alert>{psError}</Alert>}
          <div className="grid grid-cols-2 gap-4">
            <Input label="Name" value={psName} onChange={(e) => setPsName(e.target.value)} required />
            <Select label="Environment" required={!editStack} value={psEnvId} onChange={(e) => setPsEnvId(e.target.value)}
              placeholder="Select environment…" options={environments.map((e) => ({ value: e.id, label: e.name }))}
              disabled={!!editStack} />
          </div>
          <div className="rounded-lg bg-slate-50 border border-slate-200 px-3 py-2 text-xs text-slate-600">
            Trigger URL and token are inherited from the selected deployment environment.
            Manage them in <strong>Admin → Environments</strong>.
          </div>
          <Input label="State Key Parameter" value={psStateKey} onChange={(e) => setPsStateKey(e.target.value)}
            placeholder="hostname" />
          <div className="space-y-2">
            <div className="flex items-center justify-between">
              <label className="text-sm font-medium text-slate-700">Steps</label>
              <Button type="button" size="sm" variant="secondary" onClick={addStep}>+ Add Step</Button>
            </div>
            {psSteps.length === 0 && (
              <p className="text-sm text-slate-600">No steps yet. Add at least one step.</p>
            )}
            {psSteps.map((step, i) => (
              <div key={i} className="rounded-lg border border-slate-200 p-3 space-y-2">
                <div className="flex items-center justify-between">
                  <span className="text-xs font-medium text-slate-500">Step {i + 1}</span>
                  <Button type="button" size="sm" variant="danger" onClick={() => removeStep(i)}>Remove</Button>
                </div>
                <div className="grid grid-cols-3 gap-2">
                  <Input label="Template" placeholder="linode/virtual-machine" value={step.template}
                    onChange={(e) => updateStep(i, 'template', e.target.value)} required
                    hint="Path under templates/ in your infra-templates repo" />
                  <Input label="State Suffix" placeholder="-vm" value={step.stateSuffix}
                    onChange={(e) => updateStep(i, 'stateSuffix', e.target.value)} required
                    hint="Appended to the state key to form TF_STATE_NAME" />
                  <Input label="Exec Order" type="number" min={0} placeholder="0" value={step.execOrder}
                    onChange={(e) => updateStep(i, 'execOrder', e.target.value)}
                    hint="Steps with the same value run in parallel; lower values run first" />
                </div>
                <div className="space-y-1">
                  <div className="flex items-center justify-between">
                    <label className="text-sm font-medium text-slate-700">Upstream State Refs</label>
                    <Button type="button" size="sm" variant="secondary" onClick={() => addUpstreamRef(i)}>+ Add Ref</Button>
                  </div>
                  <p className="text-xs text-slate-500">Expose an earlier step&apos;s Terraform state to this step as a CI variable (promoted to TF_VAR_*). varName must be UPPER_SNAKE_CASE.</p>
                  {step.upstreamRefs.length === 0 && (
                    <p className="text-xs text-slate-600 italic">No upstream refs.</p>
                  )}
                  {step.upstreamRefs.map((ref, ri) => (
                    <div key={ri} className="flex gap-2 items-end">
                      <Input label="Var Name" placeholder="VM_STATE_NAME" value={ref.varName}
                        onChange={(e) => updateUpstreamRef(i, ri, 'varName', e.target.value)} />
                      <Input label="From Suffix" placeholder="-vm" value={ref.suffix}
                        onChange={(e) => updateUpstreamRef(i, ri, 'suffix', e.target.value)} />
                      <Button type="button" size="sm" variant="danger" onClick={() => removeUpstreamRef(i, ri)}>×</Button>
                    </div>
                  ))}
                </div>
                <div className="flex flex-col gap-1">
                  {/* Indexed id: this block is rendered once per pipeline step, so a
                      fixed one would tie every step's label to the first textarea. */}
                  <label htmlFor={`step-fixed-params-${i}`} className="text-sm font-medium text-slate-700">Fixed Parameters (optional)</label>
                  <p className="text-xs text-slate-500">Override or hardcode order parameters for this step only — one KEY=value per line</p>
                  <textarea id={`step-fixed-params-${i}`} value={step.fixedParams} onChange={(e) => updateStep(i, 'fixedParams', e.target.value)}
                    rows={2} placeholder="REGION=eu-central"
                    className="rounded-lg border border-slate-300 px-3 py-2 text-sm font-mono focus:outline-none focus:ring-2 focus:ring-blue-500" />
                </div>
              </div>
            ))}
          </div>
          <div className="flex justify-end gap-3">
            <Button type="button" variant="secondary" onClick={() => setStackModal(false)}>Cancel</Button>
            <Button type="button" variant="secondary" disabled={psSteps.length === 0}
              onClick={() => setPreviewOpen(true)}>Preview YAML</Button>
            <Button type="submit" disabled={psSaving || psSteps.length === 0}>{psSaving ? 'Saving…' : editStack ? 'Save' : 'Add'}</Button>
          </div>
        </form>
      </Modal>

      {/* Pipeline YAML Preview Modal */}
      <Modal open={previewOpen} onClose={() => setPreviewOpen(false)} title="Generated Pipeline YAML (apply)" size="lg">
        <pre className="rounded-lg bg-slate-900 text-slate-100 text-xs font-mono p-4 overflow-x-auto max-h-[60vh] overflow-y-auto whitespace-pre">
{generatePipelineYaml(psSteps, psStateKey || 'hostname', 'apply')}
        </pre>
        <div className="flex justify-end mt-4">
          <Button type="button" variant="secondary" onClick={() => setPreviewOpen(false)}>Close</Button>
        </div>
      </Modal>

      {/* Webhook Modal */}
      <Modal open={webhookModal} onClose={() => setWebhookModal(false)} title="Add Webhook" size="md">
        <form onSubmit={handleAddWebhook} className="space-y-4">
          {whError && <Alert>{whError}</Alert>}
          <Select label="Environment" required value={whEnvId} onChange={(e) => setWhEnvId(e.target.value)}
            placeholder="Select environment…" options={environments.map((e) => ({ value: e.id, label: e.name }))} />
          <Input label="Name" value={whName} onChange={(e) => setWhName(e.target.value)} required />
          <Input label="Webhook URL" type="url" value={whUrl} onChange={(e) => setWhUrl(e.target.value)} required />
          <Input label="Webhook Token" value={whToken} onChange={(e) => setWhToken(e.target.value)} />
          <Input label="Execution Order" type="number" value={whOrder} onChange={(e) => setWhOrder(e.target.value)} />
          <div className="flex justify-end gap-3">
            <Button type="button" variant="secondary" onClick={() => setWebhookModal(false)}>Cancel</Button>
            <Button type="submit" disabled={whSaving}>{whSaving ? 'Saving…' : 'Add'}</Button>
          </div>
        </form>
      </Modal>

      {/* Parameter Modal */}
      <Modal open={paramModal} onClose={() => setParamModal(false)} title={editParam ? 'Edit Parameter' : 'Add Parameter'} size="md">
        <form onSubmit={handleSaveParam} className="space-y-4">
          {paramError && <Alert>{paramError}</Alert>}
          <div className="grid grid-cols-2 gap-4">
            <Input label="Variable Name" value={paramForm.name} onChange={(e) => setParamForm((f) => ({ ...f, name: e.target.value }))} required
              hint="Terraform variable name — sent as TF_VAR_name" />
            <Input label="Display Label" value={paramForm.label} onChange={(e) => setParamForm((f) => ({ ...f, label: e.target.value }))}
              hint="User-facing name shown in the order form" />
          </div>
          <Select label="Type" value={paramForm.type}
            onChange={(e) => setParamForm((f) => ({ ...f, type: e.target.value as ParameterType }))}
            options={[
              { value: 'string', label: 'String' },
              { value: 'number', label: 'Number' },
              { value: 'bool', label: 'Boolean' },
              { value: 'dropdown', label: 'Dropdown' },
            ]} />
          <Input label="Description" value={paramForm.description}
            onChange={(e) => setParamForm((f) => ({ ...f, description: e.target.value }))} />
          <Input label="Default Value" value={paramForm.defaultValue}
            onChange={(e) => setParamForm((f) => ({ ...f, defaultValue: e.target.value }))}
            hint={paramForm.type === 'dropdown' ? 'Comma-separated options' : undefined} />
          <div className="flex gap-6">
            <div className="flex items-center gap-2">
              <input type="checkbox" id="param-required" checked={paramForm.required}
                onChange={(e) => setParamForm((f) => ({ ...f, required: e.target.checked }))}
                className="h-4 w-4 rounded border-slate-300 text-blue-600 focus:ring-blue-500" />
              <label htmlFor="param-required" className="text-sm font-medium text-slate-700">Required</label>
            </div>
            <div className="flex items-center gap-2">
              <input type="checkbox" id="param-sensitive" checked={paramForm.sensitive}
                onChange={(e) => setParamForm((f) => ({ ...f, sensitive: e.target.checked }))}
                className="h-4 w-4 rounded border-slate-300 text-blue-600 focus:ring-blue-500" />
              <label htmlFor="param-sensitive" className="text-sm font-medium text-slate-700">Sensitive</label>
            </div>
          </div>
          <div className="flex justify-end gap-3">
            <Button type="button" variant="secondary" onClick={() => setParamModal(false)}>Cancel</Button>
            <Button type="submit" disabled={paramSaving}>{paramSaving ? 'Saving…' : editParam ? 'Save' : 'Add'}</Button>
          </div>
        </form>
      </Modal>
    </div>
  )
}

function EnvironmentRow({
  env,
  existing,
  costCenters,
  productId,
  token,
  onSave,
  onDelete,
}: {
  env: DeploymentEnvironment
  existing?: {
    price: string
    currency: string
    costCenterMode: CostCenterMode
    forcedCostCenter: boolean
    overheadCostCenterId: number | null
    trialEnabled: boolean
    trialDurationMinutes: number
  }
  costCenters: CostCenter[]
  productId: number
  token: string
  onSave: (data: UpsertProductEnvironmentRequest) => Promise<void>
  onDelete: () => Promise<void>
}) {
  const [price, setPrice] = useState(existing?.price ?? '')
  const [currency, setCurrency] = useState(existing?.currency ?? 'EUR')
  const [costCenterMode, setCostCenterMode] = useState<CostCenterMode>(existing?.costCenterMode ?? 'project')
  const [forcedCostCenter, setForcedCostCenter] = useState(existing?.forcedCostCenter ?? false)
  const [trialEnabled, setTrialEnabled] = useState(existing?.trialEnabled ?? false)
  const [trialDurationMinutes, setTrialDurationMinutes] = useState(
    String(existing?.trialDurationMinutes ?? 30),
  )
  const [overheadCostCenterId, setOverheadCostCenterId] = useState(
    existing?.overheadCostCenterId !== null && existing?.overheadCostCenterId !== undefined
      ? String(existing.overheadCostCenterId)
      : '',
  )
  const [saving, setSaving] = useState(false)
  const [saved, setSaved] = useState(false)
  const [saveError, setSaveError] = useState<string | null>(null)
  const [confirmRemove, setConfirmRemove] = useState(false)
  const [removing, setRemoving] = useState(false)

  async function handleSave(e: React.FormEvent) {
    e.preventDefault()
    setSaving(true)
    setSaved(false)
    setSaveError(null)
    try {
      await onSave({
        price,
        currency,
        costCenterMode,
        forcedCostCenter,
        // Only meaningful for `overhead`; sending null otherwise keeps a stale
        // account from being applied if the mode is switched back later.
        overheadCostCenterId:
          costCenterMode === 'overhead' && overheadCostCenterId ? Number(overheadCostCenterId) : null,
        trialEnabled,
        // Fall back to 30 rather than sending NaN or 0 for a cleared field: the
        // server rejects a non-positive duration, which would surface as a
        // confusing save error on a field the operator may not have touched.
        trialDurationMinutes: Number(trialDurationMinutes) > 0 ? Number(trialDurationMinutes) : 30,
      })
      setSaved(true)
      setTimeout(() => setSaved(false), 2000)
    } catch (err) {
      setSaveError(err instanceof Error ? err.message : 'Failed to save.')
    } finally {
      setSaving(false)
    }
  }

  async function handleRemove() {
    setRemoving(true)
    setSaveError(null)
    try {
      await onDelete()
      setConfirmRemove(false)
    } catch (err) {
      // Keep the dialog open so the reason stays next to the action that failed
      // — a 409 here means the operator has to decommission first.
      setSaveError(err instanceof Error ? err.message : 'Failed to remove environment.')
    } finally {
      setRemoving(false)
    }
  }

  return (
    <form onSubmit={handleSave} className="rounded-lg border border-slate-200 p-4 space-y-3">
      <div className="flex items-center justify-between">
        <h4 className="font-medium text-slate-900">{env.name}</h4>
        {existing && (
          <Button type="button" size="sm" variant="danger" onClick={() => { setSaveError(null); setConfirmRemove(true) }}>
            Remove
          </Button>
        )}
      </div>
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
        <Input label="Price" value={price} onChange={(e) => setPrice(e.target.value)} required placeholder="0.00"
          hint="Used only while this offering has no sizes — a size's own price wins." />
        <Input label="Currency" value={currency} onChange={(e) => setCurrency(e.target.value)} required placeholder="EUR" />
        <Select label="Cost Center Mode" value={costCenterMode}
          onChange={(e) => setCostCenterMode(e.target.value as CostCenterMode)} options={COST_CENTER_MODES} />
        <div className="flex flex-col gap-1 justify-end">
          {/* Per-environment id, like `trial-${env.id}` below: this form is rendered
              once per environment, so a fixed id would point every "Forced CC" label
              at the first environment's checkbox. */}
          <label htmlFor={`forced-cc-${env.id}`} className="text-sm font-medium text-slate-700">Forced CC</label>
          <div className="flex items-center h-9">
            <input type="checkbox" id={`forced-cc-${env.id}`} checked={forcedCostCenter} onChange={(e) => setForcedCostCenter(e.target.checked)}
              className="h-4 w-4 rounded border-slate-300 text-blue-600 focus:ring-blue-500" />
          </div>
        </div>
      </div>

      {/* Trials are opt-in per offering: one provisions real infrastructure and
          asks the pipeline to grant elevated rights inside it. */}
      <div className="flex flex-wrap items-end gap-4">
        <div className="flex items-center gap-2 h-9">
          <input
            type="checkbox"
            id={`trial-${env.id}`}
            checked={trialEnabled}
            onChange={(e) => setTrialEnabled(e.target.checked)}
            className="h-4 w-4 rounded border-slate-300 text-blue-600 focus:ring-blue-500"
          />
          <label htmlFor={`trial-${env.id}`} className="text-sm font-medium text-slate-700">
            Offer as trial
          </label>
        </div>
        {trialEnabled && (
          <Input
            label="Trial duration (minutes)"
            type="number"
            min={1}
            value={trialDurationMinutes}
            onChange={(e) => setTrialDurationMinutes(e.target.value)}
            hint="The element is decommissioned automatically after this long. Needs the sweep configured — see README."
            className="w-64"
          />
        )}
      </div>

      {/* Overhead mode bills every order to one fixed shared account, so it
          needs to name which one — the other two modes never use it. */}
      {costCenterMode === 'overhead' && (
        <Select
          label="Overhead Cost Center"
          value={overheadCostCenterId}
          onChange={(e) => setOverheadCostCenterId(e.target.value)}
          placeholder="Select cost center…"
          hint={
            forcedCostCenter
              ? 'Required: orders in this environment are rejected until an account is chosen.'
              : 'Without one, orders in this environment are recorded with no cost centre.'
          }
          options={costCenters
            .filter((cc) => cc.active || String(cc.id) === overheadCostCenterId)
            .map((cc) => ({ value: cc.id, label: `${cc.code} — ${cc.name}${cc.active ? '' : ' (inactive)'}` }))}
        />
      )}
      {existing && <SizesEditor productId={productId} envId={env.id} token={token} />}

      <div className="flex items-center gap-3">
        <Button type="submit" size="sm" disabled={saving}>{saving ? 'Saving…' : 'Save'}</Button>
        {saved && <span className="text-xs text-green-600">Saved!</span>}
        {/* Only when the dialog is closed: the dialog renders saveError itself,
            and two live regions with the same text are announced twice. */}
        {saveError && !confirmRemove && <span className="text-xs text-red-600" role="alert">{saveError}</span>}
      </div>

      <Modal open={confirmRemove} onClose={() => setConfirmRemove(false)} title={`Remove ${env.name}?`} size="md">
        {saveError && <Alert className="mb-3">{saveError}</Alert>}
        <p className="text-sm text-slate-600">
          This product will no longer be orderable in <strong>{env.name}</strong>. Its price, currency and
          cost-centre settings for this environment are discarded. Already provisioned infrastructure is not
          touched — remove the environment only once nothing is deployed in it.
        </p>
        <div className="flex justify-end gap-3 mt-4">
          <Button type="button" variant="secondary" onClick={() => setConfirmRemove(false)}>Cancel</Button>
          <Button type="button" variant="danger" disabled={removing} onClick={handleRemove}>
            {removing ? 'Removing…' : 'Remove'}
          </Button>
        </div>
      </Modal>
    </form>
  )
}


/**
 * Per-offering size list (issue #98).
 *
 * Lives inside the offering row because a size belongs to a (product,
 * environment) pair: the same product legitimately costs different amounts at the
 * same size in two environments, which is half the point of the feature.
 *
 * Deliberately not a nested <form> — the offering row is already one, and nested
 * forms are invalid HTML — so every control here is a type="button".
 */
function SizesEditor({
  productId,
  envId,
  token,
}: {
  productId: number
  envId: number
  token: string
}) {
  const [sizes, setSizes] = useState<OfferingSize[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [code, setCode] = useState('')
  const [label, setLabel] = useState('')
  const [price, setPrice] = useState('')
  const [currency, setCurrency] = useState('EUR')
  const path = `/api/admin/products/${productId}/environments/${envId}/sizes`

  const load = useCallback(async () => {
    try {
      setSizes((await get<OfferingSize[]>(path, token)) ?? [])
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to load sizes.')
      setSizes([])
    }
  }, [path, token])

  useEffect(() => { void load() }, [load])

  async function handleAdd() {
    setBusy(true)
    setError(null)
    try {
      await post(path, {
        code: code.trim(),
        label: label.trim(),
        price: price.trim() || '0',
        currency: currency.trim().toUpperCase(),
        // Appended at the end of the list; an admin reorders by editing the value
        // on the row, which upserts on the same code.
        sortOrder: (sizes?.length ?? 0) + 1,
      }, token)
      setCode(''); setLabel(''); setPrice('')
      await load()
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to save the size.')
    } finally {
      setBusy(false)
    }
  }

  /** Retire rather than delete: existing orders reference the code. */
  async function handleToggleActive(size: OfferingSize) {
    setBusy(true)
    setError(null)
    try {
      await post(path, { code: size.code, label: size.label, price: size.price,
        currency: size.currency, sortOrder: size.sortOrder, active: !size.active }, token)
      await load()
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to save the size.')
    } finally {
      setBusy(false)
    }
  }

  async function handleDelete(size: OfferingSize) {
    setBusy(true)
    setError(null)
    try {
      await del(`${path}/${size.id}`, token)
      await load()
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to remove the size.')
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="rounded-lg border border-slate-100 bg-slate-50 p-3 space-y-2">
      <p className="text-sm font-medium text-slate-700">Sizes</p>
      <p className="text-xs text-slate-500">
        Each size carries its own price, and a customer must pick one. Leave the list empty to keep pricing
        the offering as a whole. The size code reaches the pipeline as <code>SIZE</code>.
      </p>
      {error && <Alert>{error}</Alert>}
      {sizes !== null && sizes.length === 0 && (
        <p className="text-xs text-slate-600">No sizes — this offering is priced by its own price above.</p>
      )}
      {sizes?.map((size) => (
        <div key={size.id} className="flex flex-wrap items-center gap-2 rounded border border-slate-200 bg-white px-3 py-2">
          <span className="font-mono text-xs text-slate-600">{size.code}</span>
          <span className="text-sm text-slate-900">{size.label}</span>
          <span className="text-sm font-medium text-slate-900">{size.price} {size.currency}</span>
          {!size.active && (
            <span className="rounded-full bg-slate-100 px-2 py-0.5 text-xs text-slate-600">retired</span>
          )}
          <span className="ml-auto flex gap-2">
            <Button type="button" size="sm" variant="secondary" disabled={busy}
              onClick={() => handleToggleActive(size)}>
              {size.active ? 'Retire' : 'Restore'}
            </Button>
            <Button type="button" size="sm" variant="danger" disabled={busy}
              onClick={() => handleDelete(size)}>Delete</Button>
          </span>
        </div>
      ))}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
        <Input label="Code" value={code} onChange={(e) => setCode(e.target.value)} placeholder="XL" />
        <Input label="Label" value={label} onChange={(e) => setLabel(e.target.value)} placeholder="Extra large" />
        <Input label="Price" value={price} onChange={(e) => setPrice(e.target.value)} placeholder="0.00" />
        <Input label="Currency" value={currency} onChange={(e) => setCurrency(e.target.value)} placeholder="EUR" />
      </div>
      <Button type="button" size="sm" disabled={busy || code.trim() === ''} onClick={handleAdd}>
        {busy ? 'Saving…' : 'Add / update size'}
      </Button>
    </div>
  )
}
