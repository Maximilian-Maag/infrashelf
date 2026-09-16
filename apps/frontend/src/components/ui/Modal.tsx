'use client'

import { useEffect, useId, useRef, type ReactNode } from 'react'
import { t } from '@/lib/i18n'
import { useLang } from '@/lib/useLang'

interface ModalProps {
  open: boolean
  onClose: () => void
  title?: string
  ariaLabel?: string
  /** Overrides the detected language for the close button's accessible name. */
  lang?: string
  children: ReactNode
  size?: 'sm' | 'md' | 'lg' | 'xl'
}

/**
 * How wide the dialog may get — and, from the second class, how narrow it must.
 *
 * None of these clamped below a phone. `md` is 448px, so on a 375px viewport
 * the default dialog measured `left: 111, right: 559`: field labels sheared off
 * the left edge and 184px hanging past the right, with no way to scroll to it
 * (#167). That reached all 11 call sites, which is where most of this app's
 * forms live.
 *
 * `calc(100vw-2rem)` leaves a 1rem gutter either side. It wins because
 * `max-width` resolves to the smaller of the two.
 */
const CLAMP_TO_VIEWPORT = 'max-w-[calc(100vw-2rem)]'

const sizeClass: Record<string, string> = {
  sm: `max-w-sm ${CLAMP_TO_VIEWPORT}`,
  md: `max-w-md ${CLAMP_TO_VIEWPORT}`,
  lg: `max-w-lg ${CLAMP_TO_VIEWPORT}`,
  xl: `max-w-2xl ${CLAMP_TO_VIEWPORT}`,
}

export function Modal({ open, onClose, title, ariaLabel, children, size = 'md', lang }: ModalProps) {
  // The close button's accessible name has to match the document language, and
  // Modal is already a client component — reading the language here keeps all 11
  // call sites from having to thread it through.
  const detected = useLang(lang ?? 'en')
  const closeLabel = t('close', lang ?? detected)
  const dialogRef = useRef<HTMLDialogElement>(null)
  const titleId = useId()

  useEffect(() => {
    const dialog = dialogRef.current
    if (!dialog) return
    if (open) {
      if (!dialog.open) dialog.showModal()
    } else {
      if (dialog.open) dialog.close()
    }
  }, [open])

  useEffect(() => {
    const dialog = dialogRef.current
    if (!dialog) return
    const handler = () => onClose()
    dialog.addEventListener('close', handler)
    return () => dialog.removeEventListener('close', handler)
  }, [onClose])

  return (
    <dialog
      ref={dialogRef}
      aria-labelledby={title ? titleId : undefined}
      aria-label={!title ? ariaLabel : undefined}
      className={`w-full ${sizeClass[size]} mx-auto my-auto rounded-2xl shadow-2xl bg-white p-0 open:flex open:flex-col max-h-[90vh] animate-modal-in`}
      onClick={(e) => {
        if (e.target === dialogRef.current) onClose()
      }}
    >
      {title && (
        <div className="flex items-center justify-between border-b border-slate-200 px-6 py-4 shrink-0">
          <h2 id={titleId} className="text-lg font-semibold text-slate-900">{title}</h2>
          <button
            onClick={onClose}
            // -mr-2 buys the extra width back out of the header's px-6, so the
            // 44px target (WCAG 2.5.5) does not push the title inward: the ✕ stays
            // optically where it was, its clickable box just now reaches the
            // padding it always looked like it filled.
            className="flex h-11 w-11 -mr-2 shrink-0 items-center justify-center rounded-md text-slate-600 hover:text-slate-700 hover:bg-slate-100 focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 transition-colors"
            aria-label={closeLabel}
          >
            <svg className="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>
      )}
      <div className="px-6 py-4 flex-1 overflow-y-auto">{children}</div>
    </dialog>
  )
}
