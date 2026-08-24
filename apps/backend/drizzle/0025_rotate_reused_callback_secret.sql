-- Migration 0004 backfilled callback_secret from webhook_token, so on a legacy
-- installation the value that authenticates INBOUND callbacks is the same string
-- the portal sends OUTBOUND as a pipeline trigger token. That token lives in the
-- CI system, not in the portal: any Maintainer of the GitLab project it triggers
-- can read it, and can therefore forge a `success` for any pipeline id in that
-- environment. Migration 0006 rotated the duplicates, which left every *unique*
-- reused token in place.
--
-- The degenerate case is worse. An operator who created the environment with a
-- blank trigger token got callback_secret = '', 0006 did not touch it because it
-- was not a duplicate, and an HMAC keyed on the empty string is one that every
-- caller can compute — no insider access needed (issue #140).
--
-- Rotate both to a portal-generated value.
--
-- OPERATOR ACTION: every environment rotated here needs its new callback secret
-- copied into the CI system's webhook configuration (Admin → Environments →
-- reveal callback secret). Its inbound callbacks are rejected until then, which
-- is the intended outcome — before this migration they were forgeable.
UPDATE "deployment_environments"
  SET "callback_secret" =
    -- Same format and length as generateCallbackSecret(); gen_random_uuid() is
    -- built in, so no pgcrypto dependency (as in migration 0006).
    'ohc-cb-' || replace(gen_random_uuid()::text, '-', '')
              || replace(gen_random_uuid()::text, '-', '')
  WHERE "callback_secret" = "webhook_token"
     OR btrim("callback_secret") = '';
