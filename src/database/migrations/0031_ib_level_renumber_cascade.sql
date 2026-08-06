-- Let the payout ladder be REORDERED without stranding the partners on it.
--
-- `ib_levels.level` is the primary key, so moving a rung is a renumber rather
-- than a sort-order change, and `ib_accounts.level` references it with an
-- IMMEDIATE check. That combination has no valid statement order: the level
-- cannot move while a partner references it, and the partner cannot move to a
-- number that does not exist yet. Both orders were tried; both fail with 23503.
--
-- ON UPDATE CASCADE resolves it by making Postgres carry the placements across
-- in the same statement. A partner stays on the rung they were placed on, and
-- that rung keeps its position in the payout chain.
--
-- ON DELETE stays RESTRICT. Renumbering a level is a reshuffle; removing one
-- out from under somebody standing on it is data loss. They deserve opposite
-- answers, and folding both into one clause would give the wrong one to
-- whichever case was not being thought about.

ALTER TABLE "ib_accounts" DROP CONSTRAINT "ib_accounts_level_ib_levels_level_fk";--> statement-breakpoint

ALTER TABLE "ib_accounts" ADD CONSTRAINT "ib_accounts_level_ib_levels_level_fk"
	FOREIGN KEY ("level") REFERENCES "public"."ib_levels"("level") ON DELETE restrict ON UPDATE cascade;
