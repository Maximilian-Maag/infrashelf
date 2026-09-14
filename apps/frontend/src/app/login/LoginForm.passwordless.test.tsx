import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'

/**
 * Signing in with a key alone (#241).
 *
 * In its own file because it has to mock `@simplewebauthn/browser`, and
 * `LoginForm.test.tsx` deliberately does not: there the real module runs, jsdom
 * has no authenticator, `browserSupportsWebAuthnAutofill()` answers false, and
 * the button correctly never appears. Mocking it there would change what every
 * other case in that file is rendering.
 */
const signIn = vi.fn()
const push = vi.fn()
const refresh = vi.fn()
const startAuthentication = vi.fn()
const supportsAutofill = vi.fn()

vi.mock('next-auth/react', () => ({ signIn: (...args: unknown[]) => signIn(...args) }))
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push, refresh }),
  useSearchParams: () => new URLSearchParams(),
}))
vi.mock('@/lib/useLang', () => ({ useLang: () => 'en' }))
vi.mock('@simplewebauthn/browser', () => ({
  startAuthentication: (...a: unknown[]) => startAuthentication(...a),
  browserSupportsWebAuthnAutofill: () => supportsAutofill(),
}))

const { LoginForm } = await import('./LoginForm')

const props = {
  shopName: 'InfraShelf',
  shopSubtitle: '',
  logoDataUrl: null,
  primaryColor: '#131921',
  secondaryColor: '#febd69',
}

const keyButton = () => screen.queryByRole('button', { name: /use security key/i })

beforeEach(() => {
  signIn.mockReset()
  push.mockReset()
  refresh.mockReset()
  startAuthentication.mockReset().mockResolvedValue({ id: 'cred-1', response: {} })
  supportsAutofill.mockReset().mockResolvedValue(true)
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
    ok: true,
    status: 200,
    json: async () => ({ challenge: 'c', rpId: 'example.test' }),
  }))
})

afterEach(() => vi.unstubAllGlobals())

describe('the passwordless button', () => {
  it('is not rendered where the browser cannot answer such a ceremony', async () => {
    supportsAutofill.mockResolvedValue(false)
    render(<LoginForm {...props} />)

    // The email field is what proves the form rendered at all, so an absent
    // button is an absent button rather than an empty page.
    expect(await screen.findByLabelText(/email/i)).toBeInTheDocument()
    await waitFor(() => expect(supportsAutofill).toHaveBeenCalled())
    expect(keyButton()).not.toBeInTheDocument()
  })

  it('appears above the email field where the browser can', async () => {
    render(<LoginForm {...props} />)
    const button = await screen.findByRole('button', { name: /use security key/i })

    // Order matters: it replaces the two fields rather than adding to them, so
    // it belongs before them. `compareDocumentPosition` is the honest way to ask.
    const email = screen.getByLabelText(/email/i)
    expect(button.compareDocumentPosition(email) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
  })

  it('signs in with no email and no password', async () => {
    const user = userEvent.setup()
    signIn.mockResolvedValue({ error: null })
    render(<LoginForm {...props} />)

    await user.click(await screen.findByRole('button', { name: /use security key/i }))

    await waitFor(() => expect(push).toHaveBeenCalled())
    // The challenge is asked for with no account named.
    expect(vi.mocked(fetch).mock.calls[0][0]).toContain('/api/auth/webauthn/options')
    const credentials = signIn.mock.calls[0][1] as Record<string, unknown>
    expect(credentials.webauthn).toBe(JSON.stringify({ id: 'cred-1', response: {} }))
    // Absent, not empty: sending an empty email would have the backend look one
    // up, and the point is that the authenticator decides who is signing in.
    expect(credentials.email).toBeUndefined()
    expect(credentials.password).toBeUndefined()
    // No `mfaToken`, which is what tells the backend this is a first factor.
    expect(credentials.mfaToken).toBeUndefined()
  })

  it('says nothing when the user closes the authenticator prompt', async () => {
    // Cancelling is not a failed sign-in, and an error would send the user
    // looking for a problem that is not there.
    const user = userEvent.setup()
    const cancelled = new Error('cancelled')
    cancelled.name = 'NotAllowedError'
    startAuthentication.mockRejectedValue(cancelled)

    render(<LoginForm {...props} />)
    await user.click(await screen.findByRole('button', { name: /use security key/i }))

    await waitFor(() => expect(startAuthentication).toHaveBeenCalled())
    expect(signIn).not.toHaveBeenCalled()
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
    // And the button is usable again rather than stuck in its loading state.
    expect(keyButton()).not.toBeDisabled()
  })

  it('reports a refused assertion as a failed sign-in', async () => {
    const user = userEvent.setup()
    signIn.mockResolvedValue({ error: 'CredentialsSignin' })
    render(<LoginForm {...props} />)

    await user.click(await screen.findByRole('button', { name: /use security key/i }))

    expect(await screen.findByText(/could not sign you in/i)).toBeInTheDocument()
    expect(push).not.toHaveBeenCalled()
  })
})
