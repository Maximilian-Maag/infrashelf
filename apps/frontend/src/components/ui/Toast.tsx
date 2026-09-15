'use client'

import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from 'react'
import { t } from '@/lib/i18n'
import { useLang } from '@/lib/useLang'

type ToastType = 'success' | 'error' | 'info'

interface ToastItem {
  id: number
  message: string
  type: ToastType
}

interface ToastContextValue {
  toast: (message: string, type?: ToastType) => void
}

const ToastContext = createContext<ToastContextValue | null>(null)

export function useToast() {
  const ctx = useContext(ToastContext)
  if (!ctx) throw new Error('useToast must be used within ToastProvider')
  return ctx
}

let nextId = 1

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<ToastItem[]>([])

  const toast = useCallback((message: string, type: ToastType = 'success') => {
    const id = nextId++
    setToasts((prev) => [...prev, { id, message, type }])
  }, [])

  return (
    <ToastContext.Provider value={{ toast }}>
      {/* Before `{children}`, not after. The bubble carries a dismiss button,
          and a control the user cannot reach before the thing it controls
          disappears is not a control: after the children it sat behind every
          field, row and link on the page, which on /admin/users is far more
          than 3.5 seconds of tabbing (WCAG 2.2.1 — #186). The container is
          `fixed`, so nothing about the layout depends on where it sits.

          The live region is on each bubble (role="alert"/"status"), not here —
          an aria-live container wrapping children that declare their own live
          role nests two regions, and some screen readers then announce twice. */}
      <div className="fixed bottom-4 right-4 z-[9999] flex flex-col gap-2 pointer-events-none">
        {toasts.map((entry) => (
          <ToastBubble
            key={entry.id}
            item={entry}
            onDismiss={() => setToasts((prev) => prev.filter((x) => x.id !== entry.id))}
          />
        ))}
      </div>
      {children}
    </ToastContext.Provider>
  )
}

const typeClass: Record<ToastType, string> = {
  success: 'bg-green-600',
  error:   'bg-red-600',
  info:    'bg-slate-700',
}

const typeIconPath: Record<ToastType, string> = {
  success: 'M5 13l4 4L19 7',
  error:   'M6 18L18 6M6 6l12 12',
  info:    'M13 16h-1v-4h-1m1-4h.01M12 2a10 10 0 100 20 10 10 0 000-20z',
}

/** How long a confirmation stays up when nobody is looking at it. */
const DISMISS_AFTER_MS = 3500

function ToastBubble({ item, onDismiss }: { item: ToastItem; onDismiss: () => void }) {
  const lang = useLang()
  /*
   * Held while the pointer is over the bubble OR focus is inside it. Reading a
   * message and dismissing it both take longer than the timer, and a message
   * that vanishes out from under the user is the timing failure WCAG 2.2.1 is
   * about (#186).
   *
   * Two pieces of state, not one. A single `held` flag is written by four
   * handlers that do not know about each other, so whichever fires last wins:
   * move the pointer away while focus is still on the Dismiss button and
   * `onMouseLeave` clears the hold, restarting the timer under a keyboard user
   * who is reaching for that very button. The mirror case is real too — tab
   * away while the pointer is still over the toast.
   *
   * Derived as the OR, so each input only ever describes itself.
   */
  const [hovered, setHovered] = useState(false)
  const [focused, setFocused] = useState(false)
  const held = hovered || focused

  // Through a ref, because the parent hands down a fresh arrow on every render.
  // As a dependency it would restart the timer each time and the toast would
  // never leave; as a ref the effect depends only on what should actually
  // restart it.
  const dismiss = useRef(onDismiss)
  dismiss.current = onDismiss

  useEffect(() => {
    // An error is not a confirmation: it is the only record of what went wrong,
    // and it is usually raised on a page the user is still working on. It waits
    // to be dismissed.
    if (item.type === 'error' || held) return
    const timer = setTimeout(() => dismiss.current(), DISMISS_AFTER_MS)
    return () => clearTimeout(timer)
  }, [item.type, held])

  return (
    <div
      role={item.type === 'error' ? 'alert' : 'status'}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      // React's onFocus/onBlur are the bubbling focusin/focusout, so tabbing to
      // the dismiss button inside holds the toast open — the whole point, since
      // the button is what the user is reaching for.
      onFocus={() => setFocused(true)}
      onBlur={() => setFocused(false)}
      className={`flex items-center gap-3 rounded-lg px-4 py-3 shadow-xl text-sm font-medium text-white pointer-events-auto animate-toast-in min-w-56 max-w-xs ${typeClass[item.type]}`}
    >
      <svg aria-hidden="true" className="h-4 w-4 shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor">
        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d={typeIconPath[item.type]} />
      </svg>
      <span className="flex-1">{item.message}</span>
      <button
        onClick={onDismiss}
        // 44px (WCAG 2.5.5) inside a toast whose text line is 20px tall, so the
        // negative margin lets the target reach into the container's py-3 instead
        // of adding 24px of height to every toast. It still fits: 44px of button
        // in a 52px box.
        className="flex h-11 w-11 -my-2 shrink-0 items-center justify-center opacity-80 hover:opacity-100 transition-opacity rounded focus:outline-none focus-visible:ring-2 focus-visible:ring-white"
        aria-label={t('dismiss', lang)}
      >
        <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
        </svg>
      </button>
    </div>
  )
}
