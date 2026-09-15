import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, waitFor, fireEvent } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type { Branding } from '@infrashelf/types'
import { BrandingForm } from './BrandingForm'

vi.mock('@/lib/api', () => ({ put: vi.fn(), apiRequest: vi.fn() }))
import { put, apiRequest } from '@/lib/api'

const toast = vi.fn()
vi.mock('@/components/ui/Toast', () => ({ useToast: () => ({ toast }) }))

const refresh = vi.fn()
vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh }) }))

const branding = (over: Partial<Branding> = {}): Branding =>
  ({
    shopName: 'InfraShelf',
    shopSubtitle: 'Infrastructure, off the shelf',
    primaryColor: '#131921',
    secondaryColor: '#febd69',
    imprintText: 'Acme GmbH',
    ...over,
  }) as Branding

const hexField = (which: 'Primary' | 'Secondary') =>
  screen.getByLabelText(`${which} Color — hex value`)
const save = () => screen.getByRole('button', { name: 'Save Branding' })

beforeEach(() => {
  toast.mockReset()
  refresh.mockReset()
  vi.mocked(put).mockReset().mockResolvedValue(undefined as never)
  vi.mocked(apiRequest).mockReset().mockResolvedValue(undefined as never)
})

/**
 * The readout under each colour is the point of this screen (#185, and the AAA
 * decision recorded in the component): the portal chrome is painted on these
 * two colours, and nothing else tells the operator that a mid-tone choice makes
 * the header unreadable.
 */
