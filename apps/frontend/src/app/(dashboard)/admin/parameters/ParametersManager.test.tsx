import { describe, it, expect, vi, beforeAll, beforeEach } from 'vitest'
import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type { Parameter, DeploymentEnvironment } from '@infrashelf/types'

// jsdom does not implement the native <dialog> methods; stub them so Modal's
// open/close effects don't throw (same stub as EnvironmentsManager.test.tsx).
beforeAll(() => {
  HTMLDialogElement.prototype.showModal = vi.fn(function (this: HTMLDialogElement) {
    this.open = true
  })
  HTMLDialogElement.prototype.close = vi.fn(function (this: HTMLDialogElement) {
    this.open = false
  })
})

vi.mock('@/lib/useLang', () => ({ useLang: () => 'en' }))
vi.mock('@/lib/api', () => ({
  get: vi.fn(),
  post: vi.fn(),
  put: vi.fn(),
  del: vi.fn(),
}))

import { get, post, put } from '@/lib/api'
import { ParametersManager } from './ParametersManager'

const parameter = (over: Record<string, unknown> = {}) => ({
  id: 1,
  scope: 'global',
  scopeId: 0,
  environmentId: null,
  name: 'instance_type',
  label: 'Instance type',
  type: 'string',
  description: '',
  defaultValue: '',
  required: false,
  sensitive: false,
  sizeValues: {},
  ...over,
})

const environments = [
  { id: 7, name: 'AWS Frankfurt' },
  { id: 8, name: 'Linode' },
]

/** Answers the two GETs the component makes on mount. */
/**
 * What the SERVER would have handed over (#460). The page fetches the
 * parameters, the environments and the projects now; `get` is still mocked for
 * the reload after a write.
 */
let serverParams: unknown[] = []

const mockApi = (params: unknown[] = [parameter()]) => {
  serverParams = params
  vi.mocked(get).mockImplementation((async (path: string) =>
    path.includes('/environments') ? environments : params) as never)
}

const renderManager = () =>
  render(
    <ParametersManager
      initial={serverParams as Parameter[]}
      initialEnvironments={environments as DeploymentEnvironment[]}
    />,
  )

/** The body of the last write, whichever verb it was. */
const lastWrite = (): Record<string, unknown> => {
  const posted = vi.mocked(post).mock.calls.at(-1)
  const putted = vi.mocked(put).mock.calls.at(-1)
  const body = putted?.[1] ?? posted?.[1]
  expect(body, 'the component sent no write at all').toBeDefined()
  return body as Record<string, unknown>
}

const wrote = () => vi.mocked(post).mock.calls.length + vi.mocked(put).mock.calls.length

/**
 * Query inside the dialog that is actually open.
 *
 * Add and Edit are two Modals and both are mounted at all times, so the same
 * label matches twice at the document level. Scoping to `dialog[open]` — which
 * the jsdom stub above maintains — is what makes a query mean the form the user
 * is looking at.
 */
const openDialog = () => {
  const dialog = document.querySelector('dialog[open]')
  expect(dialog, 'no dialog is open').not.toBeNull()
  return within(dialog as HTMLElement)
}

beforeEach(() => {
  vi.mocked(get).mockReset()
  vi.mocked(post).mockReset().mockResolvedValue(undefined as never)
  vi.mocked(put).mockReset().mockResolvedValue(undefined as never)
})

