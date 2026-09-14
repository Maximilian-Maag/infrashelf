import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type { ProductDetail } from '@infrashelf/types'

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }),
}))

vi.mock('@/lib/api', () => ({
  get: vi.fn(),
  post: vi.fn(),
}))

import { OrderForm } from './OrderForm'
import { get, post } from '@/lib/api'

const mockedGet = vi.mocked(get)
const mockedPost = vi.mocked(post)

const param = (over: Partial<ProductDetail['parameters'][number]>) => ({
  id: 1,
  scope: 'global' as const,
  scopeId: 0,
  environmentId: null,
  name: 'REGION',
  label: '',
  type: 'string' as const,
  description: '',
  defaultValue: '',
  required: false,
  sensitive: false,
  ...over,
})

// The catalog page loads the product WITHOUT an environment, so the server can
// only return one candidate per name per environment: here the all-environments
// definition of REGION plus an env-2 override of the same name.
const product = {
  id: 7,
  categoryId: 1,
  baseLanguage: 'en',
  createdAt: new Date().toISOString(),
  name: 'P',
  description: '',
  environments: [
    { productId: 7, environmentId: 1, price: '0', currency: 'EUR', costCenterMode: 'project', forcedCostCenter: false, overheadCostCenterId: null, environmentName: 'Env One' },
    { productId: 7, environmentId: 2, price: '0', currency: 'EUR', costCenterMode: 'project', forcedCostCenter: false, overheadCostCenterId: null, environmentName: 'Env Two' },
  ],
  parameters: [
    param({ id: 1, name: 'REGION', environmentId: null, label: 'Region (all envs)' }),
    param({ id: 2, name: 'REGION', environmentId: 2, scope: 'product', scopeId: 7, label: 'Region (env two)' }),
  ],
} as unknown as ProductDetail

beforeEach(() => {
  mockedPost.mockReset().mockResolvedValue(undefined as never)
  mockedGet.mockReset()
  // Templates lookup (fired on project selection) — not exercised here.
  mockedGet.mockResolvedValue([] as never)
})

