-- 0163 — THE DETAILS A CLIENT GIVES WITH AN OFFLINE DEPOSIT (29 Sep 2026).
--
-- An offline method (`requires_proof`) is paid outside the platform: OMT, a bank
-- transfer, cash. The receipt proves a payment happened; the desk also needs what
-- IDENTIFIES it — the phone the money was sent from (often not the client's own),
-- a transfer code, a reference — and each method needs its own. The owner asked
-- for the admin to define them per method, name each, choose whether it is shown
-- and whether it is required, and for clients to answer them when filing.
--
-- `payment_methods.proof_fields` — the method's questions, an ordered array of
--   {id, label, type: text|phone, required, enabled, hint?}. The rules live in
--   `common/payments/proof-fields.ts`; this only guarantees the shape.
-- `transactions.proof_details` — the client's answers, an array of
--   {fieldId, label, type, value}, each carrying the label AS ASKED so a field
--   renamed or deleted later never leaves an answer without its question (KYC
--   0148 is the lesson). NULL for everything that is not an offline deposit
--   filed with answers.
--
-- The answers are the client's own declaration about money, so they NEVER
-- change: a trigger refuses it, for every writer (the ledger lesson, 0120 — a
-- guarantee stated in a doc is not a guarantee).
--
-- The desk searches deposits by them. `deposit_details_search` folds the values
-- to lower-case letters and digits only, so "70 123 456" finds +96170123456 and
-- "ab-12" finds AB12; the index is a partial trigram GIN over it, built without
-- rewriting the table.
--
-- Written for both migration modes (backend CLAUDE.md): every statement stands
-- alone and is re-runnable.

ALTER TABLE "payment_methods" ADD COLUMN IF NOT EXISTS "proof_fields" jsonb NOT NULL DEFAULT '[]'::jsonb;--> statement-breakpoint
ALTER TABLE "payment_methods" DROP CONSTRAINT IF EXISTS "payment_methods_proof_fields_array";--> statement-breakpoint
ALTER TABLE "payment_methods" ADD CONSTRAINT "payment_methods_proof_fields_array"
  CHECK (jsonb_typeof("proof_fields") = 'array');--> statement-breakpoint
ALTER TABLE "transactions" ADD COLUMN IF NOT EXISTS "proof_details" jsonb;--> statement-breakpoint
ALTER TABLE "transactions" DROP CONSTRAINT IF EXISTS "transactions_proof_details_array";--> statement-breakpoint
ALTER TABLE "transactions" ADD CONSTRAINT "transactions_proof_details_array"
  CHECK ("proof_details" IS NULL OR jsonb_typeof("proof_details") = 'array');--> statement-breakpoint
CREATE OR REPLACE FUNCTION deposit_details_search(details jsonb) RETURNS text
  LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$
  SELECT regexp_replace(
    lower(coalesce(jsonb_path_query_array(details, '$[*].value')::text, '')),
    '[^a-z0-9]', '', 'g'
  )
$$;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "transactions_proof_details_search_idx" ON "transactions"
  USING gin (deposit_details_search("proof_details") gin_trgm_ops)
  WHERE "proof_details" IS NOT NULL;--> statement-breakpoint
-- The desk also finds a deposit by the `OX-` reference the client quotes. The
-- unique index leads with `provider`, which a lookup by reference alone cannot use.
CREATE INDEX IF NOT EXISTS "transactions_provider_ref_idx" ON "transactions" ("provider_ref");--> statement-breakpoint
CREATE OR REPLACE FUNCTION transactions_proof_details_immutable() RETURNS trigger AS $$
BEGIN
  IF NEW.proof_details IS DISTINCT FROM OLD.proof_details THEN
    RAISE EXCEPTION 'transactions.proof_details is the client''s own declaration and never changes (transaction %)', OLD.id
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$$ LANGUAGE plpgsql;--> statement-breakpoint
DROP TRIGGER IF EXISTS "transactions_proof_details_immutable" ON "transactions";--> statement-breakpoint
CREATE TRIGGER "transactions_proof_details_immutable" BEFORE UPDATE OF "proof_details" ON "transactions"
  FOR EACH ROW EXECUTE FUNCTION transactions_proof_details_immutable();
