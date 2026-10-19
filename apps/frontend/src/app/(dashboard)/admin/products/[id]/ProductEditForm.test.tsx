import { describe, it, expect, vi, beforeAll, beforeEach } from 'vitest'
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type { ProductDetail, Category, DeploymentEnvironment, CostCenter, SizeMatrix } from '@infrashelf/types'

// jsdom does not implement the native <dialog> methods; stub them so Modal's
// open/close effects don't throw (same stub as Modal.test.tsx).
beforeAll(() => {
  HTMLDialogElement.prototype.showModal = vi.fn(function (this: HTMLDialogElement) {
    this.open = true
  })
  HTMLDialogElement.prototype.close = vi.fn(function (this: HTMLDialogElement) {
    this.open = false
  })
})

const refresh = vi.fn()

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), refresh }),
}))

vi.mock('@/lib/api', () => ({
  get: vi.fn(),
  post: vi.fn(),
  put: vi.fn(),
  del: vi.fn(),
}))

import { ProductEditForm } from './ProductEditForm'
import { get, del, put, post } from '@/lib/api'

const mockedGet = vi.mocked(get)
const mockedDel = vi.mocked(del)
const mockedPut = vi.mocked(put)
const mockedPost = vi.mocked(post)

const LINKED_ENV = 1
const UNLINKED_ENV = 2

const environments = [
  { id: LINKED_ENV, name: 'AWS Frankfurt' },
  { id: UNLINKED_ENV, name: 'On-Premise Vienna' },
] as unknown as DeploymentEnvironment[]

const costCenters: CostCenter[] = [
  { id: 10, code: 'CC-100', name: 'Shared Platform', active: true },
  { id: 11, code: 'CC-200', name: 'Retired Account', active: false },
]

const product = {
  id: 7,
  categoryId: 1,
  baseLanguage: 'en',
  createdAt: new Date().toISOString(),
  name: 'Managed Postgres',
  description: '',
  // Only AWS Frankfurt is offered — On-Premise Vienna is listed but unlinked.
  environments: [
    { productId: 7, environmentId: LINKED_ENV, price: '12.00', currency: 'EUR', costCenterMode: 'project', forcedCostCenter: false, overheadCostCenterId: null, trialEnabled: false, trialDurationMinutes: 30 },
  ],
  parameters: [],
} as unknown as ProductDetail

const renderForm = (over?: Partial<ProductDetail>, props?: { initialSizes?: SizeMatrix }) =>
  render(
    <ProductEditForm
      product={{ ...product, ...over }}
      categories={[{ id: 1, name: 'Databases', displayOrder: 0 }] as Category[]}
      environments={environments}
      translations={[]}
      costCenters={costCenters}
      {...props}
    />,
  )

const EMPTY_MATRIX: SizeMatrix = { environments: [], rows: [] }

/**
 * The GETs this form fires on mount, answered by path.
 *
 * A blanket `[]` was enough while every one of them returned a list. The size
 * matrix (#249) returns an OBJECT, and `[]` left `matrix.environments` undefined,
 * which crashed the whole form — so the stub answers per endpoint and callers
 * override only the path they are testing.
 */
const stubGet = (over: Record<string, unknown> = {}) =>
  mockedGet.mockReset().mockImplementation((async (path: string) => {
    if (path in over) return over[path]
    if (path.endsWith('/sizes')) return EMPTY_MATRIX
    // Pipeline stacks and webhooks.
    return []
  }) as never)

beforeEach(() => {
  refresh.mockReset()
  mockedDel.mockReset().mockResolvedValue(undefined as never)
  mockedPut.mockReset().mockResolvedValue(undefined as never)
  // Reset only. A blanket resolved value here reaches the translation save too,
  // which does `setTranslations(created)` and turns an array into an object.
  mockedPost.mockReset()
  stubGet()
})

