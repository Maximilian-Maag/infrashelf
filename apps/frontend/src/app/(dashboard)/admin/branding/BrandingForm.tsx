'use client'

import { useId, useState } from 'react'
import { useRouter } from 'next/navigation'
import type { Branding, UpdateBrandingRequest } from '@open-hybrid-cloud/types'
import { put, apiRequest } from '@/lib/api'
import { Card } from '@/components/ui/Card'
import { Alert } from '@/components/ui/Alert'
import { Input } from '@/components/ui/Input'
import { Button } from '@/components/ui/Button'
import { useToast } from '@/components/ui/Toast'
import { readableInk, parseHex, toCanonicalHex, AA_BODY, AAA_BODY } from '@/lib/contrast'
import { useLang } from '@/lib/useLang'
import { t } from '@/lib/i18n'

interface Props {
  initial: Branding
  token: string
}

export function BrandingForm({ initial, token }: Props) {
  const lang = useLang()
  const router = useRouter()
  const { toast } = useToast()
  const [shopName, setShopName] = useState(initial.shopName)
  const [shopSubtitle, setShopSubtitle] = useState(initial.shopSubtitle)
  const [primaryColor, setPrimaryColor] = useState(initial.primaryColor)
  const [secondaryColor, setSecondaryColor] = useState(initial.secondaryColor)
  const [imprintText, setImprintText] = useState(initial.imprintText)
  const [logoFile, setLogoFile] = useState<File | null>(null)
  const [logoPreview, setLogoPreview] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  function handleLogoChange(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0]
    if (file) {
      setLogoFile(file)
      const reader = new FileReader()
      reader.onloadend = () => setLogoPreview(reader.result as string)
      reader.readAsDataURL(file)
    }
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    setSaving(true); setError(null)
    try {
      const body: UpdateBrandingRequest = {
        shopName: shopName.trim(),
        shopSubtitle: shopSubtitle.trim(),
        primaryColor,
        secondaryColor,
        imprintText: imprintText.trim(),
      }
      await put('/api/admin/branding', body, token)

      if (logoFile) {
        const fd = new FormData()
        fd.append('logo', logoFile)
        await apiRequest('/api/admin/branding/logo', { method: 'PUT', body: fd, token, isFormData: true })
      }

      toast(t('brandingSavedToast', lang))
      router.refresh()
    } catch (err) {
      setError(err instanceof Error ? err.message : t('failedToSaveBranding', lang))
    } finally {
      setSaving(false)
    }
  }

  return (
    <Card title={t('brandingSettingsTitle', lang)}>
      <form onSubmit={handleSubmit} className="space-y-5">
        {error && <Alert>{error}</Alert>}

        <div className="grid grid-cols-2 gap-4">
          <Input label={t('shopName', lang)} value={shopName} onChange={(e) => setShopName(e.target.value)} required />
          <Input label={t('subtitleLabel', lang)} value={shopSubtitle} onChange={(e) => setShopSubtitle(e.target.value)} />
        </div>

        <div className="grid grid-cols-2 gap-4">
          <ColorField
            label={t('primaryColor', lang)}
            hint={t('primaryColorHint', lang)}
            value={primaryColor}
            onChange={setPrimaryColor}
          />
          <ColorField
            label={t('secondaryColor', lang)}
            hint={t('secondaryColorHint', lang)}
            value={secondaryColor}
            onChange={setSecondaryColor}
          />
        </div>

        <div className="flex flex-col gap-1">
          <label htmlFor="branding-logo" className="text-sm font-medium text-slate-700">{t('logo', lang)}</label>
          {logoPreview && (
            <div className="mb-2">
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src={logoPreview} alt={t('logoPreviewAlt', lang)} className="h-16 object-contain rounded border border-slate-200 p-1" />
            </div>
          )}
          <input id="branding-logo" type="file" accept="image/*" onChange={handleLogoChange}
            aria-describedby="branding-logo-hint"
            className="text-sm text-slate-600 file:mr-3 file:rounded-lg file:border-0 file:bg-slate-100 file:px-3 file:py-1.5 file:text-sm file:font-medium file:text-slate-700 hover:file:bg-slate-200" />
          <p id="branding-logo-hint" className="text-xs text-slate-600">{t('logoHint', lang)}</p>
        </div>

        <div className="flex flex-col gap-1">
          <label htmlFor="branding-imprint" className="text-sm font-medium text-slate-700">{t('imprintTextLabel', lang)}</label>
          <textarea id="branding-imprint" value={imprintText} onChange={(e) => setImprintText(e.target.value)} rows={4}
            className="rounded-lg border border-slate-300 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500" />
        </div>

        <div className="flex justify-end">
          <Button type="submit" disabled={saving}>{saving ? t('saving', lang) : t('saveBranding', lang)}</Button>
        </div>
      </form>
    </Card>
  )
}

