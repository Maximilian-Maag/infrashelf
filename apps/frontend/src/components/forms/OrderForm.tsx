'use client'

import { useState, useEffect, useRef } from 'react'
import { useRouter } from 'next/navigation'
import {
  REDACTED_PARAMETER_VALUE,
  type ProductDetail,
  type Project,
  type CostCenter,
  type CreateOrderRequest,
  type Order,
  type InfrastructureElement,
  type InfrastructurePage,
  type Role,
} from '@infrashelf/types'
import { post, get, ApiError } from '@/lib/api'
import { Button } from '@/components/ui/Button'
import Link from 'next/link'
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
  lang?: string
  exchangeRates?: Record<string, number>
  localeCurrency?: string
  /**
   * Who is ordering (#509).
   *
   * Only root is offered the escape from a refusal, and the backend re-checks the
   * role — this decides whether the control is rendered at all, not whether the
   * order is allowed. Defaulted to the role that gets no escape, so a caller that
   * forgets to pass it fails closed rather than showing a control that would be
   * refused.
   */
  role?: Role
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
  lang = 'en',
  exchangeRates = {},
  localeCurrency = 'EUR',
  role = 'project_manager',
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
  /*
   * The refusal this order just came back with, when there is an escape from it
   * (#509). A code rather than a boolean, because which escape applies is which
   * refusal came back — the budget and the policy are two separate rights, and
   * sending the wrong one waives nothing (or, worse, waives the other).
   */
  const [refusal, setRefusal] = useState<'budget_blocked' | 'policy_denied' | null>(null)
  /*
   * The waivers already exercised in this refusal chain.
   *
   * A policy refusal HIDES the budget one — `createPreparedOrder` asks the policy
   * first and returns on a deny — so root waiving the policy can uncover a budget
   * refusal underneath it. Retrying with only the flag for the refusal in hand
   * would then re-send the order without the waiver already made, the policy would
   * refuse it again, and the two would alternate for ever with no way through.
   *
   * Cleared on an ordinary submit: a fresh attempt is a fresh question, and a
   * waiver kept from a previous one would grant something nobody was asked about.
   */
  const [retryOverrides, setRetryOverrides] = useState<{
    overrideBudget?: boolean
    overridePolicy?: boolean
  }>({})
  const [success, setSuccess] = useState(false)
  /*
   * The verdict the server returned with a placed order, when it had something to
   * say (#526): the policy's warning, or the rule that put the order in the
   * approvals queue. Held instead of navigating — the same choice the cart makes,
   * for the same reason: the message is the whole point of the attempt.
   */
  const [placed, setPlaced] = useState<{ warning?: string; held?: string } | null>(null)

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
  /*
   * The same list, and the request still in flight for it, as refs.
   *
   * Changing the project starts a refetch, and until it lands `resolvedParameters`
   * still holds the PREVIOUS project's definitions. Submitting in that window
   * would send the old project's defaults for the new project — this defect
   * again, inside a narrower window.
   *
   * `handleSubmit` waits for that request and reads the result from a ref:
   * awaiting cannot observe a state update, because the closure it resumes into
   * captured the old value. The submission is not refused and the button is not
   * disabled — this form answers refusals with an `Alert` on purpose (WCAG
   * 3.3.1, #186), and there is nothing here to refuse. The click just waits.
   */
  const latestParameters = useRef(product.parameters)
  const pendingParameters = useRef<Promise<unknown> | null>(null)

  useEffect(() => {
    if (!envId) {
      /*
       * One of the four effects that stay (#418). The server cannot answer this
       * one: which parameters apply depends on the environment and project the
       * user is in the middle of choosing, and nothing in the URL says what that
       * will be.
       *
       * The reset could in principle be derived during render — with no
       * environment the parameters ARE the product's. What stops that is the two
       * lines under it: this effect owns the refs `handleSubmit` awaits, and
       * writing them a render later than the state is precisely the window #406
       * is about, where a submit sent the previous selection's definitions.
       */
      // eslint-disable-next-line react-hooks/set-state-in-effect -- selection-driven; see above
      setResolvedParameters(product.parameters)
      latestParameters.current = product.parameters
      pendingParameters.current = null
      return
    }
    let stale = false
    /*
     * The project goes with the environment, and for the same reason (#406).
     *
     * A parameter can be narrowed to specific projects (#275), and that
     * narrowing is a precedence rule — so resolving without the project handed
     * one project's definition to every project. `sensitive` is the sharp edge:
     * it decides whether the input below is masked at all.
     *
     * It is in the dependency array as well as the query. Leaving it out was
     * the actual defect: the picker moved, the parameters did not, and the
     * defaults filled in on submit came from whichever definition the page had
     * been holding since before a project was chosen.
     */
    const query = new URLSearchParams({ lang, environmentId: envId })
    if (projectId) query.set('projectId', projectId)
    const request = get<ProductDetail>(`/api/catalog/${product.id}?${query}`)
      // Guard on `parameters`, not just on `detail`: a truthy-but-shapeless
      // response (an error envelope, an empty array) would otherwise store
      // undefined and crash the next render on `.filter`.
      .then((detail) => {
        if (!stale && detail?.parameters) {
          setResolvedParameters(detail.parameters)
          latestParameters.current = detail.parameters
        }
      })
      .catch(() => { /* keep the unresolved list — submit still validates server-side */ })
      .finally(() => { if (pendingParameters.current === request) pendingParameters.current = null })
    pendingParameters.current = request
    return () => { stale = true }
  }, [envId, projectId, product.id, product.parameters, lang])

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
  // The range is appended rather than written into the translation so that
  // raising MAX_QUANTITY does not silently leave 25 tables claiming the old one.
  const quantityMessage = `${t('quantityInvalid', lang)} (1–${MAX_QUANTITY})`
  const envParameters = resolvedParameters.filter(
    (p) => p.environmentId === null || String(p.environmentId) === envId,
  )

  // Load existing deployments for the selected project+product so the user can copy parameters
  useEffect(() => {
    // Stays, for the reason above (#418): the list is of deployments in the
    // project the user has just picked from a <select>, which is a choice made
    // after the page rendered. Clearing it when the project is cleared is the
    // same effect's business — a stale "copy the settings from" list belongs to
    // a project that is no longer selected.
    // eslint-disable-next-line react-hooks/set-state-in-effect -- selection-driven; see above
    if (!projectId) { setTemplates([]); setTemplateId(''); return }
    // Switching project before this resolves must not let the old project's
    // elements land in the list — they belong to a project the user left, and
    // the selection would then be validated against the wrong set.
    let stale = false
    get<InfrastructurePage>(
      `/api/infrastructure?productId=${product.id}&projectId=${projectId}`,
    )
      .then((page) => {
        if (stale) return
        // One page of the elements for this product in this project. The list is
        // a "copy the settings from" picker, and it was already unusable as a
        // scroll long before it was unbounded — the default window is the
        // honest shape for it.
        setTemplates(page?.items ?? [])
        // Keep the current selection if it is still in the list. Clearing
        // unconditionally discarded a quick-reorder prefill whenever this effect
        // ran a second time (projectId settles after the projects load), and the
        // reorder effect below will not re-apply because it has already fired —
        // so the form kept the environment and parameters but lost the template,
        // and with it the "pre-filled from this element" confirmation.
        setTemplateId((current) =>
          current !== '' && (page?.items ?? []).some((row) => String(row.id) === current) ? current : '',
        )
      })
      .catch(() => { if (!stale) setTemplates([]) })
    return () => { stale = true }
  }, [projectId, product.id])

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
    // Stays (#418), and this one is not a fetch at all: it is a one-shot action
    // taken WHEN the list arrives, which is what an effect is for. The reorder
    // link names an element, and until the templates are in hand there is
    // nothing to match it against. `reorderApplied` is what keeps it one-shot,
    // so a later edit by the user is not overwritten by the link.
    // eslint-disable-next-line react-hooks/set-state-in-effect -- applies a deep link once its data arrives
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

  /**
   * Place the order, optionally waiving the refusal that came back (#509).
   *
   * `overrides` is what the "place anyway" control sends, and it is deliberately
   * the only way in: the two refusals are two separate rights, so a body claiming
   * both would waive whatever the server asked next as well as what it refused.
   *
   * The refusal is read off the error's `code`, never off its message: the message
   * is written for a person and is reworded freely, and a form that branched on the
   * sentence would offer the wrong escape — or none — the first time it changed.
   */
  async function place(overrides: { overrideBudget?: boolean; overridePolicy?: boolean } = {}) {
    /*
     * A retry carries the waivers already made in this chain; an ordinary submit
     * carries none. See `retryOverrides` for why the chain needs them — the policy
     * gate hides the budget one, so the flags have to accumulate rather than
     * replace.
     */
    const carried = Object.keys(overrides).length > 0 ? { ...retryOverrides, ...overrides } : {}
    setRetryOverrides(carried)
    setLoading(true)
    setError(null)
    // Cleared first: this attempt is the answer to the last one, and leaving the
    // old refusal beside its own retry reads as a second, simultaneous failure.
    setRefusal(null)
    try {
      // Merge defaultValue in for any parameter the user did not touch — the
      // Input placeholder already displays the default, so users expect it to
      // be submitted. ParameterFields is now fully controlled, so paramValues
      // only contains keys the user has actually edited.
      // Wait for a project change still in flight, then read the definitions from
      // the ref rather than from `envParameters` — the render that produced the
      // latter is the one being waited on. Never rejects: the effect catches its
      // own failure and leaves the last good list in place.
      if (pendingParameters.current) await pendingParameters.current
      const effectiveParameters = latestParameters.current.filter(
        (p) => p.environmentId === null || String(p.environmentId) === envId,
      )

      const parametersWithDefaults: Record<string, string> = {}
      for (const p of effectiveParameters) {
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
        ...carried,
      }
      const created = await post<Order>('/api/orders', body)
      /*
       * A verdict that changed what happened is shown instead of navigating away
       * (#526), which is what the cart already does for the same two fields
       * (#325, #517): the sentence is the only thing that says why the order is
       * not doing what the person expected, and leaving the page discards it.
       *
       * `policyApprovalRequired` is not a warning — the order is in the queue —
       * so the two read differently here and are not merged into one message.
       */
      const placedWarning = created.policyWarning ?? undefined
      const placedHeld = created.policyApprovalRequired ?? undefined
      if (placedWarning || placedHeld) {
        // A fresh placement is a fresh question: the waivers from a previous
        // refusal chain must not ride along with it.
        setRetryOverrides({})
        setPlaced({ warning: placedWarning, held: placedHeld })
        return
      }
      setSuccess(true)
      router.push('/orders')
      router.refresh()
    } catch (err) {
      setError(err instanceof Error ? err.message : t('orderError', lang))
      const code = err instanceof ApiError ? err.code : undefined
      // Root, and only for the two refusals that HAVE an escape — a code the form
      // does not know is not an invitation to guess at one.
      setRefusal(
        role === 'root' && (code === 'budget_blocked' || code === 'policy_denied') ? code : null,
      )
    } finally {
      setLoading(false)
    }
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
    // Refused here rather than by disabling the button. Clearing the field makes
    // `Number('')` zero, and a disabled <button> is not focusable — so the form
    // used to become unsubmittable in silence, and a screen-reader user tabbing
    // to the end found no submit control at all and nothing saying why (WCAG
    // 3.3.1 — #186). Every other refusal in this form goes through `Alert`.
    if (!quantityValid) {
      setError(quantityMessage)
      return
    }
    await place()
  }

  /**
   * Root's escape from the refusal just shown (#509, #325).
   *
   * The flag follows the refusal that produced it. Both are audited server-side,
   * with the rule or the budget that was waived — so the honest thing to say
   * beside the control is that it is recorded, which is what the hint does.
   */
  async function placeAnyway() {
    await place(refusal === 'budget_blocked' ? { overrideBudget: true } : { overridePolicy: true })
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
    // Named for the argument, not for the component's `sizes`: this prices every
    // environment in the list, including ones that are not the selected one.
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

  /*
   * A placement that came back with something to say (#526).
   *
   * Not the success banner: the order was placed, but not as the person expected —
   * either a rule had something to say about it, or a rule put it in the approvals
   * queue. Navigating to the list would throw the sentence away, which is what the
   * cart learned not to do (#325) and what `policyApprovalRequired` exists to
   * prevent (#517). The link to the orders is here because that is where they were
   * going to be taken.
   */
  if (placed) {
    return (
      <div>
        {placed.held ? (
          <Alert>
            <p className="font-medium">{t('approvalRequired', lang)}</p>
            <p className="mt-1 text-sm">{placed.held}</p>
          </Alert>
        ) : (
          <Alert tone="warning">
            <p className="font-medium">{t('policyWarningNotice', lang)}</p>
            <p className="mt-1 text-sm">{placed.warning}</p>
          </Alert>
        )}
        <Link
          href="/orders"
          className="mt-3 inline-flex min-h-11 items-center rounded-md px-3 text-sm font-medium underline"
        >
          {t('orders', lang)}
        </Link>
      </div>
    )
  }

  return (
    <form onSubmit={handleSubmit} className="space-y-6">
      {error && (
        <Alert>
          {error}
          {/* The escape, and only where there is one to offer (#509). Rendered
              inside the alert rather than as a second message: it is the answer to
              this refusal, and the live region that announced the refusal should
              carry its remedy too. */}
          {refusal && (
            <div className="mt-3">
              <p className="text-sm">{t('placeAnywayHint', lang)}</p>
              <Button
                type="button"
                variant="danger"
                size="sm"
                className="mt-2"
                disabled={loading}
                onClick={placeAnyway}
              >
                {t('placeAnyway', lang)}
              </Button>
            </div>
          )}
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
        // `Input` turns this into aria-invalid plus a described-by message, so
        // the field says what is wrong with it where the user is, as well as at
        // submit time.
        error={quantityValid ? undefined : quantityMessage}
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
          <p className="mt-1 text-xs text-slate-600">{t('overheadCostCenterHint', lang)}</p>
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
            <p className="mt-1 text-xs text-slate-600">
              {`${t('paramsPrefilled', lang)}${templateId}. ${t('paramsPrefilledHint', lang)}`}
            </p>
          )}
          {fromInfraId && templateId === fromInfraId && (
            <p className="mt-1 text-xs text-slate-600" role="status">{t('reorderHint', lang)}</p>
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

      {/* Only `loading` disables it. A quantity the form will refuse is a
          refusal to say out loud, not a control to take away. */}
      <Button type="submit" disabled={loading} className="w-full">
        {loading ? t('submitting', lang) : t('placeOrder', lang)}
      </Button>
    </form>
  )
}