describe('OrderForm parameter resolution', () => {
  it('refetches the product scoped to the selected environment and renders that resolution', async () => {
    // What the server resolves for env 1: the all-environments definition wins,
    // because the only override belongs to env 2.
    mockedGet.mockImplementation((async (path: string) => {
      if (path.startsWith('/api/catalog/')) {
        return { ...product, parameters: [param({ id: 1, name: 'REGION', environmentId: null, label: 'Region (all envs)' })] }
      }
      return []
    }) as never)

    render(<OrderForm product={product} projects={[]} costCenters={[]} />)

    await userEvent.selectOptions(screen.getByLabelText(/environment/i), '1')

    await waitFor(() => {
      expect(mockedGet).toHaveBeenCalledWith('/api/catalog/7?lang=en&environmentId=1')
    })

    // Exactly one REGION control, and it is the definition createOrder will
    // validate against for env 1 — not the env-2 override that would have won a
    // name-only collapse on the server.
    await waitFor(() => {
      expect(screen.getByLabelText('Region (all envs)')).toBeInTheDocument()
    })
    expect(screen.queryByLabelText('Region (env two)')).not.toBeInTheDocument()
  })

  it('falls back to the unresolved list when the scoped refetch fails', async () => {
    mockedGet.mockImplementation((async (path: string) => {
      if (path.startsWith('/api/catalog/')) throw new Error('offline')
      return []
    }) as never)

    render(<OrderForm product={product} projects={[]} costCenters={[]} />)

    await userEvent.selectOptions(screen.getByLabelText(/environment/i), '2')

    // The env-2 candidate is still rendered from the initially-loaded list, so a
    // failed refetch degrades rather than blanking the form.
    await waitFor(() => {
      expect(screen.getByLabelText('Region (env two)')).toBeInTheDocument()
    })
  })

  // ── Cost-centre modes (FA-10.4) ───────────────────────────────────────────
  // `overhead` names a fixed shared account on the offering. Before it had
  // somewhere to store one it was lumped in with `select` and rendered a
  // picker, so a fixed overhead account was indistinguishable from a free
  // choice.
  const envWithMode = (
    mode: 'project' | 'select' | 'overhead',
    over?: { overheadCostCenterId?: number | null; overheadCostCenterName?: string | null; forcedCostCenter?: boolean },
  ) => ({
    ...product,
    environments: [{
      productId: 7,
      environmentId: 1,
      price: '0',
      currency: 'EUR',
      costCenterMode: mode,
      forcedCostCenter: over?.forcedCostCenter ?? false,
      overheadCostCenterId: over?.overheadCostCenterId ?? null,
      overheadCostCenterName: over?.overheadCostCenterName ?? null,
      environmentName: 'Env One',
    }],
  } as unknown as ProductDetail)

  const costCenters = [
    { id: 10, code: 'CC-100', name: 'Shared Platform', active: true },
  ] as never

  // The env-scoped refetch has to return a product-shaped payload — the
  // component reads `.parameters` off it.
  const mockCatalogFor = (detail: ProductDetail) => {
    mockedGet.mockImplementation((async (path: string) =>
      path.startsWith('/api/catalog/') ? detail : []) as never)
  }

  it('offers a cost-centre picker in select mode', async () => {
    const detail = envWithMode('select')
    mockCatalogFor(detail)
    render(<OrderForm product={detail} projects={[]} costCenters={costCenters} />)
    await userEvent.selectOptions(screen.getByLabelText(/environment/i), '1')

    expect(await screen.findByLabelText(/^cost center/i)).toBeInTheDocument()
    expect(screen.queryByTestId('overhead-cost-center')).not.toBeInTheDocument()
  })

  it('shows the fixed account instead of a picker in overhead mode', async () => {
    const detail = envWithMode('overhead', { overheadCostCenterId: 10, overheadCostCenterName: 'Shared Platform' })
    mockCatalogFor(detail)
    render(<OrderForm product={detail} projects={[]} costCenters={costCenters} />)
    await userEvent.selectOptions(screen.getByLabelText(/environment/i), '1')

    expect(await screen.findByTestId('overhead-cost-center')).toHaveTextContent('Shared Platform')
    // No picker: the account is fixed by the offering, so there is nothing to choose.
    expect(screen.queryByLabelText(/^cost center/i)).not.toBeInTheDocument()
  })

  it('renders a placeholder when an overhead offering has no account configured', async () => {
    const detail = envWithMode('overhead')
    mockCatalogFor(detail)
    render(<OrderForm product={detail} projects={[]} costCenters={costCenters} />)
    await userEvent.selectOptions(screen.getByLabelText(/environment/i), '1')

    expect(await screen.findByTestId('overhead-cost-center')).toHaveTextContent('—')
  })

  it('shows no cost-centre control at all in project mode', async () => {
    const detail = envWithMode('project')
    mockCatalogFor(detail)
    render(<OrderForm product={detail} projects={[]} costCenters={costCenters} />)
    await userEvent.selectOptions(screen.getByLabelText(/environment/i), '1')

    expect(screen.queryByLabelText(/^cost center/i)).not.toBeInTheDocument()
    expect(screen.queryByTestId('overhead-cost-center')).not.toBeInTheDocument()
  })

  // ── Quick reorder (issue #39) ──────────────────────────────────────────────
  // The infrastructure list links here with ?fromInfra=&projectId=. The element
  // is found in the project's template list, so no new endpoint is involved.
  const projects = [{ id: 5, name: 'Webshop', description: '', ownerId: 1, costCenterId: null, createdAt: '' }] as never

  const infraElement = {
    id: 99,
    orderId: 1,
    projectId: 5,
    environmentId: 2,
    productId: 7,
    status: 'active',
    parameters: { REGION: 'eu-central-1' },
    pipelineId: [],
    outputs: {},
    deployedAt: '2026-03-01T00:00:00.000Z',
    environmentName: 'Env Two',
  }

  const mockReorderApi = (elements: unknown[] = [infraElement]) => {
    mockedGet.mockImplementation((async (path: string) => {
      // A page, not a bare array: /api/infrastructure stopped returning every
      // element ever provisioned (#158). This picker reads one window of it.
      if (path.startsWith('/api/infrastructure')) {
        return { items: elements, total: elements.length, limit: 50, offset: 0 }
      }
      if (path.startsWith('/api/catalog/')) {
        return { ...product, parameters: [param({ id: 2, name: 'REGION', environmentId: 2, scope: 'product', scopeId: 7, label: 'Region (env two)' })] }
      }
      return []
    }) as never)
  }

  it('preselects the project it was given', async () => {
    mockReorderApi()
    render(<OrderForm product={product} projects={projects} costCenters={[]} initialProjectId="5" />)

    expect(screen.getByLabelText(/project/i)).toHaveValue('5')
  })

  it('adopts the named element: its environment and its parameters', async () => {
    mockReorderApi()
    render(
      <OrderForm product={product} projects={projects} costCenters={[]}
        fromInfraId="99" initialProjectId="5" />,
    )

    // Environment comes from the element, so the user does not have to remember
    // which one it was deployed to.
    await waitFor(() => expect(screen.getByLabelText(/environment/i)).toHaveValue('2'))
    await waitFor(() => expect(screen.getByLabelText('Region (env two)')).toHaveValue('eu-central-1'))
  })

  it('explains that the form was pre-filled', async () => {
    mockReorderApi()
    render(
      <OrderForm product={product} projects={projects} costCenters={[]}
        fromInfraId="99" initialProjectId="5" />,
    )

    await waitFor(() =>
      expect(screen.getByText(/parameters were pre-filled from this element/i)).toBeInTheDocument(),
    )
  })

  it('leaves the form untouched when the named element is not in the project', async () => {
    // A stale or hand-edited link must not silently apply someone else's config.
    mockReorderApi([])
    render(
      <OrderForm product={product} projects={projects} costCenters={[]}
        fromInfraId="99" initialProjectId="5" />,
    )

    await waitFor(() => expect(mockedGet).toHaveBeenCalled())
    expect(screen.getByLabelText(/environment/i)).toHaveValue('')
    expect(screen.queryByText(/parameters were pre-filled/i)).not.toBeInTheDocument()
  })

  it('does not re-apply the element after the user picks "start fresh"', async () => {
    const user = userEvent.setup()
    mockReorderApi()
    render(
      <OrderForm product={product} projects={projects} costCenters={[]}
        fromInfraId="99" initialProjectId="5" />,
    )

    await waitFor(() => expect(screen.getByLabelText(/environment/i)).toHaveValue('2'))
    await user.selectOptions(screen.getByLabelText(/load parameters from existing/i), '')
    // Applied at most once — otherwise the effect would immediately undo the
    // user's choice to start over.
    expect(screen.getByLabelText(/load parameters from existing/i)).toHaveValue('')
  })

  it('ignores the reorder hint when no element was named', async () => {
    mockReorderApi()
    render(<OrderForm product={product} projects={projects} costCenters={[]} initialProjectId="5" />)

    await waitFor(() => expect(mockedGet).toHaveBeenCalled())
    expect(screen.queryByText(/parameters were pre-filled/i)).not.toBeInTheDocument()
  })

  // ── Time-boxed trials (issue #1) ───────────────────────────────────────────
  // Opt-in per offering: a trial provisions real infrastructure and asks the
  // pipeline for elevated rights inside it, so the toggle only exists where one
  // is actually offered. The server re-checks regardless.
  const trialEnv = (over?: { trialEnabled?: boolean; trialDurationMinutes?: number }) => ({
    ...product,
    environments: [
      {
        productId: 7,
        environmentId: 1,
        price: '0',
        currency: 'EUR',
        costCenterMode: 'project',
        forcedCostCenter: false,
        overheadCostCenterId: null,
        trialEnabled: over?.trialEnabled ?? true,
        trialDurationMinutes: over?.trialDurationMinutes ?? 30,
        environmentName: 'Env One',
      },
      {
        productId: 7,
        environmentId: 2,
        price: '0',
        currency: 'EUR',
        costCenterMode: 'project',
        forcedCostCenter: false,
        overheadCostCenterId: null,
        trialEnabled: false,
        trialDurationMinutes: 30,
        environmentName: 'Env Two',
      },
    ],
  } as unknown as ProductDetail)

  const renderTrial = (detail: ProductDetail) => {
    mockedGet.mockImplementation((async (path: string) =>
      path.startsWith('/api/catalog/') ? detail : []) as never)
    return render(
      <OrderForm
        product={detail}
        projects={[{ id: 5, name: 'Webshop', description: '', ownerId: 1, costCenterId: null, createdAt: '' }] as never}
        costCenters={[]}
       
      />,
    )
  }

  it('offers the trial toggle only for an environment that allows one', async () => {
    renderTrial(trialEnv())
    // Nothing selected yet, so nothing to offer.
    expect(screen.queryByLabelText(/try it out/i)).not.toBeInTheDocument()

    await userEvent.selectOptions(screen.getByLabelText(/environment/i), '1')
    expect(await screen.findByLabelText(/try it out/i)).toBeInTheDocument()

    await userEvent.selectOptions(screen.getByLabelText(/environment/i), '2')
    await waitFor(() => expect(screen.queryByLabelText(/try it out/i)).not.toBeInTheDocument())
  })

  it('shows the configured duration, not a hard-coded 30', async () => {
    renderTrial(trialEnv({ trialDurationMinutes: 120 }))
    await userEvent.selectOptions(screen.getByLabelText(/environment/i), '1')

    expect(await screen.findByLabelText(/120 min trial/i)).toBeInTheDocument()
  })

  it('explains what a trial does before it is ticked', async () => {
    renderTrial(trialEnv())
    await userEvent.selectOptions(screen.getByLabelText(/environment/i), '1')

    expect(await screen.findByText(/decommissioned automatically|elevated rights/i)).toBeInTheDocument()
  })

  // Two tests rather than one: a successful submit replaces the form with the
  // confirmation, so a single render cannot exercise both branches.
  it('omits the trial flag when the box is left unticked', async () => {
    const user = userEvent.setup()
    renderTrial(trialEnv())
    await user.selectOptions(screen.getByLabelText(/environment/i), '1')
    await user.selectOptions(screen.getByLabelText(/project/i), '5')

    await user.click(screen.getByRole('button', { name: /place order/i }))
    await waitFor(() => expect(mockedPost).toHaveBeenCalled())
    expect((mockedPost.mock.calls[0][1] as Record<string, unknown>).trial).toBeUndefined()
  })

  it('sends trial: true when the box is ticked', async () => {
    const user = userEvent.setup()
    renderTrial(trialEnv())
    await user.selectOptions(screen.getByLabelText(/environment/i), '1')
    await user.selectOptions(screen.getByLabelText(/project/i), '5')
    await user.click(await screen.findByLabelText(/try it out/i))

    await user.click(screen.getByRole('button', { name: /place order/i }))
    await waitFor(() => expect(mockedPost).toHaveBeenCalled())
    expect((mockedPost.mock.calls[0][1] as Record<string, unknown>).trial).toBe(true)
  })

  it('does not smuggle the flag through after switching to a non-trial environment', async () => {
    // Ticking the box, then moving to an environment with no trial, must not send
    // trial: true — the server would reject it, and the intent is gone anyway.
    const user = userEvent.setup()
    renderTrial(trialEnv())
    await user.selectOptions(screen.getByLabelText(/environment/i), '1')
    await user.selectOptions(screen.getByLabelText(/project/i), '5')
    await user.click(await screen.findByLabelText(/try it out/i))

    await user.selectOptions(screen.getByLabelText(/environment/i), '2')
    await user.click(screen.getByRole('button', { name: /place order/i }))

    await waitFor(() => expect(mockedPost).toHaveBeenCalled())
    expect((mockedPost.mock.calls[0][1] as Record<string, unknown>).trial).toBeUndefined()
  })

  it('shows nothing for an offering that does not allow trials', async () => {
    renderTrial(trialEnv({ trialEnabled: false }))
    await userEvent.selectOptions(screen.getByLabelText(/environment/i), '1')

    await waitFor(() => expect(screen.getByLabelText(/project/i)).toBeInTheDocument())
    expect(screen.queryByLabelText(/try it out/i)).not.toBeInTheDocument()
  })
})

