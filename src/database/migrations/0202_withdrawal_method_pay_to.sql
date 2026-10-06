-- 0202 — DETAILS A WITHDRAWAL METHOD SHOWS THE CLIENT (6 Oct 2026).
--
-- 0199 let a deposit method show the client read-only details the admin sets
-- (the phone a transfer goes to, an account name). The owner asked for the same
-- on withdrawal methods: where to collect cash, a reference to quote, how a
-- payout reaches the client.
--
-- `withdrawal_payment_methods.pay_to_fields` — the same shape and rules as the
-- deposit column (`common/payments/pay-to-fields.ts`). Shown on every payout
-- route: nothing on a withdrawal competes with them the way a hosted payment
-- page does on a deposit.
--
-- What a request was shown is recorded on the request itself, in
-- `transactions.pay_to_details` — the column and its immutability trigger came
-- with 0199 and cover withdrawals already.
--
-- Written for both migration modes (backend CLAUDE.md): every statement stands
-- alone and is re-runnable.

ALTER TABLE "withdrawal_payment_methods" ADD COLUMN IF NOT EXISTS "pay_to_fields" jsonb NOT NULL DEFAULT '[]'::jsonb;--> statement-breakpoint
ALTER TABLE "withdrawal_payment_methods" DROP CONSTRAINT IF EXISTS "withdrawal_payment_methods_pay_to_fields_array";--> statement-breakpoint
ALTER TABLE "withdrawal_payment_methods" ADD CONSTRAINT "withdrawal_payment_methods_pay_to_fields_array"
  CHECK (jsonb_typeof("pay_to_fields") = 'array');
