import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'

vi.mock('@/lib/api', () => ({ get: vi.fn(), patch: vi.fn(), put: vi.fn(), del: vi.fn() }))

import { HolidaysManager, type HolidaysPayload } from './HolidaysManager'
import { get, patch, put, del } from '@/lib/api'

const mockedGet = vi.mocked(get)
const mockedPatch = vi.mocked(patch)
const mockedPut = vi.mocked(put)
const mockedDel = vi.mocked(del)

/**
 * The holiday table root maintains (#330).
 *
 * What matters here is not the markup but the three judgements the screen has
 * to make plain: that the cached answer may be old, that a feed which has never
 * been read has switched the whole feature off, and that a public holiday the
 * company works through is unticked rather than deleted.
 */
interface FeedShape {
  url: string | null
  lastSuccessAt: string | null
  lastError: string | null
  ageDays: number | null
  stale: boolean
  neverSucceeded: boolean
  observedCount: number
}

const payload = (over: Partial<{ feed: FeedShape; holidays: unknown[] }> = {}) => ({
  feed: {
    url: 'https://feed.test/h.ics',
    lastSuccessAt: '2026-09-01T00:00:00.000Z',
    lastError: null,
    ageDays: 5,
    stale: false,
    neverSucceeded: false,
    observedCount: 1,
  },
  holidays: [{ date: '2026-12-25', name: 'Christmas', source: 'feed', observed: true }],
  ...over,
})

/**
 * The policy the SERVER would have handed over (#460). `mockedGet` still covers
 * the reload after an import or an edit.
 */
let serverPayload: HolidaysPayload | null = null
const renderManager = () => render(<HolidaysManager initial={serverPayload} />)

beforeEach(() => {
  vi.resetAllMocks()
  serverPayload = payload() as HolidaysPayload
  mockedGet.mockResolvedValue(payload())
  mockedPatch.mockResolvedValue(undefined)
  mockedPut.mockResolvedValue(undefined)
  mockedDel.mockResolvedValue(undefined)
})

describe('HolidaysManager', () => {
  it('lists the cached dates with where each came from', async () => {
    renderManager()
    expect(await screen.findByText('2026-12-25')).toBeInTheDocument()
    expect(screen.getByText('Christmas')).toBeInTheDocument()
    expect(screen.getByText('feed')).toBeInTheDocument()
  })

  /*
   * The banner the whole cached design depends on. Stale data looks exactly
   * like fresh data unless the screen says otherwise.
   */
  it('warns when the last good read is old', async () => {
    serverPayload = payload({ feed: { ...payload().feed, stale: true, ageDays: 45 } }) as HolidaysPayload
    renderManager()
    expect(await screen.findByText(/has not been read successfully/i)).toBeInTheDocument()
  })

  /*
   * The loudest case, because it is the one where the feature has silently
   * stopped: a configured feed that never read means windows are not applied
   * at all (the fail-closed rule), and nothing else on screen would say so.
   */
  it('says plainly when a configured feed has never been read', async () => {
    serverPayload = payload({ feed: { ...payload().feed, neverSucceeded: true, lastSuccessAt: null } }) as HolidaysPayload
    renderManager()
    expect(await screen.findByText(/never been read/i)).toBeInTheDocument()
    expect(screen.getByText(/NOT being applied/)).toBeInTheDocument()
  })

  // Previewing before saving is the point: saving a bad URL is what trips the
  // fail-closed rule.
  it('previews a feed without saving it', async () => {
    const user = userEvent.setup()
    mockedPatch.mockResolvedValue([{ date: '2027-01-01', name: 'New Year' }])
    renderManager()
    await screen.findByText('2026-12-25')

    await user.click(screen.getByRole('button', { name: /preview/i }))

    await waitFor(() => expect(mockedPatch).toHaveBeenCalledWith('/api/admin/holidays', {
      action: 'preview', url: 'https://feed.test/h.ics',
    }))
    expect(await screen.findByText(/2027-01-01 New Year/)).toBeInTheDocument()
  })

  it('clears the feed when the url is emptied', async () => {
    const user = userEvent.setup()
    renderManager()
    await screen.findByText('2026-12-25')

    await user.clear(screen.getByLabelText(/holiday feed url/i))
    await user.click(screen.getByRole('button', { name: /^save$/i }))

    // `null`, not `''` — clearing is the way back from a URL that has stopped
    // the windows applying.
    await waitFor(() => expect(mockedPatch).toHaveBeenCalledWith('/api/admin/holidays', {
      action: 'setFeed', url: null,
    }))
  })

  /*
   * Unticking, not deleting. A feed row that is deleted comes back on the next
   * refresh — the feed is the source for those — so "we work through this one"
   * has to be expressed as a state, and it takes the row over as manual.
   */
  it('marks a holiday as worked through rather than deleting it', async () => {
    const user = userEvent.setup()
    renderManager()
    await screen.findByText('2026-12-25')

    await user.click(screen.getByRole('button', { name: /work through/i }))

    await waitFor(() => expect(mockedPut).toHaveBeenCalledWith('/api/admin/holidays', {
      date: '2026-12-25', name: 'Christmas', observed: false,
    }))
    expect(mockedDel).not.toHaveBeenCalled()
  })

  it('adds a holiday by hand', async () => {
    const user = userEvent.setup()
    renderManager()
    await screen.findByText('2026-12-25')

    await user.type(screen.getByLabelText(/^date$/i), '2026-12-28')
    await user.type(screen.getByLabelText(/^name$/i), 'Company shutdown')
    await user.click(screen.getByRole('button', { name: /^add$/i }))

    await waitFor(() => expect(mockedPut).toHaveBeenCalledWith('/api/admin/holidays', {
      date: '2026-12-28', name: 'Company shutdown', observed: true,
    }))
  })

  // A failed refresh is news, not an error: the cached dates are untouched,
  // which is the whole reason they are cached.
  it('reports a failed refresh without losing the list', async () => {
    const user = userEvent.setup()
    mockedPatch.mockResolvedValue({ refreshed: false, error: 'The feed answered 502 Bad Gateway' })
    renderManager()
    await screen.findByText('2026-12-25')

    await user.click(screen.getByRole('button', { name: /refresh now/i }))

    expect(await screen.findByText(/502 Bad Gateway/)).toBeInTheDocument()
    expect(screen.getByText('2026-12-25')).toBeInTheDocument()
  })
})
