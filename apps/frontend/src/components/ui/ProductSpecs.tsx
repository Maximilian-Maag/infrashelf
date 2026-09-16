import type { Parameter } from '@infrashelf/types'
import { t } from '@/lib/i18n'

interface Props {
  /** The definitions from `GET /api/catalog/{id}` — already resolved per scope. */
  parameters: Parameter[]
  lang: string
}

/**
 * One column's value across a name's environment variants, or null when they
 * disagree. None of the columns is nullable in `Parameter`, so null is free to
 * mean "no single answer".
 */
function agreed<T>(group: Parameter[], pick: (p: Parameter) => T): T | null {
  const first = pick(group[0])
  return group.every((p) => pick(p) === first) ? first : null
}

/**
 * The product's parameter definitions as a specification table (issue #107).
 *
 * These are the closest thing this catalogue has to a "technical details" table,
 * and until now they were only visible once you scrolled into the order form —
 * which meant "what am I actually getting" could not be answered from the part of
 * the page that describes the product.
 *
 * A real `<table>` with header cells, not a grid of divs: the relationship between
 * "Default" and the value under it is what makes the table readable at all, and
 * that relationship only exists for a screen reader if the markup says so.
 */
export function ProductSpecs({ parameters, lang }: Props) {
  if (parameters.length === 0) return null

  // The detail endpoint resolves scope precedence but keeps one definition per
  // (name, environment) while no environment is selected — which is how this page
  // always loads it, since the environment is picked later, in the order form. So
  // the same name arrives more than once, with values that need not match.
  //
  // Grouped by name, and a value is shown only where every environment agrees on
  // it; where they disagree the cell says so. Keeping one variant per name (what
  // this did before) would print one environment's default and "required" under a
  // name that means something else elsewhere, with nothing on screen to reveal it.
  // Splitting into a row per environment was the alternative, and it loses: before
  // anyone has chosen an environment those rows are noise, and the order form
  // re-reads this endpoint with the chosen one and shows the exact values there.
  const byName = new Map<string, Parameter[]>()
  for (const parameter of parameters) {
    const group = byName.get(parameter.name)
    if (group) group.push(parameter)
    else byName.set(parameter.name, [parameter])
  }

  const rows = [...byName.values()].sort((a, b) =>
    (a[0].label || a[0].name).localeCompare(b[0].label || b[0].name, undefined, { sensitivity: 'base' }),
  )

  return (
    <div className="overflow-x-auto rounded-lg border border-slate-200">
      <table className="min-w-full divide-y divide-slate-200 text-sm">
        <caption className="sr-only">{t('specifications', lang)}</caption>
        <thead className="bg-slate-50">
          <tr>
            <th scope="col" className="px-4 py-2 text-left text-xs font-semibold uppercase tracking-wider text-slate-600">
              {t('parameter', lang)}
            </th>
            <th scope="col" className="px-4 py-2 text-left text-xs font-semibold uppercase tracking-wider text-slate-600">
              {t('type', lang)}
            </th>
            <th scope="col" className="px-4 py-2 text-left text-xs font-semibold uppercase tracking-wider text-slate-600">
              {t('defaultValue', lang)}
            </th>
            <th scope="col" className="px-4 py-2 text-left text-xs font-semibold uppercase tracking-wider text-slate-600">
              {t('required', lang)}
            </th>
          </tr>
        </thead>
        <tbody className="divide-y divide-slate-100 bg-white">
          {rows.map((group) => {
            const parameter = group[0]
            const type = agreed(group, (p) => p.type)
            const required = agreed(group, (p) => p.required)
            const defaultValue = agreed(group, (p) => p.defaultValue)
            // One environment marking it sensitive is enough to redact: the value
            // is the same kind of secret wherever it is shown.
            const sensitive = group.some((p) => p.sensitive)

            return (
              <tr key={parameter.name}>
                {/* A row header, so a screen reader announces which parameter each
                    cell belongs to instead of reading four loose values. */}
                <th scope="row" className="px-4 py-2 text-left align-top font-medium text-slate-900">
                  {parameter.label || parameter.name}
                  {parameter.description && (
                    <span className="mt-0.5 block text-xs font-normal text-slate-600">
                      {parameter.description}
                    </span>
                  )}
                </th>
                <td className="px-4 py-2 align-top text-slate-700">
                  {type === null ? t('perEnvironment', lang) : type}
                </td>
                <td className="px-4 py-2 align-top text-slate-700">
                  {/* A sensitive parameter's default is still a secret — the order
                      detail page redacts these for the same reason. */}
                  {sensitive && defaultValue !== ''
                    ? t('sensitiveRedacted', lang)
                    : defaultValue === null
                      ? t('perEnvironment', lang)
                      : defaultValue || '—'}
                </td>
                <td className="px-4 py-2 align-top text-slate-700">
                  {required === null
                    ? t('perEnvironment', lang)
                    : required
                      ? t('yes', lang)
                      : t('no', lang)}
                </td>
              </tr>
            )
          })}
        </tbody>
      </table>
    </div>
  )
}
