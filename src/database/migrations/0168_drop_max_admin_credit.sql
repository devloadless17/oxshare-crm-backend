-- 0168 — NO CEILING ON A HAND CREDIT (29 Sep 2026).
--
-- 0162 gave every currency its own six limits. This drops one of them.
--
-- `max_admin_credit` bounded the two paths that create balance from nothing —
-- crediting a client wallet by hand, and funding a trading account in the
-- deposit direction. It was removed at the owner's request: the desk does not
-- work to a per-action ceiling, and a limit that gets raised whenever it binds
-- is a dialog rather than a control.
--
-- What this gives up, written down so it reads as a decision and not as an
-- oversight: the amount DTO accepts twenty digits and permission checks ask who
-- may credit, never how much, so a mistyped zero now reaches the ledger. The
-- ledger is append-only, so the correction is a compensating entry a human
-- writes AFTER the client has seen the balance. The audit row — actor, amount,
-- reason — is what remains, which makes an over-credit traceable afterwards
-- rather than impossible at the time.
--
-- The rolling 24-hour withdrawal cap (`max_withdrawal_daily`) is NOT touched
-- and is still enforced in `transactions.service.ts`.
--
-- Dropping the column would take `currencies_money_limits_ck` with it, since
-- that constraint names the column — Postgres drops a table-level CHECK that
-- depends on a dropped column, whole. So it is dropped and rebuilt explicitly,
-- minus its last clause, rather than left to disappear as a side effect.
--
-- Written for both migration modes (backend CLAUDE.md): every statement stands
-- alone and is re-runnable.

ALTER TABLE "currencies" DROP CONSTRAINT IF EXISTS "currencies_money_limits_ck";--> statement-breakpoint
ALTER TABLE "currencies" DROP COLUMN IF EXISTS "max_admin_credit";--> statement-breakpoint
-- The same shape as 0162 without the `max_admin_credit > 0` clause. The service
-- refuses these with sentences; this is the backstop for a writer that skips it.
ALTER TABLE "currencies" ADD CONSTRAINT "currencies_money_limits_ck" CHECK (
  "min_deposit" > 0
  AND "max_deposit" >= "min_deposit"
  AND "min_withdrawal" > 0
  AND "max_withdrawal" >= "min_withdrawal"
  AND "max_withdrawal_daily" >= "max_withdrawal"
);
