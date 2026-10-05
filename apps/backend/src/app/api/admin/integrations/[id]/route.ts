import { type NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import { integrationBaseUrl } from '@/lib/integrations/baseUrl'
import { requireRole, isAuth } from '@/lib/auth/middleware'
import { toResponse, parseRouteId } from '@/lib/http'
import {
  getIntegrationById,
  updateIntegration,
  deleteIntegration,
} from '@/lib/services/admin/integrations'
import { INTEGRATION_AUTH_TYPES, INTEGRATION_FAILURE_MODES } from '@/lib/db/schema'

// `kind` is absent on purpose: changing it would keep the credential, the health
// record and the audit history of a Foreman on a row that now claims to be a
// Nexus. Delete and recreate.
const UpdateIntegrationSchema = z.object({
  name: z.string().min(1).optional(),
  baseUrl: integrationBaseUrl().optional(),
  authType: z.enum(INTEGRATION_AUTH_TYPES).optional(),
  username: z.string().optional(),
  // Sending this rotates the credential; omitting it leaves the stored one
  // alone. There is no way to say "clear it" — that is what authType 'none' is.
  credential: z.string().min(1).optional(),
  // Loki multi-tenancy (#551). Null or empty string clears the tenant.
  tenant: z.string().nullable().optional(),
  environmentId: z.number().int().positive().nullable().optional(),
  enabled: z.boolean().optional(),
  failureMode: z.enum(INTEGRATION_FAILURE_MODES).optional(),
})

const badId = () => NextResponse.json({ error: 'Invalid integration id' }, { status: 400 })

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const session = await requireRole('root')(req)
  if (!isAuth(session)) return session

  const id = parseRouteId((await params).id)
  if (id === null) return badId()

  return toResponse(await getIntegrationById(id))
}

export async function PUT(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const session = await requireRole('root')(req)
  if (!isAuth(session)) return session

  const id = parseRouteId((await params).id)
  if (id === null) return badId()

  const body = await req.json().catch(() => null)
  const parsed = UpdateIntegrationSchema.safeParse(body)
  if (!parsed.success) {
    return NextResponse.json({ error: 'Invalid request', details: parsed.error.flatten() }, { status: 400 })
  }

  return toResponse(await updateIntegration(session.id, id, parsed.data))
}

export async function DELETE(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const session = await requireRole('root')(req)
  if (!isAuth(session)) return session

  const id = parseRouteId((await params).id)
  if (id === null) return badId()

  return toResponse(await deleteIntegration(session.id, id))
}
