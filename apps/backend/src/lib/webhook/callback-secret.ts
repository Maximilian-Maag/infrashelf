/**
 * Is this stored `callback_secret` usable for authenticating a callback?
 *
 * Migration 0004 backfilled the column from the free-text `webhook_token`, and
 * 0006 rotates only *duplicates* — so an environment whose operator left the
 * trigger token blank still carries `callback_secret = ''`, and the UNIQUE
 * constraint from 0006 permits exactly one such row. An HMAC keyed on the empty
 * string is a valid HMAC that anyone can compute, so that row would authenticate
 * every caller for as long as it exists.
 *
 * `trim()` rather than `length`: a secret of spaces is no more secret than one
 * of none, and a copy-paste that captured only whitespace is the realistic way
 * to get one.
 *
 * Fails closed: an environment in this state cannot receive callbacks until an
 * operator rotates its secret (Admin → Environments). Migration 0025 rotates the
 * rows that already exist.
 */
export const isUsableCallbackSecret = (secret: string): boolean => secret.trim().length > 0
