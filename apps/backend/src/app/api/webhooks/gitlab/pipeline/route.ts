import { type NextRequest, NextResponse } from 'next/server'
import { handlePipelineEvent } from '@/lib/webhook/handler'
import { db } from '@/lib/db/client'
import { deploymentEnvironments } from '@/lib/db/schema'
import { eq } from 'drizzle-orm'
import type { PipelineEvent } from '@open-hybrid-cloud/types'

interface GitLabPipelineBody {
  object_kind: string
  object_attributes: {
    id: number
    status: string
  }
}

const mapGitLabStatus = (
  status: string,
): PipelineEvent['status'] => {
  switch (status) {
    case 'success':
      return 'success'
    case 'failed':
      return 'failed'
    case 'running':
      return 'running'
    case 'pending':
    case 'created':
    case 'waiting_for_resource':
    case 'preparing':
      return 'pending'
    case 'canceled':
    case 'skipped':
      return 'canceled'
    default:
      return 'pending'
  }
}

export async function POST(req: NextRequest) {
  const token = req.headers.get('x-gitlab-token')

  // This is also what keeps an environment with a blank callback_secret
  // unreachable, which is why this route needed no change for issue #140 while
  // the two HMAC routes did. The lookup below is an equality and the runtime
  // strips surrounding whitespace from header values (`new Headers({x: '  '})`
  // reads back as ''), so a token that gets past this line is non-blank and can
  // only ever match a non-blank secret. What did affect GitLab is the reuse of
  // the outbound trigger token as the inbound secret — migration 0025.
  if (!token) {
    return NextResponse.json({ error: 'Missing token' }, { status: 401 })
  }

  // Validate against the portal-generated callback_secret — separate from
  // webhook_token (the outbound trigger token) since migration 0004. During
  // the rollout the two are identical for legacy environments (see the
  // backfill in 0004_add_callback_secret.sql), so this stays backward
  // compatible for setups that haven't rotated yet.
  // Fetch up to TWO matches: callback_secret is UNIQUE since migration 0006,
  // but a DB that hasn't been migrated yet can still hold duplicates from the
  // 0004 backfill of the (non-unique) webhook_token. Attributing the event to
  // an arbitrary one of them would silently apply it to the wrong environment,
  // so refuse instead of guessing.
  const envRows = await db
    .select({ id: deploymentEnvironments.id })
    .from(deploymentEnvironments)
    .where(eq(deploymentEnvironments.callbackSecret, token))
    .limit(2)

  if (!envRows.length) {
    return NextResponse.json({ error: 'Invalid token' }, { status: 401 })
  }

  if (envRows.length > 1) {
    console.error(
      '[webhook] Ambiguous callback secret — shared by environments',
      envRows.map((e) => e.id).join(', '),
      '— rotate them (Admin → Environments) so each is unique.',
    )
    return NextResponse.json({ error: 'Ambiguous callback secret' }, { status: 409 })
  }

  const body = await req.json().catch(() => null) as GitLabPipelineBody | null

  if (!body || body.object_kind !== 'pipeline' || !body.object_attributes) {
    return NextResponse.json({ error: 'Invalid payload' }, { status: 400 })
  }

  const event: PipelineEvent = {
    provider: 'gitlab',
    pipelineId: String(body.object_attributes.id),
    status: mapGitLabStatus(body.object_attributes.status),
  }

  await handlePipelineEvent(event, envRows[0].id)

  return NextResponse.json({ received: true })
}
