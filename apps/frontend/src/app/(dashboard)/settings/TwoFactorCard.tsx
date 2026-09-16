'use client'

import { useEffect, useState, useCallback } from 'react'
import { useSession } from 'next-auth/react'
import type {
  ConfirmTotpEnrollmentRequest,
  ConfirmTotpEnrollmentResponse,
  StartTotpEnrollmentRequest,
  StartTotpEnrollmentResponse,
  TwoFactorStatusResponse,
} from '@infrashelf/types'
import { get, post } from '@/lib/api'
import { Card } from '@/components/ui/Card'
import { Alert } from '@/components/ui/Alert'
import { Input } from '@/components/ui/Input'
import { Button } from '@/components/ui/Button'
import { useLang } from '@/lib/useLang'
import { t } from '@/lib/i18n'

/**
 * Enrollment is a three-screen wizard, and the order is load-bearing.
 *
 *   'idle'     → what the account currently has.
 *   'scanning' → the QR code and the setup key. This is the ONLY time the secret
 *                is readable; the backend stores it encrypted and never sends it
 *                again.
 *   'codes'    → the recovery codes, which are the only copy in existence: they
 *                are stored hashed, so nothing can print them a second time.
 *
 * There is no "disable" screen, because there is no such endpoint (issue #36).
 */
type Step = 'idle' | 'scanning' | 'codes'

interface Props {
  /**
   * The status the SERVER read, or `undefined` when it could not (#466).
   *
   * `undefined` and `null` are different answers and both are load-bearing:
   * `null` means no second factor is enrolled, `undefined` means nobody knows.
   * Rendering the first for the second is what this prop exists to stop — "two
   * factor is off" is the most reassuring thing this card can say.
   */
  initialStatus?: TwoFactorStatusResponse | null
}

