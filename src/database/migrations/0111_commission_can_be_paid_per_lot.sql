-- ============================================================================
-- Commission and rebate can be paid as a FIXED AMOUNT PER LOT
-- ============================================================================
--
-- Until now every payout was a PERCENTAGE of the broker's revenue on a trade.
-- That is one of the two models the industry actually runs; the other is a flat
-- amount per standard lot — "$10 a lot" — which is how most retail IB terms are
-- quoted and negotiated, and which does not care what the broker earned on any
-- individual trade.
--
-- Both now exist, chosen per tier and per programme.
--
-- ── ⚠️ THIS DEVIATES FROM THE FSD, DELIBERATELY, ON A BUSINESS DECISION ──────
--
-- FR-IB-05 says the rebate "shall be configurable per program (dynamic, not a
-- fixed per-lot figure)". FR-IB-04 and FR-IB-16 call the commission method
-- "spread-based". A flat per-lot amount is neither dynamic nor spread-based, so
-- the per-lot mode this migration adds is outside what Phase 1 committed to.
--
-- It is added on an explicit, repeated instruction from the business, and is
-- recorded here rather than argued in a commit message so that the next person
-- reading this schema against the FSD finds the reason instead of a
-- contradiction.
--
-- ── WHY PERCENTAGE IS NOT REMOVED ───────────────────────────────────────────
--
-- The question was asked. It stays for two reasons, and either alone is enough:
--
--   1. The FSD's committed method is spread-based, and a percentage of spread
--      revenue is the only mechanism in this system that delivers it. Deleting
--      it would move FURTHER from FR-IB-16, not closer.
--   2. Every existing programme is on it, and every accrual already written
--      priced against it. Removing the mode would restate live partner terms.
--
-- So this is additive. `percent` remains the default, and nothing about an
-- existing programme changes when this migration runs.
--
-- ── THE CEILING HAD TO CHANGE SHAPE, AND THAT IS THE SUBTLE PART ────────────
--
-- `ib_max_total_payout_pct` bounds a chain as a PERCENTAGE OF THE TRADE'S
-- REVENUE, and refuses anything over it. That check is meaningless against a
-- per-lot payout: paying $12 a lot on a trade whose spread earned $8 is not an
-- error in a per-lot model, it is the model. Priced across volume it is
-- profitable; priced per trade it is sometimes a loss, deliberately.
--
-- But the ceiling was never really about profitability — it is the UNIT-ERROR
-- backstop. A rate meaning 70x rather than 70% would otherwise accrue seventy
-- times the revenue, and `checkPlausible` exists to refuse that rather than pay
-- it. Per-lot needs the same backstop expressed in its own units, which is what
-- `ib_max_payout_per_lot` is: the most one trade may pay out per standard lot
-- across every leg. A mistyped "1000" instead of "10.00" is refused; a
-- legitimate $12 against $8 of revenue is not.
--
-- Each model is therefore bounded by the constraint natural to it, and a chain
-- mixing both is checked against both.

BEGIN;

-- ── The mode itself ─────────────────────────────────────────────────────────
--
-- An enum rather than a boolean: "is_per_lot" reads fine with two options and
-- badly with the third this will eventually want (a fixed amount per QUALIFIED
-- CLIENT — CPA — which `accrueForDeposit` already names as the model somebody
-- will ask for).
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'ib_payout_mode') THEN
    CREATE TYPE ib_payout_mode AS ENUM ('percent', 'per_lot');
  END IF;
END $$;

-- ── Tiers: what a partner earns at one depth ────────────────────────────────

ALTER TABLE ib_program_tiers
  ADD COLUMN IF NOT EXISTS payout_mode ib_payout_mode NOT NULL DEFAULT 'percent';

ALTER TABLE ib_program_tiers
  ADD COLUMN IF NOT EXISTS amount_per_lot numeric(28, 8);

COMMENT ON COLUMN ib_program_tiers.payout_mode IS
  'Which of the two columns beside it is authoritative. `percent` reads `rate` as a share of the '
  'broker''s revenue; `per_lot` reads `amount_per_lot` as a flat amount per standard lot, '
  'independent of what the trade earned.';

COMMENT ON COLUMN ib_program_tiers.amount_per_lot IS
  'Money per standard lot, NUMERIC(28,8) like every other amount (§6.1) — not the 12,4 that holds '
  'a percentage. NULL unless payout_mode is per_lot.';

