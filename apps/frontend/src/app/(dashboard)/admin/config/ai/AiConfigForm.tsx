'use client'

import { useState } from 'react'
import type { AiConfig, UpdateAiConfigRequest, AiProviderType } from '@open-hybrid-cloud/types'
import { put } from '@/lib/api'
import { Card } from '@/components/ui/Card'
import { Alert } from '@/components/ui/Alert'
import { Input } from '@/components/ui/Input'
import { Select } from '@/components/ui/Select'
import { Button } from '@/components/ui/Button'
import { useToast } from '@/components/ui/Toast'
import { useLang } from '@/lib/useLang'
import { t } from '@/lib/i18n'

// Provider names are proper nouns — not translated, same as "SMTP" and "Branding".
const PROVIDERS: { value: AiProviderType; label: string }[] = [
  { value: 'claude', label: 'Anthropic Claude' },
  { value: 'openai', label: 'OpenAI' },
  { value: 'azure_openai', label: 'Azure OpenAI' },
  { value: 'ollama', label: 'Ollama (Local)' },
  { value: 'localai', label: 'LocalAI' },
]

interface Props {
  initial: AiConfig | null
  token: string
}

export function AiConfigForm({ initial, token }: Props) {
  const lang = useLang()
  const { toast } = useToast()
  const [provider, setProvider] = useState<AiProviderType>(initial?.provider ?? 'claude')
  const [endpoint, setEndpoint] = useState(initial?.endpoint ?? '')
  const [apiKey, setApiKey] = useState('')
  const [model, setModel] = useState(initial?.model ?? '')
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    setSaving(true); setError(null)
    try {
      const body: UpdateAiConfigRequest = {
        provider, endpoint: endpoint.trim(), model: model.trim(),
        ...(apiKey ? { apiKey } : {}),
      }
      await put('/api/admin/config/ai', body, token)
      toast(t('aiConfigSavedToast', lang))
    } catch (err) {
      setError(err instanceof Error ? err.message : t('failedToSaveAi', lang))
    } finally {
      setSaving(false)
    }
  }

  const modelPlaceholder: Record<AiProviderType, string> = {
    claude: 'claude-opus-4-5',
    openai: 'gpt-4o',
    azure_openai: 'gpt-4o',
    ollama: 'llama3',
    localai: 'gpt-4',
  }

  return (
    <Card title={t('aiProviderSettingsTitle', lang)}>
      <form onSubmit={handleSubmit} className="space-y-4">
        {error && <Alert>{error}</Alert>}

        <Select label={t('provider', lang)} value={provider} onChange={(e) => setProvider(e.target.value as AiProviderType)} options={PROVIDERS} />

        <Input label={t('apiEndpoint', lang)} type="url" value={endpoint} onChange={(e) => setEndpoint(e.target.value)}
          placeholder="https://api.anthropic.com"
          hint={t('apiEndpointHint', lang)} />

        <Input label={t('apiKey', lang)} type="password" value={apiKey} onChange={(e) => setApiKey(e.target.value)}
          hint={initial ? t('apiKeyKeepHint', lang) : undefined} />

        <Input label={t('model', lang)} value={model} onChange={(e) => setModel(e.target.value)} required
          placeholder={modelPlaceholder[provider]} />

        <div className="flex justify-end">
          <Button type="submit" disabled={saving}>{saving ? t('saving', lang) : t('saveConfiguration', lang)}</Button>
        </div>
      </form>
    </Card>
  )
}
