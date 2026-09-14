import { decryptSecret, isEncryptedEnvelope } from '@/lib/crypto/secrets'

/**
 * The access token of a CI source, whatever state it is stored in (#111).
 *
 * `ci_sources.access_token` was plain text while `integrations.credential` was
 * already encrypted — the last column #111 names, and the one the crypto module
 * was written to get rid of. Rows written before that change are still
 * plaintext, so every read has to cope with both until the backfill has run
 * everywhere.
 *
 * `isEncryptedEnvelope` is what tells them apart, and it is a structural check
 * rather than a prefix match: `v1:` followed by a body that is valid base64 and
 * long enough to hold the IV and tag it claims to carry. A token that merely
 * began with `v1:` does not qualify — which matters, because misjudging one
 * throws on decrypt rather than degrading quietly.
 *
 * A decrypt failure is NOT swallowed into "treat it as plaintext". "The key is
 * wrong" and "this row predates encryption" need different fixes from an
 * operator, and silently handing a ciphertext to GitLab as a token would be
 * reported as an authentication failure against the wrong component.
 *
 * In its own module, not in `services/admin/ciSources.ts`, because `db/queries.ts`
 * needs it too and must not depend on an admin service to read a column.
 */
export const readAccessToken = (stored: string): string =>
  isEncryptedEnvelope(stored) ? decryptSecret(stored) : stored
