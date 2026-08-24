import { type NextRequest } from 'next/server'
import { requireRole, isAuth } from '@/lib/auth/middleware'
import { toResponse, requestLang } from '@/lib/http'
import { listApprovals } from '@/lib/services/approvals'

export async function GET(req: NextRequest) {
  const session = await requireRole('admin')(req)
  if (!isAuth(session)) return session

  return toResponse(await listApprovals(requestLang(req)))
}
