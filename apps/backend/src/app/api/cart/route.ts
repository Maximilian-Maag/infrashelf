import { type NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import { requireAuth, isAuth } from '@/lib/auth/middleware'
import { toResponse, requestLang } from '@/lib/http'
import { listCart, addToCart, clearCart, pruneOrphanedCartItems } from '@/lib/services/cart'
import { SIZE_CODE_MAX_LENGTH } from '@/lib/services/sizes'

const AddToCartSchema = z.object({
  productId: z.number().int().positive(),
  environmentId: z.number().int().positive(),
  // Prefill only — validated at checkout, not here. See the service for why.
  parameters: z.record(z.string()).optional(),
  // The chosen size (issue #98) and how many elements the line asks for (#104).
  // Both ARE validated here, by the service: unlike the parameters they are not
  // filled in later, they are what the line is.
  sizeCode: z.string().min(1).max(SIZE_CODE_MAX_LENGTH).nullable().optional(),
  quantity: z.number().int().positive().optional(),
})

export async function GET(req: NextRequest) {
  const session = await requireAuth(req)
  if (!isAuth(session)) return session

  // Drop items whose product has been deleted before listing, so the overview
  // never shows a row that checkout could not possibly accept.
  await pruneOrphanedCartItems(session)
  return toResponse(await listCart(session, requestLang(req)))
}

export async function POST(req: NextRequest) {
  const session = await requireAuth(req)
  if (!isAuth(session)) return session

  const parsed = AddToCartSchema.safeParse(await req.json().catch(() => null))
  if (!parsed.success) {
    return NextResponse.json({ error: 'Invalid request', details: parsed.error.flatten() }, { status: 400 })
  }

  return toResponse(await addToCart(session, parsed.data, requestLang(req)), 201)
}

export async function DELETE(req: NextRequest) {
  const session = await requireAuth(req)
  if (!isAuth(session)) return session

  return toResponse(await clearCart(session))
}
