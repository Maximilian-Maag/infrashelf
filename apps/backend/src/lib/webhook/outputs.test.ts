import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import type { CiSource } from '@/lib/db/queries'
import type { IntegrationTarget } from '@/lib/integrations/http'
import { fetchJobTraces, parseTofuOutputs, supportsJobTrace } from '@/lib/ci'
import { LOKI_LINE_LIMIT } from '@/lib/integrations/loki'
import { outputsBlocksIn, outputsUnavailableReason, readOutputsForElement } from './outputs'

/*
 * Reading Terraform outputs out of a pipeline log — the one channel a deployment
 * has for telling the portal what it built (#121), and the one an operator has for
 * asking a second time when the settle-time read went wrong (#215, #216).
 *
 * The CI client is mocked: what is under test is which of the three answers comes
 * back — the outputs, "the log could not be read", or "the log was read and it
 * declares none" — because only one of those is anybody's to fix, and the whole
 * reason these messages exist is that a revoked token and a template with no
 * outputs used to look identical.
 *
 * The Loki client is NOT mocked: those tests fake the HTTP responses instead, so
 * the selector, the window and the response parsing are the real ones (#111).
 */
vi.mock('@/lib/ci', () => ({
  fetchJobTraces: vi.fn(),
  parseTofuOutputs: vi.fn(),
  supportsJobTrace: vi.fn(),
}))

const mockedTraces = vi.mocked(fetchJobTraces)
const mockedParse = vi.mocked(parseTofuOutputs)
const mockedSupports = vi.mocked(supportsJobTrace)

const ciSource = (over: Partial<CiSource> = {}): CiSource =>
  ({ provider: 'gitlab', projectRef: '42', ...over }) as CiSource

const loki = (over: Partial<IntegrationTarget> = {}): IntegrationTarget => ({
  kind: 'loki',
  baseUrl: 'https://loki.example.com',
  authType: 'bearer',
  username: '',
  credential: 'a-token',
  ...over,
})

/** A Loki answer carrying `lines` for element 7, in the given order. */
const lokiStream = (lines: string[], status = 200): Response =>
  new Response(
    status === 200
      ? JSON.stringify({
          status: 'success',
          data: {
            resultType: 'streams',
            result: [
              {
                stream: { element_id: '7' },
                values: lines.map((line, i) => [`175870800${String(i).padStart(9, '0')}`, line]),
              },
            ],
          },
        })
      : JSON.stringify({ status: 'error', error: 'boom' }),
    { status, headers: { 'content-type': 'application/json' } },
  )

const lokiRequestUrl = (): URL =>
  new URL(String((vi.mocked(global.fetch).mock.calls[0] as [unknown])[0]))

beforeEach(() => {
  vi.clearAllMocks()
  vi.spyOn(console, 'warn').mockImplementation(() => {})
  vi.spyOn(console, 'error').mockImplementation(() => {})
  mockedSupports.mockImplementation((provider) => provider === 'gitlab')
  mockedTraces.mockResolvedValue(['<trace>'])
  mockedParse.mockReturnValue({})
})

afterEach(() => vi.restoreAllMocks())

describe('outputsUnavailableReason', () => {
  it('says which of the environment-level causes applies', () => {
    expect(outputsUnavailableReason(null)).toContain('no CI source')
    expect(outputsUnavailableReason(ciSource({ provider: 'bitbucket' }))).toContain('bitbucket')
    expect(outputsUnavailableReason(ciSource({ projectRef: null }))).toContain('/projects/<id>/')
  })

  it('says nothing when the environment can be read', () => {
    expect(outputsUnavailableReason(ciSource())).toBeNull()
  })

  it('says nothing when a Loki is configured, whatever the CI source is', () => {
    // The two cases this changes are the whole point of reading logs from Loki
    // (#111): a provider whose job log cannot be fetched, and an environment with
    // no CI source at all. Neither blocks a deployment whose pipelines ship their
    // logs to Loki.
    expect(outputsUnavailableReason(ciSource({ provider: 'bitbucket' }), { loki: true })).toBeNull()
    expect(outputsUnavailableReason(null, { loki: true })).toBeNull()
  })
})

