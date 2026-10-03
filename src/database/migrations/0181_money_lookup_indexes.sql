-- 0179 — INDEXES THE MONEY QUERIES WERE SCANNING WITHOUT (audit, 2 Oct 2026).
--
-- 1. `transactions.wallet_id` and `transfers.wallet_id` are foreign keys with no
--    index: every lookup by wallet, and the RESTRICT check when a wallet row is
--    deleted, scanned the whole table.
-- 2. The payout engine's per-provider rate window filters on
--    `provider_submitted_at`, which no index covered, on every submission.
CREATE INDEX IF NOT EXISTS "transactions_wallet_idx" ON "transactions" ("wallet_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "transfers_wallet_idx" ON "transfers" ("wallet_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "transactions_provider_submitted_idx"
  ON "transactions" ("provider_code", "provider_submitted_at")
  WHERE "provider_submitted_at" IS NOT NULL;
