import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { db } from '@/lib/db/client'
import { appConfig } from '@/lib/db/schema'
import { translateProduct } from './index'
import { SECRET_KEY_ENV, SECRET_KEY_HEX_LENGTH, encryptSecret } from '@/lib/crypto/secrets'

/**
 * The AI translation client (#307's tail): five providers behind one call, and the
 * single decision that matters most is WHICH HOST the prompt and the API key are
 * sent to.
 *
 * The endpoint is operator-configured and falls back to a provider default, and
 * three of the five providers have no safe default — Azure needs the deployment
 * URL, Ollama and LocalAI are host-specific. A fallback that quietly landed on
 * OpenAI would leak the prompt and the key to a service the operator never chose,
 * so the blank-endpoint cases below assert `fetch` was NOT called at all.
 *
 * Every case drives a real `fetch` mock: the request the provider would receive —
 * path, method, credential header, model — is what is asserted, not the shape of
 * the code that built it.
 */
const jsonRes = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })

const openAiAnswer = (content: string) => jsonRes({ choices: [{ message: { content } }] })
const claudeAnswer = (text: string) => jsonRes({ content: [{ text }] })

/** One app_config row, the way the admin config service writes it. */
const configure = async (over: Partial<typeof appConfig.$inferInsert> = {}) => {
  await db.delete(appConfig)
  await db.insert(appConfig).values({ id: 1, ...over })
}

const requestTo = (mock: ReturnType<typeof vi.spyOn>, index = 0) => {
  const [url, init] = mock.mock.calls[index] as [string, RequestInit]
  return {
    url: String(url),
    method: init.method,
    headers: init.headers as Record<string, string>,
    body: JSON.parse(String(init.body)) as {
      model?: string
      messages: { role: string; content: string }[]
      max_tokens?: number
    },
  }
}

beforeEach(async () => {
  await db.delete(appConfig)
})

afterEach(() => vi.restoreAllMocks())

describe('translateProduct — where the request goes', () => {
  it('uses the provider default for openai, and its default model', async () => {
    await configure({ aiProvider: 'openai', aiEndpoint: '', aiApiKey: 'sk-test' })
    const fetchMock = vi.spyOn(global, 'fetch').mockResolvedValue(openAiAnswer('{"de":{"name":"n"}}'))

    const result = await translateProduct('Web-01', 'A virtual machine')

    expect(result).toEqual({ de: { name: 'n' } })
    const call = requestTo(fetchMock)
    expect(call.url).toBe('https://api.openai.com/v1/chat/completions')
    expect(call.method).toBe('POST')
    expect(call.headers.Authorization).toBe('Bearer sk-test')
    // The model column is empty above, so the built-in default is what is asked
    // for — a fallback that quietly became '' would be a 400 from every provider.
    expect(call.body.model).toBe('gpt-4o-mini')
    expect(call.body.max_tokens).toBe(4096)
    expect(call.body.messages[0]?.content).toContain('Web-01')
    expect(call.body.messages[0]?.content).toContain('A virtual machine')
  })

  it('uses the request shape claude wants, including its version header', async () => {
    await configure({ aiProvider: 'claude', aiEndpoint: '', aiApiKey: 'sk-ant', aiModel: 'claude-sonnet' })
    const fetchMock = vi.spyOn(global, 'fetch').mockResolvedValue(claudeAnswer('{"en":{"name":"n"}}'))

    await translateProduct('Web-01', 'A virtual machine')

    const call = requestTo(fetchMock)
    expect(call.url).toBe('https://api.anthropic.com/v1/messages')
    expect(call.headers['x-api-key']).toBe('sk-ant')
    // Anthropic rejects a call without a version, and the version is a date that
    // has to be bumped deliberately rather than defaulted.
    expect(call.headers['anthropic-version']).toBe('2023-06-01')
    // Not an OpenAI-shaped bearer: sending both would put the key in two places
    // and one of them is not what the provider reads.
    expect(call.headers.Authorization).toBeUndefined()
    expect(call.body.model).toBe('claude-sonnet')
  })

  it('posts azure_openai at the configured deployment URL, verbatim', async () => {
    // Azure's URL already carries the deployment and the api-version, so appending
    // `/v1/chat/completions` — which the compatible path does — would 404 against
    // a URL that is perfectly correct.
    await configure({
      aiProvider: 'azure_openai',
      aiEndpoint: 'https://acme.openai.azure.com/openai/deployments/gpt4/chat/completions?api-version=2024-02-01',
      aiApiKey: 'az-key',
    })
    const fetchMock = vi.spyOn(global, 'fetch').mockResolvedValue(openAiAnswer('{"en":{"name":"n"}}'))

    await translateProduct('Web-01', 'A virtual machine')

    const call = requestTo(fetchMock)
    expect(call.url).toBe(
      'https://acme.openai.azure.com/openai/deployments/gpt4/chat/completions?api-version=2024-02-01',
    )
    expect(call.headers['api-key']).toBe('az-key')
    // Azure takes the model from the deployment, and a `model` field is a 400.
    expect(call.body.model).toBeUndefined()
  })

  it('appends the OpenAI-compatible path to an operator endpoint', async () => {
    for (const provider of ['ollama', 'localai'] as const) {
      await configure({ aiProvider: provider, aiEndpoint: 'http://llm.internal:11434', aiModel: 'llama3' })
      const fetchMock = vi.spyOn(global, 'fetch').mockResolvedValue(openAiAnswer('{"en":{"name":"n"}}'))

      await translateProduct('Web-01', 'A virtual machine')

      expect(requestTo(fetchMock).url).toBe('http://llm.internal:11434/v1/chat/completions')
      vi.restoreAllMocks()
    }
  })

  it('lets a configured endpoint override the provider default', async () => {
    // The reason the column exists: an operator behind a proxy or on a private
    // gateway must not have their key sent to the public host.
    await configure({ aiProvider: 'openai', aiEndpoint: 'https://llm.internal/', aiApiKey: 'sk-test' })

    const fetchMock = vi.spyOn(global, 'fetch').mockResolvedValue(openAiAnswer('{"en":{"name":"n"}}'))
    await translateProduct('Web-01', 'A virtual machine')

    expect(requestTo(fetchMock).url).toBe('https://llm.internal//v1/chat/completions')
    expect(fetchMock.mock.calls.map((c) => String(c[0]))).not.toContain(
      'https://api.openai.com/v1/chat/completions',
    )
  })

  it('treats a whitespace-only endpoint as blank', async () => {
    // The column is NOT NULL DEFAULT '', so it holds '' rather than NULL and a
    // `?? default` never fires — the trim is what makes an operator's stray space
    // mean "no endpoint" rather than a request to a host called "".
    await configure({ aiProvider: 'openai', aiEndpoint: '   ', aiApiKey: 'sk-test' })
    const fetchMock = vi.spyOn(global, 'fetch').mockResolvedValue(openAiAnswer('{"en":{"name":"n"}}'))

    await translateProduct('Web-01', 'A virtual machine')

    expect(requestTo(fetchMock).url).toBe('https://api.openai.com/v1/chat/completions')
  })
})

