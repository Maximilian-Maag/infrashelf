'use client'

import { useState, useEffect, type FormEvent } from 'react'
import { signIn } from 'next-auth/react'
import { useRouter, useSearchParams } from 'next/navigation'
import { useLang } from '@/lib/useLang'
import { t } from '@/lib/i18n'
import { Alert } from '@/components/ui/Alert'
import { readableInk, readableAccent, AA_LARGE, AA_NON_TEXT } from '@/lib/contrast'
import { MFA_LOCKED_OUT } from '@/lib/loginErrors'
import { startAuthentication, browserSupportsWebAuthnAutofill } from '@simplewebauthn/browser'
import type { SecondFactorMethod } from '@infrashelf/types'

/** The options object `startAuthentication` takes, named from its own signature. */
type AuthOptions = Parameters<typeof startAuthentication>[0]['optionsJSON']

interface Props {
  shopName: string
  shopSubtitle: string
  logoDataUrl: string | null
  primaryColor: string
  secondaryColor: string
}

/**
 * Where to go after signing in.
 *
 * The middleware has always put a `callbackUrl` on its redirect and nothing ever
 * read it, so an expired session dropped you on the dashboard root instead of the
 * page you were on (#103). Only same-site paths are honoured: an absolute URL or
 * a protocol-relative `//host` in a query parameter is an open redirect.
 */
const safeCallbackUrl = (value: string | null): string =>
  value && value.startsWith('/') && !value.startsWith('//') ? value : '/'

