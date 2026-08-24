import { type NextRequest, NextResponse } from 'next/server'
import { createHmac, timingSafeEqual } from 'crypto'
import { handlePipelineEvent } from '@/lib/webhook/handler'
import { isUsableCallbackSecret } from '@/lib/webhook/callback-secret'
import { db } from '@/lib/db/client'
import { deploymentEnvironments } from '@/lib/db/schema'
import type { PipelineEvent } from '@open-hybrid-cloud/types'

interface BitbucketPipelineBody {
  data: {
    uuid: string
    state: {
      name: string
      result?: { name: string }
    }
  }
}

const mapBitbucketStatus = (
  stateName: string,
  resultName?: string,
): PipelineEvent['status'] => {
  switch (stateName) {
    case 'COMPLETED':
      if (resultName === 'SUCCESSFUL') return 'success'
      if (resultName === 'FAILED' || resultName === 'ERROR') return 'failed'
      return 'canceled'
    case 'IN_PROGRESS':
      return 'running'
    case 'PENDING':
      return 'pending'
    default:
      return 'pending'
  }
}

export async function POST(req: NextRequest) {
  const signature = req.headers.get('x-hub-signature')
  const rawBody = await req.text()

  if (!signature) {
    return NextResponse.json({ error: 'Missing signature' }, { status: 401 })
  }

  // Validate against the inbound callback_secret, not the outbound
  // webhook_token used to trigger pipelines (migration 0004 split the two).
  // Legacy environments have callback_secret backfilled to webhook_token.
  // Identify WHICH environment the signature belongs to so the event is scoped
  // to that environment — one env's secret must not transition another's orders.
  const envRows = await db
    .select({ id: deploymentEnvironments.id, callbackSecret: deploymentEnvironments.callbackSecret })
    .from(deploymentEnvironments)

  // Drop blank secrets before any HMAC is computed. HMAC keyed on the empty
  // string is one every caller can compute, so a single environment left in that
  // state by the 0004 backfill would authenticate anyone who can reach this
  // endpoint (issue #140).
  const usableEnvs = envRows.filter((env) => isUsableCallbackSecret(env.callbackSecret))

  // Collect ALL matches rather than the first: callback_secret is UNIQUE since
  // migration 0006, but a DB that hasn't been migrated yet can still hold
  // duplicates from the 0004 backfill of the (non-unique) webhook_token. Two
  // environments sharing a secret produce the same HMAC, and attributing the
  // event to an arbitrary one of them would silently apply it to the wrong
  // environment — refuse instead of guessing.
  const matchedEnvs = usableEnvs.filter((env) => {
    const expected = `sha256=${createHmac('sha256', env.callbackSecret).update(rawBody).digest('hex')}`
    try {
      return timingSafeEqual(Buffer.from(expected), Buffer.from(signature))
    } catch {
      return false
    }
  })

  if (!matchedEnvs.length) {
    if (usableEnvs.length < envRows.length) {
      // Only on the rejection path: a callback arriving every few seconds would
      // bury this if it were logged unconditionally.
      console.warn(
        '[webhook] Skipped environments with a blank callback secret —',
        envRows.filter((env) => !isUsableCallbackSecret(env.callbackSecret)).map((e) => e.id).join(', '),
        '— rotate them (Admin → Environments); their callbacks stay refused until then.',
      )
    }
    return NextResponse.json({ error: 'Invalid signature' }, { status: 401 })
  }

  if (matchedEnvs.length > 1) {
    console.error(
      '[webhook] Ambiguous callback secret — shared by environments',
      matchedEnvs.map((e) => e.id).join(', '),
      '— rotate them (Admin → Environments) so each is unique.',
    )
    return NextResponse.json({ error: 'Ambiguous callback secret' }, { status: 409 })
  }

  const matchedEnv = matchedEnvs[0]

  let body: BitbucketPipelineBody
  try {
    body = JSON.parse(rawBody)
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 })
  }

  if (!body.data?.uuid) {
    return NextResponse.json({ received: true })
  }

  const event: PipelineEvent = {
    provider: 'bitbucket',
    pipelineId: body.data.uuid,
    status: mapBitbucketStatus(
      body.data.state?.name ?? '',
      body.data.state?.result?.name,
    ),
  }

  await handlePipelineEvent(event, matchedEnv.id)

  return NextResponse.json({ received: true })
}
