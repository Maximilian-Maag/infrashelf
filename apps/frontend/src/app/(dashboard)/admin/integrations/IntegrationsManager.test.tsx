import { describe, it, expect, vi, beforeAll, beforeEach } from 'vitest'
import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type { Integration, DeploymentEnvironment } from '@infrashelf/types'
import { IntegrationsManager } from './IntegrationsManager'

vi.mock('@/lib/api', () => ({ get: vi.fn(), post: vi.fn(), put: vi.fn(), del: vi.fn() }))
import { get, post, put, del } from '@/lib/api'

beforeAll(() => {
  HTMLDialogElement.prototype.showModal = vi.fn(function (this: HTMLDialogElement) { this.open = true })
  HTMLDialogElement.prototype.close = vi.fn(function (this: HTMLDialogElement) { this.open = false })
})

const integration = (over: Partial<Integration> = {}): Integration =>
  ({
    id: 7,
    kind: 'foreman',
    name: 'House Foreman',
    baseUrl: 'https://foreman.example.com',
    authType: 'bearer',
    username: '',
    hasCredential: true,
    environmentId: null,
    enabled: true,
    failureMode: 'best_effort',
    lastContactedAt: null,
    lastError: null,
    createdAt: null,
    updatedAt: null,
    ...over,
  }) as Integration

const environments: DeploymentEnvironment[] = [
  { id: 4, name: 'Production', description: '', ciSourceId: 1 },
  { id: 5, name: 'Staging', description: '', ciSourceId: 1 },
] as DeploymentEnvironment[]

/** The card, excluding the always-rendered dialogs behind it. */
const listCard = () =>
  (screen.getByRole('heading', { name: 'Integrations' }).closest('div.rounded-xl') as HTMLElement)

beforeEach(() => {
  vi.mocked(get).mockReset().mockResolvedValue([integration()] as never)
  vi.mocked(post).mockReset().mockResolvedValue(undefined as never)
  vi.mocked(put).mockReset().mockResolvedValue(undefined as never)
  vi.mocked(del).mockReset().mockResolvedValue(undefined as never)
})

/**
 * The registry screen for issue #111.
 *
 * Three things here are not ordinary CRUD and each is tested for its own
 * reason: the credential is write-only and must never be seeded back into a
 * form; the failure mode has no default, because the column exists precisely so
 * that somebody decided it; and health is two facts — when this last worked, and
 * why it does not now — which must not be collapsed into one.
 */