describe('ParametersManager — which environment a global parameter applies to (#275)', () => {
  /*
   * `parameters.environment_id` and the resolution behind it — an
   * environment-specific row preferred over an all-environments one — have been
   * implemented and correct since the column existed. No form ever rendered the
   * field, so the capability was unreachable and `POST /api/admin/parameters`
   * accepted an `environmentId` that nobody sent.
   */
  it('offers every environment, and all-environments first', async () => {
    mockApi()
    renderManager()
    await userEvent.click(await screen.findByRole('button', { name: /add parameter/i }))

    const select = openDialog().getByLabelText(/^environment$/i)
    const options = [...select.querySelectorAll('option')].map((o) => o.textContent)
    expect(options[0]).toMatch(/all environments/i)
    expect(options).toEqual(expect.arrayContaining(['AWS Frankfurt', 'Linode']))
  })

  it('sends the chosen environment when creating', async () => {
    mockApi()
    renderManager()
    await userEvent.click(await screen.findByRole('button', { name: /add parameter/i }))

    await userEvent.type(openDialog().getByLabelText(/variable name/i), 'REGION')
    await userEvent.selectOptions(openDialog().getByLabelText(/^environment$/i), '8')
    await userEvent.click(openDialog().getByRole('button', { name: /^(save|create|add)/i }))

    await waitFor(() => expect(wrote()).toBeGreaterThan(0))
    expect(lastWrite()).toMatchObject({ environmentId: 8 })
  })

  /*
   * Omitted, not null, when nothing was chosen: the create route treats an
   * absent `environmentId` as "all environments", and sending an explicit null
   * would be a different statement than the form is making.
   */
  it('says nothing about the environment when the default is left alone', async () => {
    mockApi()
    renderManager()
    await userEvent.click(await screen.findByRole('button', { name: /add parameter/i }))

    await userEvent.type(openDialog().getByLabelText(/variable name/i), 'REGION')
    await userEvent.click(openDialog().getByRole('button', { name: /^(save|create|add)/i }))

    await waitFor(() => expect(wrote()).toBeGreaterThan(0))
    expect(lastWrite()).not.toHaveProperty('environmentId')
  })

  /*
   * The one that makes the field usable rather than a trap: on UPDATE the null
   * is explicit. Omitting it would leave a parameter pinned to an environment
   * with no way back to "all", which is the same one-way shape #251 had to undo
   * for product retirement.
   */
  it('clears the environment back to all, explicitly, when edited', async () => {
    mockApi([parameter({ environmentId: 7 })])
    renderManager()
    await userEvent.click(await screen.findByRole('button', { name: /^edit$/i }))

    expect(openDialog().getByLabelText(/^environment$/i)).toHaveValue('7')
    await userEvent.selectOptions(openDialog().getByLabelText(/^environment$/i), '')
    await userEvent.click(openDialog().getByRole('button', { name: /^(save|update)/i }))

    await waitFor(() => expect(wrote()).toBeGreaterThan(0))
    const sent = lastWrite()
    expect(sent).toHaveProperty('environmentId')
    expect(sent.environmentId).toBeNull()
  })

  it('names the environment on a narrowed row, and says nothing on an unnarrowed one', async () => {
    mockApi([parameter({ id: 1, environmentId: 7 }), parameter({ id: 2, name: 'hostname', label: 'Hostname' })])
    renderManager()

    // Not <option>: both modals are mounted at all times and their environment
    // dropdowns contain every name, so a bare text query matches the form as
    // well as the list. The badge is what this test is about.
    const badges = (await screen.findAllByText('AWS Frankfurt')).filter((el) => el.tagName !== 'OPTION')
    expect(badges).toHaveLength(1)

    // No badge on the all-environments row: it would be noise on the common
    // case and would stop the narrowed ones standing out.
    const allEnvBadges = screen.queryAllByText(/all environments/i).filter((el) => el.tagName !== 'OPTION')
    expect(allEnvBadges).toHaveLength(0)
  })

describe('ParametersManager load failure', () => {
  it('does not claim there are no global parameters when the load failed', async () => {
    // "No global parameters yet" is a state an operator acts on — by defining
    // one that already exists (#415, #460).
    render(<ParametersManager initial={[]} initialError="backend unreachable" />)

    // Scoped to the card: every Modal renders whether or not it is open, and the
    // delete dialog carries its own copy of the error.
    const card = screen.getByRole('heading', { name: /global parameters/i }).closest('div.rounded-xl') as HTMLElement
    expect(within(card).getByText('backend unreachable')).toBeInTheDocument()
    expect(within(card).queryByText(/no global parameters yet/i)).not.toBeInTheDocument()
  })

  it('says there are none when there really are none', async () => {
    render(<ParametersManager initial={[]} />)
    expect(screen.getByText(/no global parameters/i)).toBeInTheDocument()
  })
})
})
