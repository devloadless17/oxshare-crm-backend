-- 0176 — THE CONTRACT STEP OF THE PAYMENTS CORE: Rival's own columns go.
--
-- 0173 moved every provider onto neutral columns (`provider_payment_id`,
-- `provider_payout_id`, `provider_submitted_at`, `needs_attention`,
-- `attention_reason`) and kept Rival's `rival_*` five, mirrored by a trigger, so
-- the build before it still worked after a rollback. 0168 did the same for
-- `rival_settings` beside `payment_providers`. 0173–0175 have run in production
-- since 30 Sep 2026; the owner asked for the clean-up on 1 Oct 2026.
--
-- ⚠️ ROLL FORWARD ONLY. A build before 0173 reads these columns and cannot run
-- on a database past this migration.
--
-- Re-runnable: every step is IF EXISTS / OR REPLACE.

-- 1. One last copy into the neutral columns (the mirror kept them equal; this
--    proves nothing is lost if a row ever slipped past it).
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.columns
              WHERE table_name = 'transactions' AND column_name = 'rival_external_id') THEN
    UPDATE "transactions"
       SET "provider_payment_id"   = coalesce("provider_payment_id", "rival_external_id"),
           "provider_payout_id"    = coalesce("provider_payout_id", "rival_withdrawal_id"),
           "provider_submitted_at" = coalesce("provider_submitted_at", "rival_submitted_at"),
           "needs_attention"       = "needs_attention" OR "rival_needs_attention",
           "attention_reason"      = coalesce("attention_reason", "rival_attention_reason")
     WHERE ("rival_external_id" IS NOT NULL AND "provider_payment_id" IS NULL)
        OR ("rival_withdrawal_id" IS NOT NULL AND "provider_payout_id" IS NULL)
        OR ("rival_submitted_at" IS NOT NULL AND "provider_submitted_at" IS NULL)
        OR ("rival_needs_attention" AND NOT "needs_attention")
        OR ("rival_attention_reason" IS NOT NULL AND "attention_reason" IS NULL);
  END IF;
END $$;--> statement-breakpoint

-- 2. The mirror goes first: it writes the columns about to be dropped.
DROP TRIGGER IF EXISTS "transactions_sync_rival_columns" ON "transactions";--> statement-breakpoint
DROP FUNCTION IF EXISTS transactions_mirror_rival_columns();--> statement-breakpoint

-- 3. The admin-task trigger listed `rival_needs_attention` (so the previous
--    build's writes fired it); a trigger's column list blocks dropping a column.
DROP TRIGGER IF EXISTS "transactions_resolve_admin_tasks" ON "transactions";--> statement-breakpoint
CREATE TRIGGER "transactions_resolve_admin_tasks"
  AFTER UPDATE OF "state", "needs_attention" ON "transactions"
  FOR EACH ROW
  WHEN (OLD."state" IS DISTINCT FROM NEW."state"
        OR OLD."needs_attention" IS DISTINCT FROM NEW."needs_attention")
  EXECUTE FUNCTION transactions_resolve_admin_tasks();--> statement-breakpoint

-- 4. The columns. Their indexes (the two unique ones, the poller's two partial
--    ones, 0165's attention index on the old flag) go with them; the neutral
--    columns have their own since 0173.
ALTER TABLE "transactions"
  DROP COLUMN IF EXISTS "rival_external_id",
  DROP COLUMN IF EXISTS "rival_withdrawal_id",
  DROP COLUMN IF EXISTS "rival_submitted_at",
  DROP COLUMN IF EXISTS "rival_needs_attention",
  DROP COLUMN IF EXISTS "rival_attention_reason";--> statement-breakpoint

-- 5. `rival_settings` (0052): Rival's configuration has lived on its
--    `payment_providers` row since 0168; this table was only mirrored for the
--    build before it.
DROP TRIGGER IF EXISTS "payment_providers_mirror_rival" ON "payment_providers";--> statement-breakpoint
DROP FUNCTION IF EXISTS payment_providers_mirror_rival();--> statement-breakpoint
DROP TABLE IF EXISTS "rival_settings";--> statement-breakpoint
DROP FUNCTION IF EXISTS rival_settings_mirror_provider();
