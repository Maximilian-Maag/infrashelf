import { useState } from 'react'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'

vi.mock('@/lib/api', () => ({ get: vi.fn() }))
vi.mock('@/lib/useLang', () => ({ useLang: () => 'en' }))

import {
  TemplateSourceFields,
  emptyTemplateSource,
  templateSourceComplete,
  type TemplateSource,
} from './TemplateSourceFields'
import { get } from '@/lib/api'

const mockedGet = vi.mocked(get)

/**
 * The CI source → repository → branch cascade, which had no test.
 *
 * Two things matter here and neither was pinned: that choosing a source clears
 * everything downstream of it — a stale repository under a new source is a
 * silently wrong import — and that each step stays disabled until the list
 * behind it has actually arrived.
 */
const sources = [{ id: 1, name: 'GitLab' }]
const projects = [{ id: 'grp/repo', fullPath: 'grp/repo' }]
const branches = [{ name: 'main' }]

const answer = (byPath: Record<string, unknown>) =>
  mockedGet.mockImplementation((async (path: string) => {
    for (const [fragment, value] of Object.entries(byPath)) {
      if (path.includes(fragment)) return value
    }
    return []
  }) as never)

/**
 * A CONTROLLED harness, because the cascade only loads a list in response to a
 * change — never on mount for a value it was handed.
 *
 * Rendering with `ciSourceId` already set therefore leaves the repository select
 * disabled forever, since nothing ever fetches its projects. Not a live bug:
 * both callers (`NewProductForm`, `ImportFromRepo`) start from
 * `emptyTemplateSource()`. It is a trap for the next caller that does not, which
 * is why the cascade is driven here the way a user drives it.
 */
const Harness = ({ onError }: { onError: (m: string | null) => void }) => {
  const [value, setValue] = useState<TemplateSource>(emptyTemplateSource())
  return <TemplateSourceFields value={value} onChange={setValue} onError={onError} lang="en" />
}

const renderCascade = () => {
  const onError = vi.fn()
  return { ...render(<Harness onError={onError} />), onError }
}

const renderFields = (value: TemplateSource = emptyTemplateSource()) => {
  const onChange = vi.fn()
  const onError = vi.fn()
  const result = render(
    <TemplateSourceFields value={value} onChange={onChange} onError={onError} lang="en" />,
  )
  return { ...result, onChange, onError }
}

beforeEach(() => {
  mockedGet.mockReset()
  answer({ 'ci-sources': sources, 'projects/': branches, projects })
})

describe('templateSourceComplete', () => {
  it('needs a source, a repository and a branch', () => {
    expect(templateSourceComplete({ ciSourceId: '1', projectId: 'p', ref: 'main', path: '' })).toBe(true)
  })

  it('does NOT need a path — an empty one is legitimate', () => {
    // The import endpoint accepts a template at the repository root.
    const complete = { ciSourceId: '1', projectId: 'p', ref: 'main', path: '' }
    expect(templateSourceComplete(complete)).toBe(true)
    expect(templateSourceComplete({ ...complete, path: 'templates/vm' })).toBe(true)
  })

  it.each([['ciSourceId'], ['projectId'], ['ref']] as const)(
    'is false when %s is missing',
    (field) => {
      const value = { ciSourceId: '1', projectId: 'p', ref: 'main', path: '' }
      expect(templateSourceComplete({ ...value, [field]: '' })).toBe(false)
    },
  )

  it('starts empty, and an empty source is not complete', () => {
    expect(emptyTemplateSource()).toEqual({ ciSourceId: '', projectId: '', ref: '', path: '' })
    expect(templateSourceComplete(emptyTemplateSource())).toBe(false)
  })
})

