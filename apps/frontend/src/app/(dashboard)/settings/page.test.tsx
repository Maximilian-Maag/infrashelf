import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen } from '@testing-library/react'
import type * as Navigation from 'next/navigation'
import { ApiError } from '@/lib/api'
import SettingsPage from './page'

const auth = vi.fn()
vi.mock('@/lib/auth', () => ({ auth: () => auth() }))
vi.mock('@/lib/getLang', () => ({ getLang: async () => 'en' }))

const redirect = vi.fn((url: string) => { throw new Error(`NEXT_REDIRECT:${url}`) })
vi.mock('next/navigation', async (importOriginal) => ({
  ...(await importOriginal<typeof Navigation>()),
  redirect: (url: string) => redirect(url),
}))

const get = vi.fn()
vi.mock('@/lib/serverApi', () => ({ get: (path: string) => get(path) }))

/** Each card reports what it was handed, and `undefined` distinctly from a real answer. */
const shown = (v: unknown) => (v === undefined ? 'undefined' : JSON.stringify(v))
vi.mock('./SettingsForms', () => ({
  SettingsForms: ({ initialTwoFactor, initialCredentials }: Record<string, unknown>) =>
    <div data-testid="forms" data-2fa={shown(initialTwoFactor)} data-keys={shown(initialCredentials)} />,
}))
vi.mock('@/components/forms/ActiveSessions', () => ({
  ActiveSessions: ({ initialSessions }: { initialSessions: unknown }) =>
    <div data-testid="sessions" data-value={shown(initialSessions)} />,
}))

const answer = (over: Record<string, unknown> = {}) => {
  get.mockImplementation((path: string) => {
    const key = path.startsWith('/api/sessions') ? 'sessions'
      : path.endsWith('/2fa') ? 'twoFactor' : 'credentials'
    const fallback: Record<string, unknown> = {
      sessions: [{ id: 1 }], twoFactor: { enabled: true }, credentials: { credentials: [{ id: 9 }] },
    }
    const v = key in over ? over[key] : fallback[key]
    return v instanceof Error ? Promise.reject(v) : Promise.resolve(v)
  })
}

beforeEach(() => {
  get.mockReset()
  redirect.mockClear()
  auth.mockResolvedValue({ user: { name: 'Ada', email: 'ada@test.dev', role: 'admin' } })
  answer()
})

/**
 * Three security cards, and the same rule for all of them (#466): `undefined`
 * means the server could not read it, so the card retries. `null` and `[]` are
 * real answers — no second factor, no keys, no other sessions — and rendering
 * one of those for a failed read is the most reassuring thing this page can say
 * wrongly.
 */
describe('SettingsPage', () => {
  it('sends a caller with no session to the login page', async () => {
    auth.mockResolvedValue(null)
    await expect(SettingsPage()).rejects.toThrow('NEXT_REDIRECT')
    expect(redirect).toHaveBeenCalledWith('/login')
  })

  it('fetches all three and hands each to its card', async () => {
    render(await SettingsPage())

    expect(get).toHaveBeenCalledWith('/api/sessions')
    expect(get).toHaveBeenCalledWith('/api/users/me/2fa')
    expect(get).toHaveBeenCalledWith('/api/users/me/webauthn')
    expect(screen.getByTestId('forms')).toHaveAttribute('data-2fa', '{"enabled":true}')
    expect(screen.getByTestId('forms')).toHaveAttribute('data-keys', '[{"id":9}]')
    expect(screen.getByTestId('sessions')).toHaveAttribute('data-value', '[{"id":1}]')
  })

  it('hands over undefined — not an empty answer — when a read fails', async () => {
    answer({ twoFactor: new ApiError(502, 'Bad Gateway'), credentials: new ApiError(502, 'Bad Gateway') })
    render(await SettingsPage())

    expect(screen.getByTestId('forms')).toHaveAttribute('data-2fa', 'undefined')
    expect(screen.getByTestId('forms')).toHaveAttribute('data-keys', 'undefined')
  })

  it('lets one endpoint fail without costing the other two', async () => {
    // This page is also where you change your password; an outage on a security
    // endpoint must not take that away.
    answer({ sessions: new ApiError(500, 'boom') })
    render(await SettingsPage())

    expect(screen.getByTestId('sessions')).toHaveAttribute('data-value', 'undefined')
    expect(screen.getByTestId('forms')).toHaveAttribute('data-2fa', '{"enabled":true}')
  })

  it('sends an ended session to the login page rather than three empty cards', async () => {
    // `allSettled` collects a thrown `redirect()` as a rejection like any other
    // (#434, #445) — without the rethrow this renders a settings page saying the
    // account has no second factor and no keys.
    const { redirect: realRedirect } = await vi.importActual<typeof Navigation>('next/navigation')
    let thrown: unknown
    try { realRedirect('/login?expired=1') } catch (e) { thrown = e }
    answer({ twoFactor: thrown })

    await expect(SettingsPage()).rejects.toThrow()
  })
})
