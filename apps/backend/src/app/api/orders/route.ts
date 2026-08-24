import { type NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import { requireAuth, isAuth } from '@/lib/auth/middleware'
import { toResponse, requestLang } from '@/lib/http'
import { listOrders, createOrder } from '@/lib/services/orders'
import { SIZE_CODE_MAX_LENGTH } from '@/lib/services/sizes'

const CreateOrderSchema = z.object({
  projectId: z.number().int().positive(),
  productId: z.number().int().positive(),
  environmentId: z.number().int().positive(),
  costCenterId: z.number().int().positive().optional(),
  parameters: z.record(z.string()),
  // Time-boxed trial (issue #1). The offering must be trial-enabled; the service
  // checks that rather than trusting the client, since the toggle is simply
  // hidden for products that do not offer one.
  trial: z.boolean().optional(),
  // The chosen size (issue #98). Mandatory for an offering that defines sizes and
  // refused for one that does not — the service decides, because the picker is
  // simply absent in the browser for an offering with none.
  sizeCode: z.string().min(1).max(SIZE_CODE_MAX_LENGTH).nullable().optional(),
  // One order, N infrastructure elements (issue #104). Capped by the service.
  quantity: z.number().int().positive().optional(),
})

export async function GET(req: NextRequest) {
  const session = await requireAuth(req)
  if (!isAuth(session)) return session

  return toResponse(await listOrders(session, requestLang(req)))
}

export async function POST(req: NextRequest) {
  const session = await requireAuth(req)
  if (!isAuth(session)) return session

  const body = await req.json().catch(() => null)
  const parsed = CreateOrderSchema.safeParse(body)
  if (!parsed.success) {
    return NextResponse.json({ error: 'Invalid request', details: parsed.error.flatten() }, { status: 400 })
  }

  return toResponse(await createOrder(session, parsed.data), 201)
}
