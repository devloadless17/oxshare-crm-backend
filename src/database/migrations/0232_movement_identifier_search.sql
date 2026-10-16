-- 0232 — the money search finds a movement by the provider's own ids (16 Oct 2026, audit R4-2).
-- The existing unique indexes lead with `provider_code`, so a lookup by the id alone could not
-- use them. Partial: most rows carry neither id.
SET lock_timeout = '10s';
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS transactions_provider_payment_id_idx ON transactions (provider_payment_id)
  WHERE provider_payment_id IS NOT NULL;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS transactions_provider_payout_id_idx ON transactions (provider_payout_id)
  WHERE provider_payout_id IS NOT NULL;
