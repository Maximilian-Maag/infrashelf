'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import type { ProductDetail, AddToCartRequest, CartItem } from '@open-hybrid-cloud/types'
import { post, get } from '@/lib/api'
import { publishCartCount } from '@/components/layout/CartLink'
import { Button } from '@/components/ui/Button'
import { Alert } from '@/components/ui/Alert'
import { Select } from '@/components/ui/Select'
import { Input } from '@/components/ui/Input'
import { t } from '@/lib/i18n'

interface Props {
  product: ProductDetail
  token: string
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
export function AddToCart({ product, token, lang }: Props) {
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
      await post(`/api/cart?lang=${lang}`, body, token)
      setAdded(true)
      // Tell the header badge straight away — a shopper's confirmation that the
      // click landed is the count going up, and waiting for the server round trip
      // of router.refresh() to repaint the shell reads as a dead button.
      try {
        const items = await get<CartItem[]>(`/api/cart?lang=${lang}`, token)
        publishCartCount((items ?? []).length)
      } catch { /* the refresh below still corrects the badge */ }
      router.refresh()
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to add to the cart.')
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="space-y-3">
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

      {needsSize && (
        <Select
          label={t('size', lang)}
          value={sizeCode}
          onChange={(e) => { setSizeCode(e.target.value); setAdded(false) }}
          options={[
            { value: '', label: t('selectSize', lang) },
            // The price is in the option label: the size IS the price now, and a
            // picker of bare letters asks the shopper to guess what XL costs.
            ...sizes.map((size) => ({
              value: size.code,
              label: `${size.label || size.code} — ${size.price} ${size.currency}`,
            })),
          ]}
        />
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