describe('ProductEditForm environment removal', () => {
  it('offers Remove only for environments the product is actually linked to', () => {
    renderForm()

    // One Remove button, and it belongs to the linked environment's row. The
    // row is identified by its own heading — the environment names also appear
    // in the webhook/stack modals' environment <select>s.
    const removeButtons = screen.getAllByRole('button', { name: 'Remove' })
    expect(removeButtons).toHaveLength(1)
    const row = removeButtons[0].closest('form')
    if (!row) throw new Error('environment row not found')
    expect(within(row).getByRole('heading', { name: 'AWS Frankfurt' })).toBeInTheDocument()
  })

  it('deletes the offering and refreshes once confirmed', async () => {
    const user = userEvent.setup()
    renderForm()

    await user.click(screen.getByRole('button', { name: 'Remove' }))
    // Nothing is sent from opening the dialog alone.
    expect(mockedDel).not.toHaveBeenCalled()

    const dialog = await screen.findByRole('dialog', { name: /Remove AWS Frankfurt\?/ })
    await user.click(within(dialog).getByRole('button', { name: 'Remove' }))

    await waitFor(() => {
      expect(mockedDel).toHaveBeenCalledWith(
        `/api/admin/products/7/environments/${LINKED_ENV}`,
      )
    })
    expect(refresh).toHaveBeenCalled()
  })

  it('sends nothing when the confirmation is cancelled', async () => {
    const user = userEvent.setup()
    renderForm()

    await user.click(screen.getByRole('button', { name: 'Remove' }))
    const dialog = await screen.findByRole('dialog', { name: /Remove AWS Frankfurt\?/ })
    await user.click(within(dialog).getByRole('button', { name: 'Cancel' }))

    expect(mockedDel).not.toHaveBeenCalled()
    expect(refresh).not.toHaveBeenCalled()
  })

  it('surfaces the backend refusal and keeps the dialog open', async () => {
    const user = userEvent.setup()
    mockedDel.mockRejectedValue(
      new Error('Infrastructure is still deployed in this environment — decommission it first'),
    )
    renderForm()

    await user.click(screen.getByRole('button', { name: 'Remove' }))
    const dialog = await screen.findByRole('dialog', { name: /Remove AWS Frankfurt\?/ })
    await user.click(within(dialog).getByRole('button', { name: 'Remove' }))

    expect(await screen.findByRole('alert')).toHaveTextContent(/decommission it first/)
    // Still open, so the operator sees the reason next to the action that failed.
    expect(screen.getByRole('dialog', { name: /Remove AWS Frankfurt\?/ })).toBeInTheDocument()
    expect(refresh).not.toHaveBeenCalled()
  })
})

describe('ProductEditForm overhead cost centre', () => {
  const overheadProduct = (overheadCostCenterId: number | null, forcedCostCenter = false) => ({
    environments: [
      {
        productId: 7,
        environmentId: LINKED_ENV,
        price: '12.00',
        currency: 'EUR',
        costCenterMode: 'overhead',
        forcedCostCenter,
        overheadCostCenterId,
      },
    ],
  } as unknown as Partial<ProductDetail>)

  const envRow = () => {
    const row = screen.getAllByRole('button', { name: 'Remove' })[0].closest('form')
    if (!row) throw new Error('environment row not found')
    return row
  }

  it('hides the overhead picker for modes that do not use it', () => {
    renderForm() // 'project' mode
    expect(screen.queryByLabelText(/overhead cost center/i)).not.toBeInTheDocument()
  })

  it('shows the picker when the mode is switched to overhead', async () => {
    const user = userEvent.setup()
    renderForm()

    await user.selectOptions(within(envRow()).getByLabelText(/cost center mode/i), 'overhead')
    expect(await screen.findByLabelText(/overhead cost center/i)).toBeInTheDocument()
  })

  it('preselects the stored account and offers only active ones', () => {
    renderForm(overheadProduct(10))

    const picker = screen.getByLabelText(/overhead cost center/i)
    expect(picker).toHaveValue('10')
    expect(within(picker).getByRole('option', { name: /CC-100/ })).toBeInTheDocument()
    // The inactive account is not offered — ordering would reject it anyway.
    expect(within(picker).queryByRole('option', { name: /CC-200/ })).not.toBeInTheDocument()
  })

  it('still offers an already-stored account that has since been deactivated', () => {
    // Otherwise the picker would silently show a blank selection and a Save
    // would clear the configuration the operator never touched.
    renderForm(overheadProduct(11))

    const picker = screen.getByLabelText(/overhead cost center/i)
    expect(picker).toHaveValue('11')
    expect(within(picker).getByRole('option', { name: /CC-200 — Retired Account \(inactive\)/ })).toBeInTheDocument()
  })

  it('warns that a forced overhead offering rejects orders until an account is chosen', () => {
    renderForm(overheadProduct(null, true))
    expect(screen.getByText(/orders in this environment are rejected/i)).toBeInTheDocument()
  })

  it('saves the chosen account, and clears it when the mode moves away from overhead', async () => {
    const user = userEvent.setup()
    mockedPut.mockReset().mockResolvedValue(undefined as never)
    renderForm(overheadProduct(null))

    const row = envRow()
    await user.selectOptions(screen.getByLabelText(/overhead cost center/i), '10')
    await user.click(within(row).getByRole('button', { name: 'Save' }))

    await waitFor(() => expect(mockedPut).toHaveBeenCalled())
    expect(mockedPut.mock.calls[0][1]).toMatchObject({
      costCenterMode: 'overhead',
      overheadCostCenterId: 10,
    })

    // Switching to a mode that never uses the account must not leave it stored,
    // or flipping back to overhead would silently resurrect it.
    await user.selectOptions(within(row).getByLabelText(/cost center mode/i), 'select')
    await user.click(within(row).getByRole('button', { name: 'Save' }))

    await waitFor(() => expect(mockedPut).toHaveBeenCalledTimes(2))
    expect(mockedPut.mock.calls[1][1]).toMatchObject({
      costCenterMode: 'select',
      overheadCostCenterId: null,
    })
  })
})

