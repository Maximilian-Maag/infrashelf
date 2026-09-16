import { t } from '@/lib/i18n'

interface Props {
  /** Orders whose price came from the live offering rather than their own snapshot. */
  estimatedOrders: number
  /** Amounts with no stored exchange rate; counted at zero, not silently as EUR. */
  unconverted: { currency: string; amount: number }[]
  /**
   * Orders with no recoverable price at all — no snapshot, and the offering they
   * were placed against has since been withdrawn (#189).
   *
   * The strongest caveat on this card: an estimated order is counted at a price
   * that may be wrong, and an unconverted one is reported in its own currency,
   * but this one is money that is simply missing from the total.
   */
  unpricedOrders?: number
  lang: string
  /** The current month is still running, so its figure will grow. Trend/comparison only. */
  monthInProgress?: boolean
}

/**
 * The precision caveats, repeated wherever a figure is drawn (issue #106).
 *
 * The total card has shown these since #32. A chart is where they matter more, not
 * less: a column per month looks exactly like a monthly run rate, and the catalogue
 * stores no billing period, so a trend drawn from these numbers is a trend of
 * recorded order prices and nothing else. Estimated and unconverted amounts move
 * the columns without appearing in them.
 *
 * Duplicated deliberately rather than printed once at the top of the page: a card
 * can be read, screenshotted or scrolled to on its own, and a caveat that is not
 * attached to the figure is a caveat nobody sees.
 */
export function CostCaveats({ estimatedOrders, unconverted, unpricedOrders = 0, lang, monthInProgress }: Props) {
  return (
    <div className="mt-3 space-y-1 border-t border-slate-100 pt-2">
      <p className="text-xs text-slate-600">{t('notAProjection', lang)}</p>
      {monthInProgress && <p className="text-xs text-slate-600">{t('monthInProgress', lang)}</p>}
      {estimatedOrders > 0 && (
        <p className="text-xs text-amber-700">
          {t('estimatedNotice', lang)} ({estimatedOrders})
        </p>
      )}
      {unconverted.length > 0 && (
        <p className="text-xs text-amber-700">
          {t('unconvertedNotice', lang)}{' '}
          {unconverted.map((u) => `${u.amount.toFixed(2)} ${u.currency}`).join(', ')}
        </p>
      )}
      {unpricedOrders > 0 && (
        <p className="text-xs text-red-700">
          {t('unpricedNotice', lang)} ({unpricedOrders})
        </p>
      )}
    </div>
  )
}
