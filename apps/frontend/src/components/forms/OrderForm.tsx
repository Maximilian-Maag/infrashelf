'use client'

import { useState, useEffect } from 'react'
import { useRouter } from 'next/navigation'
import {
  REDACTED_PARAMETER_VALUE,
  type ProductDetail,
  type Project,
  type CostCenter,
  type CreateOrderRequest,
  type Order,
  type InfrastructureElement,
} from '@open-hybrid-cloud/types'
import { post, get } from '@/lib/api'
import { Button } from '@/components/ui/Button'
import { Alert } from '@/components/ui/Alert'
import { Select } from '@/components/ui/Select'
import { Input } from '@/components/ui/Input'
import { ParameterFields } from './ParameterFields'
import { t } from '@/lib/i18n'
import { convertPrice, sortByValue } from '@/lib/locale'

/** Mirrors MAX_ORDER_QUANTITY in the backend, which re-checks it. */
const MAX_QUANTITY = 20

interface OrderFormProps {
  product: ProductDetail
  projects: Project[]
  costCenters: CostCenter[]
  token: string
  lang?: string
  exchangeRates?: Record<string, number>
  localeCurrency?: string
  /**
   * Quick reorder (issue #39): the infrastructure element to copy parameters
   * from, plus its project. The project has to come along — the template list is
   * loaded per project, so without it there is nothing to match the id against.
   */
  fromInfraId?: string
  initialProjectId?: string
}

