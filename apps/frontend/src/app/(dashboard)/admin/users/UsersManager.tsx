'use client'

import { useState, useEffect, useCallback } from 'react'
import type { User, Role, CreateUserRequest, UpdateUserRequest } from '@open-hybrid-cloud/types'
import { get, post, put, del } from '@/lib/api'
import { Card } from '@/components/ui/Card'
import { Alert } from '@/components/ui/Alert'
import { Input } from '@/components/ui/Input'
import { Select } from '@/components/ui/Select'
import { Button } from '@/components/ui/Button'
import { Modal } from '@/components/ui/Modal'
import { useToast } from '@/components/ui/Toast'
import { SkeletonListItem } from '@/components/ui/Skeleton'
import { useLang } from '@/lib/useLang'
import { t } from '@/lib/i18n'
import { ActiveSessions } from '@/components/forms/ActiveSessions'

interface Props { token: string }

const ROLE_KEYS: Record<Role, 'roleProjectManager' | 'roleAdmin' | 'roleRoot'> = {
  project_manager: 'roleProjectManager',
  admin: 'roleAdmin',
  root: 'roleRoot',
}

const roleBadge: Record<Role, string> = {
  project_manager: 'bg-slate-100 text-slate-600',
  admin: 'bg-blue-100 text-blue-700',
  root: 'bg-purple-100 text-purple-700',
}

