import { type NextRequest } from 'next/server'
import { requireRole, isAuth } from '@/lib/auth/middleware'
import { toResponse, parseRouteId, invalidId } from '@/lib/http'
import { approveOrder } from '@/lib/services/approvals'

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const session = await requireRole('admin')(req)
  if (!isAuth(session)) return session

  const { id } = await params
  const orderId = parseRouteId(id)
  if (orderId === null) return invalidId('order id')

  /*
   * Root's escape from a policy refusal at the moment of approval (#511).
   *
   * Read from the body rather than a separate endpoint, because it is one
   * decision with the approval itself: "approve this, and waive the rule that
   * refuses it". Whether this caller may use it is decided in the service
   * against the session's role — a body flag is never the authority for a
   * privilege (#195's rule).
   *
   * Parsed leniently: every existing caller posts no body at all, and a
   * required parse would turn each of them into a 500. `?? {}` as well as the
   * catch, because a body of literal `null` PARSES — it is the property read
   * after it that throws.
   */
  const body = ((await req.json().catch(() => null)) ?? {}) as { overridePolicy?: unknown }
  return toResponse(await approveOrder(session, orderId, { overridePolicy: body.overridePolicy === true }))
}
