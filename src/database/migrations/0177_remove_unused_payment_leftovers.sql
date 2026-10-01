-- 0177 — WHAT IS NO LONGER USED GOES (the owner, 1 Oct 2026: keep only what is
-- used). 0175's provider-balance books check, the Rival tab's permission keys
-- (its routes are gone), and Rival's two old bell kinds.
--
-- Separate from 0176 because 0176 had already run on a database. Roll forward
-- only. Re-runnable: IF EXISTS / OR REPLACE / idempotent updates.

-- 1. The admin-task trigger stops naming Rival's old task kinds (step 4
--    renames those rows).
CREATE OR REPLACE FUNCTION transactions_resolve_admin_tasks() RETURNS trigger AS $$
DECLARE
  v_actor uuid := CASE
    WHEN NEW."reviewed_by" IS DISTINCT FROM OLD."reviewed_by"
      OR NEW."reviewed_at" IS DISTINCT FROM OLD."reviewed_at"
    THEN NEW."reviewed_by"
  END;
BEGIN
  IF (OLD."state" = 'pending' AND NEW."state" <> 'pending')
     OR (OLD."state" NOT IN ('success', 'failure', 'rejected')
         AND NEW."state" IN ('success', 'failure', 'rejected')) THEN
    PERFORM resolve_admin_notifications('transaction', NEW."id", NEW."state"::text, v_actor);
  END IF;
  IF OLD."needs_attention" AND NOT NEW."needs_attention" THEN
    PERFORM resolve_admin_notifications(
      'transaction', NEW."id", 'resolved', v_actor,
      ARRAY['admin.deposit.attention', 'withdrawal.payout_submit_failed', 'withdrawal.payout_attention']
    );
  END IF;
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;--> statement-breakpoint

-- 2. The provider-balance books (0175), removed whole: its columns on the
--    provider row, the payout outcome and deposit confirmation stamps only it
--    read, and the two record columns only it summed.
ALTER TABLE "payment_providers"
  DROP COLUMN IF EXISTS "books_asset",
  DROP COLUMN IF EXISTS "books_baseline",
  DROP COLUMN IF EXISTS "books_baseline_at",
  DROP COLUMN IF EXISTS "books_checked_at",
  DROP COLUMN IF EXISTS "books_available",
  DROP COLUMN IF EXISTS "books_expected",
  DROP COLUMN IF EXISTS "books_drift_since",
  DROP COLUMN IF EXISTS "books_alerted_at";--> statement-breakpoint
ALTER TABLE "transactions" DROP CONSTRAINT IF EXISTS "transactions_provider_outcome_ck";--> statement-breakpoint
ALTER TABLE "transactions"
  DROP COLUMN IF EXISTS "provider_outcome",
  DROP COLUMN IF EXISTS "provider_outcome_at",
  DROP COLUMN IF EXISTS "provider_paid_at";--> statement-breakpoint
ALTER TABLE "payment_provider_unmatched_records"
  DROP COLUMN IF EXISTS "net_amount",
  DROP COLUMN IF EXISTS "moved_at";
--> statement-breakpoint

-- 3. The Rival tab's keys (`settings.rival.*`): its routes are gone, and 0168
--    already granted `payments.providers.*` to whoever held them.
UPDATE "roles" SET "permissions" = "permissions" - 'settings.rival.view' - 'settings.rival.edit'
 WHERE "permissions" ?| ARRAY['settings.rival.view', 'settings.rival.edit'];--> statement-breakpoint
UPDATE "admins" SET "permissions" = "permissions" - 'settings.rival.view' - 'settings.rival.edit'
 WHERE "permissions" ?| ARRAY['settings.rival.view', 'settings.rival.edit'];--> statement-breakpoint
UPDATE "admin_invites" SET "permissions" = "permissions" - 'settings.rival.view' - 'settings.rival.edit'
 WHERE "permissions" ?| ARRAY['settings.rival.view', 'settings.rival.edit'];--> statement-breakpoint
UPDATE "api_keys" SET "permissions" = "permissions" - 'settings.rival.view' - 'settings.rival.edit'
 WHERE "permissions" ?| ARRAY['settings.rival.view', 'settings.rival.edit'];--> statement-breakpoint

-- 4. Rival's two payout tasks raised before 0173 take the provider-neutral
--    names every provider raises since, so the bell has one name for each.
UPDATE "notifications"
   SET "kind" = CASE "kind"
                  WHEN 'withdrawal.rival_submit_failed' THEN 'withdrawal.payout_submit_failed'
                  ELSE 'withdrawal.payout_attention'
                END,
       "params" = coalesce("params", '{}'::jsonb) || '{"provider": "Rival"}'::jsonb
 WHERE "kind" IN ('withdrawal.rival_submit_failed', 'withdrawal.rival_attention');
