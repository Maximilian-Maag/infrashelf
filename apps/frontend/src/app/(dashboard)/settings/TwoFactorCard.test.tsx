import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type { TwoFactorStatusResponse } from '@infrashelf/types'
import { get, post } from '@/lib/api'
import { TwoFactorCard } from './TwoFactorCard'

vi.mock('@/lib/api', () => ({ get: vi.fn(), post: vi.fn() }))
vi.mock('@/lib/useLang', () => ({ useLang: () => 'en' }))

// The card reads `mustEnrollSecondFactor` off the session and clears it once an
// enrollment is confirmed (issue #197), so the tests have to supply one.
// `sessionData` is reassigned per test rather than re-mocked.
let sessionData: { mustEnrollSecondFactor?: boolean } = {}
const updateSession = vi.fn()
const getSession = vi.fn()
vi.mock('next-auth/react', () => ({
  useSession: () => ({ data: sessionData, update: updateSession }),
  getSession: () => getSession(),
}))

const mockedGet = vi.mocked(get)
const mockedPost = vi.mocked(post)

const status = (overrides: Partial<TwoFactorStatusResponse> = {}): TwoFactorStatusResponse => ({
  enabled: false,
  confirmedAt: null,
  pending: false,
  recoveryCodesRemaining: 0,
  lockedUntil: null,
  ...overrides,
})

const OFFER = {
  secret: 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ',
  secretFormatted: 'GEZD GNBV GY3T QOJQ GEZD GNBV GY3T QOJQ',
  otpauthUrl: 'otpauth://totp/ISF:root@test.dev?secret=GEZDGNBVGY3TQOJQ',
  qrSvg: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><rect width="100" height="100"/></svg>',
}

beforeEach(() => {
  mockedGet.mockReset()
  mockedPost.mockReset()
  updateSession.mockReset()
  getSession.mockReset()
  sessionData = {}
})

describe('TwoFactorCard — not yet set up', () => {
  it('offers to set it up, asking only for the password', async () => {
    mockedGet.mockResolvedValue(status())
    render(<TwoFactorCard />)

    expect(await screen.findByText('Not set up')).toBeInTheDocument()
    expect(screen.getByLabelText(/confirm with your password/i)).toBeInTheDocument()
    // No current code is asked for: there is no factor to prove yet.
    expect(screen.queryByLabelText(/authentication code/i)).toBeNull()
  })

  it('shows the QR code and the setup key after the password is accepted', async () => {
    mockedGet.mockResolvedValue(status())
    mockedPost.mockResolvedValue(OFFER)
    render(<TwoFactorCard />)

    const user = userEvent.setup()
    await user.type(await screen.findByLabelText(/confirm with your password/i), 'pw')
    await user.click(screen.getByRole('button', { name: /set up/i }))

    expect(await screen.findByText(OFFER.secretFormatted)).toBeInTheDocument()
    expect(mockedPost.mock.calls[0][0]).toBe('/api/users/me/2fa/enroll')
    expect(mockedPost.mock.calls[0][1]).toEqual({ password: 'pw' })
    // The SVG is inlined, so there is no image request and no external service.
    expect(document.querySelector('svg')).not.toBeNull()
  })

  it('surfaces a rejected password without leaving the step', async () => {
    mockedGet.mockResolvedValue(status())
    mockedPost.mockRejectedValue(new Error('Current password is incorrect'))
    render(<TwoFactorCard />)

    const user = userEvent.setup()
    await user.type(await screen.findByLabelText(/confirm with your password/i), 'nope')
    await user.click(screen.getByRole('button', { name: /set up/i }))

    expect(await screen.findByRole('alert')).toHaveTextContent(/password is incorrect/i)
    expect(screen.getByLabelText(/confirm with your password/i)).toBeInTheDocument()
  })

  it('shows the recovery codes once, and never asks for them again', async () => {
    mockedGet.mockResolvedValue(status())
    mockedPost.mockResolvedValueOnce(OFFER)
    mockedPost.mockResolvedValueOnce({ recoveryCodes: ['AAAAA-BBBBB-CCCCC-DDDDD', 'EEEEE-FFFFF-GGGGG-HHHHH'] })
    render(<TwoFactorCard />)

    const user = userEvent.setup()
    await user.type(await screen.findByLabelText(/confirm with your password/i), 'pw')
    await user.click(screen.getByRole('button', { name: /set up/i }))

    await user.type(await screen.findByLabelText(/authentication code/i), '123456')
    await user.click(screen.getByRole('button', { name: /activate/i }))

    expect(await screen.findByText('AAAAA-BBBBB-CCCCC-DDDDD')).toBeInTheDocument()
    expect(screen.getByText('EEEEE-FFFFF-GGGGG-HHHHH')).toBeInTheDocument()
    expect(mockedPost.mock.calls[1][0]).toBe('/api/users/me/2fa/confirm')

    // The secret is gone from the screen the moment it is no longer needed.
    expect(screen.queryByText(OFFER.secretFormatted)).toBeNull()
  })

  it('drops the pending secret when the enrollment is cancelled', async () => {
    mockedGet.mockResolvedValue(status())
    mockedPost.mockResolvedValue(OFFER)
    render(<TwoFactorCard />)

    const user = userEvent.setup()
    await user.type(await screen.findByLabelText(/confirm with your password/i), 'pw')
    await user.click(screen.getByRole('button', { name: /set up/i }))
    await user.click(await screen.findByRole('button', { name: /cancel/i }))

    expect(screen.queryByText(OFFER.secretFormatted)).toBeNull()
    expect(await screen.findByLabelText(/confirm with your password/i)).toBeInTheDocument()
  })
})

