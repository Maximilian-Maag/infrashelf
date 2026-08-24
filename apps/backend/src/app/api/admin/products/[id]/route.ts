import { type NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import { requireRole, isAuth } from '@/lib/auth/middleware'
import { toResponse, parseRouteId, invalidId, requestLang } from '@/lib/http'
import { getProductAdmin, updateProduct, deleteProduct } from '@/lib/services/admin/products'

const UpdateProductSchema = z.object({
  categoryId: z.number().int().positive().optional(),
  baseLanguage: z.string().optional(),
  name: z.string().min(1).optional(),
  description: z.string().optional(),
  // Optional free text describing the change (issue #38).
  changelog: z.string().max(2000).optional(),
})

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const session = await requireRole('root')(req)
  if (!isAuth(session)) return session

  const { id } = await params
  const productId = parseRouteId(id)
  if (productId === null) return invalidId('product id')
  return toResponse(await getProductAdmin(productId, requestLang(req)))
}

export async function PUT(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const session = await requireRole('root')(req)
  if (!isAuth(session)) return session

  const { id } = await params
  const productId = parseRouteId(id)
  if (productId === null) return invalidId('product id')
  const body = await req.json().catch(() => null)
  const parsed = UpdateProductSchema.safeParse(body)
  if (!parsed.success) {
    return NextResponse.json({ error: 'Invalid request', details: parsed.error.flatten() }, { status: 400 })
  }

  // The author comes from the session, never the body — a history entry that could
  // be attributed to somebody else is not a history.
  return toResponse(await updateProduct(productId, { ...parsed.data, userId: session.id }))
}

export async function DELETE(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const session = await requireRole('root')(req)
  if (!isAuth(session)) return session

  const { id } = await params
  const productId = parseRouteId(id)
  if (productId === null) return invalidId('product id')
  return toResponse(await deleteProduct(productId, session.id))
}