describe('BrandingForm', () => {
  it('starts from the stored branding', () => {
    render(<BrandingForm initial={branding()} />)

    expect(screen.getByLabelText(/^Shop Name/)).toHaveValue('InfraShelf')
    expect(screen.getByLabelText(/^Subtitle/)).toHaveValue('Infrastructure, off the shelf')
    expect(hexField('Primary')).toHaveValue('#131921')
    expect(hexField('Secondary')).toHaveValue('#febd69')
  })

  it('gives the picker and the hex box separate names', () => {
    // Both edit the same value, so one shared label left them anonymous — a
    // screen-reader user could not tell which control they had landed on.
    render(<BrandingForm initial={branding()} />)

    expect(screen.getByLabelText('Primary Color — colour picker')).toHaveAttribute('type', 'color')
    expect(hexField('Primary')).toHaveAttribute('type', 'text')
  })

  it('says a dark colour meets AA and AAA', () => {
    // Both defaults clear AAA — the dark navy and the light amber alike, since
    // `readableInk` picks whichever of black or white reads better on each.
    render(<BrandingForm initial={branding()} />)
    expect(screen.getAllByText(/meets WCAG AA and AAA/)).toHaveLength(2)
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
  })

  it('warns, and raises an alert, when a colour fails AA', async () => {
    // The whole guard rail. Not a blocker — a brand colour is sometimes a
    // requirement the operator cannot override — but it must interrupt, or the
    // header ships unreadable and nobody was told.
    render(<BrandingForm initial={branding()} />)

    fireEvent.change(hexField('Primary'), { target: { value: '#808080' } })

    const alert = await screen.findByRole('alert')
    expect(alert).toHaveTextContent('does not meet WCAG AA')
    expect(alert).toHaveTextContent('AA requires 4.5:1')
  })

  it('reports AA without raising an alert when AA passes but AAA does not', async () => {
    // AA is the level this app conforms to; AAA is information, not a blocker,
    // so it must not interrupt.
    render(<BrandingForm initial={branding({ primaryColor: '#767676' })} />)

    expect(screen.getByText(/meets WCAG AA\./)).toBeInTheDocument()
    expect(screen.getByText(/AAA requires 7:1/)).toBeInTheDocument()
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
  })

  it('says so when the hex is not a colour, instead of scoring it', async () => {
    render(<BrandingForm initial={branding()} />)

    fireEvent.change(hexField('Primary'), { target: { value: 'not-a-colour' } })

    expect(await screen.findByRole('alert')).toHaveTextContent('Not a valid hex colour')
    expect(hexField('Primary')).toHaveAttribute('aria-invalid', 'true')
    // And no contrast figure, which would be an invented number.
    expect(screen.queryByText(/4\.5:1/)).not.toBeInTheDocument()
  })

  it('feeds the picker a canonical colour whatever was typed', async () => {
    // `<input type="color">` accepts only lowercase #rrggbb, and silently shows
    // black for anything else — so a valid #ABC has to be normalised first.
    render(<BrandingForm initial={branding()} />)

    fireEvent.change(hexField('Primary'), { target: { value: '#ABC' } })
    expect(screen.getByLabelText('Primary Color — colour picker')).toHaveValue('#aabbcc')

    fireEvent.change(hexField('Primary'), { target: { value: 'nonsense' } })
    expect(screen.getByLabelText('Primary Color — colour picker')).toHaveValue('#000000')
  })

  it('scores the two colours independently', async () => {
    // One failing colour must not mark the other, or the operator cannot tell
    // which one to change.
    render(<BrandingForm initial={branding({ primaryColor: '#131921', secondaryColor: '#808080' })} />)

    expect(screen.getAllByRole('alert')).toHaveLength(1)
    expect(screen.getByText(/meets WCAG AA and AAA/)).toBeInTheDocument()
  })

  it('saves the text fields trimmed, and the colours as typed', async () => {
    const u = userEvent.setup()
    render(<BrandingForm initial={branding()} />)

    fireEvent.change(screen.getByLabelText(/^Shop Name/), { target: { value: '  Acme Cloud  ' } })
    fireEvent.change(screen.getByLabelText(/^Subtitle/), { target: { value: '  on tap  ' } })
    await u.click(save())

    await waitFor(() =>
      expect(put).toHaveBeenCalledWith('/api/admin/branding', {
        shopName: 'Acme Cloud',
        shopSubtitle: 'on tap',
        // Not trimmed — a hex has no whitespace to lose and `parseHex` is what
        // decides whether it is a colour at all.
        primaryColor: '#131921',
        secondaryColor: '#febd69',
        imprintText: 'Acme GmbH',
      }),
    )
  })

  it('trims the imprint, which is a textarea and so really is trimmed here', async () => {
    // Unlike the email and url fields elsewhere, a <textarea> is not sanitised
    // by the platform — so this assertion actually tests the component.
    const u = userEvent.setup()
    render(<BrandingForm initial={branding()} />)

    fireEvent.change(screen.getByLabelText('Imprint Text'), { target: { value: '  Acme GmbH, Vienna  ' } })
    await u.click(save())

    await waitFor(() =>
      expect(put).toHaveBeenCalledWith('/api/admin/branding', expect.objectContaining({
        imprintText: 'Acme GmbH, Vienna',
      })),
    )
  })

  it('names the section and explains what each colour paints', () => {
    // The hints are the only thing that says WHERE a colour lands, which is what
    // makes the contrast readout beside them actionable.
    render(<BrandingForm initial={branding()} />)

    expect(screen.getByRole('heading', { name: 'Branding Settings' })).toBeInTheDocument()
    expect(screen.getByText('Header, navigation and footer background.')).toBeInTheDocument()
    expect(screen.getByText('Buttons and highlights.')).toBeInTheDocument()
    expect(screen.getByText('PNG or SVG, shown in the header.')).toBeInTheDocument()
  })

  it('points both controls of a colour at that colour’s hint', () => {
    // Two inputs, one hint. Without the shared `aria-describedby` the picker is
    // announced with no indication of what it paints.
    render(<BrandingForm initial={branding()} />)

    const hint = screen.getByText('Header, navigation and footer background.')
    expect(hint.id).not.toBe('')
    expect(screen.getByLabelText('Primary Color — colour picker')).toHaveAttribute('aria-describedby', hint.id)
    expect(hexField('Primary')).toHaveAttribute('aria-describedby', hint.id)
  })

  it('marks only an unparseable colour as invalid', () => {
    render(<BrandingForm initial={branding()} />)
    expect(hexField('Primary')).not.toHaveAttribute('aria-invalid')
  })

  it('shows a preview of the chosen logo, with a name for it', async () => {
    const u = userEvent.setup()
    render(<BrandingForm initial={branding()} />)
    expect(screen.queryByRole('img')).not.toBeInTheDocument()

    await u.upload(screen.getByLabelText(/^Logo/), new File(['png'], 'logo.png', { type: 'image/png' }))

    const preview = await screen.findByRole('img', { name: 'Logo preview' })
    expect(preview).toHaveAttribute('src', expect.stringContaining('data:'))
  })

  it('does nothing when the file picker is cancelled', async () => {
    // A cancelled picker fires `change` with an empty list. Reading [0] off it
    // and carrying on would upload `undefined` as the logo.
    const u = userEvent.setup()
    render(<BrandingForm initial={branding()} />)

    fireEvent.change(screen.getByLabelText(/^Logo/), { target: { files: [] } })
    await u.click(save())

    await waitFor(() => expect(put).toHaveBeenCalled())
    expect(apiRequest).not.toHaveBeenCalled()
    expect(screen.queryByRole('img')).not.toBeInTheDocument()
  })

  it('clears a previous error once the save succeeds', async () => {
    vi.mocked(put).mockRejectedValueOnce(new Error('shop name is already taken'))
    const u = userEvent.setup()
    render(<BrandingForm initial={branding()} />)

    await u.click(save())
    await screen.findByText('shop name is already taken')

    await u.click(save())
    await waitFor(() => expect(screen.queryByText('shop name is already taken')).not.toBeInTheDocument())
  })

  it('does not upload a logo when none was chosen', async () => {
    // A second request on every save would replace the stored logo with nothing
    // each time the operator edited a colour.
    const u = userEvent.setup()
    render(<BrandingForm initial={branding()} />)

    await u.click(save())

    await waitFor(() => expect(put).toHaveBeenCalled())
    expect(apiRequest).not.toHaveBeenCalled()
  })

  it('uploads a chosen logo as multipart, after the settings', async () => {
    const u = userEvent.setup()
    render(<BrandingForm initial={branding()} />)

    const file = new File(['png-bytes'], 'logo.png', { type: 'image/png' })
    await u.upload(screen.getByLabelText(/^Logo/), file)
    await u.click(save())

    await waitFor(() => expect(apiRequest).toHaveBeenCalled())
    const [path, options] = vi.mocked(apiRequest).mock.calls[0] as [string, { method: string; isFormData: boolean; body: FormData }]
    expect(path).toBe('/api/admin/branding/logo')
    expect(options.method).toBe('PUT')
    expect(options.isFormData).toBe(true)
    expect((options.body as FormData).get('logo')).toBe(file)
  })

  it('refreshes the page, so the chrome repaints in the new colours', async () => {
    // The header and navigation are rendered by a server component from this
    // record; without the refresh the operator sees the old colours and thinks
    // the save did nothing.
    const u = userEvent.setup()
    render(<BrandingForm initial={branding()} />)

    await u.click(save())

    await waitFor(() => expect(refresh).toHaveBeenCalled())
    expect(toast).toHaveBeenCalledWith('Branding saved.')
  })

  it('says why when the save fails, and does not claim success', async () => {
    vi.mocked(put).mockRejectedValue(new Error('shop name is already taken'))
    const u = userEvent.setup()
    render(<BrandingForm initial={branding()} />)

    await u.click(save())

    expect(await screen.findByText('shop name is already taken')).toBeInTheDocument()
    expect(toast).not.toHaveBeenCalled()
    expect(refresh).not.toHaveBeenCalled()
  })

  it('says the save is under way, and refuses a second press', async () => {
    let release: () => void = () => {}
    vi.mocked(put).mockImplementation((() => new Promise<void>((r) => { release = r })) as never)
    const u = userEvent.setup()
    render(<BrandingForm initial={branding()} />)

    await u.click(save())
    expect(await screen.findByRole('button', { name: 'Saving…' })).toBeDisabled()
    release()
  })
})
