import type { CiProject, CiBranch, CiFile } from '@open-hybrid-cloud/types'
import { triggerFailure } from './triggerError'

// See gitlab.ts — cap pages followed so a large org isn't truncated at 100 rows
// while still bounding the number of requests.
const MAX_LIST_PAGES = 10

const ghHeaders = (token: string) => ({
  Authorization: `Bearer ${token}`,
  Accept: 'application/vnd.github+json',
  'X-GitHub-Api-Version': '2022-11-28',
})

// Extract the rel="next" URL from a GitHub `Link` header, if present.
// Format: <https://api.github.com/...&page=2>; rel="next", <...>; rel="last"
const parseNextLink = (linkHeader: string | null): string | null => {
  if (!linkHeader) return null
  for (const part of linkHeader.split(',')) {
    const match = part.match(/<([^>]+)>;\s*rel="next"/)
    if (match) return match[1]
  }
  return null
}

/**
 * Follow GitHub's `Link: rel="next"` pagination, concatenating each page.
 * `extract` pulls the row array out of the page body (repos search wraps rows in
 * `items`, other endpoints return a bare array).
 */
const githubListAll = async <T>(
  firstUrl: string,
  token: string,
  errorLabel: string,
  extract: (body: unknown) => T[],
): Promise<T[]> => {
  const results: T[] = []
  let url: string | null = firstUrl

  for (let i = 0; i < MAX_LIST_PAGES && url; i++) {
    const res: Response = await fetch(url, { headers: ghHeaders(token) })
    if (!res.ok) throw new Error(`${errorLabel}: ${res.status}`)
    results.push(...extract(await res.json()))
    url = parseNextLink(res.headers.get('link'))
  }

  return results
}

// repoUrl: e.g. https://github.com/owner/repo
const parseRepoUrl = (repoUrl: string): { owner: string; repo: string } => {
  const url = new URL(repoUrl)
  const parts = url.pathname.replace(/^\//, '').replace(/\.git$/, '').split('/')
  return { owner: parts[0], repo: parts[1] }
}

/**
 * How long, and how patiently, to wait for GitHub to materialise the run.
 *
 * `workflow_dispatch` answers 204 with no body, so the run id has to be looked
 * up afterwards — and the run does not exist the instant the dispatch returns.
 * In practice it appears within a second; the later, longer attempts are for a
 * queue that is briefly busy. The whole schedule is bounded because this runs
 * INLINE while an order is being placed: `triggerPipelineStacksTracked` awaits
 * one trigger per pipeline stack, so the worst case here is paid per stack.
 */
const RUN_LOOKUP_DELAYS_MS = [400, 800, 1500, 2500, 3500]

/**
 * How far before the dispatch a run may claim to have been created and still be
 * accepted as ours. GitHub stamps `created_at` from its own clock, so a portal
 * running a few seconds fast would otherwise reject the very run it just asked
 * for. Kept small: every second of skew widens the window in which a DIFFERENT
 * dispatch of the same workflow could be mistaken for this one.
 */
const RUN_CLOCK_SKEW_MS = 10_000

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))

interface WorkflowRun {
  id: number
  created_at: string
  event: string
  head_branch: string | null
}

/**
 * Find the run that a just-issued `workflow_dispatch` created.
 *
 * Returns the run id as a string, or `null` if none appeared within the
 * schedule above.
 *
 * **This is a correlation, not an identity.** GitHub gives the dispatcher no
 * handle on the run it created, so the run is identified by everything we do
 * know: same workflow, same branch, `event=workflow_dispatch`, and created no
 * earlier than the moment we dispatched. Two orders dispatching the SAME
 * workflow on the SAME branch inside this window are indistinguishable, and the
 * newest run wins for both — so one order can end up tracking the other's run.
 * The window is short and the collision needs both orders to target one
 * workflow and branch, but it is real and it is not fixable from this side:
 * eliminating it needs the workflow's cooperation (a portal-generated id passed
 * as an input and echoed into `run-name:`), which cannot be required of a
 * customer's existing workflow.
 */
const resolveDispatchedRunId = async (
  owner: string,
  repo: string,
  workflow: string,
  branch: string,
  token: string,
  dispatchedAt: number,
): Promise<string | null> => {
  const url =
    `https://api.github.com/repos/${owner}/${repo}/actions/workflows/${encodeURIComponent(workflow)}/runs` +
    `?event=workflow_dispatch&branch=${encodeURIComponent(branch)}&per_page=20`

  for (const delay of RUN_LOOKUP_DELAYS_MS) {
    await sleep(delay)

    const res = await fetch(url, { headers: ghHeaders(token) })
    if (!res.ok) {
      // A 403 here is almost always the token missing `actions:read` rather than
      // a transient fault, and retrying it four more times only delays the order.
      // Say which it was: the operator's fix differs.
      throw await triggerFailure(
        res.status === 403 || res.status === 404
          ? 'GitHub run lookup (token needs actions:read on this repository)'
          : 'GitHub run lookup',
        res,
      )
    }

    const body = (await res.json()) as { workflow_runs?: WorkflowRun[] }
    const candidates = (body.workflow_runs ?? []).filter(
      (run) => Date.parse(run.created_at) >= dispatchedAt - RUN_CLOCK_SKEW_MS,
    )
    if (candidates.length === 0) continue

    // Newest first; `id` breaks a tie, because `created_at` has second
    // granularity and two runs a few hundred milliseconds apart share it.
    candidates.sort((a, b) => Date.parse(b.created_at) - Date.parse(a.created_at) || b.id - a.id)
    return String(candidates[0].id)
  }

  return null
}

