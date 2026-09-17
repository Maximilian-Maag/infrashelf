import { type NextRequest, NextResponse } from 'next/server'
import { requireRole, isAuth } from '@/lib/auth/middleware'
import { toResponse } from '@/lib/http'
import { reconcileForemanHosts } from '@/lib/services/admin/foremanReconcile'

/**
 * What Foreman has, against what this environment ordered (#111).
 *
 * GET, and root-only like the rest of the registry. It reads Foreman and writes
 * nothing — not even `last_contacted_at`, which is the probe's to own: a
 * reconciliation that quietly doubled as a health check would make "when did
 * this last work" mean two different things depending on who asked.
 *
 * The environment is required rather than defaulted. "All environments" would be
 * one report built from several Foremans, in which a ghost cannot be read
 * without knowing which inventory was searched for it.
 */
export async function GET(req: NextRequest) {
  const session = await requireRole('root')(req)
  if (!isAuth(session)) return session

  const raw = req.nextUrl.searchParams.get('environmentId')
  const environmentId = Number(raw)
  if (raw === null || !Number.isInteger(environmentId) || environmentId <= 0) {
    return NextResponse.json({ error: 'environmentId is required' }, { status: 400 })
  }

  return toResponse(await reconcileForemanHosts(environmentId))
}
