-- What policy said about an order when it was placed (#110, #526).
--
-- A `warn` verdict was returned to the caller and written to the audit log and
-- stored nowhere, so an order placed against a rule's advice was, a week later,
-- indistinguishable from one that raised nothing on every page that shows it.
--
-- Nullable, and no backfill: the sentence is not recoverable for orders already
-- placed, and inventing one would be a lie. Null means policy had nothing to say,
-- which is exactly what an order placed before this column existed did.
ALTER TABLE "orders" ADD COLUMN "policy_warning" text;