describe('translateProduct — providers with no safe default', () => {
  it('refuses a blank endpoint instead of falling back to OpenAI', async () => {
    // The case this whole branch exists for: Azure without a deployment URL, or a
    // local provider with no host. Falling back would send the prompt AND the
    // stored key to api.openai.com.
    for (const provider of ['azure_openai', 'ollama', 'localai'] as const) {
      await configure({ aiProvider: provider, aiEndpoint: '', aiApiKey: 'secret-key' })
      const fetchMock = vi.spyOn(global, 'fetch')

      await expect(translateProduct('Web-01', 'A virtual machine'), provider).rejects.toThrow(
        `AI endpoint is not configured for provider "${provider}"`,
      )
      expect(fetchMock, provider).not.toHaveBeenCalled()
    }
  })

  it('also refuses one that is only whitespace', async () => {
    await configure({ aiProvider: 'ollama', aiEndpoint: '  \n ' })
    const fetchMock = vi.spyOn(global, 'fetch')

    await expect(translateProduct('Web-01', 'A virtual machine')).rejects.toThrow(/not configured/)
    expect(fetchMock).not.toHaveBeenCalled()
  })
})

describe('translateProduct — reading the answer back', () => {
  const ask = async (content: string) => {
    await configure({ aiProvider: 'openai', aiEndpoint: '', aiApiKey: 'sk' })
    vi.spyOn(global, 'fetch').mockResolvedValue(openAiAnswer(content))
    return translateProduct('Web-01', 'A virtual machine')
  }

  it('strips the markdown fence a chat model likes to add', async () => {
    // Models wrap JSON in ```json despite being asked not to, and the fence is not
    // JSON: without this the whole translation fails on a perfectly good answer.
    await expect(ask('```json\n{"de":{"name":"Rechner"}}\n```')).resolves.toEqual({
      de: { name: 'Rechner' },
    })
    await expect(ask('```\n{"de":{"name":"Rechner"}}\n```')).resolves.toEqual({ de: { name: 'Rechner' } })
  })

  it('says the answer was not JSON rather than returning prose', async () => {
    // The failure mode a caller can act on: an answer of "Sure! Here are the
    // translations:" would otherwise be stored as the translations.
    await expect(ask('Sure! Here are the translations:')).rejects.toThrow(
      'AI translation returned invalid JSON',
    )
  })

  it('answers an empty string when the provider returned no content', async () => {
    // Pinned as-is: an empty content means `{}` is not valid JSON, so the caller
    // sees the same "invalid JSON" refusal rather than a silent empty translation.
    await configure({ aiProvider: 'openai', aiEndpoint: '', aiApiKey: 'sk' })
    vi.spyOn(global, 'fetch').mockResolvedValue(jsonRes({ choices: [] }))

    await expect(translateProduct('Web-01', 'A virtual machine')).rejects.toThrow(
      'AI translation returned invalid JSON',
    )
  })
})

