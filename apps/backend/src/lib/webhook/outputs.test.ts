import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { CiSource } from '@/lib/db/queries'
import { fetchJobTraces, parseTofuOutputs, supportsJobTrace } from '@/lib/ci'
import { outputsUnavailableReason, readOutputsForElement } from './outputs'

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

beforeEach(() => {
  vi.clearAllMocks()
  vi.spyOn(console, 'warn').mockImplementation(() => {})
  vi.spyOn(console, 'error').mockImplementation(() => {})
  mockedSupports.mockImplementation((provider) => provider === 'gitlab')
  mockedTraces.mockResolvedValue(['<trace>'])
  mockedParse.mockReturnValue({})
})

describe('outputsUnavailableReason', () => {
  it('says which of the environment-level causes applies', () => {
    expect(outputsUnavailableReason(null)).toContain('no CI source')
    expect(outputsUnavailableReason(ciSource({ provider: 'bitbucket' }))).toContain('bitbucket')
    expect(outputsUnavailableReason(ciSource({ projectRef: null }))).toContain('/projects/<id>/')
  })

  it('says nothing when the environment can be read', () => {
    expect(outputsUnavailableReason(ciSource())).toBeNull()
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