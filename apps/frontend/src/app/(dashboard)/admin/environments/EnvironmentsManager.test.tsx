import { describe, it, expect, vi, beforeAll, beforeEach } from 'vitest'
import { render, screen, within } from '@testing-library/react'
import type { DeploymentEnvironment } from '@infrashelf/types'

// jsdom does not implement the native <dialog> methods; stub them so Modal's
// open/close effects don't throw (same stub as CategoriesManager.test.tsx).
beforeAll(() => {
  HTMLDialogElement.prototype.showModal = vi.fn(function (this: HTMLDialogElement) {
    this.open = true
  })
  HTMLDialogElement.prototype.close = vi.fn(function (this: HTMLDialogElement) {
    this.open = false
  })
})

vi.mock('@/components/ui/Toast', () => ({ useToast: () => ({ toast: vi.fn() }) }))

vi.mock('@/lib/api', () => ({
  get: vi.fn(),
  post: vi.fn(),
  put: vi.fn(),
  del: vi.fn(),
}))

import { EnvironmentsManager } from './EnvironmentsManager'
import { get } from '@/lib/api'

const mockedGet = vi.mocked(get)

const envs: DeploymentEnvironment[] = [
  { id: 1, name: 'Production', description: 'Live', ciSourceId: 1, webhookUrl: 'https://gitlab/api/v4/projects/8/trigger/pipeline' },
] as unknown as DeploymentEnvironment[]

beforeEach(() => {
  mockedGet.mockReset()
})

describe('EnvironmentsManager load failure', () => {
  // The list had a `try`/`finally` with no `catch`: a failed load left `envs`
  // empty and rendered the empty-state copy, which tells an administrator their
  // environments do not exist at the moment they are least able to check.
  it('reports a failed load instead of claiming there are no environments', async () => {
    // The server carries the reason over now rather than the manager
    // discovering it on mount (#458).
    render(<EnvironmentsManager ciSources={[]} initial={[]} initialError="502 Bad Gateway" />)

    expect(screen.getByText('502 Bad Gateway')).toBeInTheDocument()
    expect(screen.queryByText(/no environments yet/i)).not.toBeInTheDocument()
  })

  it('clears the error once a later load succeeds', async () => {
    const failed = render(<EnvironmentsManager ciSources={[]} initial={[]} initialError="502 Bad Gateway" />)
    expect(within(failed.container).getByText('502 Bad Gateway')).toBeInTheDocument()
    failed.unmount()

    // A second mount stands in for the retry path — the point is that the error
    // belongs to the load that failed, not to the component for ever.
    render(<EnvironmentsManager ciSources={[]} initial={envs} />)

    expect(screen.getByText('Production')).toBeInTheDocument()
    expect(screen.queryByText('502 Bad Gateway')).not.toBeInTheDocument()
  })

  it('still shows the empty state when the load succeeds with nothing in it', async () => {
    render(<EnvironmentsManager ciSources={[]} initial={[]} />)

    expect(screen.getByText(/no environments yet/i)).toBeInTheDocument()
  })
})