// Issue #1. Trials are opt-in per offering, so the duration field only appears
// once the offering has actually been opted in.
describe('ProductEditForm trial configuration', () => {
  const envRow = () => {
    const row = screen.getAllByRole('button', { name: 'Remove' })[0].closest('form')
    if (!row) throw new Error('environment row not found')
    return row
  }

  const trialProduct = (trialEnabled: boolean, trialDurationMinutes = 30) => ({
    environments: [
      {
        productId: 7,
        environmentId: LINKED_ENV,
        price: '12.00',
        currency: 'EUR',
        costCenterMode: 'project',
        forcedCostCenter: false,
        overheadCostCenterId: null,
        trialEnabled,
        trialDurationMinutes,
      },
    ],
  } as unknown as Partial<ProductDetail>)

  it('hides the duration field until the offering is opted in', async () => {
    const user = userEvent.setup()
    renderForm()
    expect(screen.queryByLabelText(/trial duration/i)).not.toBeInTheDocument()

    await user.click(within(envRow()).getByLabelText(/offer as trial/i))
    expect(await screen.findByLabelText(/trial duration/i)).toBeInTheDocument()
  })

  it('prefills the stored flag and duration', () => {
    renderForm(trialProduct(true, 120))
    expect(within(envRow()).getByLabelText(/offer as trial/i)).toBeChecked()
    expect(screen.getByLabelText(/trial duration/i)).toHaveValue(120)
  })

  it('saves the flag and duration', async () => {
    const user = userEvent.setup()
    mockedPut.mockReset().mockResolvedValue(undefined as never)
    renderForm(trialProduct(true, 30))

    const row = envRow()
    await user.clear(screen.getByLabelText(/trial duration/i))
    await user.type(screen.getByLabelText(/trial duration/i), '45')
    await user.click(within(row).getByRole('button', { name: 'Save' }))

    await waitFor(() => expect(mockedPut).toHaveBeenCalled())
    expect(mockedPut.mock.calls[0][1]).toMatchObject({ trialEnabled: true, trialDurationMinutes: 45 })
  })

  it('falls back to 30 rather than sending a cleared duration', async () => {
    // The server rejects a non-positive duration, which would surface as a
    // confusing save error on a field the operator may not have meant to empty.
    const user = userEvent.setup()
    mockedPut.mockReset().mockResolvedValue(undefined as never)
    renderForm(trialProduct(true, 30))

    const row = envRow()
    await user.clear(screen.getByLabelText(/trial duration/i))
    await user.click(within(row).getByRole('button', { name: 'Save' }))

    await waitFor(() => expect(mockedPut).toHaveBeenCalled())
    expect(mockedPut.mock.calls[0][1]).toMatchObject({ trialDurationMinutes: 30 })
  })
})

