import { type NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import { integrationBaseUrl } from '@/lib/integrations/baseUrl'
import { requireRole, isAuth } from '@/lib/auth/middleware'
import { toResponse } from '@/lib/http'
import { listIntegrations, createIntegration } from '@/lib/services/admin/integrations'
import {
  INTEGRATION_KINDS,
  INTEGRATION_AUTH_TYPES,
  INTEGRATION_FAILURE_MODES,
} from '@/lib/db/schema'

/**
 * The integration registry (issue #111). Root-only throughout, like CI sources:
 * these rows hold credentials to systems that can provision and destroy
 * infrastructure, which is a narrower audience than the admin catalogue.
 */

const CreateIntegrationSchema = z.object({
  kind: z.enum(INTEGRATION_KINDS),
  name: z.string().min(1),
  baseUrl: integrationBaseUrl(),
  authType: z.enum(INTEGRATION_AUTH_TYPES),
  username: z.string().optional(),
  credential: z.string().min(1).optional(),
  // Loki multi-tenancy (#551). Empty string is treated as null (single-tenant).
  tenant: z.string().nullable().optional(),
  // Explicit null is how "portal-wide" is said; omitting it means the same, but
  // nullable() lets a form submit the field it renders.
  environmentId: z.number().int().positive().nullable().optional(),
  enabled: z.boolean().optional(),
  // NOT optional, and not defaulted. The whole point of storing the failure mode
  // (#111, bullet 5) is that somebody decided it; a default here would hand back
  // the ad-hoc answer the column exists to replace.
  failureMode: z.enum(INTEGRATION_FAILURE_MODES),
})

export async function GET(req: NextRequest) {
  const session = await requireRole('root')(req)
  if (!isAuth(session)) return session

  return toResponse(await listIntegrations())
}

export async function POST(req: NextRequest) {
  const session = await requireRole('root')(req)
  if (!isAuth(session)) return session

  const body = await req.json().catch(() => null)
  const parsed = CreateIntegrationSchema.safeParse(body)
  if (!parsed.success) {
    return NextResponse.json({ error: 'Invalid request', details: parsed.error.flatten() }, { status: 400 })
  }

  return toResponse(await createIntegration(session.id, parsed.data), 201)
}
