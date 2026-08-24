import { type NextRequest, NextResponse } from 'next/server'
import { requireAuth, isAuth } from '@/lib/auth/middleware'
import { toResponse, requestLang } from '@/lib/http'
import { getCostReport, assertMaySeeProject } from '@/lib/services/costs'
import { parseCostFilters } from '@/lib/services/costFilters'

/**
 * Spending overview (issue #32).
 *
 * Open to any authenticated user, scoped by role inside the service: a project
 * manager sees the projects they own, an admin and root see everything.
 */
export async function GET(req: NextRequest) {
  const session = await requireAuth(req)
  if (!isAuth(session)) return session

  const filters = parseCostFilters(new URL(req.url).searchParams)
  if (!filters.ok) return NextResponse.json({ error: filters.message }, { status: filters.status })

  // Checked explicitly so an unauthorised projectId is refused rather than
  // returning an empty report, which reads as "no spend" instead of "not yours".
  if (filters.data.projectId !== undefined) {
    const allowed = await assertMaySeeProject(session, filters.data.projectId)
    if (!allowed.ok) return NextResponse.json({ error: allowed.message }, { status: allowed.status })
  }

  return toResponse(await getCostReport(session, filters.data, requestLang(req)))
}
