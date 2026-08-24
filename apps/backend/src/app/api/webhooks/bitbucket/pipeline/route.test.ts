import { describe, it, expect, vi, beforeEach } from 'vitest'
import { NextRequest } from 'next/server'
import { POST } from './route'
import { createCiSource, createEnvironment } from '@/test/helpers'
import { db } from '@/lib/db/client'
import { deploymentEnvironments } from '@/lib/db/schema'
import { eq } from 'drizzle-orm'
import { createHmac } from 'crypto'
import { handlePipelineEvent } from '@/lib/webhook/handler'

vi.mock('@/lib/webhook/handler', () => ({
  handlePipelineEvent: vi.fn().mockResolvedValue(undefined),
}))

const mockedHandle = vi.mocked(handlePipelineEvent)

const WEBHOOK_SECRET = 'bitbucket-test-secret'

const makeSignedRequest = (body: unknown) => {
  const rawBody = JSON.stringify(body)
  const sig = `sha256=${createHmac('sha256', WEBHOOK_SECRET).update(rawBody).digest('hex')}`
  return new NextRequest('http://localhost/api/webhooks/bitbucket/pipeline', {
    method: 'POST',
    body: rawBody,
    headers: { 'content-type': 'application/json', 'x-hub-signature': sig },
  })
}

const makeUnsignedRequest = (body: unknown) =>
  new NextRequest('http://localhost/api/webhooks/bitbucket/pipeline', {
    method: 'POST',
    body: JSON.stringify(body),
    headers: { 'content-type': 'application/json' },
  })

const validPipelineBody = {
  data: {
    uuid: '{abc-def-123}',
    state: {
      name: 'COMPLETED',
      result: { name: 'SUCCESSFUL' },
    },
  },
}

// runs AFTER global beforeEach (which truncates tables), so token is always fresh
beforeEach(async () => {
  mockedHandle.mockClear()
  const ci = await createCiSource()
  await createEnvironment(ci.id, WEBHOOK_SECRET)
})

