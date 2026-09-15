import { Alert } from './Alert'
import { t } from '@/lib/i18n'

interface SectionErrorProps {
  /** The technical reason from `section()`; renders nothing when null. */
  error: string | null
  lang: string
  className?: string
}

/**
 * What a page section says when it could not load (#415).
 *
 * Two registers on purpose. The translated sentence is for the person looking at
 * the screen; the status and message after it are for whoever has to fix it, and
 * they are NOT translated — an operator quoting `HTTP 502: Bad Gateway` into a
 * bug report is helped by it, an operator quoting a localised rendering of it is
 * not.
 *
 * `Alert` and not a bare div, for its live-region wiring: these can appear in a
 * section that streams in after the rest of the page, and a plain div is painted
 * silently (WCAG 4.1.3).
 */
// Stryker disable next-line all: the default is the empty class list — appearance only.
export function SectionError({ error, lang, className = '' }: SectionErrorProps) {
  if (!error) return null
  return (
    <Alert tone="error" className={className}>
      {t('unexpectedError', lang)}
      {/* Stryker disable next-line all: the separating space is appearance only. */}
      {' '}
      <span className="font-mono text-xs">{error}</span>
    </Alert>
  )
}