describe('ProductEditForm order callbacks', () => {
  const webhook = {
    id: 1,
    productId: 7,
    environmentId: LINKED_ENV,
    name: 'Ticketing webhook',
    webhookUrl: 'https://example.com/hook',
    execOrder: 0,
  }

  it('loads the existing callbacks on mount, same as the pipeline stacks list', async () => {
    // Before the fix, `webhooks` was only ever written by add/delete — the
    // GET this endpoint exists for was never called, so a reload made every
    // existing callback invisible and its Delete button unreachable (#145).
    stubGet({ '/api/admin/products/7/webhooks': [webhook] })

    renderForm()

    expect(await screen.findByText('Ticketing webhook')).toBeInTheDocument()
    expect(screen.getByText('https://example.com/hook')).toBeInTheDocument()
    expect(screen.queryByText('No callbacks configured.')).not.toBeInTheDocument()
    expect(mockedGet).toHaveBeenCalledWith('/api/admin/products/7/webhooks')
  })

  it('makes the loaded callback deletable', async () => {
    stubGet({ '/api/admin/products/7/webhooks': [webhook] })
    const user = userEvent.setup()
    renderForm()

    const card = (await screen.findByText('Ticketing webhook')).closest('div')?.parentElement
    if (!card) throw new Error('webhook row not found')
    await user.click(within(card).getByRole('button', { name: 'Delete' }))

    await waitFor(() => expect(mockedDel).toHaveBeenCalledWith('/api/admin/products/7/webhooks/1'))
    await waitFor(() => expect(screen.queryByText('Ticketing webhook')).not.toBeInTheDocument())
  })
})

describe('ProductEditForm translations', () => {
  const german = {
    productId: 7,
    languageCode: 'de',
    name: 'Verwaltetes Postgres',
    description: 'Eine betreute Datenbank.',
    longDescription: 'Die lange Fassung, von Hand geschrieben.',
  }

  const formWith = (translations: typeof german[]) => (
    <ProductEditForm
      product={product}
      categories={[{ id: 1, name: 'Databases', displayOrder: 0 }] as Category[]}
      environments={environments}
      translations={translations}
      costCenters={costCenters}
     
    />
  )

  const renderWithTranslations = (translations = [german]) => render(formWith(translations))

  // Modal renders its children whether or not it is open, and "Name" and "Save"
  // label something in four other forms on this page — so every query here is
  // scoped to the translation dialog, anchored on the one field only it has.
  const dialog = () => {
    const box = screen.getByLabelText(/^long description/i)
    const found = box.closest('dialog')
    if (!found) throw new Error('translation modal not found')
    return found as HTMLElement
  }
  const longDesc = () => within(dialog()).getByLabelText(/^long description/i)
  // "Name *" in the DOM: Input appends a required marker inside the label.
  const name = () => within(dialog()).getByLabelText(/^name/i)
  const openModal = (user: ReturnType<typeof userEvent.setup>) =>
    user.click(screen.getByRole('button', { name: 'Add Translation' }))
  const save = (user: ReturnType<typeof userEvent.setup>) =>
    user.click(within(dialog()).getByRole('button', { name: 'Save' }))

  beforeEach(() => {
    mockedPut.mockReset().mockResolvedValue(undefined as never)
  })

  it('loads an existing translation into the modal instead of opening blank', async () => {
    const user = userEvent.setup()
    renderWithTranslations()

    await openModal(user)

    expect(name()).toHaveValue(german.name)
    expect(within(dialog()).getByLabelText(/^description/i)).toHaveValue(german.description)
    expect(longDesc()).toHaveValue(german.longDescription)
  })

  it('keeps the long description when a translation is re-saved without touching it', async () => {
    // The erasure this covers: the modal opened blank, this form always sends
    // longDescription, so fixing a typo in the name wiped the prose the product
    // page shows.
    const user = userEvent.setup()
    renderWithTranslations()

    await openModal(user)
    await user.clear(name())
    await user.type(name(), 'Verwaltete Postgres')
    await save(user)

    await waitFor(() => expect(mockedPut).toHaveBeenCalled())
    expect(mockedPut.mock.calls[0][1]).toMatchObject({
      name: 'Verwaltete Postgres',
      longDescription: german.longDescription,
    })
  })

  it('opens blank for a language that has no translation yet', async () => {
    const user = userEvent.setup()
    renderWithTranslations([])

    await openModal(user)

    expect(name()).toHaveValue('')
    expect(longDesc()).toHaveValue('')
  })

  it('re-points every field when the language is switched', async () => {
    const user = userEvent.setup()
    renderWithTranslations()

    await openModal(user)
    await user.selectOptions(within(dialog()).getByLabelText('Language'), 'fr')

    // French has nothing stored, so the German text must not be left behind for
    // the save to write under the wrong language.
    expect(name()).toHaveValue('')
    expect(longDesc()).toHaveValue('')

    await user.selectOptions(within(dialog()).getByLabelText('Language'), 'de')
    expect(longDesc()).toHaveValue(german.longDescription)
  })

  it('follows the server list after an AI run rather than saving over it', async () => {
    // handleAiTranslate calls router.refresh(), which hands this component new
    // props but leaves useState holding the pre-run list. A re-render with a new
    // prop stands in for that refresh here: the modal has to show what the AI
    // wrote, because the form always sends longDescription and would otherwise
    // save a blank over it.
    const user = userEvent.setup()
    const { rerender } = renderWithTranslations([])

    rerender(formWith([german]))
    await openModal(user)

    expect(name()).toHaveValue(german.name)
    expect(longDesc()).toHaveValue(german.longDescription)

    await save(user)
    await waitFor(() => expect(mockedPut).toHaveBeenCalled())
    expect(mockedPut.mock.calls[0][1]).toMatchObject({ longDescription: german.longDescription })
  })

  it('still sends an edited long description', async () => {
    const user = userEvent.setup()
    renderWithTranslations()

    await openModal(user)
    await user.clear(longDesc())
    await user.type(longDesc(), 'Eine neue Fassung.')
    await save(user)

    await waitFor(() => expect(mockedPut).toHaveBeenCalled())
    expect(mockedPut.mock.calls[0][1]).toMatchObject({ longDescription: 'Eine neue Fassung.' })
  })
})

