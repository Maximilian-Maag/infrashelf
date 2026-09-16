import { ButtonLink } from '@/components/ui/Button'
import { t } from '@/lib/i18n'

interface PagerProps {
  /** Rows matching the filters, ignoring the window — what "of 3,914" reads from. */
  total: number
  limit: number
  offset: number
  /** Path to link back to, without a query string. */
  basePath: string
  /**
   * The query the current page was rendered with. Carried into both links, so
   * paging does not silently drop the filter the person is looking through.
   */
  params?: Record<string, string | undefined>
  lang: string
}

/**
 * Previous / next for a list the server pages.
 *
 * Links rather than buttons, because these pages are server components: the row
 * data for page two only exists after a request, so the control that asks for
 * it is a destination and not a state change. That also makes a page shareable
 * and the back button work. The audit log used to be the exception named here —
 * a client component paging in `useState`, with no choice because its filters
 * were in `useState` too — until #471 moved them into the URL and it became
 * another caller of this.
 *
 * Renders nothing at all when everything fits on one page. A pager that is
 * always present but always disabled is a permanent invitation to look for rows
 * that are not there.
 */
export function Pager({ total, limit, offset, basePath, params = {}, lang }: PagerProps) {
  const totalPages = Math.max(1, Math.ceil(total / Math.max(1, limit)))
  if (totalPages <= 1) return null

  const page = Math.floor(offset / Math.max(1, limit)) + 1

  const href = (nextOffset: number) => {
    const query = new URLSearchParams()
    for (const [key, value] of Object.entries(params)) {
      if (value !== undefined && value !== '' && key !== 'offset') query.set(key, value)
    }
    // Page one is the bare URL: it is the one people copy and paste, and
    // `?offset=0` on it is noise that makes two spellings of the same page.
    if (nextOffset > 0) query.set('offset', String(nextOffset))
    const qs = query.toString()
    return qs ? `${basePath}?${qs}` : basePath
  }

  return (
    <div className="flex items-center justify-between">
      <p className="text-sm text-slate-600">
        {t('page', lang)} {page} / {totalPages} · {total.toLocaleString(lang)} {t('entriesLower', lang)}
      </p>
      <div className="flex gap-2">
        {/*
          Absent rather than disabled at the ends. A disabled <a> is not a thing
          the platform has — `aria-disabled` still leaves it focusable and
          followable — and the count beside it already says which end you are at.
        */}
        {page > 1 && (
          <ButtonLink variant="secondary" size="sm" href={href(Math.max(0, offset - limit))} rel="prev">
            {t('previous', lang)}
          </ButtonLink>
        )}
        {page < totalPages && (
          <ButtonLink variant="secondary" size="sm" href={href(offset + limit)} rel="next">
            {t('next', lang)}
          </ButtonLink>
        )}
      </div>
    </div>
  )
}
