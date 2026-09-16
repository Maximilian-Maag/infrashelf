'use client'

import type { Parameter } from '@infrashelf/types'
import { Input } from '@/components/ui/Input'
import { useLang } from '@/lib/useLang'
import { t } from '@/lib/i18n'

interface ParameterFieldsProps {
  parameters: Parameter[]
  values?: Record<string, string>
  onChange: (values: Record<string, string>) => void
}

// Fully controlled: the parent owns `values`, we only render and forward
// changes. An earlier version kept a local copy synchronised through a
// useEffect on `values`, which re-fired every parent render because the
// prop reference changed each time — the effect then called setValues +
// onChange, triggering another parent render, and so on. The infinite
// re-render loop swallowed keystrokes ("hostname does not update") and
// disabled the Cost Center Select ("cannot be selected"). Removing the
// internal state and the sync effect fixes both.
/**
 * What the chosen size sets, shown rather than hidden.
 *
 * A `size` parameter has no input — its value follows from the size — but the
 * customer should still be able to see that "M" means two vCPUs and eight
 * gigabytes rather than having to trust the label. Read-only: the size picker
 * above it is the control.
 *
 * Renders nothing when no size is chosen, when the offering has none, or when
 * no parameter is driven by it, so it costs an ordinary product nothing.
 */
export function SizeDerivedValues({
  parameters,
  sizeCode,
}: {
  parameters: Parameter[]
  sizeCode: string | null | undefined
}) {
  const lang = useLang()
  if (!sizeCode) return null

  const driven = parameters
    .filter((p) => p.type === 'size')
    .map((p) => ({ param: p, value: p.sizeValues?.[sizeCode] ?? '' }))
  if (driven.length === 0) return null

  return (
    <div className="rounded-lg border border-slate-200 bg-slate-50 px-3 py-2">
      <p className="text-xs font-medium text-slate-700">{t('setByTheSize', lang)}</p>
      <dl className="mt-1 space-y-0.5">
        {driven.map(({ param, value }) => (
          <div key={param.id} className="flex justify-between gap-4 text-xs">
            <dt className="text-slate-600">{param.label?.trim() || param.name}</dt>
            <dd className={value === '' ? 'font-mono text-red-600' : 'font-mono text-slate-900'}>
              {/* A size added after the mapping was written. The order would be
                  refused, so saying so here beats a surprise at checkout. */}
              {value === '' ? t('noValueForThisSize', lang) : value}
            </dd>
          </div>
        ))}
      </dl>
    </div>
  )
}

export function ParameterFields({ parameters, values, onChange }: ParameterFieldsProps) {
  const lang = useLang()
  if (parameters.length === 0) return null

  const getValue = (p: Parameter): string => values?.[p.name] ?? p.defaultValue ?? ''
  // Prefer the human-friendly label (manually set or generated from Terraform),
  // falling back to the raw variable name when no label is configured.
  const displayLabel = (p: Parameter): string => p.label?.trim() || p.name

  const update = (name: string, value: string) => {
    onChange({ ...(values ?? {}), [name]: value })
  }

  return (
    <div className="space-y-4">
      {parameters.map((param) => {
        const value = getValue(param)
        // The operator's own explanation of what this parameter is for. The
        // string/number branch below hands it to `Input`, which wires it up;
        // the checkbox and the dropdown draw their own markup, so they have to
        // point at it themselves or it is announced for a text field and
        // silently dropped for the other two (WCAG 1.3.1, 3.3.2 — #186).
        const descriptionId = param.description ? `param-${param.id}-description` : undefined

        // Decided by the chosen size, so there is nothing here to fill in — and
        // a field the customer could contradict would let them buy an S and
        // provision an XL. The values are shown, read-only, by
        // `SizeDerivedValues` beside the size picker, where the choice that
        // produced them is.
        if (param.type === 'size') return null

        if (param.type === 'bool') {
          return (
            <div key={param.id} className="flex items-start gap-3">
              <input
                id={`param-${param.id}`}
                type="checkbox"
                checked={value === 'true'}
                onChange={(e) => update(param.name, e.target.checked ? 'true' : 'false')}
                aria-describedby={descriptionId}
                className="mt-0.5 h-4 w-4 rounded border-slate-300 text-blue-600 focus:ring-blue-500"
              />
              <div>
                <label htmlFor={`param-${param.id}`} className="text-sm font-medium text-slate-700">
                  {displayLabel(param)}
                  {param.required && <span className="ml-1 text-red-600">*</span>}
                </label>
                {param.description && (
                  <p id={descriptionId} className="text-xs text-slate-600">{param.description}</p>
                )}
              </div>
            </div>
          )
        }

        if (param.type === 'dropdown') {
          const options = param.defaultValue.split(',').map((v) => v.trim()).filter(Boolean)
          return (
            <div key={param.id} className="flex flex-col gap-1">
              <label htmlFor={`param-${param.id}`} className="text-sm font-medium text-slate-700">
                {displayLabel(param)}
                {param.required && <span className="ml-1 text-red-600">*</span>}
              </label>
              {param.description && <p id={descriptionId} className="text-xs text-slate-600">{param.description}</p>}
              <select
                id={`param-${param.id}`}
                value={value}
                onChange={(e) => update(param.name, e.target.value)}
                required={param.required}
                aria-describedby={descriptionId}
                className="min-h-11 rounded-lg border border-slate-300 px-3 py-2 text-sm text-slate-900 bg-white focus:outline-none focus:ring-2 focus:ring-blue-500"
              >
                <option value="">{t('selectPlaceholder', lang)}</option>
                {options.map((opt) => (
                  <option key={opt} value={opt}>{opt}</option>
                ))}
              </select>
            </div>
          )
        }

        return (
          <Input
            key={param.id}
            label={displayLabel(param)}
            type={param.type === 'number' ? 'number' : param.sensitive ? 'password' : 'text'}
            value={value}
            onChange={(e) => update(param.name, e.target.value)}
            required={param.required}
            hint={param.description || undefined}
            placeholder={param.defaultValue || undefined}
          />
        )
      })}
    </div>
  )
}
