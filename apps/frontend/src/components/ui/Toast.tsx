'use client'

import { createContext, useCallback, useContext, useState, type ReactNode } from 'react'
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
    setTimeout(() => setToasts((prev) => prev.filter((x) => x.id !== id)), 3500)
  }, [])

  return (
    <ToastContext.Provider value={{ toast }}>
      {children}
      {/* The live region is on each bubble (role="alert"/"status"), not here —
          an aria-live container wrapping children that declare their own live
          role nests two regions, and some screen readers then announce twice. */}
      <div className="fixed bottom-4 right-4 z-[9999] flex flex-col gap-2 pointer-events-none">
        {toasts.map((item) => (
          <ToastBubble
            key={item.id}
            item={item}
            onDismiss={() => setToasts((prev) => prev.filter((x) => x.id !== item.id))}
          />
        ))}
      </div>
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

function ToastBubble({ item, onDismiss }: { item: ToastItem; onDismiss: () => void }) {
  const lang = useLang()
  return (
    <div
      role={item.type === 'error' ? 'alert' : 'status'}
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
