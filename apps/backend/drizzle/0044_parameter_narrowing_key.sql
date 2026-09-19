-- One definition per name, per place, narrowing included — enforced by the
-- database this time (#404).
--
-- #481 shipped the application guard: `createParameter` and `updateParameter`
-- refuse a duplicate with a 409 naming the definition that is in the way, and
-- they compare the SET OF NARROWED PROJECTS as part of the key — which is what
-- keeps #275 alive, because narrowing one definition to a project while another
-- applies everywhere is the whole feature. What that guard cannot do is close
-- the race with itself: it is a check-then-insert, and two simultaneous creates
-- both pass it.
--
-- A unique index can, but not on the four columns #404 originally asked for.
-- The set lives in `parameter_projects` and an index predicate cannot contain a
-- subquery, so the set is carried on the row as a FINGERPRINT — sha256 of the
-- project ids, sorted ascending, de-duplicated, joined with commas — and the
-- index is on that.
--
-- Hashed rather than stored as the list: a parameter narrowed to a few hundred
-- projects would otherwise put kilobytes into a btree tuple, and 2704 bytes is
-- where that stops working. Nothing reads it back for meaning.
--
-- The default is sha256(''), the fingerprint of "narrowed to nothing", which is
-- what every row is until `parameter_projects` says otherwise.
ALTER TABLE "parameters" ADD COLUMN "narrowing_key" text DEFAULT 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855' NOT NULL;--> statement-breakpoint

-- Backfill from the child table. Rows with no narrowing keep the default, which
-- is already the fingerprint of the empty set — so this touches only the rows
-- #275 is actually used on.
UPDATE "parameters" AS p
SET "narrowing_key" = encode(sha256(convert_to(k.ids, 'UTF8')), 'hex')
FROM (
  -- array_agg rather than string_agg: with DISTINCT, postgres makes the ORDER BY
  -- match the aggregated expression, and `project_id::text` would then sort
  -- lexicographically — putting 10 before 4 and producing a fingerprint the
  -- application, which sorts numerically, would never compute.
  SELECT "parameter_id", array_to_string(array_agg(DISTINCT "project_id" ORDER BY "project_id"), ',') AS ids
  FROM "parameter_projects"
  GROUP BY "parameter_id"
) AS k
WHERE k."parameter_id" = p."id";--> statement-breakpoint

-- Remove what the index cannot be created over.
--
-- This deletes rows, so it is worth being exact about which. A row goes only if
-- another row agrees with it on scope, scope id, name, environment AND
-- narrowing — that is, one that is a duplicate in every respect, with no
-- ordering rule in `resolveParameterDefs` able to tell the two apart. The
-- survivor is the highest id, which is precisely the row #402's last tie-break
-- already chose, so the EFFECTIVE definition does not change for anybody: what
-- is deleted is a row that was provably doing nothing.
--
-- Note what this does NOT delete, and why the narrowing had to be in the key
-- before this was safe to write: a definition narrowed to project 7 and one
-- that applies everywhere have different fingerprints and both survive. The
-- four-column version of this statement would have deleted one of them, on
-- every installation using #275.
DELETE FROM "parameters" AS p
USING "parameters" AS q
WHERE p."scope" = q."scope"
  AND p."scope_id" = q."scope_id"
  AND p."name" = q."name"
  AND p."environment_id" IS NOT DISTINCT FROM q."environment_id"
  AND p."narrowing_key" = q."narrowing_key"
  AND p."id" < q."id";--> statement-breakpoint

-- A pair, because `environment_id` is nullable and NULL is distinct from every
-- other NULL in a unique index — one index over all five columns would let any
-- number of all-environments duplicates through. Same shape as the
-- `integrations` pair from migration 0023, for the same reason.
CREATE UNIQUE INDEX IF NOT EXISTS "parameters_definition_env_key"
  ON "parameters" ("scope", "scope_id", "name", "environment_id", "narrowing_key")
  WHERE environment_id IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "parameters_definition_all_envs_key"
  ON "parameters" ("scope", "scope_id", "name", "narrowing_key")
  WHERE environment_id IS NULL;
