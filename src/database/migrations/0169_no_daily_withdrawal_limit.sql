-- 0169 — FOUR CURRENCY LIMITS, NO MORE (owner, 29 Sep 2026).
--
-- A currency carries the deposit range and the withdrawal range and nothing
-- else: the rolling 24-hour withdrawal cap and the admin credit ceiling (both
-- 0162) are gone. The service no longer reads or writes `max_withdrawal_daily`
-- or `max_admin_credit`, and the CHECK below drops their terms, so neither can
-- refuse a change to the four that remain.
--
-- The COLUMNS stay (dead, like `trading_settings.ib_max_levels`): an older build
-- during a rollback still selects them. Re-runnable.

ALTER TABLE "currencies" DROP CONSTRAINT IF EXISTS "currencies_money_limits_ck";--> statement-breakpoint
ALTER TABLE "currencies" ADD CONSTRAINT "currencies_money_limits_ck" CHECK (
  "min_deposit" > 0
  AND "max_deposit" >= "min_deposit"
  AND "min_withdrawal" > 0
  AND "max_withdrawal" >= "min_withdrawal"
);
