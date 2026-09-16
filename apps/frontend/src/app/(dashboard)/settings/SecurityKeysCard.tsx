'use client'

import { useCallback, useEffect, useState, useSyncExternalStore } from 'react'
import { useSession } from 'next-auth/react'
import { startRegistration } from '@simplewebauthn/browser'
import type {
  WebauthnCredential,
  WebauthnCredentialsResponse,
  WebauthnRegistrationResult,
} from '@infrashelf/types'
import { get, post } from '@/lib/api'
import { Card } from '@/components/ui/Card'
import { Alert } from '@/components/ui/Alert'
import { Input } from '@/components/ui/Input'
import { Button } from '@/components/ui/Button'
import { Modal } from '@/components/ui/Modal'
import { useLang } from '@/lib/useLang'
import { t } from '@/lib/i18n'

/**
 * Security keys and passkeys (issue #197, part 2).
 *
 * A sibling of `TwoFactorCard` rather than a tab inside it, because they are not
 * alternatives the user picks between: either satisfies the requirement, and
 * holding both is the sensible thing — a key for every day, an authenticator app
 * for the day the key is in the other coat.
 *
 * The ceremony itself is the browser's. `startRegistration` opens the platform
 * prompt, and the private key never leaves the authenticator; what comes back is
 * a public key and an attestation for the server to verify.
 */
/** Nothing can change whether this browser supports WebAuthn, so there is nothing to subscribe to. */
const subscribeToNothing = () => () => {}

interface Props {
  /**
   * The keys the SERVER read, or `undefined` when it could not (#466).
   *
   * Same distinction as the sessions card: `[]` means this account has no
   * security keys, `undefined` means the endpoint did not answer. Showing the
   * first for the second tells someone their account has no second factor
   * registered at the moment they came here to check.
   */
  initialCredentials?: WebauthnCredential[] | null
}

