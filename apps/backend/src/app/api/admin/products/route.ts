import { type NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import { requireRole, isAuth } from '@/lib/auth/middleware'
import { toResponse, requestLang } from '@/lib/http'
import { listProducts, createProduct } from '@/lib/services/admin/products'
import { parsePageWindow } from '@/lib/services/page'

const CreateProductSchema = z.object({
  categoryId: z.number().int().positive(),
  baseLanguage: z.string().default('de'),
  name: z.string().min(1),
  description: z.string().default(''),
})

export async function GET(req: NextRequest) {
  const session = await requireRole('root')(req)
  if (!isAuth(session)) return session

  const window = parsePageWindow(new URL(req.url).searchParams)
  if (window === 'invalid') {
    return NextResponse.json(
      { error: 'Invalid limit or offset — expected a non-negative whole number' },
      { status: 400 },
    )
  }

  return toResponse(await listProducts(requestLang(req), window))
}

export async function POST(req: NextRequest) {
  const session = await requireRole('root')(req)
  if (!isAuth(session)) return session

  const body = await req.json().catch(() => null)
  const parsed = CreateProductSchema.safeParse(body)
  if (!parsed.success) {
    return NextResponse.json({ error: 'Invalid request', details: parsed.error.flatten() }, { status: 400 })
  }

  return toResponse(await createProduct(parsed.data, session.id), 201)
}