/**
 * Where one outputs block ends and the next begins.
 *
 * A Loki stream is keyed by element, so an element provisioned by two stacks has
 * both blocks in one list of lines. The parser stops at the first line that is
 * not an assignment, and the second `Outputs:` header is exactly that — so a
 * naive join would keep the first stack's outputs and silently drop the rest.
 */
describe('outputsBlocksIn', () => {
  it('cuts one block per header, and ignores what precedes the first one', () => {
    expect(
      outputsBlocksIn([
        'some apply chatter',
        'Outputs:',
        'ip_address = "10.0.0.5"',
        'more chatter',
        'Outputs:',
        'name = "web-01"',
      ]),
    ).toEqual(['Outputs:\nip_address = "10.0.0.5"\nmore chatter', 'Outputs:\nname = "web-01"'])
  })

  it('is empty when the log has no outputs block at all', () => {
    expect(outputsBlocksIn(['nothing here', 'Plan: 1 to add'])).toEqual([])
  })

  it('accepts the leading whitespace a real log line carries', () => {
    expect(outputsBlocksIn(['   Outputs:  ', ' a = "1"'])).toEqual(['   Outputs:  \n a = "1"'])
  })
})

describe('readOutputsForElement — with a Loki configured', () => {
  it('reads the outputs from Loki for a provider whose job log cannot be fetched', async () => {
    // The payoff of #111's Loki item, and the reason for #97: on GitHub and
    // Bitbucket the apply log is unreachable through the provider's API, so an
    // element never received its outputs at all. Here the provider is bitbucket
    // and the outputs still arrive.
    vi.spyOn(global, 'fetch').mockResolvedValue(
      lokiStream(['apply chatter', 'Outputs:', 'ip_address = "10.0.0.5"']),
    )
    mockedParse.mockReturnValue({ ip_address: '10.0.0.5' })

    const read = await readOutputsForElement(
      ciSource({ provider: 'bitbucket' }),
      ['p1'],
      { elementId: 7, loki: loki() },
    )

    expect(read).toEqual({ outputs: { ip_address: '10.0.0.5' }, error: null })
    expect(mockedTraces).not.toHaveBeenCalled()
    // The selector is the element's, built by the client rather than accepted
    // from anywhere — a LogQL query is not scoped by anything else.
    expect(lokiRequestUrl().searchParams.get('query')).toBe('{element_id="7"}')
  })

  it('asks for the window the caller knows, not the default', async () => {
    vi.spyOn(global, 'fetch').mockResolvedValue(lokiStream([]))
    const since = new Date('2026-09-01T00:00:00Z')

    await readOutputsForElement(ciSource(), ['p1'], { elementId: 7, loki: loki(), since })

    expect(lokiRequestUrl().searchParams.get('start')).toBe(`${BigInt(since.getTime()) * 1_000_000n}`)
  })

  it('parses one trace per outputs block in the element’s stream', async () => {
    vi.spyOn(global, 'fetch').mockResolvedValue(
      lokiStream(['Outputs:', 'a = "1"', 'chatter', 'Outputs:', 'b = "2"']),
    )

    await readOutputsForElement(ciSource(), ['p1'], { elementId: 7, loki: loki() })

    expect(mockedParse.mock.calls.map(([trace]) => trace)).toEqual([
      'Outputs:\na = "1"\nchatter',
      'Outputs:\nb = "2"',
    ])
  })

  it('falls back to the provider when Loki has nothing for the element', async () => {
    // The ordinary state of a deployment part-way through moving its logs: the
    // integration is configured and the pipelines have not started shipping yet.
    vi.spyOn(global, 'fetch').mockResolvedValue(lokiStream([]))
    mockedParse.mockReturnValue({ from_ci: 'yes' })

    const read = await readOutputsForElement(ciSource(), ['p1'], { elementId: 7, loki: loki() })

    expect(read).toEqual({ outputs: { from_ci: 'yes' }, error: null })
    expect(mockedTraces).toHaveBeenCalledWith(expect.anything(), 'p1')
  })

  it('points at the integration, not at the CI token, when Loki is what failed', async () => {
    vi.spyOn(global, 'fetch').mockResolvedValue(lokiStream([], 500))
    mockedSupports.mockReturnValue(false)

    const read = await readOutputsForElement(
      ciSource({ provider: 'bitbucket' }),
      ['p1'],
      { elementId: 7, loki: loki() },
    )

    expect(read.outputs).toEqual({})
    expect(read.error).toContain('Loki: HTTP 500 from /loki/api/v1/query_range: boom')
    expect(read.error).toContain('Admin → Integrations')
    expect(read.error).toContain('element_id label')
  })

  it('says the log was truncated rather than that the deployment declared nothing', async () => {
    // The one failure that reads exactly like a template with no outputs: the
    // block may simply be past the line limit.
    vi.spyOn(global, 'fetch').mockResolvedValue(
      lokiStream(Array.from({ length: LOKI_LINE_LIMIT }, (_, i) => `noise ${i}`)),
    )

    const read = await readOutputsForElement(ciSource(), ['p1'], { elementId: 7, loki: loki() })

    expect(read.outputs).toEqual({})
    expect(read.error).toContain('truncated')
    expect(read.error).not.toContain('declared none')
  })

  it('still reports the CI path’s own failure when there is no Loki', async () => {
    mockedTraces.mockRejectedValue(new Error('GitLab job trace fetch failed: 401'))

    const read = await readOutputsForElement(ciSource(), ['p1'], { elementId: 7, loki: null })

    expect(read.error).toContain('Admin → CI Sources')
    expect(read.error).not.toContain('Admin → Integrations')
  })
})

