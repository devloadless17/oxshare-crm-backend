-- The backlog decision moves out of the environment and into the settings.
--
-- ── What it decides ────────────────────────────────────────────────────────
--
-- `mt5_deals` fills from ingestion long before anything reads it, so the first
-- run of the commission engine faces months of historical trades. Paying them is
-- months of real money at once; discarding them is money partners earned and
-- never see. Neither is a default, so the engine HOLDS until somebody chooses:
--
--   NULL          nobody has decided — an aged backlog stops the run
--   'all'         pay the whole backlog, deliberately
--   ISO instant   pay from there; older deals are marked decided and accrue nothing
--
-- ── Why it stopped being IB_ACCRUAL_START ──────────────────────────────────
--
-- Two reasons, and the second is the one that matters.
--
-- First, the same objection that moved `ib_commission_hold_hours` here: a
-- COMMERCIAL decision that took a deploy to make, that the people who actually
-- make it cannot reach, and that was invisible to everybody running the platform.
--
-- Second, and stronger: this decision is IRREVERSIBLE. Money paid to a partner
-- for a trade nobody meant to pay for comes back by conversation, not by
-- redeploy. An environment variable records no actor, no timestamp and no
-- reason — so the one setting on this platform that most needs "who decided
-- this, and when" was the one that could never answer it. `SettingsService`
-- records both sides of every change to this table, and this field is in that
-- list.
--
-- The friction of editing an env file is not a substitute for accountability.
-- It is, if anything, worse: it puts the decision in the hands of whoever can
-- reach the server rather than whoever owns the commercial call.
--
-- ── The environment still answers when there is no row ─────────────────────
--
-- Exactly as `IB_COMMISSION_HOLD_HOURS` does. A deployment configured before
-- this column existed keeps behaving as it did yesterday rather than silently
-- reverting to "undecided", and once an operator saves the form the table is the
-- single answer.
--
-- NULLABLE with no default, deliberately: NULL means undecided, and defaulting
-- it to anything would be making the decision on the operator's behalf — which
-- is the entire failure this setting exists to prevent.
--
-- Idempotent, so it is re-runnable if renumbered.
ALTER TABLE trading_settings
  ADD COLUMN IF NOT EXISTS ib_accrual_start varchar(40);

COMMENT ON COLUMN trading_settings.ib_accrual_start IS
  'When commission starts being paid from. NULL = undecided (the engine holds), ''all'' = pay the whole backlog, or an ISO 8601 instant. Irreversible once acted on; every change is audited.';
