import { type NextRequest, NextResponse } from 'next/server'
import { requireAuth, isAuth } from '@/lib/auth/middleware'
import { toResponse, requestLang } from '@/lib/http'
import { listInfrastructure } from '@/lib/services/infrastructure'
import { parseInfraFilters } from '@/lib/services/infraFilters'

export async function GET(req: NextRequest) {
  const session = await requireAuth(req)
  if (!isAuth(session)) return session

  const { searchParams } = new URL(req.url)
  const filters = parseInfraFilters(searchParams)
  if (!filters.ok) {
    return NextResponse.json({ error: filters.message }, { status: filters.status })
  }

  return toResponse(await listInfrastructure(session, filters.data, requestLang(req)))
}