describe('TwoFactorCard — already active', () => {
  it('reports the state and how many recovery codes are left', async () => {
    mockedGet.mockResolvedValue(
      status({ enabled: true, confirmedAt: new Date().toISOString(), recoveryCodesRemaining: 7 }),
    )
    render(<TwoFactorCard />)

    expect(await screen.findByText('Active')).toBeInTheDocument()
    expect(screen.getByText('7')).toBeInTheDocument()
  })

  it('offers only a replacement — never a way to switch it off', async () => {
    mockedGet.mockResolvedValue(status({ enabled: true, recoveryCodesRemaining: 7 }))
    render(<TwoFactorCard />)

    expect(await screen.findByRole('button', { name: /replace authenticator/i })).toBeInTheDocument()
    for (const label of [/disable/i, /turn off/i, /remove/i, /delete/i]) {
      expect(screen.queryByRole('button', { name: label })).toBeNull()
    }
  })

  it('demands a current code as well as the password before replacing', async () => {
    mockedGet.mockResolvedValue(status({ enabled: true, recoveryCodesRemaining: 7 }))
    mockedPost.mockResolvedValue(OFFER)
    render(<TwoFactorCard />)

    const user = userEvent.setup()
    await user.type(await screen.findByLabelText(/confirm with your password/i), 'pw')
    await user.type(screen.getByLabelText(/authentication code/i), '123456')
    await user.click(screen.getByRole('button', { name: /replace authenticator/i }))

    await waitFor(() => expect(mockedPost).toHaveBeenCalled())
    expect(mockedPost.mock.calls[0][1]).toEqual({ password: 'pw', code: '123456' })
  })

  it('warns when the recovery codes have run out', async () => {
    mockedGet.mockResolvedValue(status({ enabled: true, recoveryCodesRemaining: 0 }))
    render(<TwoFactorCard />)
    // Its own message, not the "save these now — they will not be shown again"
    // one that belongs on the screen that just printed them. There are none on
    // screen here; the count is zero, which is what this says (issue #197).
    expect(await screen.findByRole('alert')).toHaveTextContent(/no recovery codes left/i)
  })

  it('does not tell the user to save codes that are not on screen', async () => {
    // The bug this replaced: the count-is-zero warning reused the string that
    // says "save these now", with nothing shown to save.
    mockedGet.mockResolvedValue(status({ enabled: true, recoveryCodesRemaining: 0 }))
    render(<TwoFactorCard />)
    expect(await screen.findByRole('alert')).not.toHaveTextContent(/save these now/i)
  })

  it('says nothing rather than erroring when the status cannot be read', async () => {
    mockedGet.mockRejectedValue(new Error('boom'))
    render(<TwoFactorCard />)
    // The card still renders its intro and the set-up form; it does not take the
    // whole settings page down with it.
    expect(await screen.findByLabelText(/confirm with your password/i)).toBeInTheDocument()
    expect(screen.queryByRole('alert')).toBeNull()
  })
})

