import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen } from '@testing-library/react'
import type * as Navigation from 'next/navigation'
import type { Project } from '@infrashelf/types'
import { ApiError } from '@/lib/api'
import ProjectsPage from './page'

const auth = vi.fn()
vi.mock('@/lib/auth', () => ({ auth: () => auth() }))
vi.mock('@/lib/getLang', () => ({ getLang: async () => 'en' }))

const redirect = vi.fn((url: string) => { throw new Error(`NEXT_REDIRECT:${url}`) })
vi.mock('next/navigation', async (importOriginal) => ({
  ...(await importOriginal<typeof Navigation>()),
  redirect: (url: string) => redirect(url),
}))

vi.mock('./NewProjectButton', () => ({ NewProjectButton: () => <button type="button">New project</button> }))

const get = vi.fn()
vi.mock('@/lib/serverApi', () => ({ get: (path: string) => get(path) }))

const project = (over: Partial<Project> = {}): Project => ({
  id: 4,
  name: 'Webshop Platform',
  description: 'The shop',
  ownerId: 3,
  ownerName: 'Ada',
  costCenterId: null,
  createdAt: '2026-01-01T00:00:00.000Z',
  ...over,
})

const answer = (value: unknown = [project()]) => {
  get.mockImplementation(() => (value instanceof Error ? Promise.reject(value) : Promise.resolve(value)))
}

beforeEach(() => {
  get.mockReset()
  redirect.mockClear()
  auth.mockResolvedValue({ user: { id: '3', role: 'user' } })
  answer()
})

describe('ProjectsPage', () => {
  it('sends a caller with no session to the login page', async () => {
    auth.mockResolvedValue(null)
    await expect(ProjectsPage()).rejects.toThrow('NEXT_REDIRECT')
    expect(redirect).toHaveBeenCalledWith('/login')
  })

  it('renders the projects it was given', async () => {
    render(await ProjectsPage())
    expect(screen.getByRole('link', { name: 'Webshop Platform' })).toHaveAttribute('href', '/projects/4')
  })

  it('leaves a dash where a project has no cost centre', async () => {
    // Nobody has said, which is not the same as an account named after nothing.
    render(await ProjectsPage())
    expect(screen.getByText('—')).toBeInTheDocument()
  })

  it('says the list is empty only when the read succeeded with nothing in it', async () => {
    answer([])
    render(await ProjectsPage())
    expect(screen.getByText(/no projects/i)).toBeInTheDocument()
  })

  it('lets a failed read reach the error boundary instead of rendering an empty table', async () => {
    // Deliberate, and worth a test because the next person to wrap this in a
    // `try` would not know: "you have no projects" during an outage is what a
    // project manager acts on, by creating one that already exists (#415).
    answer(new ApiError(500, 'Internal Server Error'))
    await expect(ProjectsPage()).rejects.toThrow('Internal Server Error')
  })
})
