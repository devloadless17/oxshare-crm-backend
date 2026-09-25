-- ============================================================================
-- MT5 groups carry their own commission rules and margin levels
-- ============================================================================
--
-- MT5 takes its own commission from a client's deals, set per group by the
-- broker on the trading server. It is separate from the CRM's commission types,
-- which pay partners. An operator saw a new $1,000 account read $997 and had no
-- screen that could say why: the group mirror held only a name, a currency and
-- a default leverage.
--
-- The bridge now reports, per group, every commission rule with its tiers and
-- the margin-call and stop-out levels. The group sync writes them here and the
-- MT5 groups screen shows them.
--
-- ALL NULLABLE, and NULL means "not reported", never "none". A bridge that
-- predates these fields sends nothing, and the sync then leaves whatever is
-- stored untouched. A group that charges no commission reports an EMPTY array.

ALTER TABLE mt5_groups
  ADD COLUMN commissions jsonb,
  ADD COLUMN margin_call numeric(28, 8),
  ADD COLUMN margin_stop_out numeric(28, 8),
  ADD COLUMN margin_stop_out_mode varchar(10);
