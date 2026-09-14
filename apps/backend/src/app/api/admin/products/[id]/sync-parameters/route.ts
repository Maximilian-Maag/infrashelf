import { type NextRequest, NextResponse } from 'next/server'
import { requireRole, isAuth } from '@/lib/auth/middleware'
import { parseRouteId, invalidId } from '@/lib/http'
import { db } from '@/lib/db/client'
import { pipelineStacks, parameters, ciSources, deploymentEnvironments } from '@/lib/db/schema'
import { eq, and } from 'drizzle-orm'
import { getFileContent } from '@/lib/ci'
import { parseTerraformVariables } from '@/lib/tfparser'
import { logAudit } from '@/lib/audit'
import type { CiProvider } from '@infrashelf/types'
import { isReservedCiVariable, isPipelineSuppliedVariable } from '@/lib/ci/reserved'
import { readAccessTokenResult } from '@/lib/ci/token'

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const session = await requireRole('root')(req)
  if (!isAuth(session)) return session

  const { id } = await params
  const productId = parseRouteId(id)
  if (productId === null) return invalidId('product id')

  const stacks = await db
    .select()
    .from(pipelineStacks)
    .where(eq(pipelineStacks.productId, productId))
    .limit(1)

  if (!stacks.length || !(stacks[0].steps as unknown[]).length) {
    return NextResponse.json(
      { error: 'No pipeline stack with steps found — add a pipeline stack first' },
      { status: 422 },
    )
  }

  const stack = stacks[0]
  const steps = stack.steps as Array<{ template: string }>
  const template = steps[0].template

  // The stack no longer carries its own webhook URL — it inherits from the
  // deployment environment. Fetch the env row for both the URL (to derive
  // the GitLab project ID) and the ci source id below.
  const [env] = await db
    .select({ ciSourceId: deploymentEnvironments.ciSourceId, webhookUrl: deploymentEnvironments.webhookUrl })
    .from(deploymentEnvironments)
    .where(eq(deploymentEnvironments.id, stack.environmentId))
    .limit(1)
  if (!env) {
    return NextResponse.json({ error: 'Deployment environment for pipeline stack not found' }, { status: 422 })
  }

  const projectIdMatch = env.webhookUrl.match(/\/projects\/(\d+)\//)
  if (!projectIdMatch) {
    return NextResponse.json(
      { error: 'Could not extract project ID from deployment environment webhook URL' },
      { status: 422 },
    )
  }
  const projectId = projectIdMatch[1]

  const envRows = await db
    .select({ ciSourceId: deploymentEnvironments.ciSourceId })
    .from(deploymentEnvironments)
    .where(eq(deploymentEnvironments.id, stack.environmentId))
    .limit(1)

  if (!envRows.length) {
    return NextResponse.json({ error: 'Deployment environment not found' }, { status: 422 })
  }

  const ciSourceRows = await db
    .select()
    .from(ciSources)
    .where(eq(ciSources.id, envRows[0].ciSourceId))
    .limit(1)

  if (!ciSourceRows.length) {
    return NextResponse.json({ error: 'CI source not found' }, { status: 422 })
  }

  const src = ciSourceRows[0]

  // Outside the try below, so a credential this server cannot read answers 503
  // rather than being reported as "could not fetch the template" — which would
  // send an operator to look at GitLab for a problem that is here.
  const token = readAccessTokenResult(src.accessToken)
  if (!token.ok) {
    return NextResponse.json({ error: token.message }, { status: token.status })
  }

  let content: string
  try {
    content = await getFileContent(
      { url: src.url, accessToken: token.data, provider: src.provider as CiProvider },
      projectId,
      'main',
      `templates/${template}/variables.tf`,
    )
  } catch {
    return NextResponse.json(
      { error: `Could not fetch templates/${template}/variables.tf from the CI source` },
      { status: 422 },
    )
  }

  // Use the canonical HCL parser (shared with the CI import-vars path) so
  // nested/validation braces are handled and numeric/boolean defaults are
  // recognised (a var with `default = 3` is optional, not required). Then
  // filter out sensitive and CI-internal variables explicitly, as before.
  //
  // And the names the server owns. This route is why issue #183 needed no one to
  // type a dangerous name: it creates a parameter definition per Terraform
  // variable, so a template declaring `variable "ref"` or `variable "tf_action"`
  // produced the definition that let the ordering user choose the git ref or turn
  // a provisioning order into a destroy. `isPipelineSuppliedVariable` is the
  // separate list, of variables the pipeline supplies to itself — it now lives
  // beside the reserved names rather than being copied into this file and
  // `templateImport.ts`, which is how the two import paths came to disagree
  // about which names a template may declare.
  const vars = parseTerraformVariables(content).filter(
    (v) => !v.sensitive && !isPipelineSuppliedVariable(v.name) && !isReservedCiVariable(v.name),
  )

  const existing = await db
    .select({ name: parameters.name })
    .from(parameters)
    .where(and(eq(parameters.scope, 'product'), eq(parameters.scopeId, productId)))

  const existingNames = new Set(existing.map((p) => p.name))

  let created = 0
  for (const v of vars) {
    if (existingNames.has(v.name)) continue
    await db.insert(parameters).values({
      scope: 'product',
      scopeId: productId,
      name: v.name,
      label: v.label,
      type: v.type,
      description: v.description,
      defaultValue: v.defaultValue,
      required: v.required,
      sensitive: false,
    })
    created++
  }

  // This route inserts `parameters` rows directly rather than going through
  // createParameter, so the service-layer audit sweep (#137) does not cover it.
  // Creating a parameter here would otherwise be the one way to add one
  // invisibly, while POST /api/admin/parameters is logged. Names only, never
  // values — a synced default can be a connection string.
  if (created > 0) {
    const names = vars.filter((v) => !existingNames.has(v.name)).map((v) => v.name)
    await logAudit(
      session.id,
      'product.parameters_synced',
      productId,
      `Synced ${created} parameter(s) from the template: ${names.join(', ')}`,
    )
  }

  return NextResponse.json({ created, skipped: vars.length - created })
}