/**
 * Paired colour swatch + hex field for one branding colour.
 *
 * Both inputs edit the same value, so they share one visible label via
 * aria-labelledby and each carries its own aria-label to say which control it
 * is — previously the label was bound to neither and both were anonymous.
 *
 * The readout underneath is the guard rail: the portal chrome is painted on this
 * colour, and until now nothing told the operator that a mid-tone choice makes
 * the header unreadable. It reports the best achievable ratio against WCAG AA
 * rather than blocking the save, because a brand colour is sometimes a
 * requirement the operator cannot override.
 */
function ColorField({
  label,
  hint,
  value,
  onChange,
}: {
  label: string
  hint: string
  value: string
  onChange: (v: string) => void
}) {
  const lang = useLang()
  const hintId = `${useId()}-hint`
  const parsed = parseHex(value)
  const { ratio } = readableInk(value)
  const ok = parsed !== null && ratio >= AA_BODY

  return (
    <div className="flex flex-col gap-1">
      <span aria-hidden="true" className="text-sm font-medium text-slate-700">{label}</span>
      <div className="flex items-center gap-2">
        <input
          type="color"
          // The picker only accepts canonical lowercase #rrggbb, so feed it the
          // normalised form of whatever the operator typed.
          value={parsed ? toCanonicalHex(parsed) : '#000000'}
          onChange={(e) => onChange(e.target.value)}
          aria-label={`${label} — ${t('colorPickerSuffix', lang)}`}
          aria-describedby={hintId}
          className="h-11 w-14 rounded border border-slate-300 cursor-pointer p-0.5"
        />
        <input
          type="text"
          value={value}
          onChange={(e) => onChange(e.target.value)}
          aria-label={`${label} — ${t('hexValueSuffix', lang)}`}
          aria-describedby={hintId}
          aria-invalid={parsed === null ? true : undefined}
          className="min-h-11 flex-1 rounded-lg border border-slate-300 px-3 py-2 text-sm font-mono focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-500"
        />
      </div>
      <p id={hintId} className="text-xs text-slate-600">{hint}</p>
      {parsed === null ? (
        <p role="alert" className="text-xs text-red-700">
          {t('invalidHexColor', lang)}
        </p>
      ) : (
        <p className={`text-xs ${ok ? 'text-slate-600' : 'text-red-700'}`} role={ok ? undefined : 'alert'}>
          {ok
            ? ratio >= AAA_BODY
              ? `${t('contrastMeetsAAA', lang)} (${ratio.toFixed(1)}:1)`
              // Named rather than silent: the chrome is painted on this colour, so
              // the operator is the only person who can trade brand for 1.4.6, and
              // the app records the criterion as out of scope precisely because
              // most brand colours cannot make the trade. Not an alert — AA is the
              // level this app conforms to, and AAA is information, not a blocker.
              : `${t('contrastMeetsAA', lang)} (${ratio.toFixed(1)}:1, ${t('contrastAaaRequires', lang)} ${AAA_BODY}:1)`
            : `${t('contrastFailsAA', lang)} (${ratio.toFixed(1)}:1, ${t('contrastAaRequires', lang)} ${AA_BODY}:1)`}
        </p>
      )}
    </div>
  )
}
