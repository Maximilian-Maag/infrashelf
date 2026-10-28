'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import type { ProductDetail, AddToCartRequest, CartItem } from '@infrashelf/types'
import { post, get } from '@/lib/api'
import { publishCartCount } from '@/components/layout/CartLink'
import { Button } from '@/components/ui/Button'
import { Alert } from '@/components/ui/Alert'
import { Select } from '@/components/ui/Select'
import { Input } from '@/components/ui/Input'
import { SizeDerivedValues } from '@/components/forms/ParameterFields'
import { SizeSwatches } from '@/components/forms/SizeSwatches'
import { t } from '@/lib/i18n'
import { localeToCurrency, convertPrice, sortByValue } from '@/lib/locale'

interface Props {
  product: ProductDetail
  /** Fetched server-side; needed here because the price now follows the choice. */
  ratesMap: Record<string, number>
  /** The currency the stored rates are quoted against (FA-11.3), default EUR. */
  baseCurrency: string
  lang: string
}

/** Mirrors MAX_ORDER_QUANTITY in the backend, which re-checks it. */
const MAX_QUANTITY = 20

/**
 * "Add to cart" in the buy box (issues #28 / #98 / #104).
 *
 * Asks for environment, size and quantity — the three things that make up a line —
 * and nothing else. Parameters are left for checkout: the whole point of a cart is
 * to collect first and fill in once, so demanding them here would make adding to
 * the cart as much work as ordering outright. The size is NOT in that category: it
 * decides the price the line is shown at, so a line without one has no price.
 */
