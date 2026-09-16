'use client'

import { useEffect, useState } from 'react'
import type { ProductVersion, ProductVersionDiff } from '@infrashelf/types'
import { get } from '@/lib/api'
import { Alert } from '@/components/ui/Alert'
import { Button } from '@/components/ui/Button'
import { Select } from '@/components/ui/Select'
import { t } from '@/lib/i18n'

interface Props {
  productId: number
  lang?: string
}

/**
 * One value in a diff, with `∅` said out loud.
 *
 * Most voices skip the glyph, so an emptied field read as `price 12.00` — with
 * no way to tell whether the price IS that or BECAME it. This is the audit
 * trail for catalogue prices (#186).
 */
function DiffValue({ value, lang, className }: { value: string; lang: string; className: string }) {
  if (value) return <span className={`font-mono text-xs ${className}`}>{value}</span>
  return (
    <span className={`font-mono text-xs ${className}`}>
      <span aria-hidden="true">∅</span>
      <span className="sr-only">{` ${t('emptyValue', lang)}`}</span>
    </span>
  )
}

/**
 * An old value and a new one, said as well as drawn.
 *
 * What separates the two on screen is a colour, a strikethrough and an arrow —
 * and none of the three reaches a screen reader: `line-through` is not
 * announced by default by NVDA, JAWS or VoiceOver, and the arrow is hidden. A
 * root admin reviewing what a change did heard `price 10.00 12.00` and had to
 * guess which way round it went (WCAG 1.4.1, 1.3.1 — #186).
 */
function ValueChange({ from, to, lang }: { from: string; to: string; lang: string }) {
  return (
    <>
      <span className="sr-only">{`${t('changedFrom', lang)} `}</span>
      <DiffValue value={from} lang={lang} className="text-red-700 line-through" />{' '}
      {/* The arrow is the only thing that carries the direction on screen, and
          it is hidden; the word beside it is the only thing that carries it to
          a reader, and it is invisible. Both, in that order. */}
      <span aria-hidden="true">→</span>
      <span className="sr-only">{` ${t('changedTo', lang)}`}</span>{' '}
      <DiffValue value={to} lang={lang} className="text-green-700" />
    </>
  )
}

/**
 * Catalogue change history for a product, with a diff between any two entries
 * (issue #38).
 *
 * Loaded on mount rather than server-rendered with the page: the history is a
 * reference panel, and a slow or failing read of it must not delay or break the
 * edit form above it.
 */