export const triggerGitHubWorkflow = async (
  repoUrl: string,
  token: string,
  workflow: string,
  branch: string,
  inputs: Record<string, string>,
): Promise<string> => {
  const { owner, repo } = parseRepoUrl(repoUrl)
  // Stamped BEFORE the dispatch: a run created while the POST is in flight is
  // ours, and a timestamp taken after it would exclude exactly that run.
  const dispatchedAt = Date.now()
  const res = await fetch(
    `https://api.github.com/repos/${owner}/${repo}/actions/workflows/${encodeURIComponent(workflow)}/dispatches`,
    {
      method: 'POST',
      headers: { ...ghHeaders(token), 'Content-Type': 'application/json' },
      body: JSON.stringify({ ref: branch, inputs }),
    },
  )

  if (!res.ok) throw await triggerFailure('GitHub workflow dispatch', res)

  // `workflow_dispatch` answers 204 with no body. This used to return a
  // synthetic `owner/repo/workflow@branch` string, which was stored in
  // `pipeline_id` — and the `workflow_run` callback reports the REAL numeric run
  // id, so the two never matched. Every GitHub callback selected zero rows and
  // every GitHub order stayed in `provisioning` forever, with no error, because
  // from the handler's side the event simply belonged to nothing it knew about
  // (issue #207).
  const runId = await resolveDispatchedRunId(owner, repo, workflow, branch, token, dispatchedAt)

  if (!runId) {
    // The workflow WAS dispatched. Saying so matters: the run is executing and
    // may be creating infrastructure that this order will not be tracking, which
    // is a different thing for an operator to go and check than a trigger that
    // never fired.
    throw new Error(
      `GitHub workflow dispatch succeeded but its run could not be identified: ` +
        `no ${workflow} run on ${branch} appeared within ` +
        `${RUN_LOOKUP_DELAYS_MS.reduce((a, b) => a + b, 0) / 1000}s. ` +
        `The workflow may be running untracked — check ${owner}/${repo} in GitHub Actions.`,
    )
  }

  return runId
}

export const listGitHubRepos = async (
  _apiUrl: string,
  token: string,
  search?: string,
): Promise<CiProject[]> => {
  const params = new URLSearchParams({ per_page: '100', visibility: 'all' })
  if (search) params.set('q', search)

  type Repo = { id: number; name: string; full_name: string }
  const repos = await githubListAll<Repo>(
    search
      ? `https://api.github.com/search/repositories?q=${encodeURIComponent(search)}&per_page=100`
      : `https://api.github.com/user/repos?${params}`,
    token,
    'GitHub list repos failed',
    (body) =>
      Array.isArray(body)
        ? (body as Repo[])
        : ((body as { items?: Repo[] }).items ?? []),
  )

  return repos.map((r) => ({
    id: String(r.id),
    name: r.name,
    fullPath: r.full_name,
  }))
}

export const listGitHubBranches = async (
  _apiUrl: string,
  token: string,
  projectId: string,
): Promise<CiBranch[]> => {
  // projectId is owner/repo
  const data = await githubListAll<{ name: string }>(
    `https://api.github.com/repos/${projectId}/branches?per_page=100`,
    token,
    'GitHub list branches failed',
    (body) => body as Array<{ name: string }>,
  )
  return data.map((b) => ({ name: b.name }))
}

export const listGitHubFiles = async (
  _apiUrl: string,
  token: string,
  projectId: string,
  branch: string,
  path: string,
): Promise<CiFile[]> => {
  const encodedPath = path.split('/').map(encodeURIComponent).join('/')
  type Entry = { name: string; path: string; type: 'file' | 'dir' | 'symlink' | 'submodule' }
  const data = await githubListAll<Entry>(
    `https://api.github.com/repos/${projectId}/contents/${encodedPath}?ref=${encodeURIComponent(branch)}`,
    token,
    'GitHub list files failed',
    (body) => (Array.isArray(body) ? (body as Entry[]) : []),
  )

  return data.map((f) => ({
    name: f.name,
    path: f.path,
    type: f.type === 'dir' ? 'tree' : 'blob',
  }))
}

export const getGitHubFileContent = async (
  _apiUrl: string,
  token: string,
  projectId: string,
  branch: string,
  filePath: string,
): Promise<string> => {
  const encodedFilePath = filePath.split('/').map(encodeURIComponent).join('/')
  const res = await fetch(
    `https://api.github.com/repos/${projectId}/contents/${encodedFilePath}?ref=${encodeURIComponent(branch)}`,
    { headers: { ...ghHeaders(token), Accept: 'application/vnd.github.raw+json' } },
  )

  if (!res.ok) throw new Error(`GitHub file content fetch failed: ${res.status}`)

  return res.text()
}