/**
 * An invalid quantity used to disable the submit button and say nothing.
 *
 * `Number('')` is 0, so clearing the field made the form unsubmittable in
 * silence — and a disabled <button> is not focusable, so a screen-reader user
 * tabbing this form reached the end and found no submit control at all, with no
 * explanation of where it went. This is the app's primary conversion path
 * (WCAG 3.3.1, 3.3.3 — #186).
 */
describe('OrderForm quantity', () => {
  const projects = [{ id: 5, name: 'Proj', costCenterId: null }] as never

  async function fillOrder() {
    const user = userEvent.setup()
    render(<OrderForm product={product} projects={projects} costCenters={[]} />)
    await user.selectOptions(screen.getByLabelText(/environment/i), '1')
    await user.selectOptions(await screen.findByLabelText(/project/i), '5')
    return user
  }

  it('keeps the submit control reachable when the quantity is empty', async () => {
    const user = await fillOrder()
    await user.clear(screen.getByLabelText(/quantity/i))

    expect(screen.getByRole('button', { name: /place order/i })).toBeEnabled()
  })

  it('says what is wrong with the field rather than only refusing', async () => {
    const user = await fillOrder()
    await user.clear(screen.getByLabelText(/quantity/i))

    const field = screen.getByLabelText(/quantity/i)
    expect(field).toHaveAttribute('aria-invalid', 'true')
    expect(field).toHaveAccessibleDescription(/permitted range/i)
  })

  it('refuses the order through the same alert every other refusal uses', async () => {
    const user = await fillOrder()
    await user.clear(screen.getByLabelText(/quantity/i))
    await user.click(screen.getByRole('button', { name: /place order/i }))

    expect(await screen.findByRole('alert')).toHaveTextContent(/permitted range/i)
    expect(mockedPost).not.toHaveBeenCalled()
  })

  it('lets a valid quantity through', async () => {
    const user = await fillOrder()
    await user.clear(screen.getByLabelText(/quantity/i))
    await user.type(screen.getByLabelText(/quantity/i), '3')
    await user.click(screen.getByRole('button', { name: /place order/i }))

    await waitFor(() => expect(mockedPost).toHaveBeenCalled())
    expect((mockedPost.mock.calls[0][1] as Record<string, unknown>).quantity).toBe(3)
  })
})


