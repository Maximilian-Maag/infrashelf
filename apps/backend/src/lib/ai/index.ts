import { db } from '@/lib/db/client'
import { appConfig } from '@/lib/db/schema'
import { eq } from 'drizzle-orm'
import type { AiProviderType } from '@infrashelf/types'
import { readAppSecret } from '@/lib/crypto/appSecrets'

const LANGUAGES = [
  'de', 'en', 'fr', 'it', 'es', 'pt', 'nl', 'pl', 'cs', 'sk', 'sl', 'hr',
  'ro', 'hu', 'bg', 'el', 'fi', 'sv', 'da', 'et', 'lv', 'lt', 'mt', 'ga', 'ru',
]

interface AiConfig {
  provider: AiProviderType
  endpoint: string
  apiKey: string
  model: string
}

// Default API host per provider, used when the admin leaves the endpoint blank.
// azure_openai / ollama / localai have no safe universal default (Azure needs
// the deployment URL; the local providers are host-specific), so they return
// '' and a blank endpoint is rejected before any request is made — never routed
// to OpenAI, which would leak the prompt + API key to the wrong service.
const defaultEndpoint = (provider: AiProviderType): string => {
  switch (provider) {
    case 'claude':
      return 'https://api.anthropic.com'
    case 'openai':
      return 'https://api.openai.com'
    default:
      return ''
  }
}

const loadConfig = async (): Promise<AiConfig> => {
  const rows = await db.select().from(appConfig).where(eq(appConfig.id, 1)).limit(1)
  const cfg = rows[0]

  const provider = (cfg?.aiProvider as AiProviderType) ?? 'openai'
  // The endpoint column is a NOT-NULL default '' string, so `?? default` never
  // fires on a blank value — treat empty/whitespace as "use provider default".
  const configuredEndpoint = cfg?.aiEndpoint?.trim() ?? ''

  // Through `readAppSecret`, not off the row (#556): the column holds an envelope
  // on rows written since, and plaintext on rows that predate it — and this module
  // reads the config table directly, so it is one of the two places a stored secret
  // is turned back into one.
  const apiKey = (await readAppSecret('aiApiKey')) ?? ''

  return {
    provider,
    endpoint: configuredEndpoint || defaultEndpoint(provider),
    apiKey,
    model: cfg?.aiModel ?? 'gpt-4o-mini',
  }
}

const buildPrompt = (name: string, description: string): string =>
  `Translate the following product name and description into exactly these 25 languages: ${LANGUAGES.join(', ')}.
Product name: "${name}"
Product description: "${description}"

Respond ONLY with a valid JSON object in this exact format (no markdown, no extra text):
{
  "de": {"name": "...", "description": "..."},
  "en": {"name": "...", "description": "..."},
  ...
}
Include all 25 language codes as keys.`

const callClaude = async (config: AiConfig, prompt: string): Promise<string> => {
  const res = await fetch(`${config.endpoint}/v1/messages`, {
    method: 'POST',
    headers: {
      'x-api-key': config.apiKey,
      'anthropic-version': '2023-06-01',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: config.model,
      max_tokens: 4096,
      messages: [{ role: 'user', content: prompt }],
    }),
  })

  if (!res.ok) throw new Error(`Claude API error: ${res.status}`)
  const data = await res.json() as { content: Array<{ text: string }> }
  return data.content[0]?.text ?? ''
}

const callOpenAICompatible = async (
  config: AiConfig,
  prompt: string,
  extraHeaders: Record<string, string> = {},
): Promise<string> => {
  const res = await fetch(`${config.endpoint}/v1/chat/completions`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${config.apiKey}`,
      'Content-Type': 'application/json',
      ...extraHeaders,
    },
    body: JSON.stringify({
      model: config.model,
      messages: [{ role: 'user', content: prompt }],
      max_tokens: 4096,
    }),
  })

  if (!res.ok) throw new Error(`OpenAI-compatible API error: ${res.status}`)
  const data = await res.json() as {
    choices: Array<{ message: { content: string } }>
  }
  return data.choices[0]?.message?.content ?? ''
}

const callAzureOpenAI = async (config: AiConfig, prompt: string): Promise<string> => {
  // endpoint should be the full Azure deployment URL
  // e.g. https://<resource>.openai.azure.com/openai/deployments/<deployment>/chat/completions?api-version=2024-02-01
  const res = await fetch(config.endpoint, {
    method: 'POST',
    headers: {
      'api-key': config.apiKey,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      messages: [{ role: 'user', content: prompt }],
      max_tokens: 4096,
    }),
  })

  if (!res.ok) throw new Error(`Azure OpenAI API error: ${res.status}`)
  const data = await res.json() as {
    choices: Array<{ message: { content: string } }>
  }
  return data.choices[0]?.message?.content ?? ''
}

export const translateProduct = async (
  name: string,
  description: string,
): Promise<Record<string, { name: string; description: string }>> => {
  const config = await loadConfig()
  // Providers without a safe default (azure_openai/ollama/localai) must have an
  // operator-configured endpoint; reject a blank one rather than misrouting the
  // request (and the API key) to the wrong host.
  if (!config.endpoint) {
    throw new Error(`AI endpoint is not configured for provider "${config.provider}"`)
  }
  const prompt = buildPrompt(name, description)

  let rawResponse: string

  switch (config.provider) {
    case 'claude':
      rawResponse = await callClaude(config, prompt)
      break
    case 'azure_openai':
      rawResponse = await callAzureOpenAI(config, prompt)
      break
    case 'openai':
    case 'ollama':
    case 'localai':
    default:
      rawResponse = await callOpenAICompatible(config, prompt)
      break
  }

  // Strip markdown code fences if present
  const jsonStr = rawResponse
    .replace(/^```(?:json)?\n?/m, '')
    .replace(/\n?```$/m, '')
    .trim()

  try {
    return JSON.parse(jsonStr) as Record<string, { name: string; description: string }>
  } catch {
    throw new Error('AI translation returned invalid JSON')
  }
}