export function OrderForm({
  product,
  projects,
  costCenters,
  token,
  lang = 'en',
  exchangeRates = {},
  localeCurrency = 'EUR',
  fromInfraId,
  initialProjectId,
}: OrderFormProps) {
  const router = useRouter()
  const [envId, setEnvId] = useState<string>('')
  const [projectId, setProjectId] = useState<string>(initialProjectId ?? '')
  const [costCenterId, setCostCenterId] = useState<string>('')
  // The size (issue #98) and how many elements to provision (issue #104). Both are
  // part of the line rather than of the parameters: the size decides the price and
  // the quantity decides how many elements one approval covers.
  const [sizeCode, setSizeCode] = useState<string>('')
  const [quantity, setQuantity] = useState<string>('1')
  const [trial, setTrial] = useState(false)
  const [paramValues, setParamValues] = useState<Record<string, string>>({})
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [success, setSuccess] = useState(false)

  const [templates, setTemplates] = useState<InfrastructureElement[]>([])
  const [templateId, setTemplateId] = useState<string>('')
  // Applied at most once, so re-picking "start fresh" after arriving via a
  // reorder link is not immediately undone by this effect.
  const [reorderApplied, setReorderApplied] = useState(false)

  // Parameter definitions for the selected environment. The page loads the
  // product without an environment (it is picked here), so the server can only
  // return one candidate per name *per environment* — the scope/environment
  // precedence that decides which one actually applies needs a concrete
  // environment. Refetch with it rather than re-deriving that precedence here,
  // so the rendered controls are exactly the definitions `createOrder`
  // validates against. Falls back to the unresolved list until the fetch lands.
  const [resolvedParameters, setResolvedParameters] = useState(product.parameters)

  useEffect(() => {
    if (!envId) { setResolvedParameters(product.parameters); return }
    let stale = false
    get<ProductDetail>(`/api/catalog/${product.id}?lang=${lang}&environmentId=${envId}`, token)
      // Guard on `parameters`, not just on `detail`: a truthy-but-shapeless
      // response (an error envelope, an empty array) would otherwise store
      // undefined and crash the next render on `.filter`.
      .then((detail) => { if (!stale && detail?.parameters) setResolvedParameters(detail.parameters) })
      // Deliberate: on a failed re-resolve the unresolved parameter list stays on
      // screen and the server validates the submission anyway, so there is nothing
      // for the user to act on.
      // eslint-disable-next-line no-restricted-syntax
      .catch(() => {})
    return () => { stale = true }
  }, [envId, product.id, product.parameters, lang, token])

  const selectedEnv = product.environments.find((e) => String(e.environmentId) === envId)
  // `overhead` used to be lumped in with `select` and rendered a picker, which
  // made a fixed shared account indistinguishable from a free choice. The
  // account is now stored on the offering, so the user is shown it, not asked.
  const isOverhead = selectedEnv?.costCenterMode === 'overhead'
  const needsCostCenter = selectedEnv?.costCenterMode === 'select'
  // Trials are opt-in per offering (issue #1), so the toggle only exists where one
  // is actually offered. The server re-checks — a hidden control is not a control.
  const trialAvailable = selectedEnv?.trialEnabled === true
  // Sizes belong to the offering. An offering with none prices off itself, which is
  // every offering that predates sizing, so the control is not rendered at all.
  const sizes = selectedEnv?.sizes ?? []
  const needsSize = sizes.length > 0
  const parsedQuantity = Number(quantity)
  const quantityValid =
    Number.isInteger(parsedQuantity) && parsedQuantity >= 1 && parsedQuantity <= MAX_QUANTITY
  const envParameters = resolvedParameters.filter(
    (p) => p.environmentId === null || String(p.environmentId) === envId,
  )

  // Load existing deployments for the selected project+product so the user can copy parameters
  useEffect(() => {
    if (!projectId) { setTemplates([]); setTemplateId(''); return }
    // Switching project before this resolves must not let the old project's
    // elements land in the list — they belong to a project the user left, and
    // the selection would then be validated against the wrong set.
    let stale = false
    get<InfrastructureElement[]>(
      `/api/infrastructure?productId=${product.id}&projectId=${projectId}`,
      token,
    )
      .then((rows) => {
        if (stale) return
        setTemplates(rows ?? [])
        // Keep the current selection if it is still in the list. Clearing
        // unconditionally discarded a quick-reorder prefill whenever this effect
        // ran a second time (projectId settles after the projects load), and the
        // reorder effect below will not re-apply because it has already fired —
        // so the form kept the environment and parameters but lost the template,
        // and with it the "pre-filled from this element" confirmation.
        setTemplateId((current) =>
          current !== '' && (rows ?? []).some((row) => String(row.id) === current) ? current : '',
        )
      })
      .catch(() => { if (!stale) setTemplates([]) })
    return () => { stale = true }
  }, [projectId, product.id, token])

  // Quick reorder: once the project's elements have loaded, adopt the one the
  // Sensitive parameter values come back redacted (#131), so a template or a
  // reorder hands us the sentinel rather than the real value. Dropping those keys
  // leaves the field empty, which prompts the user, instead of showing a value
  // that looks real and is not. The backend refuses the sentinel too — that is
  // the authoritative guard; this is so the form does not lie about it.
  //
  // The constant is shared rather than written out on both sides: if the two ever
  // disagreed, a reorder would store the placeholder as the secret again.
  const withoutRedacted = (params: Record<string, string>): Record<string, string> =>
    Object.fromEntries(Object.entries(params).filter(([, v]) => v !== REDACTED_PARAMETER_VALUE))

  // link named. Routed through applyTemplate rather than duplicating its logic,
  // so a reorder fills the form exactly the way picking the template by hand
  // does — same parameters, same environment.
  useEffect(() => {
    if (!fromInfraId || reorderApplied || templates.length === 0) return
    const match = templates.find((tpl) => String(tpl.id) === fromInfraId)
    if (!match) return
    setReorderApplied(true)
    setTemplateId(fromInfraId)
    setParamValues(withoutRedacted(match.parameters ?? {}))
    setEnvId(String(match.environmentId))
  }, [fromInfraId, reorderApplied, templates])

  function applyTemplate(id: string) {
    if (id === '') {
      // Start fresh: drop the copied parameters but leave the chosen environment
      // alone — clearing that too would undo a deliberate selection the user
      // may have made before reaching for this control.
      setTemplateId('')
      setParamValues({})
      return
    }
    const tpl = templates.find((candidate) => String(candidate.id) === id)
    if (!tpl) return
    setTemplateId(id)
    setParamValues(withoutRedacted(tpl.parameters ?? {}))
    if (String(tpl.environmentId) !== envId) setEnvId(String(tpl.environmentId))
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    if (!envId || !projectId) {
      setError(t('selectEnvProject', lang))
      return
    }
    if (needsSize && !sizeCode) {
      setError(t('selectSize', lang))
      return
    }
    setLoading(true)
    setError(null)
    try {
      // Merge defaultValue in for any parameter the user did not touch — the
      // Input placeholder already displays the default, so users expect it to
      // be submitted. ParameterFields is now fully controlled, so paramValues
      // only contains keys the user has actually edited.
      const parametersWithDefaults: Record<string, string> = {}
      for (const p of envParameters) {
        parametersWithDefaults[p.name] = paramValues[p.name] ?? p.defaultValue ?? ''
      }
      const body: CreateOrderRequest = {
        productId: product.id,
        environmentId: Number(envId),
        projectId: Number(projectId),
        parameters: parametersWithDefaults,
        ...(needsCostCenter && costCenterId ? { costCenterId: Number(costCenterId) } : {}),
        // Only when the offering has sizes: the server refuses one for an offering
        // without any, and switching environment must not smuggle the old code
        // through.
        ...(needsSize ? { sizeCode } : {}),
        ...(parsedQuantity > 1 ? { quantity: parsedQuantity } : {}),
        // Only sent when the selected environment offers a trial: switching
        // environments after ticking the box must not smuggle the flag through.
        ...(trialAvailable && trial ? { trial: true } : {}),
      }
      await post<Order>('/api/orders', body, token)
      setSuccess(true)
      router.push('/orders')
      router.refresh()
    } catch (err) {
      setError(err instanceof Error ? err.message : t('orderError', lang))
    } finally {
      setLoading(false)
    }
  }

  function formatPrice(price: string, currency: string): string {
    const converted = convertPrice(price, currency, localeCurrency, exchangeRates, lang)
    if (converted.currency !== currency) {
      return `${converted.amount} ${converted.currency}`
    }
    return `${price} ${currency}`
  }

  /**
   * What an offering costs, for the environment picker.
   *
   * Price moved to the size (issue #98), so an offering with sizes has no single
   * price: the cheapest is shown, and the size picker below states the rest. An
   * offering with no sizes still has its own price, which is what every offering
   * that predates sizing has.
   */
  function formatEnvPrice(env: ProductDetail['environments'][number]): string {
    const envSizes = env.sizes ?? []
    if (envSizes.length === 0) return formatPrice(env.price, env.currency)
    // Compared in EUR, not by the digits: sizes carry their own currency, so the
    // cheapest is not whichever one has the smallest number on it.
    const cheapest = sortByValue(envSizes, exchangeRates)[0]
    return formatPrice(cheapest.price, cheapest.currency)
  }

  if (success) {
    return (
      <Alert tone="success">
        {t('orderSuccess', lang)}
      </Alert>
    )
  }

  return (
    <form onSubmit={handleSubmit} className="space-y-6">
      {error && (
        <Alert>
          {error}
        </Alert>
      )}

      <Select
        label={t('environment', lang)}
        required
        value={envId}
        onChange={(e) => {
          setEnvId(e.target.value)
          // A size code chosen for one offering means nothing in another.
          setSizeCode('')
        }}
        placeholder={t('selectEnvironment', lang)}
        options={product.environments.map((env) => ({
          value: env.environmentId,
          label: `${env.environmentName ?? `Env ${env.environmentId}`} — ${formatEnvPrice(env)}`,
        }))}
      />

      {needsSize && (
        <Select
          label={t('size', lang)}
          required
          value={sizeCode}
          onChange={(e) => setSizeCode(e.target.value)}
          placeholder={t('selectSize', lang)}
          // The price is in the label: the size IS the price now, and a picker of
          // bare letters asks the customer to guess what XL costs.
          options={sizes.map((size) => ({
            value: size.code,
            label: `${size.label || size.code} — ${formatPrice(size.price, size.currency)}`,
          }))}
        />
      )}

      <Input
        label={t('quantity', lang)}
        type="number"
        min={1}
        max={MAX_QUANTITY}
        step={1}
        value={quantity}
        onChange={(e) => setQuantity(e.target.value)}
        // Said rather than silently clamped: one order provisions this many
        // elements, and one approval covers all of them.
        hint={`1 – ${MAX_QUANTITY}`}
      />

      <Select
        label={t('project', lang)}
        required
        value={projectId}
        onChange={(e) => setProjectId(e.target.value)}
        placeholder={t('selectProject', lang)}
        options={projects.map((p) => ({ value: p.id, label: p.name }))}
      />

      {needsCostCenter && (
        <Select
          label={t('costCenter', lang)}
          required={selectedEnv?.forcedCostCenter}
          value={costCenterId}
          onChange={(e) => setCostCenterId(e.target.value)}
          placeholder={t('selectCostCenter', lang)}
          options={costCenters
            .filter((cc) => cc.active)
            .map((cc) => ({ value: cc.id, label: `${cc.code} — ${cc.name}` }))}
        />
      )}

      {isOverhead && (
        <div>
          <p className="text-sm font-medium text-slate-700">{t('overheadCostCenter', lang)}</p>
          <p className="mt-1 text-sm text-slate-900" data-testid="overhead-cost-center">
            {selectedEnv?.overheadCostCenterName ?? '—'}
          </p>
          <p className="mt-1 text-xs text-slate-500">{t('overheadCostCenterHint', lang)}</p>
        </div>
      )}

      {trialAvailable && (
        <div className="rounded-lg border border-blue-200 bg-blue-50 p-3">
          <div className="flex items-center gap-2">
            <input
              type="checkbox"
              id="order-trial"
              checked={trial}
              onChange={(e) => setTrial(e.target.checked)}
              className="h-4 w-4 rounded border-slate-300 text-blue-600 focus:ring-blue-500"
            />
            <label htmlFor="order-trial" className="text-sm font-medium text-slate-800">
              {t('tryItOut', lang)}
              {' — '}
              {selectedEnv?.trialDurationMinutes ?? 30} {t('trialMinutes', lang)}
            </label>
          </div>
          <p className="mt-1 ml-6 text-xs text-slate-600">{t('trialHint', lang)}</p>
        </div>
      )}

      {projectId && templates.length > 0 && (
        <div>
          <Select
            label={t('loadFromExisting', lang)}
            value={templateId}
            onChange={(e) => applyTemplate(e.target.value)}
            // A real option rather than Select's `placeholder`, which renders
            // DISABLED: once a template had been picked — and a quick-reorder
            // link picks one on arrival — "start fresh" would be unreachable.
            options={[
              { value: '', label: t('startFresh', lang) },
              ...templates.map((tpl) => ({
                value: tpl.id,
                label: `#${tpl.id} · ${tpl.environmentName ?? `Env ${tpl.environmentId}`} · ${tpl.deployedAt ? new Date(tpl.deployedAt).toLocaleDateString() : 'n/a'}`,
              })),
            ]}
          />
          {templateId && (
            <p className="mt-1 text-xs text-slate-500">
              {t('paramsPrefilled', lang)}{templateId}. Edit as needed before submitting.
            </p>
          )}
          {fromInfraId && templateId === fromInfraId && (
            <p className="mt-1 text-xs text-slate-500" role="status">{t('reorderHint', lang)}</p>
          )}
        </div>
      )}

      {envId && envParameters.length > 0 && (
        <div>
          <h3 className="text-sm font-semibold text-slate-700 mb-3">{t('parameters', lang)}</h3>
          <ParameterFields
            parameters={envParameters}
            values={paramValues}
            onChange={setParamValues}
          />
        </div>
      )}

      <Button type="submit" disabled={loading || !quantityValid} className="w-full">
        {loading ? t('submitting', lang) : t('placeOrder', lang)}
      </Button>
    </form>
  )
}
