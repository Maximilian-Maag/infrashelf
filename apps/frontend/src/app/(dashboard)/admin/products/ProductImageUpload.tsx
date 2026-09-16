'use client'

import {useCallback, useRef, useState } from 'react'
import { Button } from '@/components/ui/Button'
import { Alert } from '@/components/ui/Alert'
import { ProductImagePlaceholder } from '@/components/ui/ProductImage'
import { useLang } from '@/lib/useLang'
import { t } from '@/lib/i18n'
import { PROXY_PREFIX } from '@/lib/api'

/**
 * Only for the thumbnail `src` below, which is a plain unauthenticated GET
 * straight to the API. Everything that needs the caller's identity goes through
 * PROXY_PREFIX instead (#146).
 */
const API_URL = process.env.NEXT_PUBLIC_API_URL ?? ''

/** Mirrors ALLOWED_IMAGE_MIMES in the backend service. */
const ACCEPT = 'image/png,image/jpeg,image/webp'
const MAX_BYTES = 10 * 1024 * 1024
const MAX_ALT = 300
/** Mirrors MAX_IMAGES_PER_PRODUCT in the backend service. */
const MAX_IMAGES = 8

export interface GalleryImage {
  id: number
  alt: string
  position: number
  mime: string
}

interface Props {
  productId: number
  /**
   * The gallery the SERVER already fetched (#462).
   *
   * This asked for it on mount, so the edit page arrived with an empty gallery
   * and filled it in afterwards. `load()` below stays — it runs after an upload,
   * a rename, a reorder or a delete, which are responses to actions rather than
   * to mounting.
   */
  initial: GalleryImage[]
  /** Why the server could not fetch it, if it could not (#415). */
  initialError?: string | null
  /** Called after any successful change, so the page can refetch what it shows. */
  onChanged?: () => void
}

/**
 * Manage a product's gallery: upload pictures, describe them, reorder them,
 * remove them.
 *
 * This used to manage exactly one picture, because that was all a product could
 * have. #107 made the gallery the data model, so the control follows: uploading
 * appends instead of overwriting, and each picture carries its own description
 * (#105 — required, always) and its own place in the order.
 *
 * Files go up as multipart rather than as a base64 JSON field, because the endpoint
 * reads `formData()` and because a 10 MB image would grow by a third on the way
 * through JSON.
 */
