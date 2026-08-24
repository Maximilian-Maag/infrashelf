import { type NextRequest, NextResponse } from 'next/server'
import { requireAuth, isAuth } from '@/lib/auth/middleware'
import { toResponse, parseRouteId, requestLang } from '@/lib/http'
import { getInfrastructureElement } from '@/lib/services/infrastructure'

/**
 * One infrastructure element (issue #96).
 *
 * Scoped exactly as the list is: a project manager sees the projects they own, an
 * admin and root see everything. An element outside that scope answers 404 rather
 * than 403, because "this id exists" is itself information about another project.
 */
export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const session = await requireAuth(req)
  if (!isAuth(session)) return session

  const { id } = await params
  const elementId = parseRouteId(id)
  if (elementId === null) {
    return NextResponse.json({ error: 'Invalid infrastructure id' }, { status: 400 })
  }

  return toResponse(await getInfrastructureElement(session, elementId, requestLang(req)))
}
