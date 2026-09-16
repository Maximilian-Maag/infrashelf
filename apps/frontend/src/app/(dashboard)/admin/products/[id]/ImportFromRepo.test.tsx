import { describe, it, expect, vi, beforeAll, beforeEach } from 'vitest'
import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { ImportFromRepo } from './ImportFromRepo'

vi.mock('@/lib/api', () => ({ post: vi.fn() }))
import { post } from '@/lib/api'

const refresh = vi.fn()
vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh }) }))

/**
 * The source fields browse a CI provider over the network. Replaced by a single
 * control that fills the whole source in one click, so these tests are about
 * what the import DOES with a complete source rather than about picking one.
 */
vi.mock('@/components/forms/TemplateSourceFields', () => ({
  emptyTemplateSource: () => ({ ciSourceId: '', projectId: '', ref: '', path: '' }),
  templateSourceComplete: (v: { ciSourceId: string; projectId: string; ref: string }) =>
    v.ciSourceId !== '' && v.projectId !== '' && v.ref !== '',
  TemplateSourceFields: ({ onChange }: { onChange: (v: unknown) => void }) => (
    <button
      type="button"
      onClick={() => onChange({ ciSourceId: '3', projectId: 'infra/templates', ref: 'main', path: 'modules/pg' })}
    >
      pick a source
    </button>
  ),
}))

beforeAll(() => {
  HTMLDialogElement.prototype.showModal = vi.fn(function (this: HTMLDialogElement) { this.open = true })
  HTMLDialogElement.prototype.close = vi.fn(function (this: HTMLDialogElement) { this.open = false })
})

const outcome = (over: Record<string, unknown> = {}) => ({
  created: 2, skipped: 0, createdNames: ['db_name', 'db_size'],
  skippedModules: [], filesRead: ['modules/pg/variables.tf'],
  stack: { created: true, name: 'pg-prod', stateKeyParam: 'state_key', template: 'modules/pg' },
  ...over,
})

const environments = [{ id: 1, name: 'prod' }, { id: 2, name: 'dev' }]

const open = (props: Partial<Parameters<typeof ImportFromRepo>[0]> = {}) =>
  render(
    <ImportFromRepo
      productId={7}
      environments={props.environments ?? environments}
      offeredIn={props.offeredIn ?? [1]}
      lang="en"
    />,
  )

/** Open the dialog, fill the source, choose an environment, and import. */
const runImport = async (u: ReturnType<typeof userEvent.setup>, environment?: string) => {
  await u.click(screen.getByRole('button', { name: 'Import from repository' }))
  await u.click(screen.getByRole('button', { name: 'pick a source' }))
  if (environment) await u.selectOptions(screen.getByLabelText(/^Environment/), environment)
  await u.click(screen.getByRole('button', { name: 'Import parameters' }))
}

beforeEach(() => {
  refresh.mockReset()
  vi.mocked(post).mockReset().mockResolvedValue(outcome() as never)
})

/**
 * #288 in one file: success is "the product can now be provisioned", not "some
 * rows were written". An import that created no stack, or kept one pointing
 * elsewhere, leaves the product exactly as unorderable as it was.
 */
