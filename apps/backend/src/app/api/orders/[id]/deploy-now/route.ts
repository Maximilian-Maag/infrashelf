import { type NextRequest, NextResponse } from 'next/server'
import { requireRole, isAuth } from '@/lib/auth/middleware'
import { parseRouteId, invalidId } from '@/lib/http'
import { deployScheduledOrderNow } from '@/lib/services/windowPolicy'

/**
 * Root deploys a scheduled order without waiting for its window (#330).
 *
 * Root, not admin. An admin approving an order is deciding that the order
 * should happen; this is deciding that it should happen NOW, outside the hours
 * the company said it watches its own systems — which is the guarantee the
 * whole feature exists to make, so stepping over it is root's call and is
 * audited as one.
 *
 * POST rather than PATCH on the order: it is an action with an effect, not a
 * field being edited, and it is the effect that has to be recorded.
 */
export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const session = await requireRole('root')(req)
  if (!isAuth(session)) return session

  const { id } = await params
  const orderId = parseRouteId(id)
  if (orderId === null) return invalidId('order id')

  /*
   * Root's escapes, read from the body (#519). This route is root-only, so the
   * role check has already happened — but whether a privilege exists is still
   * decided against the session (inside `recheckOrderGates`) and never by the
   * flag, which is only what the caller asked for.
   *
   * Parsed leniently, like the approve route: every existing caller posts no
   * body, and `?? {}` as well as the catch because a body of literal `null`
   * parses and it is the property read after it that throws.
   */
  const body = ((await req.json().catch(() => null)) ?? {}) as {
    overridePolicy?: unknown
    overrideBudget?: unknown
  }

  const outcome = await deployScheduledOrderNow(orderId, session, new Date(), {
    overridePolicy: body.overridePolicy === true,
    overrideBudget: body.overrideBudget === true,
  })
  if (!outcome.ok) {
    return NextResponse.json(
      { error: outcome.message, ...(outcome.code ? { code: outcome.code } : {}) },
      { status: outcome.status },
    )
  }
  return NextResponse.json({ success: true })
}