export function AddToCart({ product, ratesMap, baseCurrency, lang }: Props) {
  const router = useRouter()
  const [environmentId, setEnvironmentId] = useState(
    product.environments.length === 1 ? String(product.environments[0].environmentId) : '',
  )
  const [sizeCode, setSizeCode] = useState('')
  const [quantity, setQuantity] = useState('1')
  const [busy, setBusy] = useState(false)
  const [added, setAdded] = useState(false)
  const [error, setError] = useState<string | null>(null)

  if (product.environments.length === 0) return null

  const selectedEnv = product.environments.find((e) => String(e.environmentId) === environmentId)
  const sizes = selectedEnv?.sizes ?? []
  // An offering with no sizes prices off itself, so there is nothing to pick and
  // the control is not rendered at all.
  const needsSize = sizes.length > 0
  const parsedQuantity = Number(quantity)
  const quantityValid =
    Number.isInteger(parsedQuantity) && parsedQuantity >= 1 && parsedQuantity <= MAX_QUANTITY

  async function handleAdd() {
    setBusy(true)
    setError(null)
    try {
      const body: AddToCartRequest = {
        productId: product.id,
        environmentId: Number(environmentId),
        // Only when the offering has sizes: sending one to an offering without any
        // is refused, and switching environment must not smuggle the old code
        // through.
        ...(needsSize ? { sizeCode } : {}),
        ...(parsedQuantity > 1 ? { quantity: parsedQuantity } : {}),
      }
      await post('/api/cart', body)
      setAdded(true)
      // Tell the header badge straight away — a shopper's confirmation that the
      // click landed is the count going up, and waiting for the server round trip
      // of router.refresh() to repaint the shell reads as a dead button.
      try {
        const items = await get<CartItem[]>(`/api/cart?lang=${lang}`)
        publishCartCount((items ?? []).length)
      } catch { /* the refresh below still corrects the badge */ }
      router.refresh()
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to add to the cart.')
    } finally {
      setBusy(false)
    }
  }

  /*
   * The headline price, following the selection.
   *
   * It used to be rendered by the page, server-side, as the cheapest thing the
   * product could be bought for — a "from" price that never moved. But the size
   * IS the price here, so picking XL and watching the figure stay at the S price
   * is the one thing a buy box must not do.
   *
   * Three cases, narrowing as the shopper decides: the chosen size's price; the
   * cheapest in the chosen environment; the cheapest anywhere. Each is exactly
   * the answer to "what would this cost me right now".
   */
  const chosenSize = sizes.find((size) => size.code === sizeCode)
  const amountsIn = (env: typeof product.environments[number]) =>
    env.sizes && env.sizes.length > 0
      ? env.sizes.map((size) => ({ price: size.price, currency: size.currency }))
      : [{ price: env.price, currency: env.currency }]

  const amount = chosenSize
    ? { price: chosenSize.price, currency: chosenSize.currency }
    : sortByValue(
      selectedEnv ? amountsIn(selectedEnv) : product.environments.flatMap(amountsIn),
      ratesMap,
      baseCurrency,
    )[0]

  const shown = amount
    ? convertPrice(amount.price, amount.currency, localeToCurrency(lang), ratesMap, lang, baseCurrency)
    : null
  // Kept when the viewer's currency is not the one the offering is priced in:
  // the converted figure is a courtesy, the stored one is what is charged.
  const original =
    amount && shown && shown.currency !== amount.currency
      ? `${amount.price} ${amount.currency}`
      : null

  return (
    <div className="space-y-3">
      {shown && (
        <div>
          <p className="text-2xl font-bold text-slate-900">
            {shown.amount} {shown.currency}
          </p>
          {original && <p className="text-xs text-slate-700">{original}</p>}
          {/* slate-700, not the slate-500 this replaced: 4.76:1 is under the 7:1
              this repo holds itself to, and 12px text is not large text. */}
          {product.environments.length > 1 && selectedEnv && (
            <p className="mt-0.5 text-xs text-slate-700">
              {selectedEnv.environmentName ?? `Env ${selectedEnv.environmentId}`}
            </p>
          )}
        </div>
      )}
      {error && <Alert>{error}</Alert>}
      {added && <Alert tone="success">{t('addedToCart', lang)}</Alert>}
      <Select
        label={t('environment', lang)}
        value={environmentId}
        onChange={(e) => {
          setEnvironmentId(e.target.value)
          // The sizes belong to the offering, so a code chosen for one environment
          // means nothing in another.
          setSizeCode('')
          setAdded(false)
        }}
        options={[
          { value: '', label: t('selectEnvironment', lang) },
          ...product.environments.map((env) => ({
            value: env.environmentId,
            label: env.environmentName ?? `Env ${env.environmentId}`,
          })),
        ]}
      />

      {/* Swatches, not a dropdown. The size IS the price, and a dropdown shows
          one option at a time — so comparing what S, M and XL cost meant opening
          it and reading down a list. Every option and its price are visible at
          once, and which one is selected is visible without opening anything. */}
      {needsSize && (
        <SizeSwatches
          sizes={sizes}
          value={sizeCode}
          onChange={(code) => { setSizeCode(code); setAdded(false) }}
          lang={lang}
        />
      )}

      {/* What the chosen size actually sets. A `size` parameter has no input —
          the picker above IS its control — but "M" should not be a word the
          shopper has to take on trust. */}
      {needsSize && (
        <SizeDerivedValues parameters={product.parameters} sizeCode={sizeCode} />
      )}

      <Input
        label={t('quantity', lang)}
        type="number"
        min={1}
        max={MAX_QUANTITY}
        step={1}
        value={quantity}
        onChange={(e) => { setQuantity(e.target.value); setAdded(false) }}
      />

      {/* Plain primary: the branding's secondary colour is the app's CTA colour, and
          Button now draws it with a --bs-edge boundary so even a near-white one is a
          visible control. The radius comes from style, not a class: two competing
          rounded-* utilities resolve by stylesheet order, not source order. */}
      <Button
        onClick={handleAdd}
        disabled={busy || !environmentId || (needsSize && !sizeCode) || !quantityValid}
        className="w-full"
        style={{ borderRadius: '9999px' }}
      >
        {t('addToCart', lang)}
      </Button>
    </div>
  )
}
