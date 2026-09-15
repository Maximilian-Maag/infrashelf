'use client'

import { useEffect, useRef, useState } from 'react'
import { useRouter } from 'next/navigation'
import { SUPPORTED_LANGUAGES, t } from '@/lib/i18n'

interface Props {
  lang: string
}

export function LanguageSwitcher({ lang }: Props) {
  const router = useRouter()
  const [open, setOpen] = useState(false)
  const toggleRef = useRef<HTMLButtonElement>(null)
  const current = lang.split('-')[0].toLowerCase()

  // Allow keyboard users to dismiss the open dropdown with Escape. Restore focus
  // to the toggle so keyboard focus isn't dropped to <body> when options unmount.
  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        setOpen(false)
        toggleRef.current?.focus()
      }
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [open])

  function selectLang(code: string) {
    document.cookie = `lang=${code}; path=/; max-age=31536000; SameSite=Lax`
    window.dispatchEvent(new CustomEvent('langchange', { detail: code }))
    setOpen(false)
    toggleRef.current?.focus()
    router.refresh()
  }

  // Undefined rather than the bare code when we do not ship the language: the
  // label below already carries the code, and "Language: ZZ – ZZ" is worse than
  // saying it once.
  const currentName = SUPPORTED_LANGUAGES.find((l) => l.code === current)?.name

  return (
    <div className="relative">
      <button
        ref={toggleRef}
        onClick={() => setOpen((o) => !o)}
        className="flex items-center justify-center gap-1 min-h-11 min-w-11 text-xs font-medium border border-current/40 rounded-md px-2 py-1 brand-state focus:outline-none focus-visible:ring-2 focus-visible:ring-current active:scale-95"
        style={{ color: 'var(--bp-ink)' }}
        // Two changes from `Language: Deutsch` (#186). The word is translated,
        // so a German page does not name its own control in English; and the
        // code is in the name, because the visible label IS `DE` and an
        // accessible name that omits it fails WCAG 2.5.3 Label in Name —
        // "click Language DE" is a phrase speech control can act on and
        // "click DE" was not. The endonym stays: it is the only place the
        // toggle says WHICH language, and it is written in the language the
        // document is already in, so it needs no `lang` of its own.
        aria-label={
          currentName
            ? `${t('language', lang)}: ${current.toUpperCase()} – ${currentName}`
            : `${t('language', lang)}: ${current.toUpperCase()}`
        }
        aria-expanded={open}
      >
        <svg className="h-3.5 w-3.5 shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M3 5h12M9 3v2m1.048 9.5A18.022 18.022 0 016.412 9m6.088 9h7M11 21l5-10 5 10M12.751 5C11.783 10.77 8.07 15.61 3 18.129" />
        </svg>
        {current.toUpperCase()}
      </button>

      {open && (
        <>
          <div className="fixed inset-0 z-40" onClick={() => setOpen(false)} />
          <div className="absolute right-0 top-full mt-2 z-50 bg-white rounded-xl shadow-xl border border-slate-200 p-3 w-72 animate-slide-down">
            <div className="grid grid-cols-3 gap-1 max-h-64 overflow-y-auto pr-1">
              {SUPPORTED_LANGUAGES.map((l) => (
                <button
                  key={l.code}
                  onClick={() => selectLang(l.code)}
                  // 25 buttons that differ only by fill colour otherwise: a
                  // screen-reader user could not hear which language is in
                  // effect. `aria-current` rather than `aria-pressed` — these
                  // are not toggles, they are one selection out of a set
                  // (#186).
                  aria-current={l.code === current ? 'true' : undefined}
                  // 25 of these in a 3-column grid, so the floor matters: two lines
                  // of 10-12px type landed within a pixel of 44 by accident.
                  className="w-full flex flex-col items-center justify-center min-h-11 rounded-lg px-1 py-2 transition-colors text-center active:scale-95"
                  style={l.code === current
                    ? { backgroundColor: 'var(--bs)', color: 'var(--bs-ink)' }
                    : { color: '#475569' }
                  }
                  onMouseEnter={(e) => { if (l.code !== current) (e.currentTarget as HTMLElement).style.backgroundColor = '#f8fafc' }}
                  onMouseLeave={(e) => { if (l.code !== current) (e.currentTarget as HTMLElement).style.backgroundColor = '' }}
                >
                  <span className="font-bold text-xs">{l.code.toUpperCase()}</span>
                  {/* Every entry is written in its own language, so on a German
                      page a German voice would read `Ελληνικά` with German
                      phonemes. `lang` is what switches the pronunciation
                      (WCAG 3.1.2 Language of Parts — #186). */}
                  <span lang={l.code} className="block text-[10px] leading-tight truncate">{l.name}</span>
                </button>
              ))}
            </div>
          </div>
        </>
      )}
    </div>
  )
}
