import {
  type IntegrationTarget,
  integrationUrl,
  authHeaders,
  describeFailure,
  insecureCredentialTransport,
} from '@/lib/integrations/http'

/**
 * Reading pipeline logs out of Loki (#111, the Loki item).
 *
 * ── Why the portal reads logs from here rather than from the CI provider ────
 *
 * `lib/ci` fetches a job's stdout from the provider's own API, and only GitLab's
 * API serves it: GitHub hands a run's log back as a redirect to a ZIP, Bitbucket
 * needs every step enumerated first. So on those two providers an element never
 * receives its Terraform outputs at all (#97), and the apply log — the only
 * channel by which a deployment can tell the portal anything — is lost. A
 * deployment whose pipelines ship their stdout to Loki gives the portal ONE place
 * to read it from, whatever the provider is, and the parser stops depending on an
 * API two of the three vendors do not offer.
 *
 * ── The contract with the pipeline ─────────────────────────────────────────
 *
 * The portal sends `INFRA_ID` and `ORDER_ID` as trigger variables, so a pipeline
 * template can label the stream it pushes with them. This client reads
 *
 *     {element_id="17"}
 *
 * and nothing else is required of the shape: the label VALUE is the element id as
 * a string, and the log lines are whatever the job printed.
 *
 * ── What is deliberately not sent ──────────────────────────────────────────
 *
 * `X-Scope-OrgID`, for a multi-tenant Loki. Which tenant a portal should read is
 * a modelling decision (#551: environment? project? one per installation?) and
 * there is no field in the integration registry to hold the answer, so a
 * multi-tenant deployment needs a single-tenant gateway in front of Loki for now.
 * Sending a guessed tenant would read another tenant's logs or none at all, and
 * both look like "the pipeline shipped nothing".
 *
 * ── Read-only ──────────────────────────────────────────────────────────────
 *
 * Only `query_range` is implemented. Loki's push API is how a pipeline gets its
 * logs IN, and the portal is not in that path: it does not want a copy of the log
 * it is about to read, and a portal that could write log lines could write any
 * log line.
 */

/** One line, in the order Loki gave it and with Loki's own timestamp. */
export interface LokiLine {
  /**
   * Nanoseconds since the epoch, as Loki sent it — a string, because that is
   * 1e18 and more than a JavaScript number can hold exactly.
   */
  at: string
  line: string
}

export type LokiQueryResult =
  | { ok: true; lines: LokiLine[]; truncated: boolean }
  | { ok: false; error: string }

/**
 * How many lines one query may return.
 *
 * Loki's own default is 100, which is a fraction of a Terraform apply log, so an
 * element's outputs would silently arrive only if they happened to be in the
 * first hundred lines. Asking for 5,000 covers an apply with room to spare; when
 * the limit is what came back, `truncated` says so rather than leaving the caller
 * to guess whether the log ended or the query did.
 */
export const LOKI_LINE_LIMIT = 5_000

/**
 * Longer than the probe's 5 s and Foreman's 15 s: this is a range query over the
 * index, not a status endpoint, and a timeout that fires on a query Loki would
 * have answered is a report of "unreadable" for a log that is fine.
 */
const REQUEST_TIMEOUT_MS = 20_000

/**
 * The stream selector for one element's logs.
 *
 * Built here rather than accepted from a caller, and that is the point: a LogQL
 * query is not scoped by anything, so a free-form selector would be a portal that
 * can read every tenant's and every project's logs on behalf of whoever can reach
 * the endpoint. This function can only produce a selector for a positive integer
 * element id, which is a row the caller has already been authorised against.
 *
 * The id is interpolated, not the raw label value: `Number.isSafeInteger` refuses
 * `"17\"; }"` and `17.5` alike, so there is no string to escape. The quotes are
 * still added by this format string rather than by the value, so the shape of the
 * selector cannot be influenced from outside.
 */
export const elementLogSelector = (elementId: number): string => {
  if (!Number.isSafeInteger(elementId) || elementId <= 0) {
    throw new Error(`elementLogSelector needs a positive integer element id; got ${elementId}`)
  }
  return `{element_id="${elementId}"}`
}

/**
 * Ask Loki for the lines matching `query` between two instants.
 *
 * Never throws, like `probeIntegration` and `listForemanHosts`: an integration
 * that is unreachable is a state the portal reports, and a caller that has to
 * try/catch around an outbound call will eventually forget to.
 *
 * The window is REQUIRED rather than defaulted. Loki answers `query_range` over a
 * bounded interval, and an unbounded read of a stream that has been running for
 * a year is a query that either times out or takes the index down — neither of
 * which the caller would learn from.
 */
