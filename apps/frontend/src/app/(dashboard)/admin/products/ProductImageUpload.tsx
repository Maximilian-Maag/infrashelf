'use client'

import { useRef, useState } from 'react'
import { Button } from '@/components/ui/Button'
import { Alert } from '@/components/ui/Alert'
import { ProductImage } from '@/components/ui/ProductImage'
import { useLang } from '@/lib/useLang'
import { t } from '@/lib/i18n'

const API_URL = process.env.NEXT_PUBLIC_API_URL ?? ''

/** Mirrors ALLOWED_IMAGE_MIMES in the backend service. */
const ACCEPT = 'image/png,image/jpeg,image/webp'
const MAX_BYTES = 10 * 1024 * 1024
const MAX_ALT = 300

interface Props {
  productId: number
  token: string
  /** The description currently stored, if the product already has an image. */
  initialAlt?: string | null
  /** Bumped after a successful change so the <img> refetches instead of using cache. */
  onChanged?: () => void
}

/**
 * Upload, replace and remove a product's picture.
 *
 * There was no way to do this in the UI at all: the endpoint existed and the admin
 * guide described the feature, but no form ever called it — so every product in the
 * catalogue showed the placeholder.
 *
 * The file goes up as multipart rather than as a base64 JSON field, because the
 * endpoint reads `formData()` and because a 10 MB image would grow by a third on
 * the way through JSON.
 */
export function ProductImageUpload({ productId, token, initialAlt, onChanged }: Props) {
  const lang = useLang()
  const inputRef = useRef<HTMLInputElement>(null)
  const [alt, setAlt] = useState(initialAlt ?? '')
  const [saved, setSaved] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  // Passed to ProductImage as a cache-buster: the endpoint sets max-age=3600, so
  // a changed image needs a different URL to be shown at all.
  const [version, setVersion] = useState(0)

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
    try {
      const body = new FormData()
      body.append('image', file)
      body.append('alt', alt.trim())
      const res = await fetch(`${API_URL}/api/admin/products/${productId}/image`, {
        method: 'PUT',
        headers: { Authorization: `Bearer ${token}` },
        body,
        cache: 'no-store',
      })
      if (!res.ok) {
        const payload = await res.json().catch(() => null)
        setError(payload?.error ?? t('uploadFailed', lang))
        return
      }
      setVersion((v) => v + 1)
      setSaved(t('imageUploaded', lang))
      onChanged?.()
    } catch {
      setError(t('uploadFailed', lang))
    } finally {
      setBusy(false)
      // Clear the input so choosing the same file again still fires onChange.
      if (inputRef.current) inputRef.current.value = ''
    }
  }

  async function saveAlt() {
    if (alt.trim() === '') {
      setError(t('imageDescriptionRequiredError', lang))
      return
    }
    setBusy(true)
    setError(null)
    setSaved(null)
    try {
      const res = await fetch(`${API_URL}/api/admin/products/${productId}/image`, {
        method: 'PATCH',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ alt: alt.trim() }),
        cache: 'no-store',
      })
      if (!res.ok && res.status !== 204) {
        const payload = await res.json().catch(() => null)
        setError(payload?.error ?? t('couldNotSaveDescription', lang))
        return
      }
      setSaved(t('descriptionSaved', lang))
      onChanged?.()
    } catch {
      setError(t('couldNotSaveDescription', lang))
    } finally {
      setBusy(false)
    }
  }

  async function remove() {
    setBusy(true)
    setError(null)
    try {
      const res = await fetch(`${API_URL}/api/admin/products/${productId}/image`, {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${token}` },
        cache: 'no-store',
      })
      if (!res.ok && res.status !== 204) {
        setError(t('couldNotRemoveImage', lang))
        return
      }
      setVersion((v) => v + 1)
      setAlt('')
      setSaved(t('imageRemoved', lang))
      onChanged?.()
    } catch {
      setError(t('couldNotRemoveImage', lang))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="space-y-3">
      {error && <Alert>{error}</Alert>}
      {saved && !error && <Alert tone="success">{saved}</Alert>}

      <div className="flex flex-col gap-1">
        <label htmlFor={`product-image-alt-${productId}`} className="text-sm font-medium text-slate-700">
          {t('imageDescriptionLabel', lang)} <span className="text-red-500">*</span>
        </label>
        <input
          id={`product-image-alt-${productId}`}
          type="text"
          value={alt}
          maxLength={MAX_ALT}
          onChange={(e) => { setAlt(e.target.value); setSaved(null); setError(null) }}
          placeholder={t('placeholderImageAltExample', lang)}
          className="min-h-11 rounded-lg border border-slate-300 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
        />
        <p className="text-xs text-slate-500">
          {t('imageDescriptionHint', lang)} {t('requiredForEveryImage', lang)}
        </p>
        <div className="flex justify-end">
          <Button size="sm" variant="secondary" onClick={saveAlt} disabled={busy}>
            {t('saveDescription', lang)}
          </Button>
        </div>
      </div>

      <div className="flex items-start gap-4">
        <div className="h-32 w-32 shrink-0 rounded border border-slate-200 p-1">
          <ProductImage productId={productId} alt="" version={version} />
        </div>

        <div className="space-y-2">
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
            disabled={busy}
            onChange={(e) => {
              const file = e.target.files?.[0]
              if (file) void upload(file)
            }}
            className="block text-sm text-slate-700 file:mr-3 file:rounded-md file:border file:border-slate-300 file:bg-white file:px-3 file:py-1.5 file:text-sm file:font-medium file:text-slate-700 hover:file:bg-slate-50"
          />
          <p className="text-xs text-slate-500">{t('imageFormatHintPlain', lang)}</p>
          <Button size="sm" variant="secondary" onClick={remove} disabled={busy}>
            {busy ? t('working', lang) : t('removeImage', lang)}
          </Button>
        </div>
      </div>
    </div>
  )
}