describe('IntegrationsManager', () => {
  it('lists each integration with its system, URL and binding', () => {
    render(<IntegrationsManager initial={[integration()]} environments={environments} />)
    const list = listCard()

    // The server handed the rows over (#452); nothing is fetched on mount.
    expect(get).not.toHaveBeenCalled()

    expect(within(list).getByText('House Foreman')).toBeInTheDocument()
    expect(within(list).getByText('Foreman')).toBeInTheDocument()
    expect(within(list).getByText('https://foreman.example.com')).toBeInTheDocument()
    expect(within(list).getByText(/Portal-wide/)).toBeInTheDocument()
  })

  it('names the environment an integration is bound to, rather than its id', () => {
    render(
      <IntegrationsManager initial={[integration({ environmentId: 4 })]} environments={environments} />,
    )

    expect(within(listCard()).getByText(/Production/)).toBeInTheDocument()
  })

  it('falls back to the id when the environments list did not load', () => {
    // The two sections settle independently (#415), so this is a real state:
    // the integrations arrived and the environments did not. An unresolved
    // binding must still read as a binding — rendering nothing would make it
    // look portal-wide, which is a different configuration.
    render(<IntegrationsManager initial={[integration({ environmentId: 4 })]} environments={[]} />)

    expect(within(listCard()).getByText(/#4/)).toBeInTheDocument()
    expect(within(listCard()).queryByText(/Portal-wide/)).not.toBeInTheDocument()
  })

  it('says the list could not be loaded rather than showing none', () => {
    render(
      <IntegrationsManager initial={[]} initialError="backend unreachable" environments={environments} />,
    )

    expect(within(listCard()).getByText('backend unreachable')).toBeInTheDocument()
    expect(within(listCard()).queryByText('No integrations configured yet.')).not.toBeInTheDocument()
  })

  it('says so when there really are none', () => {
    render(<IntegrationsManager initial={[]} environments={environments} />)

    expect(screen.getByText('No integrations configured yet.')).toBeInTheDocument()
  })

  it('creates an integration with the binding and failure mode that were chosen', async () => {
    const u = userEvent.setup()
    render(<IntegrationsManager initial={[]} environments={environments} />)

    await u.click(screen.getByRole('button', { name: 'Add integration' }))
    const dialog = screen.getByRole('dialog', { name: 'Add integration' })
    await u.selectOptions(within(dialog).getByLabelText(/^System/), 'nexus')
    await u.type(within(dialog).getByLabelText(/^Name/), '  Artefacts  ')
    await u.type(within(dialog).getByLabelText(/^URL/), '  https://nexus.example.com  ')
    await u.selectOptions(within(dialog).getByLabelText(/^Environment/), '5')
    // Unpadded: the name and URL above carry the trimming assertion, and the
    // credential is deliberately NOT trimmed — that has its own test below.
    await u.type(within(dialog).getByLabelText(/^Credential/), 'nx-secret')
    await u.selectOptions(within(dialog).getByLabelText(/^On failure/), 'blocking')
    await u.click(within(dialog).getByRole('button', { name: 'Save' }))

    await waitFor(() =>
      expect(post).toHaveBeenCalledWith('/api/admin/integrations', {
        kind: 'nexus',
        name: 'Artefacts',
        baseUrl: 'https://nexus.example.com',
        authType: 'bearer',
        environmentId: 5,
        enabled: true,
        failureMode: 'blocking',
        credential: 'nx-secret',
      }),
    )
  })

  it('sends null for a portal-wide binding, not an id of zero', async () => {
    const u = userEvent.setup()
    render(<IntegrationsManager initial={[]} environments={environments} />)

    await u.click(screen.getByRole('button', { name: 'Add integration' }))
    const dialog = screen.getByRole('dialog', { name: 'Add integration' })
    await u.type(within(dialog).getByLabelText(/^Name/), 'Central Loki')
    await u.type(within(dialog).getByLabelText(/^URL/), 'https://loki.example.com')
    await u.type(within(dialog).getByLabelText(/^Credential/), 'lk-secret')
    await u.selectOptions(within(dialog).getByLabelText(/^On failure/), 'best_effort')
    await u.click(within(dialog).getByRole('button', { name: 'Save' }))

    await waitFor(() => expect(post).toHaveBeenCalled())
    expect(vi.mocked(post).mock.calls[0][1]).toMatchObject({ environmentId: null })
  })

  it('sends the credential exactly as it was typed', async () => {
    /*
     * CodeRabbit on PR #498, and it was right.
     *
     * Every other field here is trimmed. The credential is not: the API stores
     * what it is given and the probe sends it back verbatim, so trimming is the
     * portal quietly altering a secret. A password whose trailing space is part
     * of it would then fail to authenticate with nothing on screen saying why.
     */
    const u = userEvent.setup()
    render(<IntegrationsManager initial={[]} environments={environments} />)

    await u.click(screen.getByRole('button', { name: 'Add integration' }))
    const dialog = screen.getByRole('dialog', { name: 'Add integration' })
    await u.type(within(dialog).getByLabelText(/^Name/), 'Padded')
    await u.type(within(dialog).getByLabelText(/^URL/), 'https://foreman.example.com')
    await u.type(within(dialog).getByLabelText(/^Credential/), ' secret ')
    await u.selectOptions(within(dialog).getByLabelText(/^On failure/), 'best_effort')
    await u.click(within(dialog).getByRole('button', { name: 'Save' }))

    await waitFor(() => expect(post).toHaveBeenCalled())
    expect(vi.mocked(post).mock.calls[0][1]).toMatchObject({ credential: ' secret ' })
    // The name beside it still is trimmed — this is about secrets, not about
    // abandoning the cleanup everywhere.
    expect(vi.mocked(post).mock.calls[0][1]).toMatchObject({ name: 'Padded' })
  })

  it('asks for a username only for basic authentication', async () => {
    const u = userEvent.setup()
    render(<IntegrationsManager initial={[]} environments={environments} />)

    await u.click(screen.getByRole('button', { name: 'Add integration' }))
    const dialog = screen.getByRole('dialog', { name: 'Add integration' })
    expect(within(dialog).queryByLabelText(/^Username/)).not.toBeInTheDocument()

    await u.selectOptions(within(dialog).getByLabelText(/^Authentication/), 'basic')
    expect(within(dialog).getByLabelText(/^Username/)).toBeInTheDocument()
  })

  it('asks for no credential at all when the system needs none', async () => {
    // `auth_type = 'none'` is the one shape where the row legitimately holds no
    // credential, and the database CHECK forbids the opposite pairing. A field
    // that cannot be filled in usefully should not be on the form.
    const u = userEvent.setup()
    render(<IntegrationsManager initial={[]} environments={environments} />)

    await u.click(screen.getByRole('button', { name: 'Add integration' }))
    const dialog = screen.getByRole('dialog', { name: 'Add integration' })
    await u.selectOptions(within(dialog).getByLabelText(/^Authentication/), 'none')

    expect(within(dialog).queryByLabelText(/^Credential/)).not.toBeInTheDocument()
  })

  it('offers no failure mode until one is picked', async () => {
    // The API requires it and does not default it (#111, bullet 5). A form that
    // pre-selected one would hand back the ad-hoc answer the column replaced.
    const u = userEvent.setup()
    render(<IntegrationsManager initial={[]} environments={environments} />)

    await u.click(screen.getByRole('button', { name: 'Add integration' }))
    const select = within(screen.getByRole('dialog', { name: 'Add integration' })).getByLabelText(
      /^On failure/,
    ) as HTMLSelectElement

    expect(select.value).toBe('')
    expect(select.required).toBe(true)
  })

  it('never puts a stored credential back in the edit form', async () => {
    const u = userEvent.setup()
    render(
      <IntegrationsManager initial={[integration({ hasCredential: true })]} environments={environments} />,
    )

    await u.click(screen.getByRole('button', { name: 'Edit' }))
    const dialog = screen.getByRole('dialog', { name: 'Edit integration' })
    const credential = within(dialog).getByLabelText(/^Credential/) as HTMLInputElement

    // The API never returns it, so anything in here would be an invention.
    expect(credential.value).toBe('')
  })

  it('leaves the stored credential alone when the field is left blank', async () => {
    const u = userEvent.setup()
    render(<IntegrationsManager initial={[integration()]} environments={environments} />)

    await u.click(screen.getByRole('button', { name: 'Edit' }))
    const dialog = screen.getByRole('dialog', { name: 'Edit integration' })
    await u.clear(within(dialog).getByLabelText(/^Name/))
    await u.type(within(dialog).getByLabelText(/^Name/), 'Renamed Foreman')
    await u.click(within(dialog).getByRole('button', { name: 'Save' }))

    await waitFor(() => expect(put).toHaveBeenCalled())
    const body = vi.mocked(put).mock.calls[0][1] as Record<string, unknown>
    expect(body.name).toBe('Renamed Foreman')
    // Absent, not empty: an empty string would replace a working credential
    // with one that authenticates against nothing.
    expect('credential' in body).toBe(false)
    // And the kind is not sent at all — the API refuses to change it.
    expect('kind' in body).toBe(false)
  })

  it('reports an unreachable system without calling the probe a failure', async () => {
    // The probe answers HTTP 200 with `ok: false`: the admin asked whether the
    // system is reachable, and "no, because ..." answers that question.
    const u = userEvent.setup()
    vi.mocked(post).mockResolvedValue({
      ok: false,
      status: 502,
      error: 'connect ECONNREFUSED',
      lastContactedAt: null,
      lastError: 'connect ECONNREFUSED',
    } as never)
    render(<IntegrationsManager initial={[integration()]} environments={environments} />)

    await u.click(screen.getByRole('button', { name: 'Test connection' }))

    await waitFor(() =>
      expect(post).toHaveBeenCalledWith('/api/admin/integrations/7/probe', {}),
    )
    expect(await within(listCard()).findByText(/connect ECONNREFUSED/)).toBeInTheDocument()
    expect(within(listCard()).getByText(/Not reachable/)).toBeInTheDocument()
  })

  it('writes the refreshed health back onto the row after a successful probe', async () => {
    const u = userEvent.setup()
    vi.mocked(post).mockResolvedValue({
      ok: true,
      status: 200,
      lastContactedAt: '2026-09-17T10:00:00.000Z',
      lastError: null,
    } as never)
    render(
      <IntegrationsManager
        initial={[integration({ lastError: 'connect ECONNREFUSED' })]}
        environments={environments}
      />,
    )

    expect(within(listCard()).getByText('connect ECONNREFUSED')).toBeInTheDocument()

    await u.click(screen.getByRole('button', { name: 'Test connection' }))

    expect(await within(listCard()).findByText(/Reachable/)).toBeInTheDocument()
    // "never reached" is now false, and the stale reason is gone: the pair reads
    // as the state the probe just established, not the one before it.
    expect(within(listCard()).queryByText('Never reached')).not.toBeInTheDocument()
    expect(within(listCard()).queryByText('connect ECONNREFUSED')).not.toBeInTheDocument()
  })

  it('drops the probe verdict of an integration that was just edited', async () => {
    /*
     * CodeRabbit on PR #498, and it was right.
     *
     * The verdict describes the configuration it was made against. `load()`
     * refreshes the rows but nothing re-probes, so an integration whose URL has
     * just been corrected would go on showing "not reachable" for the address it
     * no longer has — a health display asserting something that is not true any
     * more, which is worse than showing nothing.
     */
    const u = userEvent.setup()
    vi.mocked(post).mockResolvedValue({
      ok: false,
      status: null,
      error: 'connect ECONNREFUSED',
      lastContactedAt: null,
      lastError: 'connect ECONNREFUSED',
    } as never)
    vi.mocked(get).mockResolvedValue([integration({ lastError: null })] as never)
    render(<IntegrationsManager initial={[integration()]} environments={environments} />)

    await u.click(screen.getByRole('button', { name: 'Test connection' }))
    expect(await within(listCard()).findByText(/Not reachable/)).toBeInTheDocument()

    await u.click(screen.getByRole('button', { name: 'Edit' }))
    const dialog = screen.getByRole('dialog', { name: 'Edit integration' })
    await u.clear(within(dialog).getByLabelText(/^URL/))
    await u.type(within(dialog).getByLabelText(/^URL/), 'https://foreman.corrected.example.com')
    await u.click(within(dialog).getByRole('button', { name: 'Save' }))

    await waitFor(() => expect(put).toHaveBeenCalled())
    await waitFor(() =>
      expect(within(listCard()).queryByText(/Not reachable/)).not.toBeInTheDocument(),
    )
  })

  describe('when the environments could not be loaded', () => {
    /*
     * CodeRabbit on PR #498, and it was the one that mattered.
     *
     * The two sections settle independently, so this state is reachable: the
     * integrations arrived, the environments did not. With an empty list the
     * binding select holds exactly one option — portal-wide — and saving an
     * integration bound to environment 4 would MOVE it there, because that is
     * all the form could offer. An outage in a list used for labels must not
     * rewrite a binding.
     */
    it('disables the binding and says why', async () => {
      const u = userEvent.setup()
      render(
        <IntegrationsManager
          initial={[integration({ environmentId: 4 })]}
          environments={[]}
          environmentsError="HTTP 500: Internal Server Error"
        />,
      )

      await u.click(screen.getByRole('button', { name: 'Edit' }))
      const dialog = screen.getByRole('dialog', { name: 'Edit integration' })
      const select = within(dialog).getByLabelText(/^Environment/) as HTMLSelectElement

      expect(select.disabled).toBe(true)
      expect(within(dialog).getByText('Failed to load environments.')).toBeInTheDocument()
      // And it still shows the binding it has, rather than reporting the first
      // option it happens to hold.
      expect(select.value).toBe('4')
    })

    it('leaves the stored binding out of the update entirely', async () => {
      const u = userEvent.setup()
      render(
        <IntegrationsManager
          initial={[integration({ environmentId: 4 })]}
          environments={[]}
          environmentsError="HTTP 500: Internal Server Error"
        />,
      )

      await u.click(screen.getByRole('button', { name: 'Edit' }))
      const dialog = screen.getByRole('dialog', { name: 'Edit integration' })
      await u.clear(within(dialog).getByLabelText(/^Name/))
      await u.type(within(dialog).getByLabelText(/^Name/), 'Renamed')
      await u.click(within(dialog).getByRole('button', { name: 'Save' }))

      await waitFor(() => expect(put).toHaveBeenCalled())
      const body = vi.mocked(put).mock.calls[0][1] as Record<string, unknown>
      expect(body.name).toBe('Renamed')
      // Absent, not null: null is a binding — the portal-wide one — and sending
      // it would be the rebinding this whole case exists to prevent.
      expect('environmentId' in body).toBe(false)
    })
  })

  it('keeps a binding selectable when the environment is not in the list', async () => {
    // Same failure in miniature: a select whose current value is absent reports
    // the FIRST option instead, and here that is portal-wide.
    const u = userEvent.setup()
    render(<IntegrationsManager initial={[integration({ environmentId: 9 })]} environments={environments} />)

    await u.click(screen.getByRole('button', { name: 'Edit' }))
    const select = within(screen.getByRole('dialog', { name: 'Edit integration' })).getByLabelText(
      /^Environment/,
    ) as HTMLSelectElement

    expect(select.value).toBe('9')
    expect(within(select).getByRole('option', { name: '#9' })).toBeInTheDocument()
  })

  it('marks a disabled integration as such', () => {
    render(<IntegrationsManager initial={[integration({ enabled: false })]} environments={environments} />)

    // Disabled is not deleted, and the difference has to be visible: a consumer
    // that treats "absent" and "switched off" alike is how a blocking
    // integration silently becomes best-effort.
    expect(within(listCard()).getByText('Disabled')).toBeInTheDocument()
  })

  it('deletes the integration it was asked about', async () => {
    const u = userEvent.setup()
    render(<IntegrationsManager initial={[integration()]} environments={environments} />)

    await u.click(screen.getByRole('button', { name: 'Delete' }))
    const dialog = screen.getByRole('dialog', { name: 'Delete integration' })
    expect(within(dialog).getByText('House Foreman')).toBeInTheDocument()
    await u.click(within(dialog).getByRole('button', { name: 'Delete' }))

    await waitFor(() => expect(del).toHaveBeenCalledWith('/api/admin/integrations/7'))
  })

  it('says why a delete failed and keeps the row', async () => {
    const u = userEvent.setup()
    vi.mocked(del).mockRejectedValue(new Error('Integration is in use'))
    render(<IntegrationsManager initial={[integration()]} environments={environments} />)

    await u.click(screen.getByRole('button', { name: 'Delete' }))
    const dialog = screen.getByRole('dialog', { name: 'Delete integration' })
    await u.click(within(dialog).getByRole('button', { name: 'Delete' }))

    expect(await within(dialog).findByText('Integration is in use')).toBeInTheDocument()
    expect(within(listCard()).getByText('House Foreman')).toBeInTheDocument()
  })
})
