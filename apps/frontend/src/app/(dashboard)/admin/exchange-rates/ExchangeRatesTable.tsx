'use client'

import { useState, useCallback } from 'react'
import type { ExchangeRate } from '@infrashelf/types'
import { get, post, put } from '@/lib/api'
import { Card } from '@/components/ui/Card'
import { Alert } from '@/components/ui/Alert'
import { Button } from '@/components/ui/Button'
import { Input } from '@/components/ui/Input'
import { Table } from '@/components/ui/Table'
import { useLang } from '@/lib/useLang'
import { t } from '@/lib/i18n'

interface Props {
  /**
   * The rates the SERVER already fetched (#456). Every price in the app is
   * converted with these, and the table asked for them on mount — so the page
   * arrived, showed a spinner, and only then asked. `load()` stays for the
   * reload after a refresh, which is a response to an action.
   */
  initial: ExchangeRate[]
  /** Why the server could not fetch them, if it could not (#415). */
  initialError?: string | null
  /**
   * The base currency the stored rates are quoted against (FA-11.3), read on the
   * server alongside the rates. EUR until root sets otherwise.
   */
  initialBaseCurrency?: string
}

export function ExchangeRatesTable({ initial, initialError = null, initialBaseCurrency = 'EUR' }: Props) {
  const lang = useLang()
  const [rates, setRates] = useState<ExchangeRate[]>(initial)
  // The server already has them, so nothing is pending on arrival.
  const [loading, setLoading] = useState(false)
  const [refreshing, setRefreshing] = useState(false)
  const [error, setError] = useState<string | null>(initialError)

  /*
   * The base currency is a setting, not a row of the table (FA-11.3). `draft` is
   * what the field holds while the operator types; `baseCurrency` is what is
   * actually configured, and what the column header is labelled with — so a
   * half-typed code never relabels the rates.
   */
  const [baseCurrency, setBaseCurrency] = useState(initialBaseCurrency)
  const [draft, setDraft] = useState(initialBaseCurrency)
  const [savingBase, setSavingBase] = useState(false)
  const [baseError, setBaseError] = useState<string | null>(null)
  const [baseSaved, setBaseSaved] = useState(false)

  const load = useCallback(async () => {
    setLoading(true)
    try {
      setRates((await get<ExchangeRate[]>('/api/admin/exchange-rates')) ?? [])
    } catch (e) {
      setError(e instanceof Error ? e.message : t('failedToLoadExchangeRates', lang))
    } finally {
      setLoading(false)
    }
  }, [lang])

  async function handleRefresh() {
    setRefreshing(true)
    setError(null)
    try {
      await post('/api/admin/exchange-rates/refresh', {})
      await load()
    } catch (e) {
      setError(e instanceof Error ? e.message : t('failedToRefreshRates', lang))
    } finally {
      setRefreshing(false)
    }
  }

  /**
   * Change the base currency.
   *
   * The backend re-bases every stored rate onto the new currency, so the figures
   * on screen are stale the moment this succeeds — the reload is not a courtesy,
   * it is the only way the table can still be true. The 409 (no rate stored for
   * the requested currency) is surfaced verbatim: it says what to do about it.
   */
  async function handleSaveBase(e: React.FormEvent) {
    e.preventDefault()
    setSavingBase(true)
    setBaseError(null)
    setBaseSaved(false)
    try {
      const saved = await put<{ baseCurrency: string }>('/api/admin/exchange-rates/base-currency', {
        baseCurrency: draft.trim(),
      })
      setBaseCurrency(saved.baseCurrency)
      setDraft(saved.baseCurrency)
      setBaseSaved(true)
      await load()
    } catch (err) {
      setBaseError(err instanceof Error ? err.message : t('failedToSaveBaseCurrency', lang))
    } finally {
      setSavingBase(false)
    }
  }

  return (
    <Card
      title={t('exchangeRates', lang)}
      action={
        <Button size="sm" variant="secondary" onClick={handleRefresh} disabled={refreshing || loading}>
          {refreshing ? t('refreshing', lang) : t('refreshRates', lang)}
        </Button>
      }
    >
      {/* The base currency first: it is what every figure below MEANS, and it is
          the one control here that changes them all at once. */}
      <form className="mb-4 border-b border-slate-200 pb-4" onSubmit={handleSaveBase}>
        <div className="flex items-end gap-2">
          <div className="w-40">
            <Input
              label={t('baseCurrency', lang)}
              hint={t('baseCurrencyHint', lang)}
              value={draft}
              onChange={(e) => { setDraft(e.target.value.toUpperCase()); setBaseSaved(false) }}
              maxLength={8}
              autoComplete="off"
              spellCheck={false}
              className="font-mono uppercase"
            />
          </div>
          <Button type="submit" size="sm" disabled={savingBase || draft.trim() === ''}>
            {savingBase ? t('saving', lang) : t('save', lang)}
          </Button>
        </div>
        {baseError && <Alert className="mt-3">{baseError}</Alert>}
        {baseSaved && <Alert tone="success" className="mt-3">{t('baseCurrencySavedToast', lang)}</Alert>}
      </form>

      {error && (
        <Alert className="mb-4">{error}</Alert>
      )}

      {loading ? (
        <div className="flex justify-center py-8">
          <div className="h-8 w-8 animate-spin rounded-full border-4 border-slate-200 border-t-blue-600" />
        </div>
      ) : (
        <Table<ExchangeRate & { id: string }>
          columns={[
            {
              header: t('currency', lang),
              render: (row) => (
                <span className="font-mono font-semibold text-slate-900">{row.currencyCode}</span>
              ),
            },
            {
              // Labelled with the base the rates are actually quoted against,
              // rather than a hardcoded "(to EUR)" that lies once root changes it.
              header: `${t('rate', lang)} (${baseCurrency})`,
              render: (row) => (
                <span className="font-mono">{Number(row.rate).toFixed(6)}</span>
              ),
            },
            {
              header: t('lastUpdated', lang),
              render: (row) => (
                <span className="text-xs text-slate-600">
                  {new Date(row.updatedAt).toLocaleString(lang)}
                </span>
              ),
            },
          ]}
          data={rates.map((r) => ({ ...r, id: r.currencyCode }))}
          emptyMessage={t('noExchangeRates', lang)}
        />
      )}
    </Card>
  )
}
