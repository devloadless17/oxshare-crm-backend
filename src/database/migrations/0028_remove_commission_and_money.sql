-- Remove the commission engine, the IB tables, the ledger and the money surface.
--
-- ── What this deletes, and why it is not a cleanup ──────────────────────────
--
-- The commission engine never processed a real deal, and the admin Partners
-- screen called routes that were never built. Those are dead weight. The MONEY
-- tables below are not — they work — and they are being dropped because the
-- balance and idempotency model is being rebuilt from scratch rather than
-- extended. Deposits, withdrawals and transfers return in a later change.
--
-- ⚠️ THE GUARANTEE THIS REMOVES. `ledger_entries` carried
-- `ledger_entries_wallet_reference_uq (wallet_id, reference_type, reference_id)`,
-- and `WalletService.post()` used it with ON CONFLICT as the ONLY database-level
-- guard against a replayed deposit or a retried provider webhook crediting a
-- client twice. Nothing replaces it in this migration. The money rebuild MUST
-- reintroduce an idempotency key before any payment provider is connected —
-- without one, a double-submitted form is a double credit and the database will
-- not stop it.
--
-- ── Order ───────────────────────────────────────────────────────────────────
--
-- Every foreign key here is ON DELETE RESTRICT, so children go first. The order
-- below is derived from the actual constraints, not guessed:
--
--   commission_accruals → deals, ib_programs, users, currencies
--   deals               → trading_accounts
--   ib_profiles         → ib_programs, users
--   transfers           → wallets, trading_accounts, users, currencies
--   transactions        → wallets, users, currencies
--   ledger_entries      → wallets
--   wallets             → users, currencies
--   trading_accounts    → users
--
-- Two columns look like foreign keys and are NOT — `ib_profiles.parent_ib_id`
-- and `transactions.destination_trading_account_id` are plain uuids. Postgres
-- would not have warned about them in any order; they leave with their tables.

DROP TABLE IF EXISTS "commission_accruals";--> statement-breakpoint
DROP TABLE IF EXISTS "deals";--> statement-breakpoint
DROP TABLE IF EXISTS "ib_profiles";--> statement-breakpoint
DROP TABLE IF EXISTS "referral_attributions";--> statement-breakpoint
DROP TABLE IF EXISTS "ib_programs";--> statement-breakpoint
DROP TABLE IF EXISTS "transfers";--> statement-breakpoint
DROP TABLE IF EXISTS "transactions";--> statement-breakpoint
DROP TABLE IF EXISTS "ledger_entries";--> statement-breakpoint
DROP TABLE IF EXISTS "wallets";--> statement-breakpoint
DROP TABLE IF EXISTS "trading_accounts";--> statement-breakpoint

-- The enums, now that nothing references them. `currency` is NOT here: it was
-- already dropped in 0027 when currencies became a table, and `currencies`
-- survives this migration because the IB level configuration references it.
DROP TYPE IF EXISTS "public"."accrual_status";--> statement-breakpoint
DROP TYPE IF EXISTS "public"."commission_method";--> statement-breakpoint
DROP TYPE IF EXISTS "public"."commission_mode";--> statement-breakpoint
DROP TYPE IF EXISTS "public"."ib_status";--> statement-breakpoint
DROP TYPE IF EXISTS "public"."ledger_entry_type";--> statement-breakpoint
DROP TYPE IF EXISTS "public"."trading_environment";--> statement-breakpoint
DROP TYPE IF EXISTS "public"."transaction_direction";--> statement-breakpoint
DROP TYPE IF EXISTS "public"."transaction_state";--> statement-breakpoint
DROP TYPE IF EXISTS "public"."transfer_direction";--> statement-breakpoint
DROP TYPE IF EXISTS "public"."transfer_state";
