-- A level is a NAME and a PERCENTAGE. The other two columns are gone.
--
-- ── payout_model ────────────────────────────────────────────────────────────
--
-- The enum offered `revenue_share` and `per_lot`. A partner's commission is cut
-- from what the BROKER EARNED on a closed position — its commission and swap —
-- which is a percentage of revenue by definition. `per_lot` priced a rebate on
-- SIZE instead, so `rate_value` meant 70% under one model and $70 per lot under
-- the other: one column, two units, on the number that decides what every
-- partner is paid.
--
-- ⚠️  A per_lot level is DISABLED rather than silently reinterpreted.
--
-- Dropping the column alone would turn a $3.50-per-lot rebate into a 3.5% share
-- the moment this ran — a different number, paid forever, with nothing on any
-- screen to say it changed. Disabling stops the rung earning until an operator
-- sets a real percentage, which is visible, recoverable and a decision a human
-- makes. Existing partners keep their placement either way; a disabled level
-- takes no share and accepts no new partners (see `ib_levels.enabled`).
--
-- No rows were affected on the database this was written against — both levels
-- were already revenue_share. The statement is here for every other one.
UPDATE "ib_levels" SET "enabled" = false WHERE "payout_model" = 'per_lot';--> statement-breakpoint

ALTER TABLE "ib_levels" DROP COLUMN IF EXISTS "payout_model";--> statement-breakpoint

-- The type itself, now that nothing references it. `ib_levels` was its only
-- user; IF EXISTS so a database that never had it is not a failed migration.
DROP TYPE IF EXISTS "public"."ib_payout_model";--> statement-breakpoint

-- ── max_direct_partners ─────────────────────────────────────────────────────
--
-- How many partners a rung could recruit directly. NULL meant unlimited, it was
-- enforced at exactly one call site — `assertParentHasRoom`, on approval — and
-- it was never set on this platform. A rule the ladder does not otherwise
-- express, that an operator had to answer on every level they created.
--
-- Dropped rather than kept-and-hidden: a column nothing writes and one thing
-- reads is a rule that silently stops being true, and the console had already
-- stopped asking.
ALTER TABLE "ib_levels" DROP COLUMN IF EXISTS "max_direct_partners";
