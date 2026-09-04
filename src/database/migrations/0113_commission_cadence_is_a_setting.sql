-- ============================================================================
-- The commission CADENCE is a setting, and the level ceiling is gone
-- ============================================================================
--
-- Two changes, both asked for directly.
--
-- ── 1. HOW OFTEN COMMISSION IS PAID BECOMES ONE NUMBER ──────────────────────
--
-- There were TWO clocks between a closed trade and money in a partner's wallet,
-- and neither was on any screen:
--
--   the HOLD WINDOW   `IB_COMMISSION_HOLD_HOURS`, default 24h — how long an
--                     accrual matures before it is payable at all
--   the PAYOUT RUN    `IB_COMMISSION_CONFIRM_CRON`, default hourly — how often
--                     the job sweeps up what has matured
--
-- Both were environment variables, so changing either needed a deploy, and
-- neither alone was enough: shortening the run against a 24h hold still pays
-- nothing for a day, and shortening the hold against an hourly run still waits
-- up to an hour. That is why this is ONE setting driving BOTH.
--
-- `ib_commission_interval_seconds` is the whole answer: an accrual matures after
-- that long, and the job runs on that period. Set it to 60 and a partner is paid
-- about a minute after the trade closes.
--
-- ⚠️ THE HOLD WINDOW IS A SAFETY FEATURE, AND THIS CAN TURN IT OFF.
--
-- 24h was chosen so a bad deposit is caught by the desk's normal daily rhythm
-- BEFORE the commission on it becomes spendable. A one-minute interval removes
-- that grace: money reaches a partner's wallet before anybody could review the
-- trade behind it, and a reversal then has to claw back a balance the partner
-- may already have moved. That is acceptable for testing and is a real decision
-- in production, which is why the admin form states it beside the control rather
-- than leaving the number to speak for itself.
--
-- 60 seconds is the floor. Below that the job would still be draining when its
-- next tick fired, and stacked runs contend for the same rows to reach the
-- outcome one of them would have reached alone.
--
-- ── 2. THE LEVEL CEILING IS REMOVED ─────────────────────────────────────────
--
-- `ib_max_levels` capped how deep the ladder could go and defaulted to 2, so a
-- third rung could not be saved without first raising a number on another
-- screen. The IB Levels page is now the only thing that decides how deep a
-- broker pays: add a rung and it pays, remove it and it stops.
--
-- The COLUMN is kept and stops being read — dropping it would take the record of
-- what a deployment had configured, and this is the second time this particular
-- ceiling has moved (0105 added it, 0107 reshaped it). Nothing writes it now.
--
-- The 1..10 CHECKs go with it, on `ib_levels`, `ib_accounts` and `ib_accruals`.
-- A tree may legitimately run deeper than ten, and refusing to STORE the rung a
-- partner occupies is the wrong way to express a payout limit.
--
-- ⚠️ WHAT IS NOT REMOVED, AND MUST NOT BE. `resolveChain` walks the partner tree
-- on the money path, over a SELF-REFERENCING key Postgres cannot keep acyclic.
-- Its `seen` set is what terminates a cycle — a mis-assigned parent would
-- otherwise loop forever — and that is untouched and independent of any depth
-- number. `MAX_CHAIN_DEPTH` is raised rather than deleted for the other shape:
-- a chain deep enough that walking it costs more than it could ever pay out.

BEGIN;

-- ── The cadence ─────────────────────────────────────────────────────────────

ALTER TABLE trading_settings
  ADD COLUMN IF NOT EXISTS ib_commission_interval_seconds integer NOT NULL DEFAULT 3600;

COMMENT ON COLUMN trading_settings.ib_commission_interval_seconds IS
  'How long a commission accrual matures before it is payable, AND how often the payout job '
  'runs — one number for both, because either alone leaves the other as the real delay. '
  'Default 3600 (hourly), which is what IB_COMMISSION_HOLD_HOURS=1 and the hourly cron did '
  'together. Minimum 60: below that a run has not finished before its next tick.';

-- 60 seconds for the reason the comment gives. No upper bound: a broker paying
-- monthly is a commercial choice, not a fault.
ALTER TABLE trading_settings DROP CONSTRAINT IF EXISTS trading_settings_ib_commission_interval_ck;
ALTER TABLE trading_settings
  ADD CONSTRAINT trading_settings_ib_commission_interval_ck
  CHECK (ib_commission_interval_seconds >= 60);

-- ── The level ceiling ───────────────────────────────────────────────────────
--
-- The column stays as the record of what was configured; nothing reads it.
COMMENT ON COLUMN trading_settings.ib_max_levels IS
  'HISTORICAL since 0113. It capped how deep the commission ladder could go; the IB Levels page '
  'is the only thing that decides that now. Retained so a deployment''s previous ceiling is still '
  'legible — nothing reads or writes it.';

-- A partner may stand on any rung their tree produces. Refusing to STORE the
-- position somebody occupies is the wrong way to bound what they are PAID.
ALTER TABLE ib_levels DROP CONSTRAINT IF EXISTS ib_levels_level_range;
ALTER TABLE ib_levels ADD CONSTRAINT ib_levels_level_range CHECK (level >= 1);

ALTER TABLE ib_accounts DROP CONSTRAINT IF EXISTS ib_accounts_level_range;
ALTER TABLE ib_accounts ADD CONSTRAINT ib_accounts_level_range CHECK (level >= 1);

ALTER TABLE ib_accruals DROP CONSTRAINT IF EXISTS ib_accruals_depth_range;
ALTER TABLE ib_accruals ADD CONSTRAINT ib_accruals_depth_range CHECK (depth >= 1);

COMMIT;
