'use client'

import {useState } from 'react'
import type { ProductImageMeta } from '@infrashelf/types'
import { Modal } from '@/components/ui/Modal'
import { ProductImagePlaceholder } from '@/components/ui/ProductImage'
import { t } from '@/lib/i18n'

const API_URL = process.env.NEXT_PUBLIC_API_URL ?? ''

/** Where one gallery picture's bytes live. */
const src = (productId: number, imageId: number) =>
  `${API_URL}/api/catalog/${productId}/images/${imageId}`

interface Props {
  productId: number
  /** The gallery in order, from `product.images`. Empty renders the placeholder. */
  images: ProductImageMeta[]
  lang: string
}

/**
 * A product's pictures: one large, the rest as thumbnails, any of them enlargeable
 * (issue #107).
 *
 * Accessibility is the interesting part, because a gallery is where it usually goes
 * wrong:
 *
 * - Every thumbnail is a real `<button>` with the picture's own description as its
 *   accessible name, so the tab order reads "the front of it", "the back of it" —
 *   not "button, button, button". The thumbnail `<img>` inside is `alt=""`,
 *   because the button already says what it is and announcing it twice is noise.
 * - The enlarge control is a button overlaying the picture rather than the picture
 *   wrapped in one: that keeps the large `<img>`'s own `alt` in the accessibility
 *   tree instead of having the button's name replace it.
 * - The zoom is a native `<dialog>` (via Modal), so Escape closes it and focus is
 *   trapped while it is open — no keyboard trap and no mouse-only exit.
 * - Left/Right step through the gallery when focus is inside it, which is what a
 *   keyboard user tries first; the prev/next buttons do the same thing for
 *   everyone else.
 */
export function ProductGallery({ productId, images, lang }: Props) {
  const [index, setIndex] = useState(0)
  const [zoomed, setZoomed] = useState(false)
  // Per image, not per gallery: one broken row should not blank the others.
  const [failed, setFailed] = useState<number[]>([])

  // The same id can arrive twice: the large picture and the zoom modal render the
  // same image, so one dead URL fires `onError` from both elements. Returning the
  // existing array on a repeat lets React bail out of that second render instead
  // of re-rendering the whole gallery for a longer list that means the same thing.
  const markFailed = (id: number) =>
    setFailed((ids) => (ids.includes(id) ? ids : [...ids, id]))

  /*
   * A reordered or shortened gallery must not leave the selection pointing past
   * the end — the page re-renders with new props, the component does not
   * remount. Clamped during render rather than in an effect (#450): as an effect
   * the out-of-range index reached the render below once before being corrected,
   * and `images[Math.min(...)]` was carrying that frame.
   */
  const [shownImages, setShownImages] = useState(images)
  if (images !== shownImages) {
    setShownImages(images)
    if (index >= images.length) setIndex(0)
  }

  if (images.length === 0) {
    return (
      <div className="h-full w-full">
        <ProductImagePlaceholder />
      </div>
    )
  }

  const current = images[Math.min(index, images.length - 1)]
  const step = (delta: number) =>
    setIndex((i) => (i + delta + images.length) % images.length)

  return (
    <div
      className="flex h-full flex-col gap-3"
      role="group"
      aria-label={t('productImages', lang)}
      onKeyDown={(event) => {
        if (images.length < 2) return
        if (event.key === 'ArrowLeft') {
          event.preventDefault()
          step(-1)
        } else if (event.key === 'ArrowRight') {
          event.preventDefault()
          step(1)
        }
      }}
    >
      <div className="relative min-h-0 flex-1">
        {failed.includes(current.id) ? (
          <ProductImagePlaceholder />
        ) : (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={src(productId, current.id)}
            alt={current.alt}
            className="h-full w-full rounded-lg object-contain"
            onError={() => markFailed(current.id)}
          />
        )}

        {/* Overlays the picture so a click anywhere on it enlarges, while staying a
            real button for the keyboard. */}
        <button
          type="button"
          onClick={() => setZoomed(true)}
          aria-label={t('enlargeImage', lang)}
          className="group absolute inset-0 flex items-end justify-end rounded-lg p-2 focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-500"
        >
          <span className="rounded-full border border-slate-200 bg-white/90 p-1.5 text-slate-600 shadow-sm transition-colors group-hover:bg-white group-hover:text-slate-900">
            <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" aria-hidden="true">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M21 21l-4.35-4.35M11 8v6M8 11h6M17 11a6 6 0 11-12 0 6 6 0 0112 0z" />
            </svg>
          </span>
        </button>

        {images.length > 1 && (
          <>
            <button
              type="button"
              onClick={() => step(-1)}
              aria-label={t('previousImage', lang)}
              className="absolute left-1 top-1/2 -translate-y-1/2 rounded-full border border-slate-200 bg-white/90 p-1.5 text-slate-600 shadow-sm transition-colors hover:bg-white hover:text-slate-900 focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-500"
            >
              <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" aria-hidden="true">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 19l-7-7 7-7" />
              </svg>
            </button>
            <button
              type="button"
              onClick={() => step(1)}
              aria-label={t('nextImage', lang)}
              className="absolute right-1 top-1/2 -translate-y-1/2 rounded-full border border-slate-200 bg-white/90 p-1.5 text-slate-600 shadow-sm transition-colors hover:bg-white hover:text-slate-900 focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-500"
            >
              <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" aria-hidden="true">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
              </svg>
            </button>
          </>
        )}
      </div>

      {images.length > 1 && (
        <ul className="flex shrink-0 gap-2 overflow-x-auto pb-1">
          {images.map((image, i) => (
            <li key={image.id}>
              <button
                type="button"
                onClick={() => setIndex(i)}
                // The picture's own description, so the tab order says what each
                // thumbnail is instead of "button, button, button".
                aria-label={image.alt}
                // Not aria-selected: these are buttons, not tabs, and
                // aria-current is the pattern for "the one you are looking at".
                aria-current={i === index ? 'true' : undefined}
                className={`block h-14 w-14 shrink-0 overflow-hidden rounded-md border-2 bg-white p-0.5 transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 ${
                  i === index ? 'border-slate-700' : 'border-slate-200 hover:border-slate-400'
                }`}
              >
                {failed.includes(image.id) ? (
                  <ProductImagePlaceholder />
                ) : (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img
                    src={src(productId, image.id)}
                    // Decorative here: the button around it carries the
                    // description, and repeating it would announce every
                    // thumbnail twice.
                    alt=""
                    className="h-full w-full object-cover"
                    onError={() => markFailed(image.id)}
                  />
                )}
              </button>
            </li>
          ))}
        </ul>
      )}

      <Modal
        open={zoomed}
        onClose={() => setZoomed(false)}
        title={t('productImages', lang)}
        lang={lang}
        size="xl"
      >
        {/* The same `failed` set as the gallery behind it, so a picture that will
            not load shows the placeholder here too rather than the browser's broken
            image icon — and one that already failed in the gallery never flashes
            broken on the way in. */}
        {failed.includes(current.id) ? (
          <ProductImagePlaceholder />
        ) : (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={src(productId, current.id)}
            alt={current.alt}
            className="mx-auto max-h-[70vh] w-full object-contain"
            onError={() => markFailed(current.id)}
          />
        )}
        <p className="mt-3 text-sm text-slate-600">{current.alt}</p>
      </Modal>
    </div>
  )
}