export function ProductVersionHistory({ productId, lang = 'en' }: Props) {
  const [versions, setVersions] = useState<ProductVersion[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [fromId, setFromId] = useState('')
  const [toId, setToId] = useState('')
  const [diff, setDiff] = useState<ProductVersionDiff | null>(null)
  const [diffError, setDiffError] = useState<string | null>(null)

  useEffect(() => {
    let stale = false
    get<ProductVersion[]>(`/api/admin/products/${productId}/versions`)
      .then((rows) => {
        if (stale) return
        const list = rows ?? []
        setVersions(list)
        // Preselect the most recent pair that can actually be compared, so the
        // common case — "what did my last change do?" — is one click.
        const comparable = list.filter((v) => v.snapshot !== null)
        if (comparable.length >= 2) {
          setToId(String(comparable[0].id))
          setFromId(String(comparable[1].id))
        }
      })
      .catch((e) => { if (!stale) setError(e instanceof Error ? e.message : 'Failed to load the history.') })
      .finally(() => { if (!stale) setLoading(false) })
    return () => { stale = true }
  }, [productId])

  async function handleCompare() {
    setDiffError(null)
    setDiff(null)
    try {
      setDiff(
        await get<ProductVersionDiff>(
          `/api/admin/products/${productId}/versions/diff?from=${fromId}&to=${toId}`,
        ),
      )
    } catch (e) {
      setDiffError(e instanceof Error ? e.message : 'Failed to compare the versions.')
    }
  }

  // Only entries with a snapshot can be diffed; a product-level change (a rename)
  // has no offering configuration to compare.
  const comparable = versions.filter((v) => v.snapshot !== null)
  const options = comparable.map((v) => ({
    value: v.id,
    label: `#${v.id} · ${new Date(v.createdAt).toLocaleString(lang)} · ${v.summary}`,
  }))

  if (loading) return <p className="text-sm text-slate-600">{t('loading', lang)}</p>
  if (error) return <Alert>{error}</Alert>

  return (
    <div className="space-y-4">
      {versions.length === 0 ? (
        <p className="text-sm text-slate-600">{t('noVersionHistory', lang)}</p>
      ) : (
        <div className="overflow-x-auto">
          <table className="min-w-full text-sm divide-y divide-slate-100">
            <thead>
              <tr>
                <th className="text-left py-2 pr-4 font-medium text-slate-600">{t('date', lang)}</th>
                <th className="text-left py-2 pr-4 font-medium text-slate-600">{t('environment', lang)}</th>
                <th className="text-left py-2 pr-4 font-medium text-slate-600">{t('changes', lang)}</th>
                <th className="text-left py-2 pr-4 font-medium text-slate-600">{t('changelog', lang)}</th>
                <th className="text-left py-2 font-medium text-slate-600">{t('user', lang)}</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {versions.map((version) => (
                <tr key={version.id} data-testid={`version-${version.id}`}>
                  <td className="py-2 pr-4 text-xs text-slate-600 whitespace-nowrap">
                    {new Date(version.createdAt).toLocaleString(lang)}
                  </td>
                  <td className="py-2 pr-4 text-xs text-slate-600">
                    {/* A dash rather than a blank: a product-level change genuinely
                        has no environment, which is different from missing data. */}
                    {version.environmentName ?? '—'}
                  </td>
                  <td className="py-2 pr-4 text-xs text-slate-900">{version.summary}</td>
                  <td className="py-2 pr-4 text-xs text-slate-700 whitespace-pre-wrap">
                    {version.changelog || '—'}
                  </td>
                  <td className="py-2 text-xs text-slate-600">{version.authorName ?? t('system', lang)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {comparable.length >= 2 && (
        <div className="border-t border-slate-100 pt-4 space-y-3">
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <Select
              label={t('fromDate', lang)}
              value={fromId}
              onChange={(e) => { setFromId(e.target.value); setDiff(null) }}
              options={options}
            />
            <Select
              label={t('toDate', lang)}
              value={toId}
              onChange={(e) => { setToId(e.target.value); setDiff(null) }}
              options={options}
            />
          </div>
          <Button size="sm" onClick={handleCompare} disabled={!fromId || !toId}>
            {t('compare', lang)}
          </Button>

          {diffError && <Alert>{diffError}</Alert>}

          {diff && (
            /* `relative` for the `sr-only` spans inside. Tailwind's sr-only is
               position: absolute, and with no positioned ancestor it is laid
               out against the initial containing block — escaping any scroll
               container and widening the document (#167). */
            <div data-testid="version-diff" className="relative rounded-lg border border-slate-200 p-3 space-y-2">
              {diff.identical ? (
                <p className="text-sm text-slate-600">{t('noChanges', lang)}</p>
              ) : (
                <>
                  {diff.fields.map((change) => (
                    <p key={change.field} className="text-sm">
                      <span className="font-medium text-slate-900">{change.field}</span>{' '}
                      <ValueChange from={change.from} to={change.to} lang={lang} />
                    </p>
                  ))}
                  {diff.parameters.map((change) => (
                    <p key={`${change.kind}-${change.name}`} className="text-sm">
                      <span className="rounded bg-slate-100 px-1.5 py-0.5 text-xs font-medium text-slate-700">
                        {t(change.kind === 'added' ? 'added' : change.kind === 'removed' ? 'removed' : 'changed', lang)}
                      </span>{' '}
                      <span className="font-mono text-xs text-slate-900">{change.name}</span>
                      {change.kind === 'changed' && (
                        <span className="text-xs text-slate-600">
                          {/* Elements rather than a joined string: the same
                              direction has to be spoken here as in the field
                              list above, and a string cannot carry it. */}
                          {change.fields.map((f, i) => (
                            <span key={f.field}>
                              {i === 0 ? ' — ' : ', '}
                              {`${f.field}: `}
                              <ValueChange from={f.from} to={f.to} lang={lang} />
                            </span>
                          ))}
                        </span>
                      )}
                    </p>
                  ))}
                </>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  )
}
