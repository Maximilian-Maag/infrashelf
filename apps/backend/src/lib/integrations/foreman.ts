import {
  type IntegrationTarget,
  integrationUrl,
  authHeaders,
  describeFailure,
} from '@/lib/integrations/http'

/**
 * Reading Foreman's host inventory (#111, the Foreman item).
 *
 * Foreman knows which hosts exist. The portal knows which hosts it ORDERED.
 * Neither can answer "is what we think we provisioned actually there, and is it
 * the only thing there" — and that comparison is worth having before any state
 * refresh exists, because it needs nothing from Terraform.
 *
 * READ-ONLY, deliberately. Registering a host on provisioning and removing it on
 * teardown are the other half of the Foreman item and they wait on a decision
 * that is not this function's to make: whether Foreman provisions through its
 * own compute resources or only records what Terraform built. Listing what is
 * there commits to neither answer.
 */

/** One host, reduced to what a comparison uses. Foreman returns far more. */
export interface ForemanHost {
  id: number
  /** Foreman's `name`, which is the FQDN for a host it manages. */
  name: string
  /** Foreman's own lifecycle word, e.g. `Active`, `Build`. Shown, never matched on. */
  status: string | null
  /** When Foreman last heard from the host. NULL for one that never reported. */
  lastReportAt: string | null
}

export type ForemanHostsResult =
  | { ok: true; hosts: ForemanHost[] }
  | { ok: false; error: string }

/**
 * Long enough for a real inventory, short enough to stay behind a request.
 *
 * Foreman's default page size is 20; asking for 100 keeps a 1,000-host estate to
 * ten round trips. The cap exists because a paginated API that answers the same
 * page for ever is a hang, and this runs while an admin waits.
 */
const PER_PAGE = 100
const MAX_PAGES = 50
const REQUEST_TIMEOUT_MS = 15_000

/** Foreman's paginated envelope, as much of it as matters here. */
interface HostsPage {
  results?: unknown
  total?: unknown
  page?: unknown
  per_page?: unknown
}

const toHost = (raw: unknown): ForemanHost | null => {
  if (raw === null || typeof raw !== 'object') return null
  const row = raw as Record<string, unknown>
  // A host without an id and a name is not something a comparison can use, and
  // skipping it is better than inventing a key: an empty name would match every
  // element whose hostname parameter is unset.
  if (typeof row.id !== 'number' || typeof row.name !== 'string' || row.name === '') return null
  return {
    id: row.id,
    name: row.name,
    status: typeof row.global_status_label === 'string' ? row.global_status_label : null,
    lastReportAt: typeof row.last_report === 'string' ? row.last_report : null,
  }
}

/**
 * Every host Foreman knows about.
 *
 * Never throws, for the same reason `probeIntegration` does not: a caller that
 * has to try/catch around an outbound call will eventually forget, and an
 * integration that is unreachable is a state the portal reports rather than one
 * that fails a request.
 */
export const listForemanHosts = async (target: IntegrationTarget): Promise<ForemanHostsResult> => {
  const hosts: ForemanHost[] = []
  const seen = new Set<number>()

  for (let page = 1; page <= MAX_PAGES; page++) {
    let url: URL
    try {
      url = integrationUrl(target.baseUrl, `/api/v2/hosts?per_page=${PER_PAGE}&page=${page}`)
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : String(e) }
    }

    let res: Response
    try {
      res = await fetch(url, {
        headers: { Accept: 'application/json', ...authHeaders(target) },
        // Not followed, like the probe: a 302 to a login page is the usual
        // answer to a bad credential, and following it would turn "unauthorised"
        // into a 200 carrying HTML.
        redirect: 'manual',
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      })
    } catch (e) {
      const name = (e as { name?: string })?.name
      if (name === 'TimeoutError' || name === 'AbortError') {
        return { ok: false, error: `No response within ${REQUEST_TIMEOUT_MS} ms` }
      }
      return { ok: false, error: describeFailure(null, url.pathname, e) }
    }

    if (!res.ok) return { ok: false, error: describeFailure(res.status, url.pathname) }

    const body = (await res.json().catch(() => null)) as HostsPage | null
    if (body === null || typeof body !== 'object' || !Array.isArray(body.results)) {
      // A 200 whose body is not the documented envelope means the URL reached
      // something that is not Foreman — a gateway's login page, most often —
      // and reporting "0 hosts" for that would read as an empty inventory.
      return { ok: false, error: `Unexpected response from ${url.pathname}` }
    }

    const batch = body.results.map(toHost).filter((h): h is ForemanHost => h !== null)
    for (const host of batch) {
      // Foreman pages by offset, so a host created while this walks can shift a
      // row onto a page already read. Dedupe rather than report it twice: the
      // comparison downstream counts, and a doubled host is a fake orphan.
      if (seen.has(host.id)) continue
      seen.add(host.id)
      hosts.push(host)
    }

    // The last page is the one that came back short. `total` is not trusted for
    // this: it is the count BEFORE the page was built on some versions, and a
    // loop that believes it walks for ever when a host is deleted mid-listing.
    if (body.results.length < PER_PAGE) return { ok: true, hosts }
  }

  return {
    ok: false,
    error: `More than ${MAX_PAGES * PER_PAGE} hosts; refusing to page further`,
  }
}