// Issue #197: the account owes this enrollment.
describe('TwoFactorCard — enrollment is required', () => {
  it('says why the user was sent here', async () => {
    sessionData = { mustEnrollSecondFactor: true }
    mockedGet.mockResolvedValue(status())
    render(<TwoFactorCard />)
    expect(await screen.findByText(/required for administrator accounts/i)).toBeInTheDocument()
  })

  it('says nothing of the sort when the enrollment is voluntary', async () => {
    mockedGet.mockResolvedValue(status())
    render(<TwoFactorCard />)
    await screen.findByLabelText(/confirm with your password/i)
    expect(screen.queryByText(/required for administrator accounts/i)).toBeNull()
  })

  it('stops saying it once a factor is confirmed', async () => {
    // The requirement is met; the prompt would only be noise.
    sessionData = { mustEnrollSecondFactor: true }
    mockedGet.mockResolvedValue(status({ enabled: true }))
    render(<TwoFactorCard />)
    await screen.findByLabelText(/confirm with your password/i)
    expect(screen.queryByText(/required for administrator accounts/i)).toBeNull()
  })

  it('clears the session flag after confirming, so the redirect stops', async () => {
    // Without this the middleware keeps bouncing the user back here, having done
    // exactly what was asked of them.
    sessionData = { mustEnrollSecondFactor: true }
    mockedGet.mockResolvedValue(status())
    mockedPost.mockResolvedValueOnce(OFFER)
    mockedPost.mockResolvedValueOnce({ recoveryCodes: ['aaaa-bbbb'] })

    render(<TwoFactorCard />)
    const user = userEvent.setup()
    await user.type(await screen.findByLabelText(/confirm with your password/i), 'pw')
    await user.click(screen.getByRole('button', { name: /set up/i }))
    await user.type(await screen.findByLabelText(/authentication code/i), '123456')
    await user.click(screen.getByRole('button', { name: /activate/i }))

    await waitFor(() => expect(updateSession).toHaveBeenCalledWith({ mustEnrollSecondFactor: false }))
  })

  it('does not touch the session when the enrollment was voluntary', async () => {
    mockedGet.mockResolvedValue(status())
    mockedPost.mockResolvedValueOnce(OFFER)
    mockedPost.mockResolvedValueOnce({ recoveryCodes: ['aaaa-bbbb'] })

    render(<TwoFactorCard />)
    const user = userEvent.setup()
    await user.type(await screen.findByLabelText(/confirm with your password/i), 'pw')
    await user.click(screen.getByRole('button', { name: /set up/i }))
    await user.type(await screen.findByLabelText(/authentication code/i), '123456')
    await user.click(screen.getByRole('button', { name: /activate/i }))

    await screen.findByText('aaaa-bbbb')
    expect(updateSession).not.toHaveBeenCalled()
  })

  it('uses the status the server read, without asking again', async () => {
    // A card that re-asked would say "two-factor is off" for a frame, which is
    // the most reassuring thing it can say and the worst to say wrongly (#466).
    render(<TwoFactorCard initialStatus={{ enabled: true } as never} />)

    expect(get).not.toHaveBeenCalled()
  })

  it('asks for itself when the server could not read it', async () => {
    // `undefined` is not `null`: the first means nobody knows, and the card has
    // to find out rather than claim no second factor is enrolled.
    vi.mocked(get).mockResolvedValue({ enabled: false } as never)
    render(<TwoFactorCard />)
    await waitFor(() => expect(get).toHaveBeenCalledWith('/api/users/me/2fa'))
  })

  it('does not say two-factor is off while the status is unknown', async () => {
    // The worst thing this card can say wrongly. `null` means neither the server
    // nor this card has been able to read it — not that no second factor is
    // enrolled (#466).
    vi.mocked(get).mockRejectedValue(new Error('backend unreachable'))
    render(<TwoFactorCard />)

    await waitFor(() => expect(get).toHaveBeenCalled())
    expect(screen.queryByText(/two-factor is off|not enabled/i)).not.toBeInTheDocument()
    expect(screen.getByText('—')).toBeInTheDocument()
  })

  it('says it is off once that is actually known', async () => {
    render(<TwoFactorCard initialStatus={{ enabled: false, recoveryCodesRemaining: 0 } as never} />)
    expect(screen.queryByText('—')).not.toBeInTheDocument()
  })
})
