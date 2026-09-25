-- ============================================================================
-- The partner ladder: level 1 takes 70%, level 2 takes 30% (owner, 26 Sep 2026)
-- ============================================================================
--
-- A level's two shares are percentages of the traded product's commission
-- type (0141):
--
--   partner at level N  earns  lots × commission_per_lot × commission_share / 100
--   the trading client  gets   lots × rebate_per_lot     × the INTRODUCER's rebate_share / 100
--
-- 0141 derived the shares from the old per-lot amounts, which left this
-- deployment at level 1 = 100% commission / 66.6667% rebate and level 2 =
-- 30% / 100%. The owner set the ladder to:
--
--   level 1 (Main Partner):  70% of the commission, 70% of the rebate
--   level 2 (Sub Partner):   30% of the commission, 30% of the rebate
--
-- The shares stay INDEPENDENT, as 0114 made them: on a sub-partner's client's
-- trade, level 2 takes its 30% and level 1 takes its own 70%, so together they
-- are paid the whole commission. On a level 1 partner's own client's trade,
-- level 1 is paid its 70% and nobody else is.
--
-- Levels 1 and 2 always exist (seeded by 0112), so an UPDATE reaches every
-- deployment. Accruals already written keep the share recorded on them in
-- `rate_value`; only trades priced after this runs use the new shares. The
-- ladder stays editable on the console's Partner levels page.

UPDATE ib_levels
   SET commission_share = 70,
       rebate_share = 70,
       enabled = true,
       updated_at = now()
 WHERE level = 1;

UPDATE ib_levels
   SET commission_share = 30,
       rebate_share = 30,
       enabled = true,
       updated_at = now()
 WHERE level = 2;
