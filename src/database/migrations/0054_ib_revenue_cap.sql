-- The broker's floor: IBs may never receive more than this share of revenue.
--
-- `ib_levels` gives each rung its own percentage OF THE FULL REVENUE, so the
-- rates are additive. A two-level chain at 70 + 30 pays out exactly 100% and
-- the house keeps nothing on that client, forever — and the plausibility guard
-- cannot catch it, because it only refuses totals GREATER than the revenue.
--
-- This is the guarantee that does not depend on anybody remembering. The chain
-- total is scaled to fit under it, pro rata, so adding a third rung can never
-- make the broker pay more than it decided to.
--
-- 50% is a middle-of-market default rather than a generous or a mean one; a
-- broker sharing spread as well as commission usually goes lower.
ALTER TABLE "trading_settings"
  ADD COLUMN IF NOT EXISTS "ib_max_revenue_share_pct" numeric(5, 2) DEFAULT '50' NOT NULL;