describe('translateProduct — refusals carry the status', () => {
  it('throws the provider-appropriate message with the HTTP status', async () => {
    const cases = [
      { provider: 'openai', endpoint: '', status: 429, message: 'OpenAI-compatible API error: 429' },
      { provider: 'claude', endpoint: '', status: 500, message: 'Claude API error: 500' },
      { provider: 'azure_openai', endpoint: 'https://x.openai.azure.com/y', status: 400, message: 'Azure OpenAI API error: 400' },
    ] as const

    for (const c of cases) {
      await configure({ aiProvider: c.provider, aiEndpoint: c.endpoint, aiApiKey: 'sk' })
      vi.spyOn(global, 'fetch').mockResolvedValue(new Response('nope', { status: c.status }))

      await expect(translateProduct('Web-01', 'A virtual machine'), c.provider).rejects.toThrow(c.message)
      vi.restoreAllMocks()
    }
  })
})

describe('the prompt', () => {
  it('asks for all 25 languages by code', async () => {
    // The list is the contract with the product form: a language missing from the
    // prompt is a field that never gets translated, and nothing else notices.
    await configure({ aiProvider: 'openai', aiEndpoint: '', aiApiKey: 'sk' })
    const fetchMock = vi.spyOn(global, 'fetch').mockResolvedValue(openAiAnswer('{}'))

    await translateProduct('Web-01', 'A virtual machine')

    const prompt = requestTo(fetchMock).body.messages[0]?.content ?? ''
    for (const code of [
      'de', 'en', 'fr', 'it', 'es', 'pt', 'nl', 'pl', 'cs', 'sk', 'sl', 'hr',
      'ro', 'hu', 'bg', 'el', 'fi', 'sv', 'da', 'et', 'lv', 'lt', 'mt', 'ga', 'ru',
    ]) {
      expect(prompt, code).toContain(code)
    }
    expect(prompt).toContain('exactly these 25 languages')
  })
})

/*
 * #556. The API key is stored as an envelope, and this module reads the config
 * table directly — so what goes on the wire has to be the plaintext, never the
 * ciphertext, and never a stale one.
 */
describe('translateProduct — the stored key (#556)', () => {
  it('sends the key decrypted from its envelope', async () => {
    await configure({ aiProvider: 'openai', aiEndpoint: '', aiApiKey: encryptSecret('sk-stored') })
    const fetchMock = vi
      .spyOn(global, 'fetch')
      .mockResolvedValue(openAiAnswer('{"de":{"name":"n"}}'))

    await translateProduct('Web-01', 'A virtual machine')

    expect(requestTo(fetchMock).headers.Authorization).toBe('Bearer sk-stored')
  })

  it('uses a key an older deployment left in plain text, and leaves it alone', async () => {
    await configure({ aiProvider: 'openai', aiEndpoint: '', aiApiKey: 'sk-legacy' })
    const fetchMock = vi
      .spyOn(global, 'fetch')
      .mockResolvedValue(openAiAnswer('{"de":{"name":"n"}}'))

    await translateProduct('Web-01', 'A virtual machine')

    // Used as it is, so an upgrade does not stop translations while the boot
    // backfill has still to run — and NOT re-written here, because a read path
    // that writes can overwrite a key an administrator is saving at that moment.
    expect(requestTo(fetchMock).headers.Authorization).toBe('Bearer sk-legacy')
    const [row] = await db.select().from(appConfig)
    expect(row?.aiApiKey).toBe('sk-legacy')
  })

  it('does not send a ciphertext when the key does not match the envelope', async () => {
    // A replaced SECRET_ENCRYPTION_KEY. The request must NOT go out with `v1:...`
    // as the bearer token: the provider would answer 401 and the operator would go
    // looking at their API key instead of at the server's own configuration.
    const configured = process.env[SECRET_KEY_ENV]
    try {
      process.env[SECRET_KEY_ENV] = 'b'.repeat(SECRET_KEY_HEX_LENGTH)
      const foreign = encryptSecret('sk-stored')
      process.env[SECRET_KEY_ENV] = configured
      await configure({ aiProvider: 'openai', aiEndpoint: '', aiApiKey: foreign })

      const fetchMock = vi
        .spyOn(global, 'fetch')
        .mockResolvedValue(openAiAnswer('{"de":{"name":"n"}}'))

      await expect(translateProduct('Web-01', 'A virtual machine')).rejects.toThrow()
      expect(fetchMock).not.toHaveBeenCalled()
    } finally {
      process.env[SECRET_KEY_ENV] = configured
    }
  })
})
