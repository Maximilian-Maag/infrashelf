import { db } from '@/lib/db/client'
import { users, products, ciSources, deploymentEnvironments } from '@/lib/db/schema'
import { eq, sql } from 'drizzle-orm'
import { gitlabProjectRefFromTriggerUrl } from '@/lib/ci/gitlab'
import { productNameSql, RECORD_LANGUAGE } from '@/lib/services/productName'

export interface CiSource {
  url: string
  accessToken: string
  provider: 'gitlab' | 'github' | 'bitbucket'
  /**
   * The project the environment's pipelines run in, for the read endpoints that
   * need it (job logs). Null when it cannot be derived — see below.
   */
  projectRef: string | null
}

/**
 * Unwrap the single row of a `count()` select.
 *
 * The reference checks in front of the admin deletes used to `select({ id })`
 * and take `.length`, which materializes every referencing row inside the
 * transaction to learn a number Postgres can return on its own.
 */
export const countWhere = async (query: PromiseLike<{ n: number }[]>): Promise<number> =>
  (await query)[0].n

/**
 * The product's name for a NOTIFICATION, not for a screen (issue #162).
 *
 * Every caller feeds this into a mail subject and body that are English sentences
 * end to end, and none of them has a reader to ask: two of them run from a CI
 * webhook, where there is no request and no session. So it resolves at
 * RECORD_LANGUAGE and takes the shared fallback from there — which is the part
 * that matters, because a product translated only into German used to arrive as
 * `Product #7` in the subject line.
 */
export const findProductName = async (productId: number): Promise<string> => {
  const rows = await db
    .select({ name: productNameSql(products.id, RECORD_LANGUAGE) })
    .from(products)
    .where(eq(products.id, productId))
    .limit(1)
  return rows[0]?.name ?? `Product #${productId}`
}

export const findUserEmail = async (userId: number): Promise<string | null> => {
  const rows = await db
    .select({ email: users.email })
    .from(users)
    .where(eq(users.id, userId))
    .limit(1)
  return rows[0]?.email ?? null
}

export const findUserName = async (userId: number): Promise<string> => {
  const rows = await db
    .select({ name: users.name })
    .from(users)
    .where(eq(users.id, userId))
    .limit(1)
  return rows[0]?.name ?? `User #${userId}`
}

export const findAdminEmails = async (): Promise<string[]> => {
  const rows = await db
    .select({ email: users.email })
    .from(users)
    .where(sql`${users.role} IN ('admin', 'root') AND ${users.active} = true`)
  return rows.map((r) => r.email)
}

export const findCiSourceForEnv = async (environmentId: number): Promise<CiSource | null> => {
  const envRows = await db
    .select({ ciSourceId: deploymentEnvironments.ciSourceId, webhookUrl: deploymentEnvironments.webhookUrl })
    .from(deploymentEnvironments)
    .where(eq(deploymentEnvironments.id, environmentId))
    .limit(1)

  if (!envRows[0]) return null

  const sourceRows = await db
    .select({ url: ciSources.url, accessToken: ciSources.accessToken, provider: ciSources.provider })
    .from(ciSources)
    .where(eq(ciSources.id, envRows[0].ciSourceId))
    .limit(1)

  if (!sourceRows[0]) return null

  const provider = sourceRows[0].provider as 'gitlab' | 'github' | 'bitbucket'

  return {
    url: sourceRows[0].url,
    accessToken: sourceRows[0].accessToken,
    provider,
    // A CI source stores the host, not the project: `url` is what the browse
    // endpoints append `/api/v4/projects` to. The project is named only in the
    // environment's own trigger URL, so that is where the job-log endpoints have to
    // get it from. Null when an operator entered a trigger URL of another shape —
    // the caller reports that rather than silently recording no outputs (#121).
    projectRef: provider === 'gitlab' ? gitlabProjectRefFromTriggerUrl(envRows[0].webhookUrl) : null,
  }
}
