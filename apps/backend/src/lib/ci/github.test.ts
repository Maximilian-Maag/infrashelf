import { describe, it, expect, beforeEach, vi } from 'vitest'
import {
  triggerGitHubWorkflow,
  listGitHubRepos,
  listGitHubBranches,
  listGitHubFiles,
  getGitHubFileContent,
} from './github'

const jsonRes = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })

// The run lookup accepts runs created no earlier than the dispatch; these two
// stand for "created just now" and "created long before this order existed".
const NOW_ISO = new Date().toISOString()
const LONG_AGO_ISO = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString()

/**
 * Drive `triggerGitHubWorkflow` through its retry schedule without waiting for
 * it. The schedule is ~8.7s of real time, which is right in production and
 * absurd in a unit test; fake timers keep the delays under test (the retry
 * count still matters) while costing nothing.
 */
const withoutWaiting = async <T>(run: () => Promise<T>): Promise<T> => {
  vi.useFakeTimers({ shouldAdvanceTime: false })
  try {
    const promise = run()
    // Attached before any timer runs: an assertion on the settled promise must
    // not race the rejection that `runAllTimersAsync` can produce.
    const settled = promise.then(
      (value) => ({ value }),
      (error: unknown) => ({ error }),
    )
    await vi.runAllTimersAsync()
    const outcome = await settled
    if ('error' in outcome) throw outcome.error
    return outcome.value
  } finally {
    vi.useRealTimers()
  }
}

const linkedRes = (body: unknown, nextUrl?: string) =>
  new Response(JSON.stringify(body), {
    status: 200,
    headers: {
      'content-type': 'application/json',
      ...(nextUrl ? { link: `<${nextUrl}>; rel="next", <${nextUrl}>; rel="last"` } : {}),
    },
  })

