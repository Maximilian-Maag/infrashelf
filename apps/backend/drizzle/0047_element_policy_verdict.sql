-- Continuous policy evaluation against what exists (#110, slice 6).
--
-- The same policies the order gate asks, asked about an element that is already
-- running: evaluated when a drift report lands (#108), because that is the moment
-- the portal re-reads the estate, and reported on the element beside that report.
--
-- REPORT-ONLY, and the shape says so. There is no status change, no flag that a
-- sweep or a webhook reads, and no column anything else branches on: an element
-- that is out of compliance is already provisioned, so un-provisioning it is not
-- something a report can justify, and refusing to render its page would hide the
-- fact somebody has to act on. What is stored is what was said, by whom, and when.

-- Nullable on purpose, all four, and NULL means "never evaluated" — deliberately
-- not the same as "evaluated and compliant". The distinction `last_refresh_outcome`
-- draws for drift, for the reason #108 opens with: an element nothing has checked
-- must not read as a healthy one.
ALTER TABLE "infrastructure_elements" ADD COLUMN IF NOT EXISTS "policy_checked_at" timestamptz;
--> statement-breakpoint

-- allow | warn | deny | needs-approval are the engine's words, which is what
-- `infrashelf/element/decision` answers. `unavailable` is the portal's own: the
-- engine could not be asked, which is a fact about the CHECK rather than about the
-- element, and the page has to be able to say which of the two it is showing.
ALTER TABLE "infrastructure_elements" ADD COLUMN IF NOT EXISTS "policy_outcome" text;
--> statement-breakpoint

-- Which rule decided. A verdict without this teaches an operator nothing about
-- what to change, which is the argument the order gate's refusal message is built
-- on (#110).
ALTER TABLE "infrastructure_elements" ADD COLUMN IF NOT EXISTS "policy_rule" text;
--> statement-breakpoint

-- The policy's own words, shown as written: the portal cannot phrase a rule it did
-- not write, and a sentence invented here would live in a translation file that
-- the policy author never reads.
ALTER TABLE "infrastructure_elements" ADD COLUMN IF NOT EXISTS "policy_message" text;
--> statement-breakpoint

-- The five stored words, pinned in the database as well as in the type. Same
-- reasoning as `infrastructure_elements_refresh_outcome` in 0039: the column is
-- written by one service, but a typo there would be a verdict the page cannot
-- render and nobody would notice until somebody looked.
ALTER TABLE "infrastructure_elements" ADD CONSTRAINT "infrastructure_elements_policy_outcome"
  CHECK ("policy_outcome" IS NULL OR "policy_outcome" IN ('allow', 'warn', 'deny', 'needs-approval', 'unavailable'));
