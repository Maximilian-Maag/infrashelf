'use client'

import { useEffect, useRef, useState } from 'react'

const API_URL = process.env.NEXT_PUBLIC_API_URL ?? ''

/**
 * The product's picture, with the placeholder as a fallback.
 *
 * A client component only because the image endpoint answers 404 when the product
 * has none: that is a load error the browser reports, not something the server
 * render can know without fetching the bytes it would then throw away.
 */
export function ProductImage({
  productId,
  alt,
  version,
}: {
  productId: number
  /**
   * The image's description, from `product.imageAlt`.
   *
   * Empty string means decorative — appropriate only where the same information is
   * already in text next to it (a cart row names the product it belongs to).
   * Anything else is a description its uploader wrote; components no longer invent
   * one.
   */
  alt: string
  /**
   * Bump to force a refetch after the image changed. The endpoint sets
   * `max-age=3600`, so without a different URL the browser keeps showing the old
   * picture — remounting the element is not enough.
   */
  version?: number
}) {
  const [failed, setFailed] = useState(false)
  const imgRef = useRef<HTMLImageElement>(null)

  /*
   * A different picture starts out not-failed — decided during render rather
   * than in an effect (#450). As an effect, a product whose predecessor had no
   * image rendered the placeholder once more before clearing the flag.
   */
  const src = `${productId}:${version ?? ''}`
  const [shownSrc, setShownSrc] = useState(src)
  if (src !== shownSrc) {
    setShownSrc(src)
    setFailed(false)
  }

  // onError alone is not enough: the browser starts loading while parsing the
  // server-rendered HTML, so an image that 404s before hydration fires its error
  // event with no handler attached and the broken-image icon stays. A finished
  // load with no intrinsic width is that same failure, observed after the fact.
  useEffect(() => {
    const img = imgRef.current
    if (img?.complete && img.naturalWidth === 0) setFailed(true)
  }, [productId, version])

  if (failed) return <ProductImagePlaceholder />

  return (
    // eslint-disable-next-line @next/next/no-img-element
    <img
      ref={imgRef}
      src={`${API_URL}/api/catalog/${productId}/image${version ? `?v=${version}` : ''}`}
      alt={alt}
      className="h-full w-full rounded-lg object-contain"
      onError={() => setFailed(true)}
    />
  )
}

/**
 * What stands in for a picture that is missing or failed to load.
 *
 * Its own export because the gallery (issue #107) shows the same thing for a
 * product with no images at all, and two drawings of "no picture" that drift apart
 * is exactly the kind of difference nobody notices until it is on a screenshot.
 *
 * Decorative by construction: the surrounding page always names the product, and a
 * placeholder has nothing of its own to describe.
 */
export function ProductImagePlaceholder() {
  return (
    <div
      className="flex h-full w-full items-center justify-center rounded-lg"
      style={{ backgroundColor: 'color-mix(in srgb, var(--bp) 8%, white)' }}
    >
      <svg
        className="h-24 w-24 opacity-25"
        style={{ color: 'var(--bp-text)' }}
        fill="none"
        viewBox="0 0 24 24"
        stroke="currentColor"
        aria-hidden="true"
      >
        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1} d="M5 12h14M5 12a2 2 0 01-2-2V6a2 2 0 012-2h14a2 2 0 012 2v4a2 2 0 01-2 2M5 12a2 2 0 00-2 2v4a2 2 0 002 2h14a2 2 0 002-2v-4a2 2 0 00-2-2" />
      </svg>
    </div>
  )
}
