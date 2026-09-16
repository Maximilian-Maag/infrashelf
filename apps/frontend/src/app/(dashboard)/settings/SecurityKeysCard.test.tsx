import { describe, it, expect, vi, beforeAll, beforeEach } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { get, post } from '@/lib/api'
import { SecurityKeysCard } from './SecurityKeysCard'

vi.mock('@/lib/api', () => ({ get: vi.fn(), post: vi.fn(), del: vi.fn() }))
vi.mock('@/lib/useLang', () => ({ useLang: () => 'en' }))

// The browser half of the ceremony. Everything the user does happens inside it,
// so the card only cares that it resolves.
vi.mock('@simplewebauthn/browser', () => ({
  startRegistration: vi.fn().mockResolvedValue({ id: 'cred-1', response: {} }),
}))

// Same shape as TwoFactorCard.test.tsx: the card reads `mustEnrollSecondFactor`
// off the session and has to be able to clear it.
let sessionData: { mustEnrollSecondFactor?: boolean } = {}
const updateSession = vi.fn()
const getSession = vi.fn()
vi.mock('next-auth/react', () => ({
  useSession: () => ({ data: sessionData, update: updateSession }),
  getSession: () => getSession(),
}))

const mockedGet = vi.mocked(get)
const mockedPost = vi.mocked(post)

// jsdom implements no WebAuthn, so the card's support probe returns false and it
// disables the button — a click would then do nothing and the test would fail on
// a symptom that has nothing to do with what it is checking.
beforeAll(() => {
  Object.defineProperty(window, 'PublicKeyCredential', { value: class {}, configurable: true })
})

beforeEach(() => {
  mockedGet.mockReset().mockResolvedValue({ credentials: [] } as never)
  mockedPost.mockReset()
  updateSession.mockReset()
  getSession.mockReset()
  sessionData = {}
})

const registerAKey = async () => {
  const user = userEvent.setup()
  await user.type(await screen.findByLabelText(/name/i), 'YubiKey 5C')
  await user.click(screen.getByRole('button', { name: /register/i }))
}

/**
 * Issue #197. A registered key discharges the mandatory-second-factor
 * requirement — `secondFactorOutstanding` counts credentials as well as a
 * confirmed TOTP secret, and re-reads both per request.
 *
 * But the MIDDLEWARE reads `mustEnrollSecondFactor` off the token minted at
 * sign-in, and this card never rewrote it. So an administrator who registered a
 * key was still redirected to /settings?enroll2fa=1 from every page, and still
 * told two-factor authentication was required — having done exactly what was
 * asked. The only way out was to sign out and back in.
 */
describe('SecurityKeysCard lifts the enrolment gate (#197)', () => {
  it('clears mustEnrollSecondFactor once a key is registered', async () => {
    sessionData = { mustEnrollSecondFactor: true }
    mockedPost
      .mockResolvedValueOnce({} as never) // register/options
      .mockResolvedValueOnce({ id: 1, label: 'YubiKey 5C' } as never) // register/verify

    render(<SecurityKeysCard />)
    await registerAKey()

    await waitFor(() => expect(updateSession).toHaveBeenCalledWith({ mustEnrollSecondFactor: false }))
    // And the session is re-read, so the middleware sees the new token on the
    // next navigation rather than one request later.
    expect(getSession).toHaveBeenCalled()
  })

  it('does not touch the session when nothing was owed', async () => {
    sessionData = { mustEnrollSecondFactor: false }
    mockedPost
      .mockResolvedValueOnce({} as never)
      .mockResolvedValueOnce({ id: 1, label: 'YubiKey 5C' } as never)

    render(<SecurityKeysCard />)
    await registerAKey()

    await waitFor(() => expect(mockedPost).toHaveBeenCalledTimes(2))
    expect(updateSession).not.toHaveBeenCalled()
  })

  // The gate must not lift on a ceremony that failed: the account still owes a
  // factor, and clearing the flag would let it past the middleware without one.
  it('leaves the gate in place when registration fails', async () => {
    sessionData = { mustEnrollSecondFactor: true }
    mockedPost.mockResolvedValueOnce({} as never).mockRejectedValueOnce(new Error('verify failed'))

    render(<SecurityKeysCard />)
    await registerAKey()

    await waitFor(() => expect(screen.getByRole('alert')).toBeInTheDocument())
    expect(updateSession).not.toHaveBeenCalled()
  })

  it('uses the keys the server read, without asking again', async () => {
    // The page fetches these now (#466); a card that re-asked would show "no
    // security keys" for a frame on a page whose whole purpose is to say
    // otherwise.
    render(<SecurityKeysCard initialCredentials={[{ id: 9, label: 'YubiKey', createdAt: '2026-01-01T00:00:00.000Z' }] as never} />)

    expect(await screen.findByText('YubiKey')).toBeInTheDocument()
    expect(get).not.toHaveBeenCalled()
  })

  it('asks for itself when the server could not read them', async () => {
    // `undefined` is not `[]`: the first means nobody knows, and the card has to
    // find out rather than claim the account has no keys.
    vi.mocked(get).mockResolvedValue({ credentials: [{ id: 9, label: 'YubiKey', createdAt: '2026-01-01T00:00:00.000Z' }] } as never)
    render(<SecurityKeysCard />)

    expect(await screen.findByText('YubiKey')).toBeInTheDocument()
    expect(get).toHaveBeenCalledWith('/api/users/me/webauthn')
  })

  it('refuses, and says why, on a browser that cannot do WebAuthn', async () => {
    // Decided from the environment rather than assumed and corrected, so an old
    // browser is never briefly offered a form it cannot use (#466).
    const original = window.PublicKeyCredential
    // @ts-expect-error — removing it is the whole point of the test
    delete window.PublicKeyCredential
    try {
      render(<SecurityKeysCard initialCredentials={[]} />)
      // The form stays visible but cannot be submitted, and says why — better
      // than a missing control with no explanation.
      expect(screen.getByRole('alert')).toBeInTheDocument()
      const submit = screen.getAllByRole('button').find((b) => b.getAttribute('type') === 'submit')
      expect(submit).toBeDisabled()
    } finally {
      window.PublicKeyCredential = original
    }
  })
})
