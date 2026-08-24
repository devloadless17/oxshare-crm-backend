-- The settlement window becomes a SETTING, not a deployment variable.
--
-- `IB_COMMISSION_HOLD_HOURS` is the one rule standing between "earned" and
-- "spendable", and it lived only in the environment: changing it meant a deploy,
-- and nobody operating the platform could see what it was. Every other
-- commercial control on this row — the account caps, the demo ceiling, the
-- broker's revenue-share floor — is already here for exactly that reason.
--
-- DEFAULT 24 matches the constant the service already falls back to, so this
-- migration changes no behaviour on any existing deployment.
--
-- Hand-written, like every migration from 0027 on: the committed drizzle
-- snapshots stop at 0026, so `drizzle-kit generate` would diff against a stale
-- baseline and prompt to rename a dozen unrelated enums.
ALTER TABLE trading_settings
  ADD COLUMN IF NOT EXISTS ib_commission_hold_hours integer NOT NULL DEFAULT 24;

-- 0 is a DELIBERATE choice and stays legal: it means "pay as soon as it is
-- calculated", which a broker running no reversal desk may genuinely want. What
-- the bound stops is the other end — a mistyped 24000 would hold every partner's
-- commission for three years while every component reported success. A year is
-- far past any settlement window anybody would choose and far short of a typo.
ALTER TABLE trading_settings
  ADD CONSTRAINT trading_settings_hold_hours_ck
  CHECK (ib_commission_hold_hours >= 0 AND ib_commission_hold_hours <= 8760);
