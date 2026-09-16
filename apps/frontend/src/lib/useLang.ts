'use client'

import { useSyncExternalStore } from 'react'
import { useServerLang } from '@/components/layout/LangProvider'

/**
 * The language this client should render in.
 *
 * In order: the cookie (the explicit choice made in the switcher), then the value
 * the SERVER resolved for this render — passed as `initial` or taken from
 * LangProvider — and only then `navigator.language`.
 *
 * The server reads the cookie AND the Accept-Language header, and its answer can
 * differ from `navigator.language`. When it did, the chrome rendered in one
 * language and the server-rendered page beside it in another.
 */
function readLang(fallback: string): string {
  const match = document.cookie.match(/(?:^|;\s*)lang=([^;]+)/)
  return match?.[1] ?? fallback
}

/**
 * Subscribe to the one thing that changes the answer: the switcher's event.
 *
 * The cookie is not observable on its own — nothing fires when it is written —
 * so the switcher announces the change and this listens for it.
 */
const subscribe = (onChange: () => void): (() => void) => {
  window.addEventListener('langchange', onChange)
  return () => window.removeEventListener('langchange', onChange)
}

export function useLang(initial?: string): string {
  const serverLang = useServerLang()
  const resolved = initial ?? serverLang ?? undefined

  /*
   * An external store, not state synced by an effect (#450).
   *
   * The cookie and `navigator.language` cannot be read during the server render
   * — reading them there is the hydration mismatch this hook exists to avoid —
   * so the answer genuinely comes from outside React. `useSyncExternalStore` is
   * built for exactly that pair: a client snapshot, a separate server snapshot,
   * and a subscription. The effect version rendered once in the server's
   * language and again in the cookie's, which is the flash this removes.
   */
  return useSyncExternalStore(
    subscribe,
    () => readLang(resolved ?? navigator.language.split('-')[0] ?? 'en'),
    () => resolved ?? 'en',
  )
}
