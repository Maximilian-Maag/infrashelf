'use client'

import { useState } from 'react'
import type { SmtpConfig, UpdateSmtpRequest } from '@open-hybrid-cloud/types'
import { put } from '@/lib/api'
import { Card } from '@/components/ui/Card'
import { Alert } from '@/components/ui/Alert'
import { Input } from '@/components/ui/Input'
import { Button } from '@/components/ui/Button'
import { useToast } from '@/components/ui/Toast'
import { useLang } from '@/lib/useLang'
import { t } from '@/lib/i18n'

interface Props {
  initial: SmtpConfig | null
  token: string
}

export function SmtpForm({ initial, token }: Props) {
  const lang = useLang()
  const { toast } = useToast()
  const [host, setHost] = useState(initial?.host ?? '')
  const [port, setPort] = useState(String(initial?.port ?? '587'))
  const [from, setFrom] = useState(initial?.from ?? '')
  const [user, setUser] = useState(initial?.user ?? '')
  const [password, setPassword] = useState('')
  const [tls, setTls] = useState(initial?.tls ?? true)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    setSaving(true); setError(null)
    try {
      const body: UpdateSmtpRequest = {
        host: host.trim(), port: Number(port),
        from: from.trim(), user: user.trim(),
        tls,
        ...(password ? { password } : {}),
      }
      await put('/api/admin/config/smtp', body, token)
      toast(t('smtpConfigSavedToast', lang))
    } catch (err) {
      setError(err instanceof Error ? err.message : t('failedToSaveSmtp', lang))
    } finally {
      setSaving(false)
    }
  }

  return (
    <Card title={t('smtpSettingsTitle', lang)}>
      <form onSubmit={handleSubmit} className="space-y-4">
        {error && <Alert>{error}</Alert>}

        <div className="grid grid-cols-3 gap-4">
          <div className="col-span-2">
            <Input label={t('host', lang)} value={host} onChange={(e) => setHost(e.target.value)} required placeholder="smtp.example.com" />
          </div>
          <Input label={t('port', lang)} type="number" value={port} onChange={(e) => setPort(e.target.value)} required />
        </div>

        <Input label={t('fromAddress', lang)} type="email" value={from} onChange={(e) => setFrom(e.target.value)} required placeholder="noreply@example.com" />
        <Input label={t('username', lang)} value={user} onChange={(e) => setUser(e.target.value)} />
        <Input label={t('password', lang)} type="password" value={password} onChange={(e) => setPassword(e.target.value)}
          hint={initial ? t('passwordKeepHint', lang) : undefined} />

        <div className="flex items-center gap-2">
          <input type="checkbox" id="tls" checked={tls} onChange={(e) => setTls(e.target.checked)}
            className="h-4 w-4 rounded border-slate-300 text-blue-600 focus:ring-blue-500" />
          <label htmlFor="tls" className="text-sm font-medium text-slate-700">{t('useTls', lang)}</label>
        </div>

        <div className="flex justify-end">
          <Button type="submit" disabled={saving}>{saving ? t('saving', lang) : t('saveConfiguration', lang)}</Button>
        </div>
      </form>
    </Card>
  )
}
