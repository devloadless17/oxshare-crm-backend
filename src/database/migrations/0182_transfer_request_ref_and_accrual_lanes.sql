-- 0182 — TRADING/TRANSFER AUDIT FIXES (2 Oct 2026). Hand-authored, like 0179.
--
-- 1. `transfers.request_ref` + UNIQUE: an admin deposit-to-account replayed on
--    the same idempotency key found the wallet credit already made, then moved
--    the wallet money to MT5 a SECOND time (each transfer has its own uuid, so
--    the bridge's key could not catch it). The replay now finds the transfer.
-- 2. The accrual queue's lanes. Orphaned trades, open legs and backed-off deals
--    sat at the oldest end of `mt5_deals_unaccrued_idx` and were re-scanned on
--    every run. Orphans and open legs are now PARKED out of the ready index; a
--    trigger unparks a login's deals the moment a client comes to own it.
-- 3. The never-written `positions` table and its enums are dropped.
ALTER TABLE "transfers" ADD COLUMN IF NOT EXISTS "request_ref" text;--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "transfers_request_ref_uq"
  ON "transfers" ("request_ref") WHERE "request_ref" IS NOT NULL;--> statement-breakpoint
ALTER TABLE "mt5_deals" ADD COLUMN IF NOT EXISTS "commission_parked_at" timestamp with time zone;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "mt5_deals_ready_idx"
  ON "mt5_deals" ("dealt_at", "id")
  WHERE "commission_processed_at" IS NULL AND "commission_retry_after" IS NULL AND "commission_parked_at" IS NULL;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "mt5_deals_retry_idx"
  ON "mt5_deals" ("commission_retry_after")
  WHERE "commission_processed_at" IS NULL AND "commission_retry_after" IS NOT NULL;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "mt5_deals_parked_login_idx"
  ON "mt5_deals" ("login")
  WHERE "commission_parked_at" IS NOT NULL AND "commission_processed_at" IS NULL;--> statement-breakpoint
CREATE OR REPLACE FUNCTION mt5_deals_unpark_on_owner() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.user_id IS NOT NULL AND NEW.login IS NOT NULL THEN
    UPDATE mt5_deals SET commission_parked_at = NULL
     WHERE login = NEW.login
       AND commission_parked_at IS NOT NULL
       AND commission_processed_at IS NULL;
  END IF;
  RETURN NULL;
END $$;--> statement-breakpoint
DROP TRIGGER IF EXISTS "mt5_deals_unpark_on_owner" ON "trading_accounts";--> statement-breakpoint
CREATE TRIGGER "mt5_deals_unpark_on_owner"
  AFTER INSERT OR UPDATE OF "user_id", "login" ON "trading_accounts"
  FOR EACH ROW EXECUTE FUNCTION mt5_deals_unpark_on_owner();--> statement-breakpoint
DROP TABLE IF EXISTS "positions";--> statement-breakpoint
DROP TYPE IF EXISTS "position_status";--> statement-breakpoint
DROP TYPE IF EXISTS "position_side";
