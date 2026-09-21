-- OPA joins the registry as a kind (#110, slice 1).
--
-- The policy engine is an integration row rather than a `POLICY_ENGINE_URL` env
-- var for the reasons #111 built the registry: one place for the base URL, the
-- credential (encrypted since #413), the per-environment binding, the health
-- probe and the failure semantics — and one place an operator can reach when a
-- policy gate misbehaves, which an env var is not.
--
-- The CHECK is dropped and re-added rather than widened: constraint definitions
-- are not alterable in Postgres, and both statements are in one migration so
-- there is no window in which the table has no kind constraint at all.
--
-- Nothing is backfilled and nothing can be: no existing row holds a kind this
-- list does not, which is exactly what `integrations_kind_check` has been
-- enforcing since 0023.
ALTER TABLE "integrations" DROP CONSTRAINT "integrations_kind_check";--> statement-breakpoint
ALTER TABLE "integrations" ADD CONSTRAINT "integrations_kind_check" CHECK (kind IN ('foreman','ansible','nexus','pulp','loki','grafana','opa'));
