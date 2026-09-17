/**
 * Reading a Postgres error code back out of whatever drizzle wrapped it in.
 *
 * Lived in `services/admin/integrations.ts` until #404 needed the same thing for
 * the parameter uniqueness index. Shared rather than copied, because the part
 * that is easy to get wrong is not the constant — it is the walk.
 */

/** Unique-violation. A modelling rule an operator cannot guess from a 500. */
export const UNIQUE_VIOLATION = '23505'

/** Foreign-key violation — in practice an id that does not exist. */
export const FK_VIOLATION = '23503'

/** CHECK violation — a rule stated in TypeScript and enforced where it cannot be raced. */
export const CHECK_VIOLATION = '23514'

/**
 * The SQLSTATE of a failed query, or null.
 *
 * Walks `cause`: drizzle wraps the driver's error in a DrizzleQueryError, so the
 * `code` is one or more levels down. Reading `e.code` directly — which is what
 * the raw-`postgres` call sites in lib/bootstrap do, correctly, because they
 * bypass drizzle — silently finds nothing here, and a 409 would become a 500
 * with a constraint name in it.
 */
export const pgErrorCode = (e: unknown): string | null => {
  for (let cursor = e, depth = 0; cursor !== null && cursor !== undefined && depth < 5; depth++) {
    const code = (cursor as { code?: unknown }).code
    if (typeof code === 'string') return code
    cursor = (cursor as { cause?: unknown }).cause
  }
  return null
}

/** The constraint the failed query violated, or null. Same walk, same reason. */
export const pgConstraintName = (e: unknown): string | null => {
  for (let cursor = e, depth = 0; cursor !== null && cursor !== undefined && depth < 5; depth++) {
    const name = (cursor as { constraint_name?: unknown }).constraint_name
    if (typeof name === 'string') return name
    cursor = (cursor as { cause?: unknown }).cause
  }
  return null
}
