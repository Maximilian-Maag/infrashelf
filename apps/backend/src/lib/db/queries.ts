import { db } from '@/lib/db/client'
import { users, products, ciSources, deploymentEnvironments } from '@/lib/db/schema'
import { productNameSql } from '@/lib/db/productText'
import { eq, sql } from 'drizzle-orm'
import { gitlabProjectRefFromTriggerUrl } from '@/lib/ci/gitlab'
import { readAccessToken } from '@/lib/ci/token'

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
 * The product's name for a notification — an email subject, an approval alert.
 *
 * `lang` defaults to English and is not threaded from a request, because there
 * is no request: these are sent from webhook handlers and background sweeps, and
 * the recipient's language is not stored anywhere. Personalising the subject
 * line needs a language column on `users`; that is a feature, not a fix, and it
 * is not invented here.
 *
 * What DOES change is the fallback. This used to select `language_code = 'en'`
 * and nothing else, so a product translated only into German — ordinary, because
 * the admin form offered four of the 25 languages — produced the literal subject
 * "Product #7". Now it falls through English, German and then any translation
 * the product has, and only reaches `Product #7` for a product with no
 * translations at all (#162).
 */
export const findProductName = async (productId: number, lang = 'en'): Promise<string> => {
  const [row] = await db
    .select({ name: productNameSql(lang, sql`${productId}`) })
    .from(products)
    .where(eq(products.id, productId))
    .limit(1)
  return row?.name ?? `Product #${productId}`
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
    // Decrypted at the edge of the database, so every CI caller downstream keeps
    // taking a plain token and none of them has to know how it is stored (#111).
    // Rows written before encryption are returned unchanged — see readAccessToken.
    accessToken: readAccessToken(sourceRows[0].accessToken),
    provider,
    // A CI source stores the host, not the project: `url` is what the browse
    // endpoints append `/api/v4/projects` to. The project is named only in the
    // environment's own trigger URL, so that is where the job-log endpoints have to
    // get it from. Null when an operator entered a trigger URL of another shape —
    // the caller reports that rather than silently recording no outputs (#121).
    projectRef: provider === 'gitlab' ? gitlabProjectRefFromTriggerUrl(envRows[0].webhookUrl) : null,
  }
}