/**
 * The size matrix (#249).
 *
 * The editor this replaced was scoped to one offering, so what a size cost across
 * environments — the comparison a per-environment price exists FOR — could not be
 * seen at all, and pricing S/M/L/XL in four environments was sixteen separate
 * saves. These pin the two promises that replaces it with: a row reads across, and
 * a row saves across.
 */
describe('ProductEditForm size matrix', () => {
  const MATRIX: SizeMatrix = {
    environments: [
      { environmentId: LINKED_ENV, name: 'AWS Frankfurt', currency: 'EUR' },
      { environmentId: UNLINKED_ENV, name: 'On-Premise Vienna', currency: 'CHF' },
    ],
    rows: [
      {
        code: 'XL',
        label: 'Extra large',
        sortOrder: 1,
        cells: [
          { environmentId: LINKED_ENV, id: 11, price: '40.00', currency: 'EUR', active: true },
          { environmentId: UNLINKED_ENV, id: 12, price: '100.00', currency: 'CHF', active: true },
        ],
      },
    ],
  }

  const withMatrix = (matrix: SizeMatrix) => stubGet({ '/api/admin/products/7/sizes': matrix })

  it('shows what one size costs in every environment on a single row', async () => {
    withMatrix(MATRIX)
    renderForm()

    // Both prices are reachable from the row's own code, which is the whole point:
    // "what does XL cost where" used to mean opening one editor per environment.
    expect(await screen.findByLabelText('XL — AWS Frankfurt — Price')).toHaveValue('40.00')
    expect(screen.getByLabelText('XL — On-Premise Vienna — Price')).toHaveValue('100.00')
    // And not flattened onto one currency: the same size in two environments is
    // two prices, in whatever the environment bills in.
    expect(screen.getByLabelText('XL — AWS Frankfurt — Currency')).toHaveValue('EUR')
    expect(screen.getByLabelText('XL — On-Premise Vienna — Currency')).toHaveValue('CHF')
  })

  it('prices a new size in every environment in one request', async () => {
    withMatrix({ environments: MATRIX.environments, rows: [] })
    renderForm()

    // fireEvent, not userEvent: this form re-renders whole on every keystroke, and
    // typing four fields a character at a time runs past the 5s test budget.
    fireEvent.change(await screen.findByLabelText('Code'), { target: { value: 'S' } })
    fireEvent.change(screen.getByLabelText('Label'), { target: { value: 'Small' } })
    fireEvent.change(screen.getByLabelText('Add / update size — AWS Frankfurt — Price'), { target: { value: '10.00' } })
    fireEvent.change(screen.getByLabelText('Add / update size — On-Premise Vienna — Price'), { target: { value: '25.00' } })
    fireEvent.click(screen.getByRole('button', { name: 'Add / update size' }))

    // One PUT carrying both cells, not one request per environment: a bulk edit
    // applied a cell at a time can leave half a price list behind.
    await waitFor(() => expect(mockedPut).toHaveBeenCalledTimes(1))
    expect(mockedPut).toHaveBeenCalledWith('/api/admin/products/7/sizes/S', {
      label: 'Small',
      sortOrder: 1,
      cells: [
        { environmentId: LINKED_ENV, price: '10.00', currency: 'EUR' },
        { environmentId: UNLINKED_ENV, price: '25.00', currency: 'CHF' },
      ],
    })
  })

  it('retires the cell it is asked to clear instead of deleting the size', async () => {
    withMatrix(MATRIX)
    renderForm()

    const vienna = await screen.findByLabelText('XL — On-Premise Vienna — Price')
    fireEvent.change(vienna, { target: { value: '' } })
    // Scoped to the row: the page's own "Save" belongs to the basic-information
    // form, and clicking that one would have proved nothing about the grid.
    const row = vienna.closest('tr')
    if (!row) throw new Error('the XL row was not found')
    fireEvent.click(within(row).getByRole('button', { name: 'Save' }))

    await waitFor(() => expect(mockedPut).toHaveBeenCalledTimes(1))
    // Vienna is simply absent from the body — that is what tells the server to
    // retire it. Sending a deletion instead would break the orders that name it.
    expect(mockedPut).toHaveBeenCalledWith('/api/admin/products/7/sizes/XL', {
      label: 'Extra large',
      sortOrder: 1,
      cells: [{ environmentId: LINKED_ENV, price: '40.00', currency: 'EUR' }],
    })
    expect(mockedDel).not.toHaveBeenCalled()
  })

  it('loads a retired cell empty, and still says what it was priced at', async () => {
    withMatrix({
      environments: MATRIX.environments,
      rows: [{
        ...MATRIX.rows[0],
        cells: [
          { environmentId: LINKED_ENV, id: 11, price: '40.00', currency: 'EUR', active: true },
          { environmentId: UNLINKED_ENV, id: 12, price: '100.00', currency: 'CHF', active: false },
        ],
      }],
    })
    renderForm()

    // Empty is what "not offered here" looks like in every other cell, so a
    // retired one has to look the same — otherwise re-saving the row silently
    // puts the size back on sale.
    expect(await screen.findByLabelText('XL — On-Premise Vienna — Price')).toHaveValue('')
    // The price it was struck at is still on screen: it is what the orders placed
    // while it was active were charged.
    expect(screen.getByText('retired · 100.00 CHF')).toBeInTheDocument()
  })

  /*
   * #473. The page reads the grid now, so the first paint has it — an editor
   * that asks on mount shows an empty grid while it waits, and an empty grid on
   * this screen is a claim that nothing is priced.
   */
  it('renders the grid the page read, without asking for it again', async () => {
    renderForm(undefined, { initialSizes: MATRIX })

    expect(screen.getByLabelText('XL — AWS Frankfurt — Price')).toHaveValue('40.00')
    // Synchronously, not after a round trip: no `find*` above, and nothing asked.
    await waitFor(() => expect(mockedGet).toHaveBeenCalled())
    expect(mockedGet.mock.calls.map((c) => String(c[0]))).not.toContain('/api/admin/products/7/sizes')
  })

  it('retries on its own when the page could not read the grid', async () => {
    // `undefined` is not the same answer as a matrix with no rows: it means the
    // server's read failed, and the editor says so rather than showing a product
    // that is priced as a product that is not.
    withMatrix(MATRIX)
    renderForm()

    expect(await screen.findByLabelText('XL — AWS Frankfurt — Price')).toHaveValue('40.00')
  })

  it('reports its own failure rather than showing an unpriced product', async () => {
    mockedGet.mockReset().mockImplementation((async (path: string) => {
      if (path.endsWith('/sizes')) throw new Error('503 Service Unavailable')
      return []
    }) as never)

    renderForm()

    expect(await screen.findByText('503 Service Unavailable')).toBeInTheDocument()
  })

  it('redraws the columns when an offering is withdrawn', async () => {
    // The columns ARE the offerings, so a withdrawal has to redraw the grid even
    // though the page handed one in — otherwise the withdrawn environment keeps
    // a column whose saves would 404. This is the case the server cannot answer:
    // it happened after the page rendered.
    const user = userEvent.setup()
    stubGet({ '/api/admin/products/7/sizes': { environments: [MATRIX.environments[0]], rows: MATRIX.rows } })
    renderForm(undefined, { initialSizes: MATRIX })

    expect(screen.getByLabelText('XL — On-Premise Vienna — Price')).toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: 'Remove' }))
    const dialog = await screen.findByRole('dialog', { name: /Remove AWS Frankfurt\?/ })
    await user.click(within(dialog).getByRole('button', { name: 'Remove' }))

    await waitFor(() =>
      expect(screen.queryByLabelText('XL — On-Premise Vienna — Price')).not.toBeInTheDocument(),
    )
  })

  it('says a size needs an offering before it can be priced', async () => {
    withMatrix(EMPTY_MATRIX)
    renderForm()

    expect(
      await screen.findByText('Offer this product in at least one environment below first: a size is priced per environment.'),
    ).toBeInTheDocument()
  })
})

