'use client'

import { useState } from 'react'
import type { UpdateProfileRequest, ChangePasswordRequest, Role, TwoFactorStatusResponse, WebauthnCredential } from '@infrashelf/types'
import { put } from '@/lib/api'
import { Card } from '@/components/ui/Card'
import { Alert } from '@/components/ui/Alert'
import { Input } from '@/components/ui/Input'
import { Button } from '@/components/ui/Button'
import { useLang } from '@/lib/useLang'
import { t } from '@/lib/i18n'
import { TwoFactorCard } from './TwoFactorCard'
import { SecurityKeysCard } from './SecurityKeysCard'

interface Props {
  initialName: string
  email: string
  role: Role | undefined
  /*
   * Threaded straight through to the two security cards (#466).
   *
   * They used to fetch their own state on mount, so a settings page arrived
   * saying "two-factor is off" and "no security keys" — the two most reassuring
   * things either card can say — and corrected itself afterwards. `undefined`
   * means the server's read failed and the card should retry; it is not the same
   * as `null` or `[]`, which are real answers.
   */
  initialTwoFactor?: TwoFactorStatusResponse | null
  initialCredentials?: WebauthnCredential[] | null
}

export function SettingsForms({ initialName, email, role, initialTwoFactor, initialCredentials }: Props) {
  const lang = useLang()
  const [name, setName] = useState(initialName)
  const [profileSaving, setProfileSaving] = useState(false)
  const [profileError, setProfileError] = useState<string | null>(null)
  const [profileSuccess, setProfileSuccess] = useState(false)

  const [currentPassword, setCurrentPassword] = useState('')
  const [newPassword, setNewPassword] = useState('')
  const [confirmPassword, setConfirmPassword] = useState('')
  const [pwSaving, setPwSaving] = useState(false)
  const [pwError, setPwError] = useState<string | null>(null)
  const [pwSuccess, setPwSuccess] = useState(false)

  async function handleProfileSave(e: React.FormEvent) {
    e.preventDefault()
    setProfileSaving(true)
    setProfileError(null)
    setProfileSuccess(false)
    try {
      const body: UpdateProfileRequest = { name: name.trim() }
      await put('/api/users/me', body)
      setProfileSuccess(true)
    } catch (err) {
      setProfileError(err instanceof Error ? err.message : t('failedToUpdateProfile', lang))
    } finally {
      setProfileSaving(false)
    }
  }

  async function handlePasswordChange(e: React.FormEvent) {
    e.preventDefault()
    if (newPassword !== confirmPassword) {
      setPwError(t('passwordsDoNotMatch', lang))
      return
    }
    setPwSaving(true)
    setPwError(null)
    setPwSuccess(false)
    try {
      const body: ChangePasswordRequest = { currentPassword, newPassword }
      await put('/api/users/me/password', body)
      setPwSuccess(true)
      setCurrentPassword('')
      setNewPassword('')
      setConfirmPassword('')
    } catch (err) {
      setPwError(err instanceof Error ? err.message : t('failedToChangePassword', lang))
    } finally {
      setPwSaving(false)
    }
  }

  return (
    <div className="space-y-6">
      <Card title={t('profileTitle', lang)}>
        <form onSubmit={handleProfileSave} className="space-y-4">
          {profileError && (
            <Alert>{profileError}</Alert>
          )}
          {profileSuccess && (
            <Alert tone="success">{t('profileUpdated', lang)}</Alert>
          )}
          <Input label={t('email', lang)} type="email" value={email} disabled />
          <Input label={t('name', lang)} value={name} onChange={(e) => setName(e.target.value)} required />
          <div className="flex justify-end">
            <Button type="submit" disabled={profileSaving}>
              {profileSaving ? t('saving', lang) : t('saveProfile', lang)}
            </Button>
          </div>
        </form>
      </Card>

      <Card title={t('changePassword', lang)}>
        <form onSubmit={handlePasswordChange} className="space-y-4">
          {pwError && (
            <Alert>{pwError}</Alert>
          )}
          {pwSuccess && (
            <Alert tone="success">{t('passwordChanged', lang)}</Alert>
          )}
          <Input
            label={t('currentPassword', lang)}
            type="password"
            value={currentPassword}
            onChange={(e) => setCurrentPassword(e.target.value)}
            required
          />
          <Input
            label={t('newPassword', lang)}
            type="password"
            value={newPassword}
            onChange={(e) => setNewPassword(e.target.value)}
            required
          />
          <Input
            label={t('confirmNewPassword', lang)}
            type="password"
            value={confirmPassword}
            onChange={(e) => setConfirmPassword(e.target.value)}
            required
          />
          <div className="flex justify-end">
            <Button type="submit" disabled={pwSaving}>
              {pwSaving ? t('changing', lang) : t('changePassword', lang)}
            </Button>
          </div>
        </form>
      </Card>

      {/* Cosmetic only. The gate is `loadTwoFactorAccount` on the server, which
          answers 403 to every 2FA endpoint for any other role; this just keeps a
          card nobody can use off the page. An SSO administrator sees it and is
          told by the backend that their MFA belongs to the identity provider
          (issue #36).

          Both administrative roles, since #197: `admin` must hold a factor too,
          and a card that stayed root-only would have left them required to enroll
          with nowhere to do it. */}
      {(role === 'root' || role === 'admin') && (
        <>
          <TwoFactorCard initialStatus={initialTwoFactor} />
          {/* A sibling, not a tab inside it: the two are not alternatives to pick
              between. Either satisfies the requirement, and holding both is the
              sensible thing — a key for every day, an app for the day the key is
              in the other coat (#197 part 2). */}
          <SecurityKeysCard initialCredentials={initialCredentials} />
        </>
      )}
    </div>
  )
}
