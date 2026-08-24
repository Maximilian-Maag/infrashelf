import { describe, it, expect, vi, beforeEach } from 'vitest'
import { NextRequest } from 'next/server'
import { POST } from './route'
import { createCiSource, createEnvironment } from '@/test/helpers'
import { handlePipelineEvent } from '@/lib/webhook/handler'
import { db } from '@/lib/db/client'
import { deploymentEnvironments } from '@/lib/db/schema'
import { eq } from 'drizzle-orm'

vi.mock('@/lib/webhook/handler', () => ({
  handlePipelineEvent: vi.fn().mockResolvedValue(undefined),
}))

const mockedHandle = vi.mocked(handlePipelineEvent)
beforeEach(() => mockedHandle.mockClear())

const VALID_TOKEN = 'gitlab-valid-token'

const validPayload = {
  object_kind: 'pipeline',
  object_attributes: { id: 123, status: 'success' },
}

const makeRequest = (body: unknown, token?: string) => {
  const headers: Record<string, string> = { 'content-type': 'application/json' }
  if (token) headers['x-gitlab-token'] = token
  return new NextRequest('http://localhost/api/webhooks/gitlab/pipeline', {
    method: 'POST',
    body: JSON.stringify(body),
    headers,
  })
}

// runs AFTER global beforeEach (which truncates tables), so token is always fresh
beforeEach(async () => {
  const ci = await createCiSource()
  await createEnvironment(ci.id, VALID_TOKEN)
})

describe('POST /api/webhooks/gitlab/pipeline', () => {
  it('returns 401 when no token header is present', async () => {
    const res = await POST(makeRequest(validPayload))
    expect(res.status).toBe(401)
    const body = await res.json()
    expect(body.error).toBe('Missing token')
  })

  it('accepts a valid payload with a matching token', async () => {
    const res = await POST(makeRequest(validPayload, VALID_TOKEN))
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.received).toBe(true)
  })

  it('passes the matched environment id to the handler (event scoping)', async () => {
    const [env] = await db
      .select({ id: deploymentEnvironments.id })
      .from(deploymentEnvironments)
      .where(eq(deploymentEnvironments.callbackSecret, VALID_TOKEN))

    const res = await POST(makeRequest(validPayload, VALID_TOKEN))
    expect(res.status).toBe(200)
    expect(mockedHandle).toHaveBeenCalledTimes(1)
    expect(mockedHandle.mock.calls[0][1]).toBe(env.id)
  })

  it('returns 401 for an unknown token', async () => {
    const res = await POST(makeRequest(validPayload, 'invalid-token'))
    expect(res.status).toBe(401)
    const body = await res.json()
    expect(body.error).toBe('Invalid token')
  })

  it('returns 400 for wrong object_kind', async () => {
    const res = await POST(makeRequest({ object_kind: 'push', object_attributes: { id: 1 } }, VALID_TOKEN))
    expect(res.status).toBe(400)
  })

  it('returns 400 for missing object_attributes', async () => {
    const res = await POST(makeRequest({ object_kind: 'pipeline' }, VALID_TOKEN))
    expect(res.status).toBe(400)
  })

  it('returns 400 for non-JSON body', async () => {
    const req = new NextRequest('http://localhost/api/webhooks/gitlab/pipeline', {
      method: 'POST',
      body: 'not json',
      headers: { 'content-type': 'application/json', 'x-gitlab-token': VALID_TOKEN },
    })
    const res = await POST(req)
    expect(res.status).toBe(400)
  })

  it('maps gitlab running status and returns 200', async () => {
    const res = await POST(
      makeRequest({ object_kind: 'pipeline', object_attributes: { id: 99, status: 'running' } }, VALID_TOKEN),
    )
    expect(res.status).toBe(200)
  })

  it('maps canceled status correctly', async () => {
    const res = await POST(
      makeRequest({ object_kind: 'pipeline', object_attributes: { id: 100, status: 'canceled' } }, VALID_TOKEN),
    )
    expect(res.status).toBe(200)
  })

  it('maps failed status correctly', async () => {
    const res = await POST(
      makeRequest({ object_kind: 'pipeline', object_attributes: { id: 101, status: 'failed' } }, VALID_TOKEN),
    )
    expect(res.status).toBe(200)
  })

  // Regression for migration 0004: after separating callback_secret from
  // webhook_token, a rotated trigger token must NOT unlock the webhook while
  // callback_secret still holds a different value.
  it('validates X-Gitlab-Token against callback_secret, not the outbound trigger token', async () => {
    // Rotate webhook_token in the DB so it no longer matches the callback_secret
    // seeded by createEnvironment (which set both to VALID_TOKEN).
    await db.update(deploymentEnvironments).set({ webhookToken: 'rotated-trigger-only' })
      .where(eq(deploymentEnvironments.webhookToken, VALID_TOKEN))

    // Old token still matches callback_secret (the backfill's value) → accepted.
    const okRes = await POST(makeRequest(validPayload, VALID_TOKEN))
    expect(okRes.status).toBe(200)

    // New trigger token is NOT the callback secret → rejected.
    const denyRes = await POST(makeRequest(validPayload, 'rotated-trigger-only'))
    expect(denyRes.status).toBe(401)
  })

  // Migration 0006 makes callback_secret UNIQUE, but a DB that hasn't been
  // migrated can still hold duplicates from the 0004 backfill of the
  // (non-unique) webhook_token. The constraint is dropped here to reproduce
  // that state: picking one of the matching environments arbitrarily would
  // apply the event to the wrong one, so the route must refuse.
  it('rejects a callback secret shared by more than one environment instead of guessing', async () => {
    const { sql } = await import('drizzle-orm')
    await db.execute(
      sql`ALTER TABLE deployment_environments DROP CONSTRAINT deployment_environments_callback_secret_unique`,
    )
    try {
      const ci2 = await createCiSource({ name: 'CI-dup' })
      await createEnvironment(ci2.id, VALID_TOKEN)

      const res = await POST(makeRequest(validPayload, VALID_TOKEN))
      expect(res.status).toBe(409)
      const body = await res.json()
      expect(body.error).toBe('Ambiguous callback secret')
      // Nothing was transitioned.
      expect(mockedHandle).not.toHaveBeenCalled()
    } finally {
      await db.execute(sql`DELETE FROM deployment_environments WHERE callback_secret = ${VALID_TOKEN}`)
      await db.execute(
        sql`ALTER TABLE deployment_environments ADD CONSTRAINT deployment_environments_callback_secret_unique UNIQUE (callback_secret)`,
      )
    }
  })
})