/*
 * The product page and the global parameters admin are two editors for one
 * thing, and they disagreed: this one wrote its four type options out by hand,
 * so `size` — added to `ParameterType` — never appeared here (#313). Reported
 * by an operator who could not pick T-shirt size while editing a parameter.
 */
describe('ProductEditForm parameter types', () => {
  /*
   * Scoped to the dialog, and not by accident: the page behind it has its own
   * Save and its own Add Translation, so an unscoped `/^(add|save)/` matches
   * three buttons and the failure names the count rather than the problem.
   */
  const openParameterForm = async () => {
    renderForm()
    await userEvent.click(await screen.findByRole('button', { name: /add parameter/i }))
    return within(await screen.findByRole('dialog'))
  }

  it('offers every parameter type, T-shirt size included', async () => {
    const dialog = await openParameterForm()

    const select = dialog.getByLabelText(/^type$/i)
    const offered = within(select).getAllByRole('option').map((o) => (o as HTMLOptionElement).value)

    // Every member of ParameterType, not a list repeated from the source: the
    // bug was exactly a list that agreed with itself and with nothing else.
    expect(offered).toEqual(['string', 'number', 'bool', 'dropdown', 'size'])
  })

  it('asks for a value per size once the type is size, and sends them', async () => {
    mockedPost.mockResolvedValue({ id: 1, type: 'size' } as never)
    const dialog = await openParameterForm()

    // Nothing to fill in until the type calls for it.
    expect(dialog.queryByLabelText(/value per size/i)).not.toBeInTheDocument()

    await userEvent.selectOptions(dialog.getByLabelText(/^type$/i), 'size')
    await userEvent.type(dialog.getByLabelText(/variable name/i), 'instance_type')
    await userEvent.type(dialog.getByLabelText(/value per size/i), 'S=t3.micro\nXL=m6i.2xlarge')
    await userEvent.click(dialog.getByRole('button', { name: /^(add|save)$/i }))

    await waitFor(() => expect(mockedPost).toHaveBeenCalled())
    const [, body] = mockedPost.mock.calls[0] as [string, { type: string; sizeValues: Record<string, string> }]
    expect(body.type).toBe('size')
    expect(body.sizeValues).toEqual({ S: 't3.micro', XL: 'm6i.2xlarge' })
  })
})

