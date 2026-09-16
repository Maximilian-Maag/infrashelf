import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { act, renderHook } from '@testing-library/react'
import type { ReactNode } from 'react'
import { LangProvider } from '@/components/layout/LangProvider'
import { useLang } from './useLang'

/**
 * The precedence this hook implements is load-bearing: the bug it was written
 * for was the catalogue rendering its labels in German inside a chrome the
 * server had rendered in English, because the client resolved the language from
 * `navigator.language` and the server from the cookie AND Accept-Language.
 */

function setCookie(value: string | null) {
  setRawCookie(value === null ? '' : `lang=${value}`)
}

/** The whole cookie string, for the cases where the neighbours are the point. */
function setRawCookie(raw: string) {
  Object.defineProperty(document, 'cookie', {
    configurable: true,
    get: () => raw,
    set: () => {},
  })
}

function setNavigatorLanguage(value: string) {
  Object.defineProperty(window.navigator, 'language', { configurable: true, value })
}

const withProvider = (lang: string) =>
  function Wrapper({ children }: { children: ReactNode }) {
    return <LangProvider lang={lang}>{children}</LangProvider>
  }

beforeEach(() => {
  setCookie(null)
  setNavigatorLanguage('fr-FR')
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe('useLang precedence', () => {
  it('uses the cookie even when the server passed something else', () => {
    setCookie('de')
    const { result } = renderHook(() => useLang('en'))
    expect(result.current).toBe('de')
  })

  it('uses the SERVER value, not navigator.language, when there is no cookie', () => {
    // The regression this hook exists for: navigator said fr, the server said en,
    // and the page rendered half in each.
    const { result } = renderHook(() => useLang('en'))
    expect(result.current).toBe('en')
  })

  it('takes the server value from LangProvider when no initial prop is given', () => {
    const { result } = renderHook(() => useLang(), { wrapper: withProvider('es') })
    expect(result.current).toBe('es')
  })

  it('lets an explicit initial prop win over the provider', () => {
    const { result } = renderHook(() => useLang('it'), { wrapper: withProvider('es') })
    expect(result.current).toBe('it')
  })

  it('falls back to navigator.language only when neither cookie nor server value exists', () => {
    setNavigatorLanguage('nl-NL')
    const { result } = renderHook(() => useLang())
    expect(result.current).toBe('nl')
  })

  it('strips the region from navigator.language', () => {
    setNavigatorLanguage('pt-BR')
    const { result } = renderHook(() => useLang())
    expect(result.current).toBe('pt')
  })

  it('picks the lang cookie out of a jar holding other cookies', () => {
    Object.defineProperty(document, 'cookie', {
      configurable: true,
      get: () => 'theme=dark; lang=sv; session=abc',
      set: () => {},
    })
    const { result } = renderHook(() => useLang('en'))
    expect(result.current).toBe('sv')
  })

  it('does not match a cookie whose name merely ends in "lang"', () => {
    // `sublang=de` must not be read as the language choice.
    Object.defineProperty(document, 'cookie', {
      configurable: true,
      get: () => 'sublang=de',
      set: () => {},
    })
    const { result } = renderHook(() => useLang('en'))
    expect(result.current).toBe('en')
  })
})

describe('useLang langchange event', () => {
  it('adopts the language the switcher announces', () => {
    const { result } = renderHook(() => useLang('en'))
    act(() => {
      // Exactly what `persistLang` does, in that order: write the cookie, then
      // announce. The hook re-reads the cookie on the announcement rather than
      // trusting the event's payload (#450), so the two can no longer disagree —
      // and this test would pass on a payload that contradicted the cookie
      // before.
      setCookie('hu')
      window.dispatchEvent(new CustomEvent('langchange', { detail: 'hu' }))
    })
    expect(result.current).toBe('hu')
  })

  it('believes the cookie over the announcement, if they ever differ', () => {
    // They cannot today — `persistLang` writes both — but the cookie is what the
    // server will read on the next request, so it is the one that decides.
    const { result } = renderHook(() => useLang('en'))
    act(() => {
      setCookie('hu')
      window.dispatchEvent(new CustomEvent('langchange', { detail: 'sv' }))
    })
    expect(result.current).toBe('hu')
  })

  it('stops listening once unmounted', () => {
    // Every page mounts several of these. A listener left behind sets state on
    // an unmounted tree on every language switch.
    const remove = vi.spyOn(window, 'removeEventListener')
    const { unmount } = renderHook(() => useLang('en'))
    unmount()
    expect(remove).toHaveBeenCalledWith('langchange', expect.any(Function))
  })

  it('re-reads the cookie when the server value changes', () => {
    const { result, rerender } = renderHook(({ l }: { l: string }) => useLang(l), {
      initialProps: { l: 'en' },
    })
    expect(result.current).toBe('en')
    rerender({ l: 'da' })
    expect(result.current).toBe('da')
  })
})

// `document.cookie` is one string holding every cookie for the origin, so the
// pattern has to find `lang` among neighbours without matching a cookie that
// merely ends in it.
describe('useLang cookie parsing', () => {
  // No provider at all, which is what the login page renders: `useServerLang()`
  // answers null there, so the cookie is what decides.
  const read = () => renderHook(() => useLang())

  it('finds lang after another cookie', () => {
    setRawCookie('session=abc; lang=fr; theme=dark')
    const { result } = read()
    expect(result.current).toBe('fr')
  })

  it('finds lang when it comes first', () => {
    setRawCookie('lang=it; session=abc')
    const { result } = read()
    expect(result.current).toBe('it')
  })

  it('stops at the next cookie rather than swallowing it', () => {
    setRawCookie('lang=nl; session=abc')
    const { result } = read()
    expect(result.current).toBe('nl')
  })

  // `mylang=de` ends in `lang=de`. Without the boundary the hook would adopt
  // another cookie's value as the interface language.
  it('does not match a cookie whose name merely ends in lang', () => {
    setNavigatorLanguage('en')
    setRawCookie('mylang=de; session=abc')
    const { result } = read()
    expect(result.current).not.toBe('de')
  })
})
