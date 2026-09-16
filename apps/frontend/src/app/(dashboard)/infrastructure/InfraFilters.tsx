'use client'

import { useEffect, useState, useTransition } from 'react'
import { useRouter, usePathname, useSearchParams } from 'next/navigation'
import type { InfraFacets } from '@infrashelf/types'
import { Input } from '@/components/ui/Input'
import { Select } from '@/components/ui/Select'
import { Button } from '@/components/ui/Button'
import { t } from '@/lib/i18n'

/**
 * Prepend a selectable "no filter" option.
 *
 * Select's own `placeholder` renders as a DISABLED option, which is correct for a
 * required field but wrong for a filter — once a value had been picked, "all"
 * would be unreachable and the only way back would be Clear filters.
 */
const anyOption = (label: string, options: { value: string | number; label: string }[]) =>
  [{ value: '', label }, ...options]

interface Props {
  facets: InfraFacets
  lang: string
  /** Number of rows the current filters produced, for the live-region summary. */
  resultCount: number
}

/**
 * Filter bar for the infrastructure list.
 *
 * The filters live in the URL rather than in component state: the page is a
 * server component that reads them from `searchParams`, so a filtered view is
 * bookmarkable and survives a reload, and the list is filtered by the database
 * rather than in the browser. Every control therefore writes to the URL and lets
 * the server re-render.
 */