describe('readOutputsForElement', () => {
  it('will not borrow a sibling element’s outputs when no trigger ever fired', async () => {
    const read = await readOutputsForElement(ciSource(), [], { elementId: 7 })

    expect(read.outputs).toEqual({})
    expect(read.error).toContain('No pipeline ever started for this element')
    expect(mockedTraces).not.toHaveBeenCalled()
  })

  it('returns what it read, and no error, when the log parses', async () => {
    mockedParse.mockReturnValue({ ip_address: '10.0.0.5' })

    const read = await readOutputsForElement(ciSource(), ['p1'], { elementId: 7 })

    expect(read).toEqual({ outputs: { ip_address: '10.0.0.5' }, error: null })
  })

  it('keeps the outputs of the pipelines that did report when one log cannot be read', async () => {
    mockedTraces.mockImplementation(async (_source, pipelineId) => {
      if (pipelineId === 'p1') throw new Error('GitLab job trace fetch failed: 401')
      return ['<trace>']
    })
    mockedParse.mockReturnValue({ ip_address: '10.0.0.5' })

    const read = await readOutputsForElement(ciSource(), ['p1', 'p2'], { elementId: 7 })

    expect(read.outputs).toEqual({ ip_address: '10.0.0.5' })
    // Not an error: something WAS read, and an error beside real outputs would
    // tell an operator their deployment recorded nothing.
    expect(read.error).toBeNull()
  })

  it('names the read failure and points at the token when nothing could be read', async () => {
    mockedTraces.mockRejectedValue(new Error('GitLab job trace fetch failed: 401'))

    const read = await readOutputsForElement(ciSource(), ['p1'], { elementId: 7 })

    expect(read.outputs).toEqual({})
    expect(read.error).toContain('GitLab job trace fetch failed: 401')
    expect(read.error).toContain('Admin → CI Sources')
  })

  it('distinguishes a log that was read and declared no outputs from a log it could not read', async () => {
    const read = await readOutputsForElement(ciSource(), ['p1'], { elementId: 7 })

    expect(read.outputs).toEqual({})
    expect(read.error).toContain('declared none')
  })

  it('keeps the first value when two of its pipelines report the same key', async () => {
    mockedParse
      .mockReturnValueOnce({ ip_address: '10.0.0.5' })
      .mockReturnValueOnce({ ip_address: '10.0.0.9' })

    const read = await readOutputsForElement(ciSource(), ['p1', 'p2'], { elementId: 7 })

    // By trigger order, not by which log happened to parse when: a value that
    // changes from run to run is worse than one that is arbitrary but stable.
    expect(read.outputs.ip_address).toBe('10.0.0.5')
  })
})