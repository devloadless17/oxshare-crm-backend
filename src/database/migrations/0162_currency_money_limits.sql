-- 0162 — MONEY LIMITS BELONG TO THE CURRENCY (29 Sep 2026).
--
-- The owner's report: an operator could not let a client withdraw more than
-- 50,000 Lebanese pounds — about fifty cents. The deposit and withdrawal
-- floors and ceilings were ONE set of numbers in server config
-- (`MoneyLimits`: 10 / 250,000 to deposit, 10 / 50,000 to withdraw, 100,000 a
-- day, 50,000 per admin credit), applied to every currency alike. A limit is an
-- amount of a CURRENCY, and "50,000" means nothing until you say of what: the
-- same figure is a large USD withdrawal and pocket change in LBP. There is no
-- FX source in this system, and there must not be one just to compare limits.
--
-- So each currency carries its own six limits, in its own units, and the
-- operator sets them on the Currencies screen. Every existing currency is
-- backfilled with the numbers that applied to it until now, so nothing changes
-- on the day this ships — USD reads exactly as before, and the operator raises
-- LBP to what makes sense for LBP.
--
-- A deposit METHOD may carry its own tighter range (min_amount / max_amount,
-- both optional). They were dropped in 0042 because nothing wrote to them; they
-- return as OVERRIDES that can only narrow the currency's range, for a channel
-- with its own cap. NULL means "the currency's limit".
--
-- Written for both migration modes (backend CLAUDE.md): every statement stands
-- alone and is re-runnable.

ALTER TABLE "currencies" ADD COLUMN IF NOT EXISTS "min_deposit" numeric(28, 8) NOT NULL DEFAULT 10;--> statement-breakpoint
ALTER TABLE "currencies" ADD COLUMN IF NOT EXISTS "max_deposit" numeric(28, 8) NOT NULL DEFAULT 250000;--> statement-breakpoint
ALTER TABLE "currencies" ADD COLUMN IF NOT EXISTS "min_withdrawal" numeric(28, 8) NOT NULL DEFAULT 10;--> statement-breakpoint
ALTER TABLE "currencies" ADD COLUMN IF NOT EXISTS "max_withdrawal" numeric(28, 8) NOT NULL DEFAULT 50000;--> statement-breakpoint
ALTER TABLE "currencies" ADD COLUMN IF NOT EXISTS "max_withdrawal_daily" numeric(28, 8) NOT NULL DEFAULT 100000;--> statement-breakpoint
ALTER TABLE "currencies" ADD COLUMN IF NOT EXISTS "max_admin_credit" numeric(28, 8) NOT NULL DEFAULT 50000;--> statement-breakpoint
-- The shape every set of limits must have. The service refuses the same things
-- with sentences; this is the backstop for a writer that skips it.
ALTER TABLE "currencies" DROP CONSTRAINT IF EXISTS "currencies_money_limits_ck";--> statement-breakpoint
ALTER TABLE "currencies" ADD CONSTRAINT "currencies_money_limits_ck" CHECK (
  "min_deposit" > 0
  AND "max_deposit" >= "min_deposit"
  AND "min_withdrawal" > 0
  AND "max_withdrawal" >= "min_withdrawal"
  AND "max_withdrawal_daily" >= "max_withdrawal"
  AND "max_admin_credit" > 0
);--> statement-breakpoint
ALTER TABLE "payment_methods" ADD COLUMN IF NOT EXISTS "min_amount" numeric(28, 8);--> statement-breakpoint
ALTER TABLE "payment_methods" ADD COLUMN IF NOT EXISTS "max_amount" numeric(28, 8);--> statement-breakpoint
ALTER TABLE "payment_methods" DROP CONSTRAINT IF EXISTS "payment_methods_amount_bounds_ck";--> statement-breakpoint
ALTER TABLE "payment_methods" ADD CONSTRAINT "payment_methods_amount_bounds_ck" CHECK (
  ("min_amount" IS NULL OR "min_amount" > 0)
  AND ("max_amount" IS NULL OR "max_amount" > 0)
  AND ("min_amount" IS NULL OR "max_amount" IS NULL OR "max_amount" >= "min_amount")
);