export function InfraFilters({ facets, lang, resultCount }: Props) {
  const router = useRouter()
  const pathname = usePathname()
  const searchParams = useSearchParams()
  const [isPending, startTransition] = useTransition()

  // The text input is the one control that cannot write straight through: a
  // navigation per keystroke would both hammer the API and fight the caret.
  const urlSearch = searchParams.get('search') ?? ''
  const [search, setSearch] = useState(urlSearch)

  /*
   * Adopt the URL value when it changes from the outside (back/forward, or the
   * Clear button) without clobbering what is being typed — during render rather
   * than in an effect (#462).
   *
   * As an effect the box showed the OLD text for a frame after a Back, which on
   * a filter bar reads as the navigation not having happened. Setting state
   * during render is React's answer for a prop, or a URL, that state mirrors: it
   * re-runs this component before committing, so the stale value never paints.
   */
  const [shownUrlSearch, setShownUrlSearch] = useState(urlSearch)
  if (urlSearch !== shownUrlSearch) {
    setShownUrlSearch(urlSearch)
    setSearch(urlSearch)
  }

  useEffect(() => {
    if (search === urlSearch) return
    const id = setTimeout(() => apply({ search }), 300)
    return () => clearTimeout(id)
    // `apply` itself is deliberately left out of this list: it is a fresh
    // closure every render, and including it would re-run this effect (and
    // restart the timer) on every unrelated re-render. `searchParams` DOES
    // have to be here even though it is only read inside `apply`, not this
    // effect body: `apply` merges its argument into `searchParams`, so a
    // filter picked while this timer is still pending must be reflected in
    // the merge when the timer fires — otherwise it fires with the
    // `searchParams` captured back when the timer was scheduled, and
    // `router.replace`s the picked filter straight back out (#138). The
    // `search === urlSearch` guard above is what stops this from looping on
    // the navigation this effect's own `apply` call causes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [search, urlSearch, searchParams])

  function apply(changes: Record<string, string>) {
    const next = new URLSearchParams(searchParams.toString())
    for (const [key, value] of Object.entries(changes)) {
      // Drop empty values so a cleared filter leaves a clean, shareable URL
      // rather than a trail of `&status=&search=`.
      if (value === '' || value === 'all') next.delete(key)
      else next.set(key, value)
    }
    const qs = next.toString()
    startTransition(() => {
      // replace, not push: dragging a date picker or retyping a search term
      // should not bury the previous page under a dozen history entries.
      router.replace(qs ? `${pathname}?${qs}` : pathname)
    })
  }

  const value = (key: string) => searchParams.get(key) ?? ''
  const activeCount = ['search', 'status', 'environmentId', 'projectId', 'productId', 'deployedFrom', 'deployedTo']
    .filter((key) => value(key) !== '').length

  return (
    <div className="rounded-xl border border-slate-200 bg-white p-4 space-y-3">
      <div className="flex items-center justify-between">
        <h2 className="text-sm font-semibold text-slate-900">
          {t('filters', lang)}
          {activeCount > 0 && (
            <span className="ml-2 rounded-full bg-blue-100 px-2 py-0.5 text-xs font-medium text-blue-700">
              {activeCount}
            </span>
          )}
        </h2>
        {activeCount > 0 && (
          <Button
            size="sm"
            variant="secondary"
            onClick={() => startTransition(() => router.replace(pathname))}
          >
            {t('clearFilters', lang)}
          </Button>
        )}
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3">
        <Input
          label={t('search', lang)}
          type="search"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder={t('searchProducts', lang)}
        />
        <Select
          label={t('status', lang)}
          value={value('status')}
          onChange={(e) => apply({ status: e.target.value })}
          options={anyOption(t('allStatuses', lang), [
            // Every value here is a badge the list can render, and every badge
            // the list can render is here. Two of them are states of the ORDER
            // rather than of the element — a machine still being built and one
            // whose pipeline failed are both stored 'active' — and leaving
            // either out makes 'active' quietly include it (#287).
            { value: 'provisioning', label: t('statusProvisioning', lang) },
            { value: 'active', label: t('statusActive', lang) },
            { value: 'failed', label: t('statusFailed', lang) },
            { value: 'decommissioning', label: t('decommissioning', lang) },
            { value: 'decommissioned', label: t('statusDecommissioned', lang) },
          ])}
        />
        <Select
          label={t('environment', lang)}
          value={value('environmentId')}
          onChange={(e) => apply({ environmentId: e.target.value })}
          options={anyOption(t('allEnvironments', lang), facets.environments.map((e) => ({ value: e.id, label: e.name })))}
        />
        <Select
          label={t('project', lang)}
          value={value('projectId')}
          onChange={(e) => apply({ projectId: e.target.value })}
          options={anyOption(t('allProjects', lang), facets.projects.map((p) => ({ value: p.id, label: p.name })))}
        />
        <Select
          label={t('product', lang)}
          value={value('productId')}
          onChange={(e) => apply({ productId: e.target.value })}
          options={anyOption(t('allProductsFilter', lang), facets.products.map((p) => ({ value: p.id, label: p.name })))}
        />
        <Input
          label={t('deployedFrom', lang)}
          type="date"
          value={value('deployedFrom')}
          onChange={(e) => apply({ deployedFrom: e.target.value })}
        />
        <Input
          label={t('deployedTo', lang)}
          type="date"
          value={value('deployedTo')}
          onChange={(e) => apply({ deployedTo: e.target.value })}
        />
        <Select
          label={t('sortBy', lang)}
          value={`${value('sort') || 'date'}:${value('direction') || 'desc'}`}
          onChange={(e) => {
            const [sort, direction] = e.target.value.split(':')
            apply({ sort, direction })
          }}
          options={[
            { value: 'date:desc', label: t('sortNewestFirst', lang) },
            { value: 'date:asc', label: t('sortOldestFirst', lang) },
            { value: 'name:asc', label: `${t('name', lang)} A–Z` },
            { value: 'name:desc', label: `${t('name', lang)} Z–A` },
            { value: 'status:asc', label: t('status', lang) },
          ]}
        />
      </div>

      {/* Announced rather than merely drawn: a filter change re-renders the list
          below without moving focus, so a screen-reader user would otherwise get
          no feedback that anything happened. */}
      <p className="text-xs text-slate-600" role="status" aria-live="polite" aria-busy={isPending}>
        {resultCount} {t('matchingElements', lang)}
      </p>
    </div>
  )
}