export function ProductImageUpload({ productId, initial, initialError = null, onChanged }: Props) {
  const lang = useLang()
  const inputRef = useRef<HTMLInputElement>(null)
  const [images, setImages] = useState<GalleryImage[]>(initial)
  const [alt, setAlt] = useState('')
  const [saved, setSaved] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(initialError)
  // Bumped after a change so the thumbnails refetch: the image endpoints set
  // max-age=3600, so a replaced picture at the same id needs a different URL.
  const [version, setVersion] = useState(0)

  const load = useCallback(async () => {
    try {
      const res = await fetch(`${PROXY_PREFIX}/api/admin/products/${productId}/images`, {
        cache: 'no-store',
      })
      if (!res.ok) {
        setError(t('couldNotLoadGallery', lang))
        return
      }
      setImages(await res.json())
      // Cleared on success, not just set on failure: a transient error otherwise
      // leaves its alert standing over a gallery that has since loaded.
      setError(null)
    } catch {
      setError(t('couldNotLoadGallery', lang))
    }
  }, [productId, lang])

  /** Re-read the gallery and tell the page, after a change succeeded. */
  const afterChange = async (message: string) => {
    setVersion((v) => v + 1)
    setSaved(message)
    await load()
    onChanged?.()
  }

  async function upload(file: File) {
    // Checked here as well as on the server: refusing a 40 MB file before it is
    // uploaded is the difference between instant feedback and a long wait.
    if (file.size > MAX_BYTES) {
      setError(`${t('fileTooLargePrefix', lang)} ${(file.size / 1024 / 1024).toFixed(1)} ${t('mbLimitSuffix', lang)}`)
      if (inputRef.current) inputRef.current.value = ''
      return
    }

    // Refused before the upload rather than after: the server requires it too, and
    // an image nobody described is the thing this control exists to prevent.
    if (alt.trim() === '') {
      setError(t('describeBeforeUpload', lang))
      if (inputRef.current) inputRef.current.value = ''
      return
    }

    setBusy(true)
    setError(null)
    setSaved(null)
    try {
      const body = new FormData()
      body.append('image', file)
      body.append('alt', alt.trim())
      const res = await fetch(`${PROXY_PREFIX}/api/admin/products/${productId}/images`, {
        method: 'POST',
        body,
        cache: 'no-store',
      })
      if (!res.ok) {
        const payload = await res.json().catch(() => null)
        setError(payload?.error ?? t('uploadFailed', lang))
        return
      }
      // Cleared, because the next upload is a different picture and reusing this
      // description is how a gallery ends up with three identical alt texts.
      setAlt('')
      await afterChange(t('imageUploaded', lang))
    } catch {
      setError(t('uploadFailed', lang))
    } finally {
      setBusy(false)
      // Clear the input so choosing the same file again still fires onChange.
      if (inputRef.current) inputRef.current.value = ''
    }
  }

  async function saveAlt(image: GalleryImage, next: string) {
    if (next.trim() === '') {
      setError(t('imageDescriptionRequiredError', lang))
      return
    }
    setBusy(true)
    setError(null)
    setSaved(null)
    try {
      const res = await fetch(`${PROXY_PREFIX}/api/admin/products/${productId}/images/${image.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ alt: next.trim() }),
        cache: 'no-store',
      })
      if (!res.ok && res.status !== 204) {
        const payload = await res.json().catch(() => null)
        setError(payload?.error ?? t('couldNotSaveDescription', lang))
        return
      }
      await afterChange(t('descriptionSaved', lang))
    } catch {
      setError(t('couldNotSaveDescription', lang))
    } finally {
      setBusy(false)
    }
  }

  async function remove(image: GalleryImage) {
    setBusy(true)
    setError(null)
    setSaved(null)
    try {
      const res = await fetch(`${PROXY_PREFIX}/api/admin/products/${productId}/images/${image.id}`, {
        method: 'DELETE',
        cache: 'no-store',
      })
      if (!res.ok && res.status !== 204) {
        setError(t('couldNotRemoveImage', lang))
        return
      }
      await afterChange(t('imageRemoved', lang))
    } catch {
      setError(t('couldNotRemoveImage', lang))
    } finally {
      setBusy(false)
    }
  }

  /** Move one picture one place up or down. The endpoint wants the whole order. */
  async function move(index: number, delta: number) {
    const target = index + delta
    if (target < 0 || target >= images.length) return

    const order = images.map((image) => image.id)
    ;[order[index], order[target]] = [order[target], order[index]]

    setBusy(true)
    setError(null)
    setSaved(null)
    try {
      const res = await fetch(`${PROXY_PREFIX}/api/admin/products/${productId}/images`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ order }),
        cache: 'no-store',
      })
      if (!res.ok && res.status !== 204) {
        const payload = await res.json().catch(() => null)
        setError(payload?.error ?? t('couldNotReorderGallery', lang))
        return
      }
      await afterChange(t('imageOrderSaved', lang))
    } catch {
      setError(t('couldNotReorderGallery', lang))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="space-y-4">
      {error && <Alert>{error}</Alert>}
      {saved && !error && <Alert tone="success">{saved}</Alert>}

      {/* The gallery, in the order the product page shows it. */}
      {images.length === 0 ? (
        <p className="text-sm text-slate-600">{t('noPicturesYet', lang)}</p>
      ) : (
        <ol className="space-y-3">
          {images.map((image, index) => (
            <li key={image.id} className="flex items-start gap-3 rounded-lg border border-slate-200 p-3">
              <div className="h-20 w-20 shrink-0 rounded border border-slate-200 p-1">
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img
                  src={`${API_URL}/api/catalog/${productId}/images/${image.id}?v=${version}`}
                  alt=""
                  className="h-full w-full rounded object-contain"
                />
              </div>

              <div className="min-w-0 flex-1 space-y-2">
                <label
                  htmlFor={`product-image-alt-${image.id}`}
                  className="block text-sm font-medium text-slate-700"
                >
                  {index === 0 ? t('imageDescriptionLeading', lang) : t('imageDescriptionLabel', lang)}{' '}
                  <span className="text-red-600">*</span>
                </label>
                <input
                  id={`product-image-alt-${image.id}`}
                  type="text"
                  // Keyed on the stored value, not `defaultValue` alone. The server
                  // canonicalises the description (it trims), and `load()` refetches
                  // after every change — an uncontrolled input keeps whatever was
                  // typed, so the field and the row disagree and the next blur PATCHes
                  // a value the server already rejected the whitespace of. The key
                  // remounts the input when the stored value actually changes, which
                  // keeps typing uninterrupted in between.
                  key={`${image.id}:${image.alt}`}
                  defaultValue={image.alt}
                  maxLength={MAX_ALT}
                  onBlur={(e) => {
                    if (e.target.value.trim() !== image.alt) void saveAlt(image, e.target.value)
                  }}
                  className="w-full min-h-11 rounded-lg border border-slate-300 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
                />
                <div className="flex flex-wrap gap-2">
                  <Button
                    size="sm"
                    variant="secondary"
                    onClick={() => move(index, -1)}
                    disabled={busy || index === 0}
                    aria-label={`${t('moveUp', lang)}: ${image.alt}`}
                  >
                    {t('moveUp', lang)}
                  </Button>
                  <Button
                    size="sm"
                    variant="secondary"
                    onClick={() => move(index, 1)}
                    disabled={busy || index === images.length - 1}
                    aria-label={`${t('moveDown', lang)}: ${image.alt}`}
                  >
                    {t('moveDown', lang)}
                  </Button>
                  <Button
                    size="sm"
                    variant="danger"
                    onClick={() => remove(image)}
                    disabled={busy}
                    aria-label={`${t('remove', lang)}: ${image.alt}`}
                  >
                    {t('remove', lang)}
                  </Button>
                </div>
              </div>
            </li>
          ))}
        </ol>
      )}

      {/* Adding one. The description comes first, because the upload starts the
          moment a file is chosen and the server refuses one without it. */}
      <div className="space-y-2 rounded-lg border border-dashed border-slate-300 p-3">
        <div className="flex flex-col gap-1">
          <label htmlFor={`product-image-alt-new-${productId}`} className="text-sm font-medium text-slate-700">
            {t('imageDescriptionLabel', lang)} <span className="text-red-600">*</span>
          </label>
          <input
            id={`product-image-alt-new-${productId}`}
            type="text"
            value={alt}
            maxLength={MAX_ALT}
            onChange={(e) => { setAlt(e.target.value); setSaved(null); setError(null) }}
            placeholder={t('placeholderImageAltExample', lang)}
            className="min-h-11 rounded-lg border border-slate-300 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
          />
          <p className="text-xs text-slate-600">
            {t('imageDescriptionHint', lang)} {t('requiredForEveryImage', lang)}
          </p>
        </div>

        <div className="flex flex-col gap-1">
          {/* A file input with no label is an unlabelled control — the browser's
              "Choose file" text is not a name. */}
          <label htmlFor={`product-image-${productId}`} className="block text-sm font-medium text-slate-700">
            {t('imageFileLabel', lang)}
          </label>
          <input
            ref={inputRef}
            id={`product-image-${productId}`}
            type="file"
            accept={ACCEPT}
            disabled={busy || images.length >= MAX_IMAGES}
            onChange={(e) => {
              const file = e.target.files?.[0]
              if (file) void upload(file)
            }}
            className="block w-full max-w-full text-sm text-slate-700 file:mr-3 file:rounded-md file:border file:border-slate-300 file:bg-white file:px-3 file:py-1.5 file:text-sm file:font-medium file:text-slate-700 hover:file:bg-slate-50"
          />
          <p className="text-xs text-slate-600">
            {t('imageFormatHintPlain', lang)} {t('maxPicturesPerProduct', lang)}: {MAX_IMAGES}.
            {images.length >= MAX_IMAGES && ` ${t('removeOneToAddAnother', lang)}`}
          </p>
        </div>
      </div>

      {/* Only here so a product with no pictures still shows what the page will
          show; the real gallery is the list above. */}
      {images.length === 0 && (
        <div className="h-32 w-32">
          <ProductImagePlaceholder />
        </div>
      )}
    </div>
  )
}
