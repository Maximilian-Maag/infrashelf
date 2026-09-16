import { auth } from '@/lib/auth'
import { redirect, unstable_rethrow } from 'next/navigation'
import type { SessionInfo, TwoFactorStatusResponse, WebauthnCredentialsResponse, WebauthnCredential } from '@infrashelf/types'
import { PageHeader } from '@/components/layout/PageHeader'
import { SettingsForms } from './SettingsForms'
import { ActiveSessions } from '@/components/forms/ActiveSessions'
import { get } from '@/lib/serverApi'
import { t } from '@/lib/i18n'
import { getLang } from '@/lib/getLang'

/**
 * Rethrow Next's control flow out of a settled batch (#434, #445).
 *
 * `allSettled` collects a thrown `redirect()` as a rejection like any other, so
 * without this an ended session renders a settings page full of empty security
 * cards instead of the login screen. `section()` does the same thing for the
 * pages that render a reason; this page does not want a reason, it wants the
 * cards to retry.
 */
const unstable_rethrow_settled = (results: PromiseSettledResult<unknown>[]): void => {
  for (const result of results) if (result.status === 'rejected') unstable_rethrow(result.reason)
}

export default async function SettingsPage() {
  const session = await auth()
  if (!session) redirect('/login')

  const userName = session.user?.name ?? ''
  const userEmail = session.user?.email ?? ''

  const lang = await getLang()

  // Fetched here rather than in the client component so the first paint shows the
  // real list. Non-fatal on purpose: this page is also where you change your
  // password, and an outage on the session endpoint must not take that away. The
  // one 401 case that matters — the session ending mid-render — is already handled
  // upstream by the middleware and the dashboard layout (#103).
  // undefined, not [], when the fetch fails. An empty array is indistinguishable
  // from "you have no other sessions", which for a security card is the worst
  // possible lie: it says the account is quiet while the endpoint is down, and
  // it also stops the client component from retrying. Leaving it undefined makes
  // ActiveSessions fetch on mount and surface its own error, while the rest of
  // the settings page still renders.
  /*
   * The three security cards, fetched here rather than each on mount (#466).
   *
   * Same arrangement for all of them now, and the same reason: `undefined` means
   * the server's read failed, so the card retries and surfaces its own error,
   * while `null` and `[]` are real answers — no second factor, no keys, no other
   * sessions. Rendering a real answer for a failed read is what this avoids, and
   * on a security page those are the three most reassuring things to say wrongly.
   *
   * `allSettled` rather than three `try`/`catch` blocks: one endpoint being down
   * must not cost the other two, and a catch around a `serverApi` call swallows
   * the login redirect it throws for an ended session (#434).
   */
  const [sessionsRes, twoFactorRes, credentialsRes] = await Promise.allSettled([
    get<SessionInfo[]>('/api/sessions'),
    get<TwoFactorStatusResponse>('/api/users/me/2fa'),
    get<WebauthnCredentialsResponse>('/api/users/me/webauthn'),
  ])
  unstable_rethrow_settled([sessionsRes, twoFactorRes, credentialsRes])

  const sessions = sessionsRes.status === 'fulfilled' ? sessionsRes.value : undefined
  const twoFactor = twoFactorRes.status === 'fulfilled' ? twoFactorRes.value : undefined
  const credentials: WebauthnCredential[] | undefined =
    credentialsRes.status === 'fulfilled' ? credentialsRes.value.credentials : undefined

  return (
    <div className="max-w-2xl mx-auto space-y-6">
      <PageHeader title={t('profileSettings', lang)} subtitle={t('profileSettingsSubtitle', lang)} />
      <SettingsForms
        initialName={userName}
        email={userEmail}
        role={session.user?.role}
        initialTwoFactor={twoFactor}
        initialCredentials={credentials}
      />
      <ActiveSessions initialSessions={sessions} />
    </div>
  )
}
