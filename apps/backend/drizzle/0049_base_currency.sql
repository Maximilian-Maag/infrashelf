-- Configurable base currency (FA-11.3).
--
-- The base currency is what product prices are stored in and what exchanged
-- rates are quoted against. It was hardcoded to EUR everywhere: `grep
-- baseCurrency` returned nothing, and the frontend conversion helpers treated
-- 'EUR' as the fixed anchor.
--
-- EUR is the default so every existing installation keeps reading its own
-- numbers the same way — the column changes nothing until root sets it to
-- something else, at which point the next rate refresh re-bases the stored
-- rates onto the new currency.
--
-- NOT NULL with a default (like `deployment_time_zone` in 0038): a base currency
-- always has a value, and 'EUR' is the one every row already means.

ALTER TABLE "app_config" ADD COLUMN IF NOT EXISTS "base_currency" text NOT NULL DEFAULT 'EUR';