describe('the cascade', () => {
  it('loads the CI sources on mount, since nothing has to happen first', async () => {
    renderFields()
    await waitFor(() => expect(mockedGet).toHaveBeenCalledWith('/api/admin/ci-sources'))
  })

  it('clears the repository and branch when the source changes', async () => {
    // Everything downstream is stale. Left in place it would import from a
    // repository that does not belong to the newly chosen source.
    const user = userEvent.setup()
    const { onChange } = renderFields({
      ciSourceId: '1', projectId: 'grp/repo', ref: 'main', path: 'templates/vm',
    })
    await screen.findByRole('option', { name: 'GitLab' })

    await user.selectOptions(screen.getByLabelText(/ci source/i), '1')

    expect(onChange).toHaveBeenCalledWith(
      expect.objectContaining({ ciSourceId: '1', projectId: '', ref: '' }),
    )
    // The path is NOT cleared: it is a repository path the user typed, and it is
    // as likely to be right under the new source as the old one.
    expect(onChange.mock.calls[0][0].path).toBe('templates/vm')
  })

  it('opens each step only once the one before it has answered', async () => {
    const user = userEvent.setup()
    renderCascade()

    // Repository is shut until a source is chosen AND its projects have arrived.
    expect(screen.getByLabelText(/repository/i)).toBeDisabled()
    await screen.findByRole('option', { name: 'GitLab' })
    await user.selectOptions(screen.getByLabelText(/ci source/i), '1')
    await waitFor(() => expect(screen.getByLabelText(/repository/i)).not.toBeDisabled())

    // Branch is shut until a repository is chosen and ITS branches have arrived.
    expect(screen.getByLabelText(/branch/i)).toBeDisabled()
    await user.selectOptions(screen.getByLabelText(/repository/i), 'grp/repo')
    await waitFor(() => expect(screen.getByLabelText(/branch/i)).not.toBeDisabled())
  })

  it('fetches nothing when the source is cleared back to none', async () => {
    const user = userEvent.setup()
    renderFields({ ciSourceId: '1', projectId: '', ref: '', path: '' })
    await screen.findByRole('option', { name: 'GitLab' })
    mockedGet.mockClear()

    await user.selectOptions(screen.getByLabelText(/ci source/i), '')

    // Only the clearing; no request for the projects of "nothing".
    expect(mockedGet).not.toHaveBeenCalled()
  })

  it('escapes a repository id with slashes in it when asking for branches', async () => {
    // `grp/repo` is one path segment, not two — unescaped it addresses a
    // different endpoint entirely.
    const user = userEvent.setup()
    renderCascade()
    await screen.findByRole('option', { name: 'GitLab' })
    await user.selectOptions(screen.getByLabelText(/ci source/i), '1')
    await waitFor(() => expect(screen.getByLabelText(/repository/i)).not.toBeDisabled())

    await user.selectOptions(screen.getByLabelText(/repository/i), 'grp/repo')

    await waitFor(() =>
      expect(mockedGet).toHaveBeenCalledWith(
        '/api/admin/ci/1/projects/grp%2Frepo/branches',
      ),
    )
  })
})

describe('what stays disabled until its list arrives', () => {
  it('disables the repository until a source is chosen', () => {
    renderFields()
    expect(screen.getByLabelText(/repository/i)).toBeDisabled()
  })

  it('disables the branch until a repository is chosen', () => {
    renderFields({ ciSourceId: '1', projectId: '', ref: '', path: '' })
    expect(screen.getByLabelText(/branch/i)).toBeDisabled()
  })

  it('disables every field when the caller says the form is busy', async () => {
    render(
      <TemplateSourceFields
        value={{ ciSourceId: '1', projectId: 'grp/repo', ref: 'main', path: '' }}
        onChange={vi.fn()}
        onError={vi.fn()}
        lang="en"
        disabled
      />,
    )
    for (const label of [/ci source/i, /repository/i, /branch/i, /path/i]) {
      expect(screen.getByLabelText(label)).toBeDisabled()
    }
  })
})

describe('errors go up, not on screen', () => {
  it('reports a failed load to the caller', async () => {
    mockedGet.mockRejectedValue(new Error('CI is unreachable'))
    const { onError } = renderFields()
    await waitFor(() => expect(onError).toHaveBeenCalledWith('CI is unreachable'))
  })

  it('clears the previous error before each attempt', async () => {
    // Otherwise a stale message sits beside a field that has since succeeded.
    const { onError } = renderFields()
    await waitFor(() => expect(onError).toHaveBeenCalledWith(null))
  })
})