describe('POST /api/webhooks/bitbucket/pipeline', () => {
  it('returns 401 when no signature header is present', async () => {
    const res = await POST(makeUnsignedRequest(validPipelineBody))
    expect(res.status).toBe(401)
    const body = await res.json()
    expect(body.error).toBe('Missing signature')
  })

  it('accepts valid payload with matching HMAC signature', async () => {
    const res = await POST(makeSignedRequest(validPipelineBody))
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.received).toBe(true)
  })

  it('passes the environment whose secret matched to the handler (event scoping)', async () => {
    const ci2 = await createCiSource({ name: 'CI-Other' })
    await createEnvironment(ci2.id, 'other-secret')

    const [matched] = await db
      .select({ id: deploymentEnvironments.id })
      .from(deploymentEnvironments)
      .where(eq(deploymentEnvironments.callbackSecret, WEBHOOK_SECRET))

    const res = await POST(makeSignedRequest(validPipelineBody))
    expect(res.status).toBe(200)
    expect(mockedHandle).toHaveBeenCalledTimes(1)
    expect(mockedHandle.mock.calls[0][1]).toBe(matched.id)
  })

  it('returns 401 for invalid signature', async () => {
    const rawBody = JSON.stringify(validPipelineBody)
    const req = new NextRequest('http://localhost/api/webhooks/bitbucket/pipeline', {
      method: 'POST',
      body: rawBody,
      headers: { 'content-type': 'application/json', 'x-hub-signature': 'sha256=invalidsignature' },
    })
    const res = await POST(req)
    expect(res.status).toBe(401)
    const body = await res.json()
    expect(body.error).toBe('Invalid signature')
  })

  it('returns 400 for non-JSON body', async () => {
    const rawBody = 'not json'
    const sig = `sha256=${createHmac('sha256', WEBHOOK_SECRET).update(rawBody).digest('hex')}`
    const req = new NextRequest('http://localhost/api/webhooks/bitbucket/pipeline', {
      method: 'POST',
      body: rawBody,
      headers: { 'content-type': 'application/json', 'x-hub-signature': sig },
    })
    const res = await POST(req)
    expect(res.status).toBe(400)
  })

  it('returns 200 received:true when data.uuid is missing', async () => {
    const res = await POST(makeSignedRequest({ data: { state: { name: 'COMPLETED' } } }))
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.received).toBe(true)
  })

  it('maps IN_PROGRESS to running', async () => {
    const res = await POST(
      makeSignedRequest({
        data: { uuid: '{xyz-789}', state: { name: 'IN_PROGRESS' } },
      }),
    )
    expect(res.status).toBe(200)
  })

  it('maps COMPLETED FAILED to failed', async () => {
    const res = await POST(
      makeSignedRequest({
        data: { uuid: '{xyz-000}', state: { name: 'COMPLETED', result: { name: 'FAILED' } } },
      }),
    )
    expect(res.status).toBe(200)
  })

  it('maps PENDING state correctly', async () => {
    const res = await POST(
      makeSignedRequest({
        data: { uuid: '{pending-uuid}', state: { name: 'PENDING' } },
      }),
    )
    expect(res.status).toBe(200)
  })

  it('maps COMPLETED ERROR to failed', async () => {
    const res = await POST(
      makeSignedRequest({
        data: { uuid: '{error-uuid}', state: { name: 'COMPLETED', result: { name: 'ERROR' } } },
      }),
    )
    expect(res.status).toBe(200)
  })

  // Regression: inbound callbacks must be verified against callback_secret, not
  // the outbound webhook_token. When an operator rotates the two apart, a
  // callback signed with the callback_secret is accepted and one signed with
  // the webhook_token is rejected.
  it('validates the signature against callback_secret, not webhook_token', async () => {
    const ci = await createCiSource()
    await db.insert(deploymentEnvironments).values({
      name: 'Rotated Env',
      ciSourceId: ci.id,
      webhookUrl: 'https://example.com/trigger',
      webhookToken: 'outbound-trigger-token',
      callbackSecret: 'inbound-callback-secret',
    })

    const rawBody = JSON.stringify(validPipelineBody)
    const makeReq = (secret: string) =>
      new NextRequest('http://localhost/api/webhooks/bitbucket/pipeline', {
        method: 'POST',
        body: rawBody,
        headers: {
          'content-type': 'application/json',
          'x-hub-signature': `sha256=${createHmac('sha256', secret).update(rawBody).digest('hex')}`,
        },
      })

    const accepted = await POST(makeReq('inbound-callback-secret'))
    expect(accepted.status).toBe(200)

    const rejected = await POST(makeReq('outbound-trigger-token'))
    expect(rejected.status).toBe(401)
  })

  // Migration 0006 makes callback_secret UNIQUE, but a DB that hasn't been
  // migrated can still hold duplicates from the 0004 backfill of the
  // (non-unique) webhook_token. Two environments sharing a secret produce the
  // SAME valid HMAC, so the first match is arbitrary — the route must refuse
  // rather than scope the event to the wrong environment.
  it('rejects a signature that matches more than one environment instead of guessing', async () => {
    const { sql } = await import('drizzle-orm')
    await db.execute(
      sql`ALTER TABLE deployment_environments DROP CONSTRAINT deployment_environments_callback_secret_unique`,
    )
    try {
      const ci2 = await createCiSource({ name: 'CI-dup' })
      await createEnvironment(ci2.id, WEBHOOK_SECRET)

      const res = await POST(makeSignedRequest(validPipelineBody))
      expect(res.status).toBe(409)
      const body = await res.json()
      expect(body.error).toBe('Ambiguous callback secret')
      expect(mockedHandle).not.toHaveBeenCalled()
    } finally {
      await db.execute(sql`DELETE FROM deployment_environments WHERE callback_secret = ${WEBHOOK_SECRET}`)
      await db.execute(
        sql`ALTER TABLE deployment_environments ADD CONSTRAINT deployment_environments_callback_secret_unique UNIQUE (callback_secret)`,
      )
    }
  })

  // Issue #140. Migration 0004 backfilled callback_secret from the free-text
  // webhook_token and 0006 rotated only duplicates, so an environment created
  // with a blank trigger token keeps callback_secret = ''. HMAC keyed on a blank
  // string is one anyone can compute, so before the fix these two requests —
  // forged with no secret knowledge at all — were accepted, and could transition
  // any pipeline id belonging to that environment.
  it.each([
    ['empty', ''],
    ['whitespace', '   '],
  ])('refuses a signature forged with a %s callback secret', async (_label, secret) => {
    const ci = await createCiSource({ name: `CI-blank-${_label}` })
    await db.insert(deploymentEnvironments).values({
      name: 'Legacy Env',
      ciSourceId: ci.id,
      webhookUrl: 'https://example.com/trigger',
      webhookToken: secret,
      callbackSecret: secret,
    })

    const rawBody = JSON.stringify(validPipelineBody)
    const res = await POST(
      new NextRequest('http://localhost/api/webhooks/bitbucket/pipeline', {
        method: 'POST',
        body: rawBody,
        headers: {
          'content-type': 'application/json',
          'x-hub-signature': `sha256=${createHmac('sha256', secret).update(rawBody).digest('hex')}`,
        },
      }),
    )

    expect(res.status).toBe(401)
    expect(mockedHandle).not.toHaveBeenCalled()
  })
})
