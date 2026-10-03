-- 0180 — THE COMMISSION CONFIRM QUEUE CANNOT BE STARVED, AND ACCRUALS ARE FOUND BY CLIENT (audit, 2 Oct 2026).
--
-- 1. `confirm_attempts` / `last_confirm_failed_at`: the confirm run read pending
--    accruals oldest-first, so rows whose credit fails for good kept the head of
--    the queue and took the same batch slots on every run, paying nothing newer.
--    A failed attempt is now recorded and the queue orders never-failed rows
--    first (then oldest failure). Rows stay `pending`; idempotency is unchanged.
-- 2. `ib_accruals.client_user_id` had no index: the admin "accruals for this
--    client" filter and the rebate scope predicate scanned an unbounded table.
ALTER TABLE "ib_accruals" ADD COLUMN IF NOT EXISTS "confirm_attempts" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "ib_accruals" ADD COLUMN IF NOT EXISTS "last_confirm_failed_at" timestamp with time zone;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "ib_accruals_pending_queue_idx"
  ON "ib_accruals" ("last_confirm_failed_at" ASC NULLS FIRST, "created_at")
  WHERE "status" = 'pending';--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "ib_accruals_client_user_idx" ON "ib_accruals" ("client_user_id", "created_at");