export function SecurityKeysCard({ initialCredentials }: Props) {
  const { data: session, update: updateSession } = useSession()
  // The token's copy of the gate, which is what the middleware reads.
  const mustEnroll = session?.mustEnrollSecondFactor === true
  const lang = useLang()
  const [credentials, setCredentials] = useState<WebauthnCredential[] | null>(initialCredentials ?? null)
  const [label, setLabel] = useState('')
  const [busy, setBusy] = useState(false)
  /** The key the confirmation modal is about, or null while it is closed. */
  const [removing, setRemoving] = useState<{ id: number; label: string } | null>(null)
  const [password, setPassword] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [recoveryCodes, setRecoveryCodes] = useState<string[]>([])

  /*
   * Fetches and returns; it does not set state — the shape the sessions card
   * uses, and for its reason: every caller decides whether the component is
   * still mounted before it writes.
   *
   * A list that cannot be read is not worth an error banner over the whole
   * settings page, so it resolves to `null` and the card shows nothing until it
   * can.
   */
  const fetchCredentials = useCallback(
    () => get<WebauthnCredentialsResponse>('/api/users/me/webauthn')
      .then((data) => data.credentials)
      .catch(() => null),
    [],
  )

  /** Re-read after registering or removing a key. */
  const load = useCallback(async () => setCredentials(await fetchCredentials()), [fetchCredentials])

  /*
   * Only when the server could not read them (#466) — the page fetches this now,
   * like the sessions card beside it. `undefined` means that read failed, and
   * then this retries and reports its own outcome.
   */
  useEffect(() => {
    if (initialCredentials !== undefined) return
    let live = true
    void fetchCredentials().then((next) => { if (live) setCredentials(next) })
    return () => { live = false }
    // `initialCredentials` is a mount-time decision, not something to react to.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fetchCredentials])

  /*
   * Whether this browser can do WebAuthn at all — an old one simply cannot.
   *
   * A property of the environment, not of this component, and unreadable during
   * the server render: `useSyncExternalStore` takes a server snapshot and a
   * client one, which is exactly the shape of the question (#466). As state set
   * by an effect it started optimistic, so a browser without WebAuthn was
   * briefly offered a form it cannot use.
   */
  const supported = useSyncExternalStore(
    subscribeToNothing,
    () => Boolean(window.PublicKeyCredential),
    () => true,
  )

  async function handleRegister(e: React.FormEvent) {
    e.preventDefault()
    setError(null)
    setBusy(true)
    try {
      const options = await post<Parameters<typeof startRegistration>[0]['optionsJSON']>(
        '/api/users/me/webauthn/register/options',
        {},
      )
      // Opens the platform prompt. Everything the user does — touching the key,
      // Touch ID, a PIN — happens inside here, and the private half of the
      // credential never leaves the authenticator.
      const response = await startRegistration({ optionsJSON: options })
      const result = await post<WebauthnRegistrationResult>(
        '/api/users/me/webauthn/register/verify',
        { label: label.trim(), response },
      )
      setLabel('')
      // Present only when this was the first factor on the account, and this is
      // the only copy that will ever exist.
      if (result.recoveryCodes?.length) setRecoveryCodes(result.recoveryCodes)
      await load()

      // Lift the enrolment gate, exactly as `TwoFactorCard` does after a
      // confirmed TOTP secret (#197).
      //
      // `secondFactorOutstanding` already stopped counting this account the
      // moment the credential was stored — it re-reads both factors per request,
      // and a key discharges the requirement as much as an app does. But the
      // MIDDLEWARE reads `mustEnrollSecondFactor` off the token minted at
      // sign-in, and nothing here was rewriting it. So an administrator who
      // registered a key was still redirected to /settings?enroll2fa=1 from
      // every page, and still shown "two-factor authentication is required" —
      // having done exactly what was asked of them, with the only way out being
      // to sign out and back in.
      //
      // After the recovery codes are on screen, not before: lifting the gate
      // must not race the user reading the only copy of them.
      if (mustEnroll) {
        const { getSession } = await import('next-auth/react')
        await updateSession({ mustEnrollSecondFactor: false })
        await getSession()
      }
    } catch (err) {
      // A user who closes the prompt lands here too, and telling them their key
      // failed would be wrong — so the browser's own abort is not an error.
      if (err instanceof Error && (err.name === 'NotAllowedError' || err.name === 'AbortError')) {
        return
      }
      setError(err instanceof Error ? err.message : t('unexpectedError', lang))
    } finally {
      setBusy(false)
    }
  }

  /*
   * Removal asks for the account password (#231).
   *
   * Registering a key can argue that touching the hardware is the proof.
   * Removing one cannot, and a stolen session could otherwise strip the spare
   * key out of the recommended primary-plus-backup setup, one at a time, with
   * the owner finding out only when they reached for it.
   *
   * A POST rather than the DELETE this replaces: the browser reaches the API
   * through `/api/proxy`, which drops the body of a DELETE, so the password
   * would arrive as undefined and every removal would fail.
   */
  async function handleRemove() {
    if (removing === null) return
    setError(null)
    setBusy(true)
    try {
      await post(`/api/users/me/webauthn/${removing.id}/remove`, { password })
      setRemoving(null)
      setPassword('')
      await load()
    } catch (err) {
      // Includes the 403 for a wrong password and the 409 for removing the last
      // factor an account has, whose message says what to do instead.
      setError(err instanceof Error ? err.message : t('unexpectedError', lang))
    } finally {
      setBusy(false)
    }
  }

  return (
    <Card title={t('securityKeys', lang)}>
      <div className="space-y-4">
        {error && <Alert>{error}</Alert>}

        <p className="text-sm text-slate-600">{t('securityKeysIntro', lang)}</p>

        {!supported && <Alert tone="warning">{t('securityKeysUnsupported', lang)}</Alert>}

        {recoveryCodes.length > 0 && (
          <div className="space-y-2">
            <Alert tone="warning">{t('twoFactorRecoveryHint', lang)}</Alert>
            <ul className="grid gap-1 font-mono text-sm sm:grid-cols-2">
              {recoveryCodes.map((c) => (
                <li key={c} className="rounded bg-slate-50 px-3 py-1.5 text-slate-900">
                  {c}
                </li>
              ))}
            </ul>
          </div>
        )}

        {credentials && credentials.length > 0 ? (
          <ul className="divide-y divide-slate-100">
            {credentials.map((c) => (
              <li key={c.id} className="flex flex-wrap items-center justify-between gap-2 py-2">
                <div>
                  <p className="text-sm font-medium text-slate-900">{c.label}</p>
                  <p className="text-xs text-slate-600">
                    {t('added', lang)} {new Date(c.createdAt).toLocaleDateString(lang)}
                    {c.lastUsedAt
                      ? ` · ${t('lastUsed', lang)} ${new Date(c.lastUsedAt).toLocaleDateString(lang)}`
                      : ` · ${t('neverUsed', lang)}`}
                  </p>
                </div>
                <Button
                  variant="danger"
                  disabled={busy}
                  onClick={() => { setError(null); setPassword(''); setRemoving({ id: c.id, label: c.label }) }}
                >
                  {t('remove', lang)}
                </Button>
              </li>
            ))}
          </ul>
        ) : (
          credentials !== null && <p className="text-sm text-slate-600">{t('noSecurityKeys', lang)}</p>
        )}

        <Modal
          open={removing !== null}
          onClose={() => setRemoving(null)}
          title={t('removeSecurityKeyTitle', lang)}
          size="sm"
        >
          {/* Mounted only while the dialog is open. A <dialog> keeps its children
              in the DOM when closed, so an always-rendered password field would
              sit invisibly on the settings page — a second "current password"
              for a password manager to offer to fill, and a second match for
              anything looking the field up by its label. */}
          {removing !== null && (
            <div className="space-y-3">
              <p className="text-sm text-slate-600">
                {t('removeSecurityKeyIntro', lang)} <strong>{removing.label}</strong>
              </p>
              <Input
                label={t('currentPassword', lang)}
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                required
                autoComplete="current-password"
                hint={t('removeSecurityKeyPasswordHint', lang)}
              />
            </div>
          )}
          <div className="flex justify-end gap-2 mt-4">
            <Button variant="secondary" onClick={() => setRemoving(null)}>{t('cancel', lang)}</Button>
            <Button
              variant="danger"
              disabled={busy || password === ''}
              aria-busy={busy}
              onClick={() => void handleRemove()}
            >
              {t('remove', lang)}
            </Button>
          </div>
        </Modal>

        <form onSubmit={handleRegister} className="space-y-4">
          <Input
            label={t('securityKeyName', lang)}
            hint={t('securityKeyNameHint', lang)}
            value={label}
            onChange={(e) => setLabel(e.target.value)}
            maxLength={64}
            required
          />
          <Button type="submit" disabled={busy || !supported}>
            {busy ? t('registering', lang) : t('registerSecurityKey', lang)}
          </Button>
        </form>
      </div>
    </Card>
  )
}
