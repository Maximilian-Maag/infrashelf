import { describe, it, expect } from 'vitest'
import { buildOrderDocument, ORDER_DOCUMENT_VERSION, type OrderDocumentSource } from './orderDocument'
import { REDACTED } from '@/lib/services/parameterRedaction'

/**
 * The order document's shape is an interface someone else writes policies
 * against (issue #110), so these tests are about the CONTRACT rather than about
 * the code: what the engine receives, key by key, and what must never be in it.
 */

const source = (over: Partial<OrderDocumentSource> = {}): OrderDocumentSource => ({
  projectId: 7,
  productId: 42,
  environmentId: 3,
  sizeCode: 'M',
  quantity: 2,
  isTrial: false,
  costCenterId: 11,
  parameters: { instance_type: 't3.large', db_password: 'hunter2' },
  ...over,
})

const requester = { id: 5, email: 'pm@example.com', role: 'project_manager' as const }

describe('buildOrderDocument', () => {
  it('produces exactly the documented shape, key by key', () => {
    /*
     * A full deep equality, deliberately, and not a `toMatchObject`.
     *
     * A rename or a retype inside this object does not break the portal — it
     * breaks every policy written against the old name, silently, and a policy
     * that no longer matches reads as a policy that found nothing wrong. So the
     * assertion is the whole document; if this fails, the fix is to bump
     * ORDER_DOCUMENT_VERSION and say in #110 why the shape moved.
     */
    expect(buildOrderDocument(source(), requester, new Set())).toEqual({
      version: ORDER_DOCUMENT_VERSION,
      projectId: 7,
      productId: 42,
      environmentId: 3,
      size: 'M',
      quantity: 2,
      trial: false,
      costCenterId: 11,
      parameters: { instance_type: 't3.large', db_password: 'hunter2' },
      sensitiveParameters: [],
      requester: { id: 5, email: 'pm@example.com', role: 'project_manager' },
    })
  })

  it('says which document it is, so a policy can be written against one', () => {
    // Pinned rather than derived: a version that changes without a thought is a
    // version that stops being an interface.
    expect(ORDER_DOCUMENT_VERSION).toBe(1)
    expect(buildOrderDocument(source(), requester, new Set()).version).toBe(1)
  })

  it('carries the requester and their role, which is what half the policies ask', () => {
    const doc = buildOrderDocument(source(), { id: 9, email: 'root@example.com', role: 'root' }, new Set())
    expect(doc.requester).toEqual({ id: 9, email: 'root@example.com', role: 'root' })
  })

  it('keeps a null size and a null cost centre as nulls, not as omissions', () => {
    // An absent key and a null are the same to most engines, but not to a policy
    // author reading the shape: "no size defined" and "we forgot to send it" must
    // not look alike.
    const doc = buildOrderDocument(source({ sizeCode: null, costCenterId: null }), requester, new Set())
    expect(doc).toHaveProperty('size', null)
    expect(doc).toHaveProperty('costCenterId', null)
  })
})

describe('the sensitive values that must not reach the engine', () => {
  it('replaces the value and names the parameter instead', () => {
    const doc = buildOrderDocument(source(), requester, new Set(['db_password']))

    expect(doc.parameters.db_password).toBe(REDACTED)
    expect(doc.sensitiveParameters).toEqual(['db_password'])
    // The non-sensitive one is untouched: over-redacting the VALUES would make
    // instance sizing unpoliceable, which is one of the policies #110 names.
    expect(doc.parameters.instance_type).toBe('t3.large')
  })

  it('says the secret is not in the serialised document at all', () => {
    // The assertion that would have caught the original shape: a policy engine is
    // an external system, and `orders.parameters` holds the plaintext (#131
    // redacts it on every read path, not at rest).
    const doc = buildOrderDocument(source(), requester, new Set(['db_password']))
    expect(JSON.stringify(doc)).not.toContain('hunter2')
  })

  it('uses the same sentinel the read paths use, not a second one', () => {
    // A policy that special-cases secrets must be looking at the string the rest
    // of the portal uses, or the two disagree about what a secret looks like.
    const doc = buildOrderDocument(source(), requester, new Set(['db_password']))
    expect(doc.parameters.db_password).toBe(REDACTED)
    expect(REDACTED).toBe('[redacted]')
  })

  it('lists only the names that are actually present, sorted', () => {
    const doc = buildOrderDocument(
      source({ parameters: { zebra_secret: 'a', alpha_secret: 'b', instance_type: 'x' } }),
      requester,
      new Set(['zebra_secret', 'alpha_secret', 'absent_elsewhere']),
    )
    expect(doc.sensitiveParameters).toEqual(['alpha_secret', 'zebra_secret'])
  })

  it('degrades to an empty document rather than throwing on a missing map', () => {
    // `PreparedOrder.parameters` is always an object, but a caller assembling the
    // source by hand is the case this protects, and a gate that throws is a gate
    // that fails closed on a request that was fine.
    const doc = buildOrderDocument(
      source({ parameters: undefined as unknown as Record<string, string> }),
      requester,
      new Set(['db_password']),
    )
    expect(doc.parameters).toEqual({})
    expect(doc.sensitiveParameters).toEqual([])
  })
})
