import { type NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import { requireRole, isAuth } from '@/lib/auth/middleware'
import { toResponse } from '@/lib/http'
import { getBranding, updateBranding } from '@/lib/services/admin/branding'

const UpdateBrandingSchema = z.object({
  primaryColor: z.string().optional(),
  secondaryColor: z.string().optional(),
  shopName: z.string().optional(),
  shopSubtitle: z.string().optional(),
  imprintText: z.string().optional(),
})

// Root-only, matching PUT. The payload is the same six fields
// /api/public/branding serves anonymously, so this closed no leak that existed
// on the day it was written — it closes the one that arrives with the next
// column added to brandingPublicColumns (issue #140). Callers that legitimately
// have no session (the login page) and callers whose role is below root (the
// dashboard shell, rendered for project managers) use the public route.
export async function GET(req: NextRequest) {
  const session = await requireRole('root')(req)
  if (!isAuth(session)) return session

  return toResponse(await getBranding())
}

export async function PUT(req: NextRequest) {
  const session = await requireRole('root')(req)
  if (!isAuth(session)) return session

  const body = await req.json().catch(() => null)
  const parsed = UpdateBrandingSchema.safeParse(body)
  if (!parsed.success) {
    return NextResponse.json({ error: 'Invalid request', details: parsed.error.flatten() }, { status: 400 })
  }

  return toResponse(await updateBranding(parsed.data, session.id))
}
