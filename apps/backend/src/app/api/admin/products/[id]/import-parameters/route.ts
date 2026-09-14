import { type NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import { requireRole, isAuth } from '@/lib/auth/middleware'
import { parseRouteId, invalidId, toResponse } from '@/lib/http'
import { db } from '@/lib/db/client'
import { ciSources, products } from '@/lib/db/schema'
import { eq } from 'drizzle-orm'
import { ok, err } from '@/lib/services/result'
import { scanTemplate, importScannedParameters } from '@/lib/services/admin/templateImport'
import { readAccessToken } from '@/lib/ci/token'
import type { CiProvider } from '@infrashelf/types'

const ImportSchema = z.object({
  ciSourceId: z.number().int().positive(),
  /** Numeric id or URL-encoded path, whichever the provider wants. */
  projectId: z.string().min(1),
  ref: z.string().min(1),
  /** Directory of the root template, repository-relative. '' is the repository root. */
  path: z.string(),
  /**
   * Which environment the imported template should become a pipeline stack for.
   *
   * Optional, so an import that only wants the variables still works — but the
   * dialog sends it, because a product with parameters and no way to provision
   * them is the state that made an imported Kubernetes product unorderable.
   */
  environmentId: z.number().int().positive().optional(),
})

/**
 * Import a product's parameters straight from a repository path.
 *
 * The sibling `sync-parameters` derives all four of these from a pipeline stack,
 * which is why it cannot run before one exists (#248) and why it always reads
 * `main`. This one is told where to look, so parameters can be imported while
 * the product is still being set up — and from a branch, which is how a template
 * change is tried out before it is merged.
 *
 * The scan reads every `.tf` in the directory and follows local `module` sources,
 * because a template built out of modules declares few variables of its own.
 *
 * Given an `environmentId` it also gives the product a PIPELINE STACK for that
 * environment, built from the same path. Importing the variables alone left the
 * product looking finished and unorderable — a product is provisioned by a
 * webhook or a stack, and a freshly imported one had neither.
 */
export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const session = await requireRole('root')(req)
  if (!isAuth(session)) return session

  const { id } = await params
  const productId = parseRouteId(id)
  if (productId === null) return invalidId('product id')

  const body = await req.json().catch(() => null)
  const parsed = ImportSchema.safeParse(body)
  if (!parsed.success) {
    return NextResponse.json({ error: 'Invalid request', details: parsed.error.flatten() }, { status: 400 })
  }

  // `parameters.scopeId` is polymorphic — global, category or product — so it
  // carries no foreign key and the database will accept a product that does not
  // exist. Without this the route answers 200 to a typo in the URL and leaves
  // orphan rows behind that nothing will ever show or clean up.
  const [product] = await db
    .select({ id: products.id })
    .from(products)
    .where(eq(products.id, productId))
    .limit(1)
  if (!product) return toResponse(err(404, 'Product not found'))

  const [src] = await db
    .select()
    .from(ciSources)
    .where(eq(ciSources.id, parsed.data.ciSourceId))
    .limit(1)
  if (!src) return toResponse(err(404, 'CI source not found'))

  const source = { url: src.url, accessToken: readAccessToken(src.accessToken), provider: src.provider as CiProvider }

  try {
    const scan = await scanTemplate(source, parsed.data.projectId, parsed.data.ref, parsed.data.path)
    // An empty scan is not an error, and saying which files were read is what
    // tells the operator whether the path was wrong or the template simply
    // declares nothing.
    return toResponse(
      ok(
        await importScannedParameters(
          productId,
          scan,
          session.id,
          parsed.data.environmentId !== undefined
            ? { environmentId: parsed.data.environmentId, path: parsed.data.path }
            : undefined,
        ),
      ),
    )
  } catch (e) {
    console.error('[import-parameters]', e)
    return toResponse(
      err(422, `Could not read ${parsed.data.path || 'the repository root'} at ${parsed.data.ref}: ${e instanceof Error ? e.message : String(e)}`),
    )
  }
}
