import { type NextRequest } from 'next/server'
import { requireAuth, isAuth } from '@/lib/auth/middleware'
import { toResponse, parseRouteId, invalidId } from '@/lib/http'
import { getProduct } from '@/lib/services/catalog'

/**
 * An optional numeric query parameter.
 *
 * Absent or empty reads as "not supplied"; anything present but not an id is a
 * 400 rather than a `NaN` handed to the query builder, which is what `parseInt`
 * did here before (`?environmentId=abc` became `eq(environment_id, NaN)`).
 */
const optionalId = (raw: string | null): number | null | undefined =>
  raw ? parseRouteId(raw) : undefined

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const session = await requireAuth(req)
  if (!isAuth(session)) return session

  const { id } = await params
  const productId = parseRouteId(id)
  if (productId === null) return invalidId('product id')

  const { searchParams } = new URL(req.url)
  const lang = searchParams.get('lang') ?? 'en'

  const environmentId = optionalId(searchParams.get('environmentId'))
  if (environmentId === null) return invalidId('environment id')

  /*
   * The project the order form is pointed at, when it has one (#406).
   *
   * Without it the parameter definitions are resolved with no idea which
   * project is asking, and a definition narrowed to one project is handed to
   * every project — including the `sensitive` flag that decides whether the
   * form masks the input at all.
   */
  const projectId = optionalId(searchParams.get('projectId'))
  if (projectId === null) return invalidId('project id')

  return toResponse(await getProduct(productId, lang, environmentId, projectId))
}
