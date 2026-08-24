import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import type { CiSource } from '@open-hybrid-cloud/types'

vi.mock('@/lib/api', () => ({
  get: vi.fn(),
  post: vi.fn(),
  put: vi.fn(),
  del: vi.fn(),
}))

import { EnvironmentsManager } from './EnvironmentsManager'
import { get } from '@/lib/api'

const mockedGet = vi.mocked(get)

const ciSources: CiSource[] = [
  { id: 1, name: 'GitLab', url: 'https://gitlab.test', provider: 'gitlab' },
]

beforeEach(() => {
  mockedGet.mockReset()
})

describe('EnvironmentsManager', () => {
  it('reports a failed load instead of showing the empty state', async () => {
    // `load` used to be try/finally with no catch, and every caller dropped the
    // promise: a failing GET became an unhandled rejection and the admin was told
    // there were no environments. Adding one here would then collide with the
    // ones that do exist.
    mockedGet.mockRejectedValue(new Error('Upstream unavailable'))

    render(<EnvironmentsManager token="tok" ciSources={ciSources} />)

    await waitFor(() => expect(screen.getByText('Upstream unavailable')).toBeInTheDocument())
  })

  it('clears the error once a later load succeeds', async () => {
    mockedGet.mockRejectedValueOnce(new Error('Upstream unavailable'))
    const { rerender } = render(<EnvironmentsManager token="tok" ciSources={ciSources} />)
    await waitFor(() => expect(screen.getByText('Upstream unavailable')).toBeInTheDocument())

    mockedGet.mockResolvedValue([
      { id: 7, name: 'Production', description: null, ciSourceId: 1 },
    ] as never)
    // A new token rebuilds `load`, which is what the effect watches — the same
    // path a refreshed session takes.
    rerender(<EnvironmentsManager token="tok2" ciSources={ciSources} />)

    await waitFor(() => expect(screen.getByText('Production')).toBeInTheDocument())
    expect(screen.queryByText('Upstream unavailable')).not.toBeInTheDocument()
  })
})
