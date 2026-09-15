import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, waitFor, fireEvent } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type { AiConfig } from '@infrashelf/types'
import { AiConfigForm } from './AiConfigForm'

vi.mock('@/lib/api', () => ({ put: vi.fn() }))
import { put } from '@/lib/api'

const toast = vi.fn()
vi.mock('@/components/ui/Toast', () => ({ useToast: () => ({ toast }) }))

const config = (over: Partial<AiConfig> = {}): AiConfig =>
  ({ provider: 'claude', endpoint: 'https://api.anthropic.com', model: 'claude-opus-4-5', ...over }) as AiConfig

const save = () => screen.getByRole('button', { name: 'Save Configuration' })

beforeEach(() => {
  toast.mockReset()
  vi.mocked(put).mockReset().mockResolvedValue(undefined as never)
})

describe('AiConfigForm', () => {
  it('starts from the stored configuration', () => {
    render(<AiConfigForm initial={config()} />)

    expect(screen.getByLabelText(/^Provider/)).toHaveValue('claude')
    expect(screen.getByLabelText(/^API Endpoint/)).toHaveValue('https://api.anthropic.com')
    expect(screen.getByLabelText(/^Model/)).toHaveValue('claude-opus-4-5')
  })

  it('never puts the stored key back in the field', () => {
    // Same rule as the SMTP password and the CI access token: the API does not
    // return it, and a pre-filled field would say it is readable.
    render(<AiConfigForm initial={config()} />)
    expect(screen.getByLabelText(/^API Key/)).toHaveValue('')
    expect(screen.getByLabelText(/^API Key/)).toHaveAttribute('type', 'password')
  })

  it('leaves the stored key alone when the field is left blank', async () => {
    const u = userEvent.setup()
    render(<AiConfigForm initial={config()} />)

    await u.click(save())

    await waitFor(() => expect(put).toHaveBeenCalled())
    expect(vi.mocked(put).mock.calls[0][1]).not.toHaveProperty('apiKey')
  })

  it('replaces the key when one is typed', async () => {
    const u = userEvent.setup()
    render(<AiConfigForm initial={config()} />)

    await u.type(screen.getByLabelText(/^API Key/), 'sk-rotated')
    await u.click(save())

    await waitFor(() =>
      expect(put).toHaveBeenCalledWith('/api/admin/config/ai', expect.objectContaining({ apiKey: 'sk-rotated' })),
    )
  })

  it('lets the model be emptied, which is how the default is asked for', async () => {
    // #317's rule again: an empty model is what `lib/ai` already means by "use
    // the default", and a field that can be set but never emptied is a setting
    // nobody can undo.
    render(<AiConfigForm initial={config()} />)

    expect(screen.getByLabelText(/^Model/)).not.toBeRequired()
    fireEvent.change(screen.getByLabelText(/^Model/), { target: { value: '' } })
    fireEvent.submit(save().closest('form') as HTMLFormElement)

    await waitFor(() =>
      expect(put).toHaveBeenCalledWith('/api/admin/config/ai', expect.objectContaining({ model: '' })),
    )
  })

  it('trims the endpoint and the model', async () => {
    // `fireEvent` for the endpoint: a browser trims `type="url"` itself.
    render(<AiConfigForm initial={config()} />)

    // Not the endpoint: jsdom sanitises `type="url"` as a browser does, so its
    // `.trim()` cannot be told apart from the platform's here.
    fireEvent.change(screen.getByLabelText(/^Model/), { target: { value: '  gpt-4o  ' } })
    fireEvent.submit(save().closest('form') as HTMLFormElement)

    await waitFor(() =>
      expect(put).toHaveBeenCalledWith('/api/admin/config/ai', expect.objectContaining({ model: 'gpt-4o' })),
    )
  })

  it('offers all five providers and sends the chosen one', async () => {
    const u = userEvent.setup()
    render(<AiConfigForm initial={config()} />)

    const provider = screen.getByLabelText(/^Provider/)
    // Including the two self-hosted ones — the point of the list is that this
    // does not have to be a hosted API.
    expect([...provider.querySelectorAll('option')].map((o) => o.getAttribute('value')))
      .toEqual(['claude', 'openai', 'azure_openai', 'ollama', 'localai'])

    await u.selectOptions(provider, 'ollama')
    await u.click(save())

    await waitFor(() =>
      expect(put).toHaveBeenCalledWith('/api/admin/config/ai', expect.objectContaining({ provider: 'ollama' })),
    )
  })

  it('suggests a model that belongs to the chosen provider', async () => {
    // The placeholder is the only guidance here, and `gpt-4o` under Ollama
    // would be advice that cannot work.
    const u = userEvent.setup()
    render(<AiConfigForm initial={config()} />)

    expect(screen.getByLabelText(/^Model/)).toHaveAttribute('placeholder', 'claude-opus-4-5')
    await u.selectOptions(screen.getByLabelText(/^Provider/), 'ollama')
    expect(screen.getByLabelText(/^Model/)).toHaveAttribute('placeholder', 'llama3')
  })

  it('defaults a fresh installation to Claude', () => {
    render(<AiConfigForm initial={null} />)
    expect(screen.getByLabelText(/^Provider/)).toHaveValue('claude')
    expect(screen.getByLabelText(/^API Endpoint/)).toHaveValue('')
    expect(screen.getByLabelText(/^Model/)).toHaveValue('')
  })

  it('opens on the provider that is configured, not on the default', () => {
    // The default is only for an installation that has never been configured.
    // Falling back to Claude over a stored Ollama would quietly re-point an
    // operator's self-hosted setup at a hosted API.
    render(<AiConfigForm initial={config({ provider: 'ollama', model: 'llama3' })} />)

    expect(screen.getByLabelText(/^Provider/)).toHaveValue('ollama')
    expect(screen.getByLabelText(/^Model/)).toHaveValue('llama3')
  })

  it('suggests a model for every provider it offers', async () => {
    // A placeholder that belongs to another provider is advice that cannot work.
    const u = userEvent.setup()
    render(<AiConfigForm initial={config()} />)
    const model = screen.getByLabelText(/^Model/)

    for (const [provider, placeholder] of [
      ['openai', 'gpt-4o'],
      ['azure_openai', 'gpt-4o'],
      ['localai', 'gpt-4'],
      ['ollama', 'llama3'],
      ['claude', 'claude-opus-4-5'],
    ] as const) {
      await u.selectOptions(screen.getByLabelText(/^Provider/), provider)
      expect(model, provider).toHaveAttribute('placeholder', placeholder)
    }
  })

  it('names the section, explains the endpoint, and shows no alert until something fails', () => {
    render(<AiConfigForm initial={config()} />)

    expect(screen.getByRole('heading', { name: 'AI Provider Settings' })).toBeInTheDocument()
    // The hint is what says an empty endpoint is a choice rather than an omission.
    expect(screen.getByText('Leave blank to use the default endpoint for the selected provider')).toBeInTheDocument()
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
  })

  it('clears a previous error once the save succeeds', async () => {
    vi.mocked(put).mockRejectedValueOnce(new Error('the key was rejected'))
    const u = userEvent.setup()
    render(<AiConfigForm initial={config()} />)

    await u.click(save())
    await screen.findByText('the key was rejected')

    await u.click(save())
    await waitFor(() => expect(screen.queryByText('the key was rejected')).not.toBeInTheDocument())
  })

  it('confirms the save, and says why when it fails', async () => {
    const u = userEvent.setup()
    render(<AiConfigForm initial={config()} />)
    await u.click(save())
    await waitFor(() => expect(toast).toHaveBeenCalledWith('AI configuration saved.'))

    toast.mockReset()
    vi.mocked(put).mockRejectedValue(new Error('the key was rejected by the provider'))
    await u.click(save())

    expect(await screen.findByText('the key was rejected by the provider')).toBeInTheDocument()
    expect(toast).not.toHaveBeenCalled()
  })

  it('says the save is under way, and refuses a second press', async () => {
    let release: () => void = () => {}
    vi.mocked(put).mockImplementation((() => new Promise<void>((r) => { release = r })) as never)
    const u = userEvent.setup()
    render(<AiConfigForm initial={config()} />)

    await u.click(save())
    expect(await screen.findByRole('button', { name: 'Saving…' })).toBeDisabled()
    release()
  })

  it('offers the keep-it hint only when there is a key to keep', () => {
    const { unmount } = render(<AiConfigForm initial={config()} />)
    expect(screen.getByText('Leave blank to keep existing key')).toBeInTheDocument()
    unmount()

    render(<AiConfigForm initial={null} />)
    expect(screen.queryByText('Leave blank to keep existing key')).not.toBeInTheDocument()
  })
})
