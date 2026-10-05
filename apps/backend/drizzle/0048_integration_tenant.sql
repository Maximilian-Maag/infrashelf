-- Loki multi-tenancy (#551).
--
-- `X-Scope-OrgID` selects a tenant in a multi-tenant Loki deployment. Without
-- it, every Loki query reads the default (single) tenant, which returns the
-- wrong logs — or none — in any multi-tenant setup, and both look identical to
-- "the pipeline shipped nothing".
--
-- Which tenant a portal should read is a modelling decision (#551: per
-- environment, per project, or one per installation). The column makes it
-- settable; NULL preserves the existing single-tenant behaviour.
--
-- Only Loki reads it; every other integration kind ignores it.

ALTER TABLE "integrations" ADD COLUMN IF NOT EXISTS "tenant" text;