describe('ProductEditForm pipeline stacks', () => {
  /**
   * The interleaving that duplicated a row in CI (#384), driven directly.
   *
   * Both requests are deferred so the test decides the order: the create is
   * submitted first, then the MOUNT FETCH resolves with a list that already
   * contains the new stack — which is what the server returns once the insert
   * has committed — and only then does the POST resolve. A plain
   * `[...prev, created]` appends to a list that already has the record and the
   * stack is drawn twice, sharing a React key.
   *
   * Deferred rather than ordered by timers: the race is between two microtask
   * continuations, and a delay long enough to be reliable would also be long
   * enough to hide the bug on a slow machine.
   */
  it('draws a created stack once when the mount fetch lands mid-create', async () => {
    const user = userEvent.setup()

    const created = {
      id: 3,
      productId: 7,
      environmentId: LINKED_ENV,
      name: 'Payments VM',
      stateKeyParam: 'hostname',
      steps: [{ template: 'linode/virtual-machine', stateSuffix: '-vm', execOrder: 0 }],
    }

    let resolveList: (stacks: unknown) => void = () => {}
    const pendingList = new Promise((resolve) => { resolveList = resolve })
    stubGet({ '/api/admin/products/7/pipeline-stacks': pendingList })

    let resolveCreate: (stack: unknown) => void = () => {}
    mockedPost.mockImplementation((() => new Promise((resolve) => { resolveCreate = resolve })) as never)

    renderForm()

    await user.click(screen.getByRole('button', { name: 'Add Stack' }))
    const dialog = await screen.findByRole('dialog', { name: 'Add Pipeline Stack' })

    await user.type(within(dialog).getByLabelText(/^Name/), created.name)
    await user.selectOptions(within(dialog).getByLabelText(/^Environment/), String(LINKED_ENV))
    await user.click(within(dialog).getByRole('button', { name: '+ Add Step' }))
    await user.type(within(dialog).getByLabelText(/^Template/), created.steps[0].template)
    await user.type(within(dialog).getByLabelText(/^State Suffix/), created.steps[0].stateSuffix)

    await user.click(within(dialog).getByRole('button', { name: 'Add' }))
    await waitFor(() => expect(mockedPost).toHaveBeenCalledWith(
      '/api/admin/products/7/pipeline-stacks',
      expect.objectContaining({ name: created.name, environmentId: LINKED_ENV }),
    ))

    // The mount fetch is served after the insert committed, so it already
    // carries the new stack — and its `.then` replaces the list.
    resolveList([created])
    await waitFor(() => expect(screen.getAllByTestId('stack-item')).toHaveLength(1))

    // Only now does the create resolve and the handler put its record in.
    resolveCreate(created)

    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Add Pipeline Stack' })).not.toBeInTheDocument())
    expect(screen.getAllByTestId('stack-item')).toHaveLength(1)
    expect(screen.getAllByText(created.name)).toHaveLength(1)
  })

  it('appends a created stack that the list does not already carry', async () => {
    const user = userEvent.setup()

    const existing = {
      id: 1, productId: 7, environmentId: LINKED_ENV, name: 'Gateway VM',
      stateKeyParam: 'hostname', steps: [{ template: 'linode/virtual-machine', stateSuffix: '-gw', execOrder: 0 }],
    }
    const created = { ...existing, id: 2, name: 'Payments VM' }

    stubGet({ '/api/admin/products/7/pipeline-stacks': [existing] })
    mockedPost.mockResolvedValue(created as never)

    renderForm()
    await waitFor(() => expect(screen.getAllByTestId('stack-item')).toHaveLength(1))

    await user.click(screen.getByRole('button', { name: 'Add Stack' }))
    const dialog = await screen.findByRole('dialog', { name: 'Add Pipeline Stack' })
    await user.type(within(dialog).getByLabelText(/^Name/), created.name)
    await user.selectOptions(within(dialog).getByLabelText(/^Environment/), String(LINKED_ENV))
    await user.click(within(dialog).getByRole('button', { name: '+ Add Step' }))
    await user.type(within(dialog).getByLabelText(/^Template/), 'linode/virtual-machine')
    await user.type(within(dialog).getByLabelText(/^State Suffix/), '-vm')
    await user.click(within(dialog).getByRole('button', { name: 'Add' }))

    await waitFor(() => expect(screen.getAllByTestId('stack-item')).toHaveLength(2))
    expect(screen.getByText('Gateway VM')).toBeInTheDocument()
    expect(screen.getByText('Payments VM')).toBeInTheDocument()
  })
})
