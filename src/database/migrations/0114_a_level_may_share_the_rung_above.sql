-- ============================================================================
-- A level may be paid a SHARE OF THE RUNG ABOVE IT
-- ============================================================================
--
-- The shape the business asked for, in their own words: the main partner gets
-- $10 per lot, and "the sub-partner takes thirty percent of the ten dollars the
-- main partner gets, and he gets three dollars".
--
-- That 30% is a share of ANOTHER PARTNER'S RATE, not of the broker's revenue —
-- and the existing `percent` mode cannot say it. `percent` reads
-- `revenue_basis` and takes a slice of what the broker earned on the trade;
-- 30% of commission+swap on a $10-a-lot trade is not $3, it is 30% of whatever
-- MT5 happened to charge. The two are unrelated numbers that both look like
-- "30%" on a form.
--
-- ── WHY A THIRD MODE RATHER THAN A FOURTH REVENUE BASIS ─────────────────────
--
-- `revenue_basis` answers "which of the broker's earnings is this a share of",
-- and every value it has names something the BROKER made: charges, spread
-- markup, or both. A share of the rung above is not a broker figure at all — it
-- is derived from another level's configuration, and it exists whether or not
-- the trade earned anything.
--
-- Adding it as a basis would put a non-revenue value in a column whose whole
-- job is naming revenue, and `brokerRevenueFor` would need a branch that
-- ignores the trade entirely. A mode is the honest home: the mode already
-- decides HOW a number is read, and `per_lot` set the precedent by being priced
-- from volume rather than from revenue.
--
-- ── WHAT IT MEANS ON A TRADE ────────────────────────────────────────────────
--
-- A sub-partner's client trades one lot:
--
--   sub-partner   (level 2, share_of_parent 30%)  30% × $10  =  $3
--   main partner  (level 1, per_lot $10)          full rate  = $10
--   client rebate (level 1's rebate, per lot)                =  $2
--
-- ⚠️ THE MAIN PARTNER STILL TAKES THEIR FULL $10. The sub's share is ADDED,
-- not carved out of it, so the deeper the tree the more one lot costs. That was
-- chosen deliberately over splitting the $10 — recruiting must not reduce what
-- the recruiter earns — and it is why `ib_max_payout_per_lot` matters: it is
-- the only thing bounding what a long chain costs per lot, and it is no longer
-- on any form. Default $50.
--
-- ── WHERE THE PARENT'S RATE COMES FROM ──────────────────────────────────────
--
-- The level DIRECTLY ABOVE — level N reads level N-1 — and NOT the next earner
-- in the chain. Those differ whenever a rung is unconfigured or a partner is
-- suspended, and reading the chain would make one partner's rate depend on
-- which of their ancestors happened to be active on the day. A rate card must
-- be quotable without knowing the tree.
--
-- Level 1 has no rung above it, so this mode is meaningless there and the
-- engine skips it with a reason rather than paying zero silently.
--
-- If the rung above is ITSELF a share, the chain of shares resolves upward
-- until it reaches a per-lot or percent rung. Bounded by the ladder's own
-- depth, which is finite and small.

BEGIN;

-- Postgres cannot add an enum value inside a transaction that then USES it, but
-- adding it alone is fine — nothing below reads it.
ALTER TYPE ib_payout_mode ADD VALUE IF NOT EXISTS 'share_of_parent';

COMMENT ON TYPE ib_payout_mode IS
  'How a commission or rebate leg is priced. `percent` is a share of broker revenue (see '
  'revenue_basis); `per_lot` is money for each standard lot, indifferent to what the trade '
  'earned; `share_of_parent` is a percentage of the rate on the level directly above — what a '
  'sub-partner earning "30% of the main partner''s $10" is paid.';

COMMIT;

-- ── The shape CHECK has to accept the new mode ──────────────────────────────
--
-- Separate statement because the value added above is not usable in the same
-- transaction that created it.
--
-- `share_of_parent` reads `commission_rate` — it is a percentage — and forbids
-- an amount, exactly like `percent`. The difference is what the percentage
-- applies TO, which is not a storage concern.

ALTER TABLE ib_levels DROP CONSTRAINT IF EXISTS ib_levels_commission_shape;
ALTER TABLE ib_levels
  ADD CONSTRAINT ib_levels_commission_shape CHECK (
    (commission_mode IN ('percent', 'share_of_parent') AND commission_amount_per_lot IS NULL)
    OR
    (commission_mode = 'per_lot'
      AND commission_amount_per_lot IS NOT NULL
      AND commission_amount_per_lot >= 0)
  );

ALTER TABLE ib_levels DROP CONSTRAINT IF EXISTS ib_levels_rebate_shape;
ALTER TABLE ib_levels
  ADD CONSTRAINT ib_levels_rebate_shape CHECK (
    (rebate_mode IN ('percent', 'share_of_parent') AND rebate_amount_per_lot IS NULL)
    OR
    (rebate_mode = 'per_lot'
      AND rebate_amount_per_lot IS NOT NULL
      AND rebate_amount_per_lot >= 0)
  );

-- ⚠️ THE SHARE CEILING NO LONGER APPLIES TO A `share_of_parent` LEG.
--
-- `ib_levels_share_fits` bounds commission + rebate to 100% because both were
-- shares of the SAME revenue figure, so they added up. A share of the rung
-- above is a share of a different number entirely — 30% of the parent's rate
-- plus a 5% rebate on revenue is not 35% of anything — and summing them would
-- refuse an honest rate card.
--
-- Per-lot legs were already excluded for exactly this reason. This extends the
-- same rule to the third mode: only figures that are shares of one revenue are
-- summed against it.
ALTER TABLE ib_levels DROP CONSTRAINT IF EXISTS ib_levels_share_fits;
ALTER TABLE ib_levels
  ADD CONSTRAINT ib_levels_share_fits CHECK (
    (CASE WHEN commission_mode = 'percent' THEN commission_rate ELSE 0 END)
    + (CASE WHEN rebate_mode = 'percent' THEN rebate_rate ELSE 0 END)
    <= 100
  );

-- ── A level carries a DESCRIPTION ───────────────────────────────────────────
--
-- The add-a-level dialog asks for one. A rung's name is short by necessity
-- ("Sub Partner"); the description is where a desk records what the tier is
-- FOR — who qualifies, what was agreed — which is the question asked months
-- later by somebody who was not in the room.
ALTER TABLE ib_levels ADD COLUMN IF NOT EXISTS description text;

COMMENT ON COLUMN ib_levels.description IS
  'What this tier is for, in the desk''s own words. Nothing computes with it.';