/*
 * #406. The form resolved parameters before a project was chosen and never
 * again after, so a definition narrowed to one project (#275) reached every
 * project — and the defaults filled in on submit came from it.
 */
describe('OrderForm resolves parameters for the selected project (#406)', () => {
  const projects = [
    { id: 5, name: 'Webshop' },
    { id: 6, name: 'Billing' },
  ] as never

  const regionFor = (label: string, defaultValue: string) => [
    param({ id: 1, name: 'REGION', environmentId: null, label, defaultValue }),
  ]

  it('sends the project with the catalog refetch', async () => {
    const user = userEvent.setup()
    mockedGet.mockImplementation((async (path: string) =>
      path.startsWith('/api/catalog/')
        ? { ...product, parameters: regionFor('Region', 'westeurope') }
        : []) as never)

    render(<OrderForm product={product} projects={projects} costCenters={[]} />)
    await user.selectOptions(screen.getByLabelText(/environment/i), '1')
    await user.selectOptions(screen.getByLabelText(/project/i), '5')

    await waitFor(() => {
      expect(mockedGet).toHaveBeenCalledWith('/api/catalog/7?lang=en&environmentId=1&projectId=5')
    })
  })

  it('re-resolves when the project changes, not only when the environment does', async () => {
    const user = userEvent.setup()
    mockedGet.mockImplementation((async (path: string) => {
      if (!path.startsWith('/api/catalog/')) return []
      return {
        ...product,
        parameters: path.includes('projectId=6')
          ? regionFor('Region (Billing)', 'northeurope')
          : regionFor('Region (Webshop)', 'westeurope'),
      }
    }) as never)

    render(<OrderForm product={product} projects={projects} costCenters={[]} />)
    await user.selectOptions(screen.getByLabelText(/environment/i), '1')
    await user.selectOptions(screen.getByLabelText(/project/i), '5')
    expect(await screen.findByLabelText('Region (Webshop)')).toBeInTheDocument()

    // The picker moving is the whole point: before the fix `projectId` was in
    // neither the query nor the dependency array, so this second selection
    // changed nothing and the form kept Webshop's definition.
    await user.selectOptions(screen.getByLabelText(/project/i), '6')
    expect(await screen.findByLabelText('Region (Billing)')).toBeInTheDocument()
  })

  /*
   * The narrower window inside the same defect. The refetch is asynchronous, so
   * between choosing a project and its definitions arriving the form is still
   * holding the previous project's. Submitting there sent the old project's
   * defaults for the new project.
   */
  it('waits for an in-flight project change before filling in defaults', async () => {
    const user = userEvent.setup()
    let releaseBilling: (() => void) | undefined
    const billingArrived = new Promise<void>((resolve) => { releaseBilling = resolve })

    mockedGet.mockImplementation((async (path: string) => {
      if (!path.startsWith('/api/catalog/')) return []
      if (path.includes('projectId=6')) {
        // Held open, so the submit below happens while this is still in flight.
        await billingArrived
        return { ...product, parameters: regionFor('Region (Billing)', 'northeurope') }
      }
      return { ...product, parameters: regionFor('Region (Webshop)', 'westeurope') }
    }) as never)

    render(<OrderForm product={product} projects={projects} costCenters={[]} />)
    await user.selectOptions(screen.getByLabelText(/environment/i), '1')
    await user.selectOptions(screen.getByLabelText(/project/i), '5')
    expect(await screen.findByLabelText('Region (Webshop)')).toBeInTheDocument()

    await user.selectOptions(screen.getByLabelText(/project/i), '6')
    // Still showing Webshop's control: Billing's response has not been released.
    expect(screen.getByLabelText('Region (Webshop)')).toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: /place order/i }))
    expect(mockedPost).not.toHaveBeenCalled()

    releaseBilling?.()

    await waitFor(() => expect(mockedPost).toHaveBeenCalled())
    const body = mockedPost.mock.calls[0][1] as { projectId: number; parameters: Record<string, string> }
    expect(body.projectId).toBe(6)
    // The value that matters: Billing's default, not the one the form was still
    // rendering when the button was clicked.
    expect(body.parameters.REGION).toBe('northeurope')
  })
})