export const queryLokiLogs = async (
  target: IntegrationTarget,
  query: string,
  window: { since: Date; until?: Date },
): Promise<LokiQueryResult> => {
  let url: URL
  try {
    url = integrationUrl(target.baseUrl, '/loki/api/v1/query_range')
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) }
  }

  const insecure = insecureCredentialTransport(target, url)
  if (insecure) return { ok: false, error: insecure }

  const until = window.until ?? new Date()
  if (window.since.getTime() > until.getTime()) {
    return { ok: false, error: 'The log window ends before it starts.' }
  }

  // Nanoseconds as strings: Loki takes RFC3339 or a Unix timestamp with optional
  // nanoseconds, and the integer form avoids any question about how the instance
  // parses a date.
  const params = new URLSearchParams({
    query,
    start: nanosecondTimestamp(window.since),
    end: nanosecondTimestamp(until),
    limit: String(LOKI_LINE_LIMIT),
    // Oldest first, so a caller that keeps the first value it parses keeps the
    // one from the run that actually applied. Loki's default is backwards.
    direction: 'forward',
  })

  let res: Response
  try {
    res = await fetch(`${url.toString()}?${params.toString()}`, {
      headers: { Accept: 'application/json', ...authHeaders(target) },
      // Not followed, like every other client here: a 302 to a login page is the
      // usual answer to a bad credential, and following it would turn
      // "unauthorised" into a 200 carrying HTML.
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

  if (!res.ok) {
    // Loki puts a parser's complaint in the body of a 400, and "HTTP 400" alone
    // sends the operator looking at their credentials for a query error.
    const said = await readErrorBody(res)
    return {
      ok: false,
      error: said ? `${describeFailure(res.status, url.pathname)}: ${said}` : describeFailure(res.status, url.pathname),
    }
  }

  const body = (await res.json().catch(() => null)) as LokiResponse | null
  if (body === null || typeof body !== 'object' || body.status !== 'success') {
    // A 200 whose envelope is not Loki's means the URL reached something else —
    // a gateway's login page, most often — and reporting "no lines" for that
    // would read as a pipeline that shipped nothing.
    return { ok: false, error: `Unexpected response from ${url.pathname}` }
  }
  if (body.data?.resultType !== 'streams' || !Array.isArray(body.data.result)) {
    return { ok: false, error: `Loki answered with ${String(body.data?.resultType)} instead of streams` }
  }

  const lines: LokiLine[] = []
  for (const stream of body.data.result) {
    if (!Array.isArray(stream?.values)) continue
    for (const entry of stream.values) {
      if (!Array.isArray(entry) || entry.length < 2) continue
      const [at, line] = entry
      // The timestamp is checked for shape, not just type: it is parsed as a
      // BigInt for the sort below, and `BigInt("")` throws — which would break the
      // promise this function makes of never throwing, on the strength of what a
      // server (or something wearing Loki's URL) chose to send.
      if (typeof at !== 'string' || !/^\d+$/.test(at) || typeof line !== 'string') continue
      lines.push({ at, line })
    }
  }

  return { ok: true, lines: sortByTimestamp(lines), truncated: lines.length >= LOKI_LINE_LIMIT }
}

/**
 * Merge the streams into one timeline.
 *
 * `query_range` returns one array per stream, each sorted on its own, and a
 * `{element_id="17"}` query can match several: a pipeline that labels its logs
 * per stage, or one that restarted and opened a new stream. Concatenating them
 * would interleave two runs' `Outputs:` blocks and hand the parser a log that
 * never existed in that order.
 *
 * BigInt because the timestamps are nanoseconds: `Number` loses the low digits
 * above 2^53, which is a millisecond of a 1970-free epoch and enough to make two
 * lines compare equal.
 */
const sortByTimestamp = (lines: LokiLine[]): LokiLine[] =>
  [...lines].sort((a, b) => {
    const left = BigInt(a.at)
    const right = BigInt(b.at)
    return left < right ? -1 : left > right ? 1 : 0
  })

const nanosecondTimestamp = (at: Date): string => `${BigInt(at.getTime()) * 1_000_000n}`

/** Loki's error envelope, and the part of a success envelope this module reads. */
interface LokiResponse {
  status?: unknown
  error?: unknown
  data?: {
    resultType?: unknown
    result?: { stream?: unknown; values?: unknown }[]
  }
}

/**
 * The sentence out of an error body, if there is one.
 *
 * Truncated: Loki is not the only thing that can answer on this URL, and a login
 * page's HTML is not a message to put in front of an operator.
 */
const readErrorBody = async (res: Response): Promise<string | null> => {
  const text = await res.text().catch(() => '')
  if (!text) return null
  try {
    const parsed = JSON.parse(text) as { error?: unknown }
    if (typeof parsed.error === 'string' && parsed.error !== '') return parsed.error.slice(0, 300)
  } catch {
    // Not JSON: fall through to the raw text, trimmed.
  }
  const trimmed = text.replace(/\s+/g, ' ').trim()
  return trimmed === '' ? null : trimmed.slice(0, 300)
}
