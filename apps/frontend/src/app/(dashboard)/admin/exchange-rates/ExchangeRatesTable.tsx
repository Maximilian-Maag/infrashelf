'use client'

import {useState, useCallback } from 'react'
import type { ExchangeRate } from '@infrashelf/types'
import { get, post } from '@/lib/api'
import { Card } from '@/components/ui/Card'
import { Alert } from '@/components/ui/Alert'
import { Button } from '@/components/ui/Button'
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
}

export function ExchangeRatesTable({ initial, initialError = null }: Props) {
  const lang = useLang()
  const [rates, setRates] = useState<ExchangeRate[]>(initial)
  // The server already has them, so nothing is pending on arrival.
  const [loading, setLoading] = useState(false)
  const [refreshing, setRefreshing] = useState(false)
  const [error, setError] = useState<string | null>(initialError)

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

  return (
    <Card
      title={t('exchangeRates', lang)}
      action={
        <Button size="sm" variant="secondary" onClick={handleRefresh} disabled={refreshing || loading}>
          {refreshing ? t('refreshing', lang) : t('refreshRates', lang)}
        </Button>
      }
    >
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
              header: t('rateToEur', lang),
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