export function LoginForm({ shopName, shopSubtitle, logoDataUrl, primaryColor, secondaryColor }: Props) {
  const router = useRouter()
  const searchParams = useSearchParams()
  const lang = useLang()
  const sessionExpired = searchParams.get('expired') === '1'
  const callbackUrl = safeCallbackUrl(searchParams.get('callbackUrl'))
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [rememberMe, setRememberMe] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  /**
   * The challenge from step one, held only in component state.
   *
   * Not in `sessionStorage` or a query parameter: it is a five-minute bearer
   * credential for finishing a sign-in, and the page it is needed on is the page
   * that received it. A reload starting over from the password is the correct
   * outcome, not a bug to work around.
   */
  const [mfaToken, setMfaToken] = useState<string | null>(null)
  const [code, setCode] = useState('')
  /**
   * The WebAuthn request options, when the account holds a key (#197 part 2).
   *
   * Handed over with the challenge in step one, so reaching for the key costs no
   * extra round trip. Null means the account has no key — or that building them
   * failed, in which case the code field is the fallback wherever the account
   * has one. Where it does not, the step says so rather than showing nothing
   * (#240).
   */
  const [webauthnOptions, setWebauthnOptions] = useState<AuthOptions | null>(null)
  /** Whether the account also holds an authenticator app, so the code field is worth showing. */
  const [hasTotp, setHasTotp] = useState(true)

  /**
   * Whether this browser can do a passwordless ceremony at all (#241).
   *
   * `false` until the effect below answers, so the button never flashes in and
   * out on a browser that cannot use it. The check is asynchronous and
   * client-only — it asks the platform authenticator, which does not exist
   * during server rendering.
   */
  const [passwordlessAvailable, setPasswordlessAvailable] = useState(false)

  useEffect(() => {
    let stale = false
    /*
     * Conditional mediation is the honest question to ask.
     *
     * `browserSupportsWebAuthn()` alone is not enough: a browser can support
     * WebAuthn as a second factor and still have no discoverable credential to
     * offer, and the button would then open a prompt with nothing in it. This
     * asks whether the platform can answer a ceremony that names no account.
     */
    browserSupportsWebAuthnAutofill()
      .then((supported) => { if (!stale) setPasswordlessAvailable(supported) })
      .catch(() => { if (!stale) setPasswordlessAvailable(false) })
    return () => { stale = true }
  }, [])

  /**
   * Sign in with a key alone — no email, no password (#241).
   *
   * Two round trips and no account named in either: the first asks for a
   * challenge with no `allowCredentials`, the second redeems whatever the
   * authenticator produced. The account comes out of the credential.
   */
  async function handlePasswordlessSubmit() {
    setError(null)
    setLoading(true)
    try {
      // `/api/login-challenge`, not `/api/proxy`: the proxy checks the session and
      // answers 401, and nobody on this page has one yet. See that route for why
      // the passwordless options are folded into it rather than given a route of
      // their own.
      const res = await fetch('/api/login-challenge', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ passwordless: true }),
      })
      if (!res.ok) {
        setError(t('unexpectedError', lang))
        return
      }
      const optionsJSON = (await res.json()) as AuthOptions
      const assertion = await startAuthentication({ optionsJSON })
      const result = await signIn('credentials', {
        webauthn: JSON.stringify(assertion),
        rememberMe: String(rememberMe),
        redirect: false,
      })
      // Not `invalidCredentials`: "Invalid email or password" names two fields
      // this sign-in never touched.
      if (!(await finishSignIn(result))) setError(t('securityKeySignInFailed', lang))
    } catch (err) {
      // Closing the prompt, or having no credential to offer, is not a failed
      // sign-in — the user is still on the form with the password field ready.
      if (err instanceof Error && (err.name === 'NotAllowedError' || err.name === 'AbortError')) {
        return
      }
      setError(t('unexpectedError', lang))
    } finally {
      setLoading(false)
    }
  }

  const finishSignIn = async (result: { error?: string | null; code?: string } | undefined) => {
    if (result?.error) return false
    router.push(callbackUrl)
    router.refresh()
    return true
  }

  /**
   * Step one: check the password and find out whether a code is needed.
   *
   * This goes through the app's own route handler rather than `signIn`, because
   * `signIn` can only answer yes or no — a sign-in that needs a second factor
   * would come back as the same error as a wrong password, and the form could
   * never know to ask for a code. See app/api/login-challenge/route.ts.
   */
  async function handleSubmit(e: FormEvent) {
    e.preventDefault()
    setError(null)
    setLoading(true)
    try {
      const res = await fetch('/api/login-challenge', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        // "Remember me" is sent with the PASSWORD, not with the code: the
        // backend seals it into the challenge, so a two-step sign-in gets the
        // lifetime the user actually asked for without the second step being
        // able to change it (#37).
        body: JSON.stringify({ email, password, rememberMe }),
      })
      const data = (await res.json().catch(() => null)) as
        | {
            ok?: boolean
            mfaRequired?: boolean
            mfaToken?: string
            methods?: SecondFactorMethod[]
            webauthnOptions?: unknown
            error?: string
          }
        | null

      if (!res.ok || !data?.ok) {
        // Two statuses carry a message worth repeating, and everything else is
        // deliberately just "invalid credentials" so this cannot be used to find
        // out which accounts exist.
        //
        //   429 — says how long to wait, which is worth more than a generic
        //         failure.
        //   5xx — is not about the credentials AT ALL. A JWT_SECRET under 32
        //         characters makes every login fail with a 500 saying the server
        //         is misconfigured, and this used to render that as "invalid
        //         email or password". An operator then checks the password they
        //         know is right, forever. Nothing is disclosed by admitting the
        //         server is broken: it is broken for every email, including ones
        //         that do not exist.
        //   403 — the password was RIGHT and something else is in the way: the
        //         account is deactivated. Only reachable past a correct
        //         password, so it discloses nothing to anyone who does not
        //         already hold the credentials — and rendering it as "invalid
        //         email or password" is what sent an operator hunting for a
        //         password problem for an afternoon (#196).
        const worthRepeating = res.status === 429 || res.status === 403 || res.status >= 500
        setError(worthRepeating && data?.error ? data.error : t('invalidCredentials', lang))
        return
      }

      if (data.mfaRequired && data.mfaToken) {
        setMfaToken(data.mfaToken)
        setCode('')
        setWebauthnOptions((data.webauthnOptions as AuthOptions | null) ?? null)
        // Two ways this can arrive without naming a method, and both mean "show
        // the code field", which is what every account had before keys existed:
        // `methods` absent is an older backend, and `methods: []` is a backend
        // that requires a second factor and lists none. `!data.methods` covered
        // only the first — an empty array is truthy, so the second hid the code
        // field and left the user with no way to finish signing in at all.
        const named = data.methods ?? []
        setHasTotp(named.length === 0 || named.includes('totp'))
        return
      }

      // No second factor: sign in the ordinary way. `rememberMe` is sent as a
      // string because NextAuth credentials are form fields (#37).
      const result = await signIn('credentials', {
        email,
        password,
        rememberMe: String(rememberMe),
        redirect: false,
      })
      if (!(await finishSignIn(result))) {
        setError(t('invalidCredentials', lang))
      }
    } catch {
      setError(t('unexpectedError', lang))
    } finally {
      setLoading(false)
    }
  }

  /**
   * Step two, with a key: run the ceremony and redeem the assertion.
   *
   * The browser signs over the origin it is actually on, so this is the half of
   * the sign-in a lookalike page cannot complete — the assertion it collected
   * would name the wrong origin and the server would refuse it.
   */
  async function handleKeySubmit() {
    if (!mfaToken || !webauthnOptions) return
    setError(null)
    setLoading(true)
    try {
      const assertion = await startAuthentication({ optionsJSON: webauthnOptions })
      const result = await signIn('credentials', {
        email,
        mfaToken,
        webauthn: JSON.stringify(assertion),
        redirect: false,
      })
      if (!(await finishSignIn(result))) setError(t('invalidCredentials', lang))
    } catch (err) {
      // Closing the prompt is not a failed sign-in, and saying so would send the
      // user looking for a problem that is not there.
      if (err instanceof Error && (err.name === 'NotAllowedError' || err.name === 'AbortError')) {
        return
      }
      setError(t('unexpectedError', lang))
    } finally {
      setLoading(false)
    }
  }

  /** Step two: redeem the challenge with a TOTP code or a recovery code. */
  async function handleCodeSubmit(e: FormEvent) {
    e.preventDefault()
    if (!mfaToken) return
    setError(null)
    setLoading(true)
    try {
      const result = await signIn('credentials', { email, mfaToken, code, redirect: false })
      if (!(await finishSignIn(result))) {
        // The lockout is the one failure worth distinguishing: it is the
        // difference between "try again" and "stop trying and use a recovery
        // code". Everything else stays generic on purpose.
        setError(
          result?.code === MFA_LOCKED_OUT
            ? t('twoFactorLockedOut', lang)
            : t('invalidCredentials', lang),
        )
        setCode('')
      }
    } catch {
      setError(t('unexpectedError', lang))
    } finally {
      setLoading(false)
    }
  }

  return (
    <div
      className="min-h-screen flex items-center justify-center bg-slate-100 px-4"
      style={{
        '--bp': primaryColor,
        '--bs': secondaryColor,
        '--bp-ink': readableInk(primaryColor).ink,
        '--bs-ink': readableInk(secondaryColor).ink,
        // The brand colour used AS text on a white card — darkened until it
        // clears readableAccent's default target (7:1), so a pale brand stays
        // readable.
        '--bp-text': readableAccent(primaryColor),
        // Same boundary as the dashboard gives its filled controls.
        '--bs-edge': readableAccent(secondaryColor, undefined, AA_NON_TEXT),
        // The same again for the PRIMARY fill, which is what the two submit
        // buttons on this page are painted with. `Button` has given its filled
        // controls a `--bs-edge` boundary since #178, for the reason it states
        // there: a near-white brand colour — #f5f5f4 is a real configuration
        // here — is a button indistinguishable from the card behind it, which
        // reads as disabled and fails WCAG 1.4.11. These two are hand-rolled
        // rather than `Button`s, so they never got it (#195, F3).
        '--bp-edge': readableAccent(primaryColor, undefined, AA_NON_TEXT),
        // Focus rings sit on the white card, so they need the same treatment.
        '--ring-accent': readableAccent(secondaryColor, '#ffffff', AA_LARGE),
      } as React.CSSProperties}
    >
      {/* A landmark, not a plain div: this page renders outside the dashboard
          layout, so nothing else on it provides one and every element on the
          screen sat outside all landmarks. `landmark-one-main` and `region`
          both say so — two of the rules this gate did not request until #185. */}
      <main className="w-full max-w-sm">
        <div className="text-center mb-8">
          {logoDataUrl ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={logoDataUrl} alt={shopName} className="h-12 mx-auto mb-4 object-contain" />
          ) : null}
          <h1 className="text-2xl font-bold text-slate-900">{shopName}</h1>
          {shopSubtitle && <p className="text-sm text-slate-600 mt-1">{shopSubtitle}</p>}
        </div>

        <div className="bg-white rounded-xl border border-slate-200 shadow-sm p-6">
          {error && (
            <Alert className="mb-4">
              {error}
            </Alert>
          )}

          {/* Why you are looking at this page. Suppressed once there is an error
              from this attempt — that one is about what just happened. */}
          {sessionExpired && !error && (
            <Alert tone="info" className="mb-4">
              {t('sessionExpired', lang)}
            </Alert>
          )}

          {mfaToken ? (
            <form onSubmit={handleCodeSubmit} className="space-y-4">
              <h2 className="text-base font-semibold text-slate-900">{t('twoFactorAuth', lang)}</h2>

              {/* The key first where the account has one: it is the stronger of
                  the two, and it is one press against six typed digits. Its own
                  button rather than the form's submit, because the ceremony is
                  not a form submission and pressing Enter in the code field must
                  not start it (#197 part 2). */}
              {webauthnOptions && (
                <div className="space-y-2">
                  <p className="text-sm text-slate-600">{t('twoFactorKeyHint', lang)}</p>
                  <button
                    type="button"
                    onClick={() => void handleKeySubmit()}
                    disabled={loading}
                    className="w-full min-h-11 rounded-md border px-3 py-2 text-sm font-medium disabled:opacity-60"
                    style={{ borderColor: 'var(--bs-edge)', color: 'var(--bp-text)' }}
                  >
                    {loading ? t('twoFactorVerifying', lang) : t('useSecurityKey', lang)}
                  </button>
                  {hasTotp && (
                    <p className="text-center text-xs text-slate-500">{t('orUseCode', lang)}</p>
                  )}
                </div>
              )}

              {hasTotp && <p className="text-sm text-slate-600">{t('twoFactorLoginHint', lang)}</p>}
              <div className={hasTotp ? undefined : 'hidden'}>
                <label htmlFor="code" className="block text-sm font-medium text-slate-700 mb-1">
                  {t('twoFactorCodeLabel', lang)}
                </label>
                <input
                  id="code"
                  name="code"
                  type="text"
                  // one-time-code lets a phone offer the code from its keychain;
                  // the field also has to accept a 23-character recovery code,
                  // so it is not numeric-only.
                  autoComplete="one-time-code"
                  inputMode="text"
                  spellCheck={false}
                  autoCapitalize="characters"
                  // Never on a hidden field: an account with only a key has this
                  // input hidden, and a required invisible input is a form the
                  // browser refuses to submit without saying why.
                  required={hasTotp}
                  autoFocus={hasTotp}
                  value={code}
                  onChange={(e) => setCode(e.target.value)}
                  className="w-full min-h-11 rounded-md border border-slate-200 px-3 py-2 text-sm tracking-widest text-slate-900 placeholder-slate-500 focus:outline-none focus:ring-2 focus:border-transparent"
                  style={{ '--tw-ring-color': 'var(--ring-accent)' } as React.CSSProperties}
                  placeholder="123456"
                />
              </div>
              {/* The submit button belongs to the code field, so it is gated on the
                  same condition (#240). An account that holds only a key had it
                  rendered under the hidden field, where the only thing it could
                  do was submit an empty code and come back with "invalid
                  credentials" — a refusal for a control that should not have
                  been offered.

                  The label is not `signIn` either: those are the words on the
                  button of the password step the user just pressed, so repeating
                  them here reads as "you are being asked to log in again"
                  rather than "confirm this code". */}
              {hasTotp && (
                <button
                  type="submit"
                  disabled={loading}
                  className="w-full min-h-11 rounded-md border px-4 py-2.5 text-sm font-semibold hover:opacity-90 focus:outline-none focus-visible:ring-2 focus-visible:ring-offset-2 disabled:opacity-50 disabled:cursor-not-allowed transition-opacity"
                  // Same --ring-accent the fields above use, and for a sharper
                  // reason: `ring-2` with no colour falls back to `currentcolor`,
                  // which on this button is --bp-ink — white for every dark
                  // primary. A white ring on the default white offset, on a white
                  // card, with the UA outline removed, is no focus indicator at
                  // all (#186).
                  style={{
                    backgroundColor: 'var(--bp)',
                    color: 'var(--bp-ink)',
                    borderColor: 'var(--bp-edge, transparent)',
                    '--tw-ring-color': 'var(--ring-accent)',
                  } as React.CSSProperties}
                >
                  {loading ? t('twoFactorVerifying', lang) : t('twoFactorVerify', lang)}
                </button>
              )}

              {/* Neither control: a key-only account whose request options failed
                  to build (login-challenge leaves them null rather than failing
                  the sign-in). Before #240 the dead submit button at least made
                  the card look finished; hiding it correctly would otherwise
                  leave a heading and a Back link with no explanation. A recovery
                  code is no help here — they live on the TOTP row, which this
                  account does not have. */}
              {!hasTotp && !webauthnOptions && (
                <p className="text-sm text-slate-600">{t('twoFactorNoMethod', lang)}</p>
              )}
              <button
                type="button"
                onClick={() => {
                  // Discard the challenge as well as the code: going back means
                  // starting over from the password, not keeping a live
                  // half-finished sign-in around.
                  setMfaToken(null)
                  setCode('')
                  setPassword('')
                  setError(null)
                }}
                className="w-full min-h-11 rounded-md px-4 py-2 text-sm font-medium text-slate-600 hover:text-slate-900 focus:outline-none focus-visible:ring-2"
                style={{ '--tw-ring-color': 'var(--ring-accent)' } as React.CSSProperties}
              >
                {t('back', lang)}
              </button>
            </form>
          ) : (
          <form onSubmit={handleSubmit} className="space-y-4">
            {/*
              * Before the email field, because it replaces both fields rather
              * than adding to them (#241). A user who signs in this way never
              * touches either.
              *
              * Only where the browser can actually answer such a ceremony — the
              * check is asynchronous, so this is absent on first paint and on
              * anything that cannot do it, rather than present and failing.
              *
              * `type="button"`, or it would submit the form it sits inside.
              */}
            {passwordlessAvailable && (
              <div className="space-y-4">
                <button
                  type="button"
                  onClick={handlePasswordlessSubmit}
                  disabled={loading}
                  className="w-full min-h-11 rounded-md border border-slate-300 px-4 py-2 text-sm font-medium text-slate-700 hover:bg-slate-50 focus:outline-none focus-visible:ring-2 disabled:opacity-60"
                  style={{ '--tw-ring-color': 'var(--ring-accent)' } as React.CSSProperties}
                >
                  {t('useSecurityKey', lang)}
                </button>
                {/* Punctuation between two controls that already name
                  * themselves, so `aria-hidden` and no text: a translated "or"
                  * would be a twenty-sixth string in twenty-five tables for a
                  * word the layout already says. */}
                <div className="h-px bg-slate-200" aria-hidden="true" />
              </div>
            )}
            <div>
              <label htmlFor="email" className="block text-sm font-medium text-slate-700 mb-1">
                {t('emailAddress', lang)}
              </label>
              <input
                id="email"
                type="email"
                autoComplete="email"
                required
                autoFocus
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                className="w-full min-h-11 rounded-md border border-slate-200 px-3 py-2 text-sm text-slate-900 placeholder-slate-500 focus:outline-none focus:ring-2 focus:border-transparent"
                // Not var(--bs) directly: a pale secondary colour makes the focus ring
                // invisible. --ring-accent is the AA-adjusted variant.
                style={{ '--tw-ring-color': 'var(--ring-accent)' } as React.CSSProperties}
                placeholder="you@example.com"
              />
            </div>

            <div>
              <label htmlFor="password" className="block text-sm font-medium text-slate-700 mb-1">
                {t('password', lang)}
              </label>
              <input
                id="password"
                type="password"
                autoComplete="current-password"
                required
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                className="w-full min-h-11 rounded-md border border-slate-200 px-3 py-2 text-sm text-slate-900 placeholder-slate-500 focus:outline-none focus:ring-2 focus:border-transparent"
                // Not var(--bs) directly: a pale secondary colour makes the focus ring
                // invisible. --ring-accent is the AA-adjusted variant.
                style={{ '--tw-ring-color': 'var(--ring-accent)' } as React.CSSProperties}
                placeholder="••••••••"
              />
            </div>

            {/* A real checkbox with a real label: this decides how long the
                session lives, so it has to be reachable by keyboard and
                announced, not a styled div. */}
            <div className="flex items-center gap-2">
              <input
                id="rememberMe"
                type="checkbox"
                checked={rememberMe}
                onChange={(e) => setRememberMe(e.target.checked)}
                className="h-4 w-4 rounded border-slate-300 focus:outline-none focus-visible:ring-2"
                style={{ '--tw-ring-color': 'var(--ring-accent)' } as React.CSSProperties}
              />
              <label htmlFor="rememberMe" className="text-sm text-slate-700">
                {t('rememberMe', lang)}
              </label>
            </div>

            <button
              type="submit"
              disabled={loading}
              className="w-full min-h-11 rounded-md border px-4 py-2.5 text-sm font-semibold hover:opacity-90 focus:outline-none focus-visible:ring-2 focus-visible:ring-offset-2 disabled:opacity-50 disabled:cursor-not-allowed transition-opacity"
              // See the verify button above: without a colour the ring inherits
              // --bp-ink and disappears into the white offset it is drawn on.
              style={{
                backgroundColor: 'var(--bp)',
                color: 'var(--bp-ink)',
                borderColor: 'var(--bp-edge, transparent)',
                '--tw-ring-color': 'var(--ring-accent)',
              } as React.CSSProperties}
            >
              {loading ? t('signingIn', lang) : t('signIn', lang)}
            </button>
          </form>
          )}
        </div>
      </main>
    </div>
  )
}