export function UsersManager({ token }: Props) {
  const lang = useLang()
  const ROLES: { value: Role; label: string }[] = (Object.keys(ROLE_KEYS) as Role[]).map((value) => ({
    value, label: t(ROLE_KEYS[value], lang),
  }))
  const { toast } = useToast()
  const [users, setUsers] = useState<User[]>([])
  const [loading, setLoading] = useState(true)
  const [addOpen, setAddOpen] = useState(false)
  const [editTarget, setEditTarget] = useState<User | null>(null)
  const [deleteTarget, setDeleteTarget] = useState<User | null>(null)
  // Root looking at somebody else's sessions (issue #37). The API is the same
  // one the user's own settings page calls, scoped with ?userId= and refused for
  // anyone who is not root — so there is no second authorisation path here that
  // could drift from the first.
  const [sessionsTarget, setSessionsTarget] = useState<User | null>(null)
  const [formEmail, setFormEmail] = useState('')
  const [formName, setFormName] = useState('')
  const [formRole, setFormRole] = useState<Role>('project_manager')
  const [formPassword, setFormPassword] = useState('')
  const [saving, setSaving] = useState(false)
  const [formError, setFormError] = useState<string | null>(null)
  const [deleteError, setDeleteError] = useState<string | null>(null)
  const [flashId, setFlashId] = useState<number | null>(null)

  const load = useCallback(async () => {
    setLoading(true)
    try {
      setUsers((await get<User[]>('/api/admin/users', token)) ?? [])
      setDeleteError(null)
    } catch (e) {
      setDeleteError(e instanceof Error ? e.message : t('failedToLoadUsers', lang))
    } finally {
      setLoading(false)
    }
  }, [token, lang])

  useEffect(() => { void load() }, [load])

  function openAdd() {
    setFormEmail(''); setFormName(''); setFormRole('project_manager'); setFormPassword(''); setFormError(null); setAddOpen(true)
  }

  function openEdit(user: User) {
    setFormName(user.name); setFormRole(user.role); setFormPassword(''); setFormError(null); setEditTarget(user)
  }

  async function handleAdd(e: React.FormEvent) {
    e.preventDefault()
    setSaving(true); setFormError(null)
    try {
      const body: CreateUserRequest = {
        email: formEmail.trim(),
        name: formName.trim(),
        role: formRole,
        password: formPassword,
      }
      await post('/api/admin/users', body, token)
      setAddOpen(false)
      toast(t('userCreatedToast', lang))
      void load()
    } catch (err) {
      setFormError(err instanceof Error ? err.message : t('genericFailed', lang))
    } finally {
      setSaving(false)
    }
  }

  async function handleEdit(e: React.FormEvent) {
    e.preventDefault()
    if (!editTarget) return
    const id = editTarget.id
    setSaving(true); setFormError(null)
    try {
      const body: UpdateUserRequest = { name: formName.trim(), role: formRole }
      await put(`/api/admin/users/${id}`, body, token)
      setEditTarget(null)
      setFlashId(id)
      toast(t('userUpdatedToast', lang))
      void load()
    } catch (err) {
      setFormError(err instanceof Error ? err.message : t('genericFailed', lang))
    } finally {
      setSaving(false)
    }
  }

  async function handleDelete() {
    if (!deleteTarget) return
    setSaving(true); setDeleteError(null)
    try {
      await del(`/api/admin/users/${deleteTarget.id}`, token)
      setDeleteTarget(null)
      toast(t('userDeletedToast', lang), 'info')
      void load()
    } catch (e) {
      setDeleteError(e instanceof Error ? e.message : t('failedToDeleteGeneric', lang))
    } finally {
      setSaving(false)
    }
  }

  async function toggleActive(user: User) {
    try {
      await put(`/api/admin/users/${user.id}`, { active: !user.active } satisfies UpdateUserRequest, token)
      void load()
    } catch (e) {
      setDeleteError(e instanceof Error ? e.message : t('failedToUpdateGeneric', lang))
    }
  }

  return (
    <>
      <Card title={t('users', lang)} action={<Button size="sm" onClick={openAdd}>{t('addUser', lang)}</Button>}>
        {deleteError && !deleteTarget && (
          <Alert className="mb-3">{deleteError}</Alert>
        )}
        {loading ? (
          <div className="space-y-2">
            {Array.from({ length: 4 }).map((_, i) => <SkeletonListItem key={i} />)}
          </div>
        ) : users.length === 0 ? (
          <p className="text-center py-6 text-slate-600">{t('noUsersYet', lang)}</p>
        ) : (
          <div className="space-y-2">
            {users.map((user) => (
              <div key={user.id} className={`flex items-center justify-between rounded-lg border border-slate-100 px-4 py-3 ${user.id === flashId ? 'animate-flash-row' : ''}`}>
                <div className="flex items-center gap-3">
                  <span className={`inline-block h-2 w-2 rounded-full ${user.active ? 'bg-green-500' : 'bg-slate-300'}`} />
                  <div>
                    <div className="flex items-center gap-2">
                      <p className="font-medium text-slate-900">{user.name}</p>
                      <span className={`rounded-full px-2 py-0.5 text-xs font-medium ${roleBadge[user.role]}`}>
                        {t(ROLE_KEYS[user.role], lang)}
                      </span>
                    </div>
                    <p className="text-xs text-slate-500">{user.email}</p>
                  </div>
                </div>
                <div className="flex gap-2">
                  <Button size="sm" variant="ghost" onClick={() => toggleActive(user)}>
                    {user.active ? t('deactivate', lang) : t('activate', lang)}
                  </Button>
                  <Button
                    size="sm"
                    variant="ghost"
                    // One word on every row, so the accessible name has to name the
                    // row — five identical "Sessions" buttons tell a screen-reader
                    // user nothing.
                    aria-label={`${t('activeSessions', lang)}: ${user.name} (${user.email})`}
                    onClick={() => setSessionsTarget(user)}
                  >
                    {t('activeSessions', lang)}
                  </Button>
                  <Button size="sm" variant="secondary" onClick={() => openEdit(user)}>{t('edit', lang)}</Button>
                  <Button size="sm" variant="danger" onClick={() => { setDeleteError(null); setDeleteTarget(user) }}>{t('delete', lang)}</Button>
                </div>
              </div>
            ))}
          </div>
        )}
      </Card>

      <Modal open={addOpen} onClose={() => setAddOpen(false)} title={t('addUser', lang)} size="md">
        <form onSubmit={handleAdd} className="space-y-4">
          {formError && <Alert>{formError}</Alert>}
          <Input label={t('email', lang)} type="email" value={formEmail} onChange={(e) => setFormEmail(e.target.value)} required />
          <Input label={t('name', lang)} value={formName} onChange={(e) => setFormName(e.target.value)} required />
          <Select label={t('role', lang)} value={formRole} onChange={(e) => setFormRole(e.target.value as Role)} options={ROLES} />
          <Input label={t('password', lang)} type="password" value={formPassword} onChange={(e) => setFormPassword(e.target.value)} required />
          <div className="flex justify-end gap-3 pt-2">
            <Button type="button" variant="secondary" onClick={() => setAddOpen(false)}>{t('cancel', lang)}</Button>
            <Button type="submit" disabled={saving}>{saving ? t('creating', lang) : t('createButton', lang)}</Button>
          </div>
        </form>
      </Modal>

      <Modal open={!!editTarget} onClose={() => setEditTarget(null)} title={t('editUser', lang)} size="md">
        <form onSubmit={handleEdit} className="space-y-4">
          {formError && <Alert>{formError}</Alert>}
          <Input label={t('name', lang)} value={formName} onChange={(e) => setFormName(e.target.value)} required />
          <Select label={t('role', lang)} value={formRole} onChange={(e) => setFormRole(e.target.value as Role)} options={ROLES} />
          <div className="flex justify-end gap-3 pt-2">
            <Button type="button" variant="secondary" onClick={() => setEditTarget(null)}>{t('cancel', lang)}</Button>
            <Button type="submit" disabled={saving}>{saving ? t('saving', lang) : t('save', lang)}</Button>
          </div>
        </form>
      </Modal>

      <Modal
        open={!!sessionsTarget}
        onClose={() => setSessionsTarget(null)}
        title={sessionsTarget ? `${t('activeSessions', lang)} — ${sessionsTarget.name}` : t('activeSessions', lang)}
        size="xl"
      >
        {/* Keyed on the user so switching rows remounts it rather than showing the
            previous user's list while the new one loads. No initialSessions: the
            dialog was not open when the page rendered, so there is nothing to have
            fetched ahead of time. */}
        {sessionsTarget && (
          <ActiveSessions key={sessionsTarget.id} token={token} userId={sessionsTarget.id} />
        )}
      </Modal>

      <Modal open={!!deleteTarget} onClose={() => setDeleteTarget(null)} title={t('deleteUserTitle', lang)} size="sm">
        {deleteError && <Alert className="mb-4">{deleteError}</Alert>}
        <p className="text-sm text-slate-600 mb-6">{t('deleteUserPrompt', lang)} <strong>{deleteTarget?.name}</strong> ({deleteTarget?.email})?</p>
        <div className="flex justify-end gap-3">
          <Button variant="secondary" onClick={() => setDeleteTarget(null)}>{t('cancel', lang)}</Button>
          <Button variant="danger" onClick={handleDelete} disabled={saving}>{saving ? t('deleting', lang) : t('delete', lang)}</Button>
        </div>
      </Modal>
    </>
  )
}
