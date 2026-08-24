import { type NextRequest } from 'next/server'
import { requireAuth, isAuth } from '@/lib/auth/middleware'
import { toResponse, parseRouteId, invalidId, requestLang } from '@/lib/http'
import { getOrderById } from '@/lib/services/orders'

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const session = await requireAuth(req)
  if (!isAuth(session)) return session

  const { id } = await params
  const orderId = parseRouteId(id)
  if (orderId === null) return invalidId('order id')
  return toResponse(await getOrderById(session, orderId, requestLang(req)))
}