export function TwoFactorCard({ initialStatus }: Props) {
  const lang = useLang()
  // Read from the session rather than passed in: the same flag the middleware
  // redirected on, so the card cannot disagree with the thing that sent the user
  // here (issue #197).
  const { data: session, update: updateSession } = useSession()
  const mustEnroll = session?.mustEnrollSecondFactor === true
  const [status, setStatus] = useState<TwoFactorStatusResponse | null>(initialStatus ?? null)
  const [step, setStep] = useState<Step>('idle')
  const [password, setPassword] = useState('')
  const [currentCode, setCurrentCode] = useState('')
  const [offer, setOffer] = useState<StartTotpEnrollmentResponse | null>(null)
  const [recoveryCodes, setRecoveryCodes] = useState<string[]>([])
  const [confirmCode, setConfirmCode] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  /*
   * Fetches and returns; it does not set state — the shape the sessions card
   * beside this one uses, and for its reason: every caller decides whether the
   * component is still mounted before it writes.
   *
   * A status that cannot be read is not worth an error banner over the whole
   * settings page, so it resolves to `null` and the card shows nothing until it
   * can.
   */
  const fetchStatus = useCallback(
    () => get<TwoFactorStatusResponse>('/api/users/me/2fa').catch(() => null),
    [],
  )

  /** Re-read after enrolling or removing, where the card IS the thing that changed. */
  const loadStatus = async () => setStatus(await fetchStatus())

  /*
   * Only when the server could not read it (#466).
   *
   * The page fetches this now, like the sessions card beside it, so the first
   * paint shows the real answer instead of "two-factor is off" — which is the
   * most reassuring thing this card can say and the worst one to say wrongly.
   *
   * `undefined` means the server's own read failed, and then this retries and
   * surfaces its own outcome. `null` is a real answer: no second factor
   * enrolled.
   */
  useEffect(() => {
    if (initialStatus !== undefined) return
    let live = true
    void fetchStatus().then((next) => { if (live) setStatus(next) })
    return () => { live = false }
    // `initialStatus` is a mount-time decision, not something to react to.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fetchStatus])

  async function handleStart(e: React.FormEvent) {
    e.preventDefault()
    setBusy(true)
    setError(null)
    try {
      const body: StartTotpEnrollmentRequest = {
        password,
        ...(status?.enabled ? { code: currentCode } : {}),
      }
      setOffer(await post<StartTotpEnrollmentResponse>('/api/users/me/2fa/enroll', body))
      setStep('scanning')
      // The password and the current code have done their job; holding them in
      // state for the rest of the wizard serves no purpose.
      setPassword('')
      setCurrentCode('')
    } catch (err) {
      setError(err instanceof Error ? err.message : t('unexpectedError', lang))
    } finally {
      setBusy(false)
    }
  }

  async function handleConfirm(e: React.FormEvent) {
    e.preventDefault()
    setBusy(true)
    setError(null)
    try {
      const body: ConfirmTotpEnrollmentRequest = { code: confirmCode }
      const result = await post<ConfirmTotpEnrollmentResponse>(
        '/api/users/me/2fa/confirm',
        body,
      )
      setRecoveryCodes(result.recoveryCodes)
      // Drop the secret from memory the moment it is no longer needed on screen.
      setOffer(null)
      setConfirmCode('')
      setStep('codes')
      await loadStatus()
      // Clear the "must enroll" flag on the session token (issue #197). The
      // backend already stopped refusing this account the moment `confirm`
      // returned — it re-reads the factor per request — but the token minted at
      // sign-in still says otherwise, and the middleware reads the token. Without
      // this the user is bounced back here from wherever they navigate next,
      // having done exactly what was asked of them.
      //
      // Deliberately after the recovery codes are on screen and not before: the
      // gate lifting must not race the user reading the only copy of them.
      if (mustEnroll) {
        const { getSession } = await import('next-auth/react')
        await updateSession({ mustEnrollSecondFactor: false })
        await getSession()
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : t('unexpectedError', lang))
    } finally {
      setBusy(false)
    }
  }

  return (
    <Card title={t('twoFactorAuth', lang)}>
      <div className="space-y-4">
        {error && <Alert>{error}</Alert>}

        {/* Why the user is on this page at all (issue #197). Without it, being
            bounced here from wherever they were going reads as a bug. Shown until
            the factor is confirmed, not until they start — an abandoned
            enrollment leaves the requirement exactly where it was. */}
        {mustEnroll && !status?.enabled && (
          <Alert tone="warning">{t('twoFactorRequiredPrompt', lang)}</Alert>
        )}

        {step === 'idle' && (
          <>
            <p className="text-sm text-slate-600">{t('twoFactorIntro', lang)}</p>
            <dl className="flex flex-wrap gap-x-8 gap-y-2 text-sm">
              <div>
                <dt className="text-slate-600">{t('status', lang)}</dt>
                <dd className="font-medium text-slate-900">
                  {/* A dash while the status is UNKNOWN, not "off" (#466).
                      `null` here means nobody has been able to read it — the
                      server's attempt failed and this card's retry has not
                      answered yet, or failed too. "Two-factor is off" is the most
                      reassuring thing this card can say and the worst to say
                      without knowing, so it says nothing, which is what the
                      card's own contract promises: it "shows nothing until it
                      can". The keys card beside it has always done this — its
                      "no security keys" line is gated on `credentials !== null`
                      for the same reason. */}
                  {status === null ? '—' : status.enabled ? t('twoFactorOn', lang) : t('twoFactorOff', lang)}
                </dd>
              </div>
              {status?.enabled && (
                <div>
                  <dt className="text-slate-600">{t('twoFactorRecoveryLeft', lang)}</dt>
                  <dd className="font-medium text-slate-900">{status.recoveryCodesRemaining}</dd>
                </div>
              )}
            </dl>

            {/* Out of recovery codes and no authenticator means the only way back
                in is an operator with database access, so say so before it
                happens rather than after.

                Its own string, not `twoFactorRecoveryHint`: that one reads "save
                these now — they will not be shown again", which is the right
                thing to say on the screen that HAS just printed them, and
                nonsense here, where the count is zero and there is nothing on
                screen to save. */}
            {status?.enabled && status.recoveryCodesRemaining === 0 && (
              <Alert tone="warning">{t('twoFactorRecoveryExhausted', lang)}</Alert>
            )}

            <form onSubmit={handleStart} className="space-y-4">
              <Input
                label={t('twoFactorCurrentPassword', lang)}
                type="password"
                autoComplete="current-password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                required
              />
              {/* Replacing a live authenticator costs a current code — otherwise a
                  stolen session plus a phished password could swap the factor out
                  and lock the real owner out of their own account. */}
              {status?.enabled && (
                <Input
                  label={t('twoFactorCodeLabel', lang)}
                  hint={t('twoFactorCodeHint', lang)}
                  autoComplete="one-time-code"
                  value={currentCode}
                  onChange={(e) => setCurrentCode(e.target.value)}
                  required
                />
              )}
              <div className="flex justify-end">
                <Button type="submit" disabled={busy}>
                  {status?.enabled ? t('twoFactorReplace', lang) : t('twoFactorSetUp', lang)}
                </Button>
              </div>
            </form>
          </>
        )}

        {step === 'scanning' && offer && (
          <>
            <p className="text-sm text-slate-600">{t('twoFactorScanHint', lang)}</p>
            <div className="flex flex-col items-start gap-4 sm:flex-row sm:items-center">
              {/* The backend renders the QR as a self-contained SVG, so there is
                  no image request, no external service and no dependency. */}
              <div
                className="w-40 shrink-0 rounded-md border border-slate-200 bg-white p-2"
                role="img"
                aria-label={t('twoFactorAuth', lang)}
                dangerouslySetInnerHTML={{ __html: offer.qrSvg }}
              />
              <div className="min-w-0">
                <div className="text-sm text-slate-600">{t('twoFactorSetupKey', lang)}</div>
                <code className="mt-1 block break-all font-mono text-sm text-slate-900">
                  {offer.secretFormatted}
                </code>
              </div>
            </div>

            <form onSubmit={handleConfirm} className="space-y-4">
              <Input
                label={t('twoFactorCodeLabel', lang)}
                hint={t('twoFactorCodeHint', lang)}
                autoComplete="one-time-code"
                value={confirmCode}
                onChange={(e) => setConfirmCode(e.target.value)}
                required
              />
              <div className="flex justify-end gap-2">
                <Button
                  type="button"
                  variant="secondary"
                  onClick={() => {
                    setOffer(null)
                    setConfirmCode('')
                    setStep('idle')
                    setError(null)
                  }}
                >
                  {t('cancel', lang)}
                </Button>
                <Button type="submit" disabled={busy}>
                  {busy ? t('twoFactorVerifying', lang) : t('twoFactorActivate', lang)}
                </Button>
              </div>
            </form>
          </>
        )}

        {step === 'codes' && (
          <>
            <Alert tone="success">{t('twoFactorOn', lang)}</Alert>
            <h3 className="text-sm font-semibold text-slate-900">
              {t('twoFactorRecoveryCodes', lang)}
            </h3>
            <Alert tone="warning">{t('twoFactorRecoveryHint', lang)}</Alert>
            <ul className="grid grid-cols-1 gap-1 font-mono text-sm text-slate-900 sm:grid-cols-2">
              {recoveryCodes.map((code) => (
                <li key={code} className="rounded bg-slate-50 px-2 py-1">
                  {code}
                </li>
              ))}
            </ul>
            <div className="flex justify-end">
              <Button
                type="button"
                onClick={() => {
                  setRecoveryCodes([])
                  setStep('idle')
                }}
              >
                {t('confirm', lang)}
              </Button>
            </div>
          </>
        )}
      </div>
    </Card>
  )
}
