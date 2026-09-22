import { describe, it, expect } from 'vitest'
import {
  buildElementDocument,
  ELEMENT_DOCUMENT_VERSION,
  type ElementDocumentSource,
} from './elementDocument'
import { REDACTED } from '@/lib/services/parameterRedaction'

/**
 * The element document's shape is an interface somebody else writes policies
 * against (issue #110, slice 6), so these tests are about the CONTRACT rather
 * than about the code: what the engine receives for a running element, key by
 * key, and what must never be in it.
 */

const source = (over: Partial<ElementDocumentSource> = {}): ElementDocumentSource => ({
  elementId: 91,
  orderId: 7,
  projectId: 3,
  productId: 42,
  environmentId: 2,
  sizeCode: 'M',
  quantity: 1,
  status: 'active',
  deployedAt: new Date('2026-09-01T10:00:00.000Z'),
  parameters: { instance_type: 't3.large', db_password: 'hunter2' },
  outputs: { public_ip: '203.0.113.9' },
  lastRefreshOutcome: 'drifted',
  driftDetectedAt: new Date('2026-09-21T06:00:00.000Z'),
  driftSummary: { resources: [{ address: 'linode_instance.vm', action: 'update' }] },
  ...over,
})

describe('buildElementDocument', () => {
  it('produces exactly the documented shape, key by key', () => {
    /*
     * A full deep equality, deliberately, and not a `toMatchObject`.
     *
     * A rename or retype inside this object does not break the portal — it breaks
     * every policy written against the old name, silently, and a policy that no
     * longer matches reads as a policy that found nothing wrong. If this fails,
     * the fix is to bump ELEMENT_DOCUMENT_VERSION and say in #110 why it moved.
     */
    expect(buildElementDocument(source(), new Set())).toEqual({
      version: ELEMENT_DOCUMENT_VERSION,
      elementId: 91,
      orderId: 7,
      projectId: 3,
      productId: 42,
      environmentId: 2,
      size: 'M',
      quantity: 1,
      status: 'active',
      deployedAt: '2026-09-01T10:00:00.000Z',
      parameters: { instance_type: 't3.large', db_password: 'hunter2' },
      sensitiveParameters: [],
      outputs: { public_ip: '203.0.113.9' },
      refresh: {
        outcome: 'drifted',
        driftDetectedAt: '2026-09-21T06:00:00.000Z',
        resources: [{ address: 'linode_instance.vm', action: 'update' }],
      },
    })
  })

  it('says which document it is, so a policy can be written against one', () => {
    expect(ELEMENT_DOCUMENT_VERSION).toBe(1)
    expect(buildElementDocument(source(), new Set()).version).toBe(1)
  })

  it('redacts a sensitive value but names it, so a rule can reason about presence', () => {
    const doc = buildElementDocument(source(), new Set(['db_password']))

    expect(doc.parameters.db_password).toBe(REDACTED)
    expect(doc.parameters.instance_type).toBe('t3.large')
    // The name travels; the value does not. A policy asking "does this hold a
    // database password" needs only the name.
    expect(doc.sensitiveParameters).toEqual(['db_password'])
    expect(JSON.stringify(doc)).not.toContain('hunter2')
  })

  it('carries what the last refresh found, because that is the live fact', () => {
    const doc = buildElementDocument(source(), new Set())

    expect(doc.refresh.outcome).toBe('drifted')
    expect(doc.refresh.resources).toEqual([{ address: 'linode_instance.vm', action: 'update' }])
  })

  it('distinguishes never refreshed from refreshed clean', () => {
    /*
     * The distinction #108 opens with: NULL means "never heard", which is a
     * different thing from "checked and clean". A policy that cannot tell them
     * apart would treat an element nobody is checking as a compliant one.
     */
    const never = buildElementDocument(
      source({ lastRefreshOutcome: null, driftDetectedAt: null, driftSummary: null }),
      new Set(),
    )
    const clean = buildElementDocument(
      source({ lastRefreshOutcome: 'clean', driftDetectedAt: null, driftSummary: null }),
      new Set(),
    )

    expect(never.refresh.outcome).toBeNull()
    expect(never.refresh.resources).toEqual([])
    expect(clean.refresh.outcome).toBe('clean')
    expect(never.refresh.outcome).not.toBe(clean.refresh.outcome)
  })

  it('survives an element with no parameters, no outputs and no deployment time', () => {
    const doc = buildElementDocument(
      source({ parameters: null, outputs: null, deployedAt: null, driftSummary: null }),
      new Set(),
    )

    expect(doc.parameters).toEqual({})
    expect(doc.outputs).toEqual({})
    expect(doc.deployedAt).toBeNull()
  })
})
