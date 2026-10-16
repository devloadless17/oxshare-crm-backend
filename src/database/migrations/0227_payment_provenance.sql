-- 0227 — a payment records who APPROVED it, and the desk's own credits and debits record who made
-- them and WHY (16 Oct 2026).
--
-- Two gaps found while making every movement explain itself for accounting:
--
--  * `reviewed_by` is the LAST person to decide a payment. A withdrawal approved by one admin and
--    settled by another kept only the settler, so the two-person control (withdrawals.approve and
--    withdrawals.settle are separate keys precisely so two people can be required) was invisible
--    on the record. `approved_by_admin_id` / `approved_at` keep the approval; `reviewed_by` stays
--    the final decider.
--  * The desk's hand credit and debit (`manual_admin`) carried neither the admin nor the reason
--    they must type: both lived only in audit_log, the client's email and the bell. Now the row
--    carries `reviewed_by` (made and decided at once) and `desk_reason(_ar)`.
--
-- Backfilled from the audit rows those paths write INSIDE their money transaction (wallet.credit,
-- wallet.debit, deposit.approve, withdrawal.approve), so the history is exact. No FK to admins, for
-- transactions.reviewed_by's reasoning. Frozen once written. No totals or task trigger fires on
-- these columns (both are UPDATE OF state/amount/... only).
--
-- Hand-written (see 0040's header). Re-runnable.

SET lock_timeout = '10s';
--> statement-breakpoint
ALTER TABLE transactions ADD COLUMN IF NOT EXISTS approved_by_admin_id uuid;
--> statement-breakpoint
ALTER TABLE transactions ADD COLUMN IF NOT EXISTS approved_at timestamptz;
--> statement-breakpoint
ALTER TABLE transactions ADD COLUMN IF NOT EXISTS desk_reason text;
--> statement-breakpoint
ALTER TABLE transactions ADD COLUMN IF NOT EXISTS desk_reason_ar text;
--> statement-breakpoint
DROP TRIGGER IF EXISTS transactions_provenance_immutable ON transactions;
--> statement-breakpoint

-- The desk's own credits and debits: who made them and why.
UPDATE transactions t
   SET reviewed_by = COALESCE(t.reviewed_by, a.actor_id::uuid),
       reviewed_at = COALESCE(t.reviewed_at, t.created_at),
       desk_reason = COALESCE(t.desk_reason, a.details->>'reason'),
       desk_reason_ar = COALESCE(t.desk_reason_ar, a.details->>'reasonAr')
  FROM (
    SELECT DISTINCT ON (subject_id) subject_id, actor_id, details
      FROM audit_log
     WHERE action IN ('wallet.credit', 'wallet.debit') AND subject_type = 'transaction'
       AND actor_kind = 'admin'
       AND actor_id ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
     ORDER BY subject_id, created_at
  ) a
 WHERE t.provider = 'manual_admin' AND a.subject_id = t.id::text
   AND (t.reviewed_by IS NULL OR t.desk_reason IS NULL);
--> statement-breakpoint
-- Who approved: the FIRST approval of each payment.
UPDATE transactions t
   SET approved_by_admin_id = a.actor_id::uuid, approved_at = a.created_at
  FROM (
    SELECT DISTINCT ON (subject_id) subject_id, actor_id, created_at
      FROM audit_log
     WHERE action IN ('deposit.approve', 'withdrawal.approve') AND subject_type = 'transaction'
       AND actor_kind = 'admin'
       AND actor_id ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
     ORDER BY subject_id, created_at
  ) a
 WHERE a.subject_id = t.id::text AND t.approved_by_admin_id IS NULL;
--> statement-breakpoint
ALTER TABLE transactions DROP CONSTRAINT IF EXISTS transactions_approval_pair_ck;
--> statement-breakpoint
ALTER TABLE transactions ADD CONSTRAINT transactions_approval_pair_ck
  CHECK ((approved_by_admin_id IS NULL) = (approved_at IS NULL));
--> statement-breakpoint
CREATE OR REPLACE FUNCTION transactions_provenance_immutable() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'a payment''s approval and desk reason are written once (transaction %)', OLD.id
    USING ERRCODE = '23514', CONSTRAINT = 'transactions_provenance_immutable';
END $$ LANGUAGE plpgsql;
--> statement-breakpoint
-- Frozen once SET: the first write (NULL → value) is the approval itself.
CREATE TRIGGER transactions_provenance_immutable
  BEFORE UPDATE OF approved_by_admin_id, approved_at, desk_reason, desk_reason_ar ON transactions
  FOR EACH ROW
  WHEN ((OLD.approved_by_admin_id IS NOT NULL
         AND OLD.approved_by_admin_id IS DISTINCT FROM NEW.approved_by_admin_id)
     OR (OLD.approved_at IS NOT NULL AND OLD.approved_at IS DISTINCT FROM NEW.approved_at)
     OR (OLD.desk_reason IS NOT NULL AND OLD.desk_reason IS DISTINCT FROM NEW.desk_reason)
     OR (OLD.desk_reason_ar IS NOT NULL AND OLD.desk_reason_ar IS DISTINCT FROM NEW.desk_reason_ar))
  EXECUTE FUNCTION transactions_provenance_immutable();
--> statement-breakpoint
RESET lock_timeout;