-- `rate > 0` was unconditional and cannot stay so: a per-lot tier legitimately
-- carries no rate. Each mode now requires exactly the column it reads and
-- forbids the other, so a row can never be ambiguous about which number pays.
ALTER TABLE ib_program_tiers
  DROP CONSTRAINT IF EXISTS ib_program_tiers_rate_positive;

ALTER TABLE ib_program_tiers
  DROP CONSTRAINT IF EXISTS ib_program_tiers_payout_shape;

-- ⚠️ `IS NOT NULL` is not redundant beside `> 0`.
--
-- A CHECK that evaluates to NULL PASSES in Postgres, and `NULL > 0` is NULL —
-- so `amount_per_lot > 0` alone accepts a per-lot tier carrying no amount at
-- all, which is exactly the row this constraint exists to refuse. It looked
-- correct and was caught by `ib-schema-constraints.spec.ts` rather than by
-- review, which is the whole reason that suite asserts constraint NAMES against
-- real INSERTs instead of trusting the DDL to mean what it reads like.
ALTER TABLE ib_program_tiers
  ADD CONSTRAINT ib_program_tiers_payout_shape CHECK (
    (payout_mode = 'percent' AND rate > 0 AND amount_per_lot IS NULL)
    OR
    (payout_mode = 'per_lot' AND amount_per_lot IS NOT NULL AND amount_per_lot > 0)
  );

-- ── Programmes: what the CLIENT gets back ───────────────────────────────────

ALTER TABLE ib_programs
  ADD COLUMN IF NOT EXISTS rebate_mode ib_payout_mode NOT NULL DEFAULT 'percent';

ALTER TABLE ib_programs
  ADD COLUMN IF NOT EXISTS rebate_amount_per_lot numeric(28, 8);

COMMENT ON COLUMN ib_programs.rebate_mode IS
  'As ib_program_tiers.payout_mode, for the leg that credits the trading client.';

ALTER TABLE ib_programs
  DROP CONSTRAINT IF EXISTS ib_programs_rebate_shape;

-- A rebate of zero is legitimate — that is a commission_only programme — so
-- unlike a tier this permits the absent case rather than demanding a figure.
ALTER TABLE ib_programs
  ADD CONSTRAINT ib_programs_rebate_shape CHECK (
    (rebate_mode = 'percent'  AND rebate_amount_per_lot IS NULL)
    OR
    (rebate_mode = 'per_lot' AND rebate_amount_per_lot IS NOT NULL AND rebate_amount_per_lot >= 0)
  );

-- ── The per-lot ceiling ─────────────────────────────────────────────────────

ALTER TABLE trading_settings
  ADD COLUMN IF NOT EXISTS ib_max_payout_per_lot numeric(28, 8) NOT NULL DEFAULT 50;

COMMENT ON COLUMN trading_settings.ib_max_payout_per_lot IS
  'The most ONE TRADE may pay out per standard lot, summed across every leg including the '
  'client rebate. The unit-error backstop for per-lot terms, in the units per-lot terms are '
  'quoted in — the percentage ceiling beside it cannot bound them, because a per-lot payout is '
  'not a share of revenue. Refuses rather than scales, exactly as the percentage ceiling does: '
  'the deal defers on the 0092 backoff and pays in full once the terms are corrected.';

ALTER TABLE trading_settings
  DROP CONSTRAINT IF EXISTS trading_settings_ib_max_payout_per_lot_ck;

ALTER TABLE trading_settings
  ADD CONSTRAINT trading_settings_ib_max_payout_per_lot_ck
  CHECK (ib_max_payout_per_lot > 0);

-- ── The share-fits trigger only ever understood percentages ─────────────────
--
-- `ib_programs_share_fits` bounds one programme's tiers plus its rebate to 100%,
-- which is a statement about percentages and says nothing about an amount. It is
-- left in place and now applies only to the rows it can read: a per-lot tier
-- carries `rate = 0`, so it contributes nothing to that sum and the constraint
-- neither blocks it nor pretends to have checked it.
--
-- Deliberately NOT extended to per-lot. There is no "100%" of a flat amount to
-- compare against — the bound for those is `ib_max_payout_per_lot`, applied per
-- TRADE at accrual time, where the lot count is actually known.

COMMIT;
