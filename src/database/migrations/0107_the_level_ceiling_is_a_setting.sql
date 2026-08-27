-- ─────────────────────────────────────────────────────────────────────────────
-- How many LEVELS a commission programme may reach becomes a setting.
--
-- Committed scope is TWO — Feature List Rev 9, IB-17: "Two-level structure
-- (L1 + L2); both earn; no level beyond L2", and the document's own header:
-- "The IB structure is fixed at two levels, L1 and L2, both earning." So the
-- column DEFAULTS to 2 and a database that has never been touched carries
-- exactly what was agreed.
--
-- ── Why this is a column and not the constant it used to be ─────────────────
--
-- It was `MAX_CHAIN_DEPTH = 2` in the engine. That made "how deep does this
-- broker pay" a thing only a deploy could answer — and worse, the constant and
-- the console's own notion of depth could disagree, so enabling a third level
-- told an operator earnings travelled three levels while the third partner
-- silently earned nothing on every trade.
--
-- ARCHITECTURE §8.6 argued for removing the cap entirely and migration 0102
-- did. That was this repo's engineering document overruling the client's
-- committed scope, which it does not get to do: it wins on IMPLEMENTATION, and
-- how many levels a broker pays is SCOPE. The cap comes back here — as a number
-- somebody SETS rather than one somebody deploys.
--
-- ── Why on `trading_settings` and not on the programme ──────────────────────
--
-- It is not a property of any one programme. It is the ceiling every programme
-- is configured inside, so putting it on a programme would state one
-- platform-wide fact N times and invite two of them to disagree.
--
-- ⚠️ 0103 and 0104 took the IB block OFF this table, so this needs its reason
-- stated rather than assumed. Those four — the broker cap, the settlement
-- window, the accrual start, the revenue basis — were each a rule about WHAT
-- PARTNERS ARE PAID, competing with the Commission Programmes page for the same
-- job. This one is not a payment rule: it BOUNDS what that page will accept.
-- It constrains the catalogue rather than duplicating it, which is why it can
-- sit here without recreating the two-places problem those four had.
--
-- ── It bounds what may be SAVED, and nothing else ───────────────────────────
--
-- Lowering it stops new ladders going deeper. It does not truncate a programme
-- that already reaches further, and it re-prices nobody — the same rule a
-- disabled currency and a suspended partner already follow here: an operator
-- adjusting a limit must not silently restate money that is owed.
--
-- The CHECK stops at 10 because `ib_program_tiers_depth_range` and
-- `ib_accruals_depth_range` both do. A ceiling above what the engine can store
-- would let an operator configure a ladder whose deepest level fails at INSERT
-- — on the money path, taking every legitimate earner on that trade with it.
-- ─────────────────────────────────────────────────────────────────────────────

ALTER TABLE "trading_settings"
  ADD COLUMN IF NOT EXISTS "ib_max_levels" integer DEFAULT 2 NOT NULL;
--> statement-breakpoint

ALTER TABLE "trading_settings" DROP CONSTRAINT IF EXISTS "trading_settings_ib_max_levels_ck";
--> statement-breakpoint

ALTER TABLE "trading_settings"
  ADD CONSTRAINT "trading_settings_ib_max_levels_ck"
  CHECK ("ib_max_levels" >= 1 AND "ib_max_levels" <= 10);
