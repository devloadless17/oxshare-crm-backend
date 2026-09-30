-- 0172 — A payment provider's OPERATOR note gets a home only admins read.
--
-- When Rival refuses or cancels an approved payout, its webhook carries
-- `adminNotes`: the provider operator's own words ("AML flag, matches watchlist
-- #4411", "dup of 88231"). Until now that text became the withdrawal's
-- `rejection_reason`, which the client reads on their transaction, in their
-- bell and in the decision email. The client is now told a fixed sentence and
-- the note lives here, projected by the admin desks only (never by
-- `TransactionView`, the client's shape).
--
-- Re-runnable: the column is IF NOT EXISTS and the backfill touches only rows
-- still carrying a note in the client's field.

ALTER TABLE "transactions" ADD COLUMN IF NOT EXISTS "provider_note" text;
--> statement-breakpoint

-- Withdrawals the provider already refused. The audit row of each refusal
-- (`withdrawal.rival.reject`) recorded the reason it wrote; anything but the
-- two fixed sentences it fell back to was the operator's note. Move it to
-- `provider_note` and give the client the fixed sentence.
WITH leaked AS (
  SELECT DISTINCT ON (a."subject_id")
         a."subject_id"::uuid AS tx_id,
         a."details"->>'reason' AS note
    FROM "audit_log" a
   WHERE a."action" = 'withdrawal.rival.reject'
     AND a."subject_id" ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
     AND coalesce(a."details"->>'reason', '') NOT IN (
           '',
           'Rejected by the payment platform.',
           'Cancelled on the payment platform.',
           'The payment provider could not complete this withdrawal.'
         )
   ORDER BY a."subject_id", a."created_at" DESC
)
UPDATE "transactions" t
   SET "provider_note" = coalesce(t."provider_note", l.note),
       "rejection_reason" = 'The payment provider could not complete this withdrawal.'
  FROM leaked l
 WHERE t."id" = l.tx_id
   AND t."rejection_reason" IS NOT DISTINCT FROM l.note;
--> statement-breakpoint

-- The same note, copied into the client's "withdrawal declined" bell row.
UPDATE "notifications" n
   SET "params" = jsonb_set(
         n."params", '{reason}',
         to_jsonb('The payment provider could not complete this withdrawal.'::text))
  FROM "transactions" t
 WHERE n."recipient_kind" = 'client'
   AND n."kind" = 'withdrawal.rejected'
   AND n."params"->>'transactionId' = t."id"::text
   AND t."provider_note" IS NOT NULL
   AND n."params"->>'reason' IS NOT DISTINCT FROM t."provider_note";