describe('ImportFromRepo', () => {
  it('will not import until the source is complete', async () => {
    const u = userEvent.setup()
    open()

    await u.click(screen.getByRole('button', { name: 'Import from repository' }))
    expect(screen.getByRole('button', { name: 'Import parameters' })).toBeDisabled()

    await u.click(screen.getByRole('button', { name: 'pick a source' }))
    expect(screen.getByRole('button', { name: 'Import parameters' })).toBeEnabled()
  })

  it('sends the source, and the environment when one was chosen', async () => {
    const u = userEvent.setup()
    open()
    await runImport(u, '1')

    await waitFor(() =>
      expect(post).toHaveBeenCalledWith('/api/admin/products/7/import-parameters', {
        ciSourceId: 3,
        projectId: 'infra/templates',
        ref: 'main',
        path: 'modules/pg',
        environmentId: 1,
      }),
    )
  })

  it('omits the environment entirely rather than sending an empty one', async () => {
    const u = userEvent.setup()
    open()
    await runImport(u)

    await waitFor(() => expect(post).toHaveBeenCalled())
    expect(vi.mocked(post).mock.calls[0][1]).not.toHaveProperty('environmentId')
  })

  it('preselects the environment only when there is exactly one', async () => {
    const u = userEvent.setup()
    const single = open({ environments: [{ id: 5, name: 'only' }], offeredIn: [5] })
    await u.click(within(single.container).getByRole('button', { name: 'Import from repository' }))
    expect(within(single.container).getByLabelText(/^Environment/)).toHaveValue('5')
    single.unmount()

    open()
    await u.click(screen.getByRole('button', { name: 'Import from repository' }))
    expect(screen.getByLabelText(/^Environment/)).toHaveValue('')
  })

  it('offers EVERY environment, not only the ones the product is offered in', async () => {
    // Filtering emptied the list on exactly the product that needs the import
    // most — a new one, with no offerings yet — so the environment could not be
    // chosen at all.
    const u = userEvent.setup()
    open({ offeredIn: [] })

    await u.click(screen.getByRole('button', { name: 'Import from repository' }))
    const options = [...screen.getByLabelText(/^Environment/).querySelectorAll('option')]
    expect(options.map((o) => o.textContent)).toEqual(expect.arrayContaining(['prod', 'dev']))
  })

  it('warns about an environment with no offering without refusing it', async () => {
    // Inert rather than wrong: a stack fires only for an order, and an order
    // needs an offering. Discovering the missing offering at the till is the bad
    // outcome.
    const u = userEvent.setup()
    open({ offeredIn: [1] })

    await u.click(screen.getByRole('button', { name: 'Import from repository' }))
    await u.selectOptions(screen.getByLabelText(/^Environment/), '2')

    expect(screen.getByText(/not offered in that environment yet/i)).toBeInTheDocument()
    await u.click(screen.getByRole('button', { name: 'pick a source' }))
    expect(screen.getByRole('button', { name: 'Import parameters' })).toBeEnabled()
  })

  it('says nothing about offerings for an environment that has one', async () => {
    const u = userEvent.setup()
    open({ offeredIn: [1] })

    await u.click(screen.getByRole('button', { name: 'Import from repository' }))
    await u.selectOptions(screen.getByLabelText(/^Environment/), '1')
    expect(screen.queryByText(/not offered in that environment yet/i)).not.toBeInTheDocument()
  })

  it('calls it a success only when parameters AND a stack landed', async () => {
    const u = userEvent.setup()
    open()
    await runImport(u, '1')

    const box = await screen.findByRole('status')
    expect(box).toHaveTextContent('Parameters imported: 2')
    expect(box).toHaveTextContent('Pipeline stack created')
    expect(box).toHaveClass('bg-green-50')
  })

  it('treats an existing stack that already points here as settled', async () => {
    vi.mocked(post).mockResolvedValue(outcome({
      stack: { created: false, reason: 'already-configured', name: 'pg-prod' },
    }) as never)
    const u = userEvent.setup()
    open()
    await runImport(u, '1')

    const box = await screen.findByRole('status')
    expect(box).toHaveTextContent('Existing pipeline stack kept')
    expect(box).toHaveClass('bg-green-50')
  })

  it('does NOT call it a success when the stack points somewhere else', async () => {
    // It used to say the same thing as "kept", so an operator correcting a path
    // could not tell "already right" from "not looked at" (#288).
    vi.mocked(post).mockResolvedValue(outcome({
      stack: {
        created: false, reason: 'points-elsewhere', name: 'pg-prod',
        existingTemplates: ['modules/old'], importedTemplate: 'modules/pg',
      },
    }) as never)
    const u = userEvent.setup()
    open()
    await runImport(u, '1')

    const box = await screen.findByRole('alert')
    expect(box).toHaveTextContent('runs a different template — nothing was changed')
    // Both sides of the difference, so the operator can see what it would have
    // become. Nothing is rewritten: the stack's steps decide the Terraform state
    // key, and repointing it silently would leave running infrastructure
    // addressed by a name its teardown no longer derives.
    expect(box).toHaveTextContent('modules/old')
    expect(box).toHaveTextContent('modules/pg')
    expect(box).not.toHaveClass('bg-green-50')
  })

  it('does NOT call it a success when no environment was chosen', async () => {
    // The silent case and the likeliest one: with two or more environments the
    // field starts empty and is easy to walk past, and the import then reported
    // a clean success while never attempting the stack.
    vi.mocked(post).mockResolvedValue(outcome({ stack: undefined }) as never)
    const u = userEvent.setup()
    open()
    await runImport(u)

    const box = await screen.findByRole('alert')
    expect(box).toHaveTextContent('no environment was selected')
    expect(box).toHaveTextContent('cannot be ordered')
    expect(box).not.toHaveClass('bg-green-50')
  })

  it('does NOT call it a success when the path names no template', async () => {
    vi.mocked(post).mockResolvedValue(outcome({
      stack: { created: false, reason: 'no-template-path' },
    }) as never)
    const u = userEvent.setup()
    open()
    await runImport(u, '1')

    const box = await screen.findByRole('alert')
    expect(box).toHaveTextContent('the path names no template')
    expect(box).not.toHaveClass('bg-green-50')
  })

  it('does NOT call it a success when nothing was imported, even with a stack', async () => {
    vi.mocked(post).mockResolvedValue(outcome({ created: 0, createdNames: [] }) as never)
    const u = userEvent.setup()
    open()
    await runImport(u, '1')

    const box = await screen.findByRole('alert')
    expect(box).toHaveTextContent('No new parameters')
    expect(box).not.toHaveClass('bg-green-50')
  })

  it('names what it created, and counts what was already there', async () => {
    vi.mocked(post).mockResolvedValue(outcome({ skipped: 3 }) as never)
    const u = userEvent.setup()
    open()
    await runImport(u, '1')

    const box = await screen.findByRole('status')
    expect(box).toHaveTextContent('Parameters imported: 2 · Already existed: 3')
    expect(box).toHaveTextContent('db_name, db_size')
  })

  it('explains what the import is for, and what choosing an environment adds', async () => {
    // The sibling "Sync from template" cannot run before a stack exists — which
    // is precisely while a product is being set up — and always reads `main`.
    const u = userEvent.setup()
    open()
    await u.click(screen.getByRole('button', { name: 'Import from repository' }))

    expect(screen.getByText(/straight from the repository/)).toBeInTheDocument()
    expect(screen.getByText(/Also creates a pipeline stack/)).toBeInTheDocument()
  })

  it('names the state key the new stack will address its Terraform state by', async () => {
    const u = userEvent.setup()
    open()
    await runImport(u, '1')

    const box = await screen.findByRole('status')
    expect(box).toHaveTextContent('key: state_key')
  })

  it('shows a dash when the stack that points elsewhere runs nothing named', async () => {
    vi.mocked(post).mockResolvedValue(outcome({
      stack: {
        created: false, reason: 'points-elsewhere', name: 'pg-prod',
        existingTemplates: [], importedTemplate: 'modules/pg',
      },
    }) as never)
    const u = userEvent.setup()
    open()
    await runImport(u, '1')

    expect(await screen.findByText('—')).toBeInTheDocument()
  })

  it('separates several files, and several skipped modules, readably', async () => {
    vi.mocked(post).mockResolvedValue(outcome({
      filesRead: ['a/variables.tf', 'b/variables.tf'],
      skippedModules: [
        { module: 'vpc', source: 's1', reason: 'not found' },
        { module: 'dns', source: 's2', reason: 'private' },
      ],
    }) as never)
    const u = userEvent.setup()
    open()
    await runImport(u, '1')

    expect(await screen.findByText(/a\/variables\.tf, b\/variables\.tf/)).toBeInTheDocument()
    expect(screen.getByText(/vpc \(not found\); dns \(private\)/)).toBeInTheDocument()
  })

  it('says which files it read', async () => {
    // How an operator tells a wrong path from a template that genuinely declares
    // nothing.
    const u = userEvent.setup()
    open()
    await runImport(u, '1')

    expect(await screen.findByText(/Files read: modules\/pg\/variables\.tf/)).toBeInTheDocument()
  })

  it('names a module it could not read, and why', async () => {
    vi.mocked(post).mockResolvedValue(outcome({
      skippedModules: [{ module: 'vpc', source: 'git::…', reason: 'not found' }],
    }) as never)
    const u = userEvent.setup()
    open()
    await runImport(u, '1')

    expect(await screen.findByText(/vpc \(not found\)/)).toBeInTheDocument()
  })

  it('falls back to the source when a skipped module has no name', async () => {
    vi.mocked(post).mockResolvedValue(outcome({
      skippedModules: [{ module: '', source: 'git::https://x/y', reason: 'unsupported' }],
    }) as never)
    const u = userEvent.setup()
    open()
    await runImport(u, '1')

    expect(await screen.findByText(/git::https:\/\/x\/y \(unsupported\)/)).toBeInTheDocument()
  })

  it('refreshes the page behind, because its parameter list is server-rendered', async () => {
    const u = userEvent.setup()
    open()
    await runImport(u, '1')
    await waitFor(() => expect(refresh).toHaveBeenCalled())
  })

  it('says why the import failed, and stays open', async () => {
    vi.mocked(post).mockRejectedValue(new Error('repository not reachable'))
    const u = userEvent.setup()
    open()
    await runImport(u, '1')

    expect(await screen.findByText('repository not reachable')).toBeInTheDocument()
    expect(refresh).not.toHaveBeenCalled()
  })

  it('refuses a second press while one import is running', async () => {
    let release: (v: unknown) => void = () => {}
    vi.mocked(post).mockImplementation((() => new Promise((r) => { release = r })) as never)
    const u = userEvent.setup()
    open()
    await runImport(u, '1')

    const button = await screen.findByRole('button', { name: 'Importing…' })
    expect(button).toBeDisabled()
    expect(button).toHaveAttribute('aria-busy', 'true')

    // Awaited, not just released: the handler sets state after `post` resolves,
    // and letting that land after the test ends is an act warning and a write
    // into the next test's render.
    release(outcome())
    expect(await screen.findByRole('status')).toBeInTheDocument()
  })

  it('starts a second import from a clean slate', async () => {
    // A stale outcome over a dialog the operator has just reopened reads as the
    // result of an import that has not happened.
    const u = userEvent.setup()
    open()
    await runImport(u, '1')
    await screen.findByRole('status')

    // Two "Close" buttons: the Modal's own dismiss and this dialog's footer one.
    const footerClose = screen.getAllByRole('button', { name: 'Close' }).at(-1) as HTMLElement
    await u.click(footerClose)
    await u.click(screen.getByRole('button', { name: 'Import from repository' }))

    expect(screen.queryByText('Parameters imported: 2')).not.toBeInTheDocument()
  })
})