describe('github ci client', () => {
  beforeEach(() => {
    vi.restoreAllMocks()
  })

  describe('triggerGitHubWorkflow', () => {
    // The run id used to be a synthetic `owner/repo/workflow@branch` string,
    // because workflow_dispatch answers 204 with no body. The `workflow_run`
    // callback reports the real numeric id, so nothing ever matched and every
    // GitHub order stayed in `provisioning` forever (#207).
    it('POSTs to workflow_dispatch with ref + inputs, then returns the real run id', async () => {
      const fetchMock = vi.spyOn(global, 'fetch').mockImplementation(((url: string | URL) =>
        String(url).includes('/dispatches')
          ? Promise.resolve(new Response(null, { status: 204 }))
          : Promise.resolve(
              jsonRes({ workflow_runs: [{ id: 1234567890, created_at: NOW_ISO, event: 'workflow_dispatch', head_branch: 'main' }] }),
            )) as unknown as typeof fetch)

      const id = await withoutWaiting(() =>
        triggerGitHubWorkflow(
          'https://github.com/acme/infra',
          'ghp_token',
          'deploy.yml',
          'main',
          { HOSTNAME: 'web-01' },
        ),
      )

      expect(id).toBe('1234567890')
      const [url, init] = fetchMock.mock.calls[0]
      expect(String(url)).toBe('https://api.github.com/repos/acme/infra/actions/workflows/deploy.yml/dispatches')
      expect(init?.method).toBe('POST')
      const body = JSON.parse(String(init?.body))
      expect(body).toEqual({ ref: 'main', inputs: { HOSTNAME: 'web-01' } })
      const headers = new Headers(init?.headers as HeadersInit)
      expect(headers.get('authorization')).toBe('Bearer ghp_token')

      // The lookup is scoped to the workflow, the branch, and dispatch events —
      // an unrelated push build of the same workflow must not be picked up.
      const lookupUrl = String(fetchMock.mock.calls[1][0])
      expect(lookupUrl).toContain('/actions/workflows/deploy.yml/runs')
      expect(lookupUrl).toContain('event=workflow_dispatch')
      expect(lookupUrl).toContain('branch=main')
    })

    it('ignores runs that predate the dispatch, and keeps looking', async () => {
      // An older run of the same workflow on the same branch is the normal case
      // — the list endpoint returns history. Attributing an order to a run that
      // finished last week would settle it instantly against the wrong result.
      let lookups = 0
      vi.spyOn(global, 'fetch').mockImplementation(((url: string | URL) => {
        if (String(url).includes('/dispatches')) return Promise.resolve(new Response(null, { status: 204 }))
        lookups += 1
        return Promise.resolve(
          jsonRes({
            workflow_runs:
              lookups === 1
                ? [{ id: 111, created_at: LONG_AGO_ISO, event: 'workflow_dispatch', head_branch: 'main' }]
                : [
                    { id: 111, created_at: LONG_AGO_ISO, event: 'workflow_dispatch', head_branch: 'main' },
                    { id: 222, created_at: NOW_ISO, event: 'workflow_dispatch', head_branch: 'main' },
                  ],
          }),
        )
      }) as unknown as typeof fetch)

      const id = await withoutWaiting(() =>
        triggerGitHubWorkflow('https://github.com/a/b', 't', 'w.yml', 'main', {}),
      )

      expect(id).toBe('222')
      expect(lookups).toBe(2)
    })

    it('reports that the workflow may be running untracked when no run appears', async () => {
      // The dispatch SUCCEEDED. That distinction is the whole message: a run is
      // executing and this order will not be tracking it, which is a different
      // thing to go and check than a trigger that never fired.
      vi.spyOn(global, 'fetch').mockImplementation(((url: string | URL) =>
        String(url).includes('/dispatches')
          ? Promise.resolve(new Response(null, { status: 204 }))
          : Promise.resolve(jsonRes({ workflow_runs: [] }))) as unknown as typeof fetch)

      await expect(
        withoutWaiting(() =>
          triggerGitHubWorkflow('https://github.com/acme/infra', 't', 'w.yml', 'main', {}),
        ),
      ).rejects.toThrow(/dispatch succeeded but its run could not be identified[\s\S]*untracked/)
    })

    it('names the missing scope when the run lookup is forbidden', async () => {
      // A 403 on the runs endpoint is a token without `actions:read`, not a
      // transient fault — retrying it four more times only delays the order.
      const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
      let lookups = 0
      vi.spyOn(global, 'fetch').mockImplementation(((url: string | URL) => {
        if (String(url).includes('/dispatches')) return Promise.resolve(new Response(null, { status: 204 }))
        lookups += 1
        return Promise.resolve(new Response('{"message":"Resource not accessible"}', { status: 403 }))
      }) as unknown as typeof fetch)

      await expect(
        withoutWaiting(() =>
          triggerGitHubWorkflow('https://github.com/acme/infra', 't', 'w.yml', 'main', {}),
        ),
      ).rejects.toThrow(/actions:read/)
      expect(lookups).toBe(1)
      errSpy.mockRestore()
    })

    it('throws a descriptive error on non-2xx', async () => {
      const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
      vi.spyOn(global, 'fetch').mockResolvedValue(new Response('{"message":"Not Found"}', { status: 404 }))
      await expect(
        triggerGitHubWorkflow('https://github.com/a/b', 't', 'w.yml', 'main', {}),
      ).rejects.toThrow(/404/)
      errSpy.mockRestore()
    })

    // Issue #144, and the worst of the three: GitHub answers an invalid
    // workflow_dispatch with a 422 that lists the offending INPUTS verbatim — the
    // order's parameter values, sensitive ones included — and that body used to be
    // spliced straight into a message that reaches a 502 body and logAudit.
    it('keeps the provider response body out of the thrown message', async () => {
      const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
      vi.spyOn(global, 'fetch').mockResolvedValue(
        new Response(
          '{"message":"Unexpected inputs provided: [\\"ADMIN_PASSWORD: sup3rs3cret\\"]"}',
          { status: 422 },
        ),
      )

      await expect(
        triggerGitHubWorkflow('https://github.com/a/b', 't', 'w.yml', 'main', {
          ADMIN_PASSWORD: 'sup3rs3cret',
        }),
      ).rejects.toThrow(
        expect.objectContaining({ message: expect.not.stringContaining('sup3rs3cret') }),
      )

      expect(errSpy).toHaveBeenCalledWith(
        expect.stringContaining('422'),
        expect.stringContaining('sup3rs3cret'),
      )
      errSpy.mockRestore()
    })
  })

  describe('listGitHubRepos', () => {
    it('lists user repos as CiProject[] when no search term', async () => {
      const fetchMock = vi.spyOn(global, 'fetch').mockResolvedValue(
        jsonRes([{ id: 1, name: 'infra', full_name: 'acme/infra' }, { id: 2, name: 'ops', full_name: 'acme/ops' }]),
      )
      const repos = await listGitHubRepos('https://api.github.com', 'tok')
      expect(fetchMock.mock.calls[0][0]).toContain('/user/repos')
      expect(repos).toEqual([
        { id: '1', name: 'infra', fullPath: 'acme/infra' },
        { id: '2', name: 'ops', fullPath: 'acme/ops' },
      ])
    })

    it('uses the search endpoint and unwraps items[] when search is provided', async () => {
      const fetchMock = vi.spyOn(global, 'fetch').mockResolvedValue(
        jsonRes({ items: [{ id: 5, name: 'stuff', full_name: 'acme/stuff' }] }),
      )
      const repos = await listGitHubRepos('https://api.github.com', 'tok', 'stuff')
      expect(fetchMock.mock.calls[0][0]).toContain('/search/repositories')
      expect(fetchMock.mock.calls[0][0]).toContain('q=stuff')
      expect(repos).toEqual([{ id: '5', name: 'stuff', fullPath: 'acme/stuff' }])
    })

    it('throws on non-2xx', async () => {
      vi.spyOn(global, 'fetch').mockResolvedValue(new Response('', { status: 500 }))
      await expect(listGitHubRepos('https://api.github.com', 'tok')).rejects.toThrow(/500/)
    })

    it('follows the Link rel="next" header and concatenates pages', async () => {
      const fetchMock = vi
        .spyOn(global, 'fetch')
        .mockResolvedValueOnce(
          linkedRes(
            [{ id: 1, name: 'infra', full_name: 'acme/infra' }],
            'https://api.github.com/user/repos?page=2',
          ),
        )
        .mockResolvedValueOnce(jsonRes([{ id: 2, name: 'ops', full_name: 'acme/ops' }]))

      const repos = await listGitHubRepos('https://api.github.com', 'tok')

      expect(fetchMock).toHaveBeenCalledTimes(2)
      expect(String(fetchMock.mock.calls[1][0])).toBe('https://api.github.com/user/repos?page=2')
      expect(repos).toEqual([
        { id: '1', name: 'infra', fullPath: 'acme/infra' },
        { id: '2', name: 'ops', fullPath: 'acme/ops' },
      ])
    })

    it('caps at 10 pages if the Link header always points to a next page', async () => {
      const fetchMock = vi
        .spyOn(global, 'fetch')
        .mockImplementation(async () =>
          linkedRes(
            [{ id: 1, name: 'r', full_name: 'acme/r' }],
            'https://api.github.com/user/repos?page=next',
          ),
        )

      const repos = await listGitHubRepos('https://api.github.com', 'tok')
      expect(fetchMock).toHaveBeenCalledTimes(10)
      expect(repos.length).toBe(10)
    })
  })

  describe('listGitHubBranches', () => {
    it('returns CiBranch[] for /repos/:owner/:repo/branches', async () => {
      vi.spyOn(global, 'fetch').mockResolvedValue(jsonRes([{ name: 'main' }, { name: 'dev' }]))
      const branches = await listGitHubBranches('https://api.github.com', 'tok', 'acme/infra')
      expect(branches).toEqual([{ name: 'main' }, { name: 'dev' }])
    })

    it('throws on non-2xx', async () => {
      vi.spyOn(global, 'fetch').mockResolvedValue(new Response('', { status: 403 }))
      await expect(listGitHubBranches('https://api.github.com', 'tok', 'acme/infra')).rejects.toThrow(/403/)
    })
  })

  describe('listGitHubFiles', () => {
    it('maps GitHub `dir` type to `tree`, others to `blob`', async () => {
      vi.spyOn(global, 'fetch').mockResolvedValue(
        jsonRes([
          { name: 'main.tf', path: 'templates/vm/main.tf', type: 'file' },
          { name: 'modules', path: 'templates/vm/modules', type: 'dir' },
        ]),
      )
      const files = await listGitHubFiles('https://api.github.com', 'tok', 'acme/infra', 'main', 'templates/vm')
      expect(files).toEqual([
        { name: 'main.tf', path: 'templates/vm/main.tf', type: 'blob' },
        { name: 'modules', path: 'templates/vm/modules', type: 'tree' },
      ])
    })

    it('percent-encodes path segments', async () => {
      const fetchMock = vi.spyOn(global, 'fetch').mockResolvedValue(jsonRes([]))
      await listGitHubFiles('https://api.github.com', 'tok', 'acme/infra', 'main', 'has space/dir')
      const url = String(fetchMock.mock.calls[0][0])
      expect(url).toContain('/contents/has%20space/dir')
    })
  })

  describe('getGitHubFileContent', () => {
    it('requests raw content and returns it verbatim', async () => {
      const raw = 'variable "hostname" {\n  type = string\n}\n'
      const fetchMock = vi.spyOn(global, 'fetch').mockResolvedValue(new Response(raw, { status: 200 }))
      const content = await getGitHubFileContent('https://api.github.com', 'tok', 'acme/infra', 'main', 'variables.tf')
      expect(content).toBe(raw)
      const headers = new Headers(fetchMock.mock.calls[0][1]?.headers as HeadersInit)
      expect(headers.get('accept')).toContain('vnd.github.raw+json')
    })
  })
})
