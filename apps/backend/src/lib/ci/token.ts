import {
  decryptSecret,
  isEncryptedEnvelope,
  SecretEncryptionUnavailableError,
} from '@/lib/crypto/secrets'
import { ok, err, type Result } from '@/lib/services/result'

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

/**
 * `readAccessToken` as a `Result`, for routes that must not 500 over it.
 *
 * Decryption can fail two ways, and neither is the caller's fault nor a CI
 * problem:
 *
 *   - `SecretEncryptionUnavailableError` — no key, or a malformed one. The
 *     token is fine; the server cannot read it.
 *   - anything else out of `decryptSecret` — the envelope does not authenticate
 *     under this key, which in practice means the key was replaced. It is not
 *     rotatable in place, so this is a configuration fact too.
 *
 * Both are **503**, and deliberately not the 422 the CI routes answer when a
 * template cannot be fetched: "the CI system did not give us the file" and "this
 * server cannot read its own credential" send an operator to different places.
 * Before this existed one route returned 422 for it and the other let it escape
 * as an unhandled 500 — two wrong answers to one question.
 */
export const readAccessTokenResult = (stored: string): Result<string> => {
  try {
    return ok(readAccessToken(stored))
  } catch (e) {
    if (e instanceof SecretEncryptionUnavailableError) {
      return err(503, `Cannot read the CI source's access token: ${e.message}`)
    }
    return err(
      503,
      "The CI source's access token could not be decrypted. It was encrypted with a " +
        'different SECRET_ENCRYPTION_KEY; the key is not rotatable in place, so the token ' +
        'has to be entered again under the current one.',
    )
  }
}
