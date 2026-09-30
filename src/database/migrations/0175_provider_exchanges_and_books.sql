-- 0175 — what a provider was asked and answered, and its balance against our books (30 Sep 2026).
--
-- Two recommendations of 3pay's guide (docs/integration-guide.pdf), built for every provider:
--
--   §10 "Log every 3pay API request/response for at least 90 days for audit and reconciliation."
--   §6.5 step 3 "Call /getMerchantDetails and compare totalAmt to what your books say your
--        balance should be. Alert if they diverge more than a small tolerance."

-- ── 1. The raw exchange log ──────────────────────────────────────────────────
-- Every call the platform makes to a provider (outbound) and every delivery a provider makes
-- to us (inbound): the path, the bodies as sent and received, the status, how long it took and
-- what went wrong. Never the credentials — they travel in headers, which are not kept — and
-- never a webhook's signature (the guide: "Log the raw body (redact the signature)").
CREATE TABLE IF NOT EXISTS "payment_provider_exchanges" (
  "id" bigserial PRIMARY KEY,
  "provider_code" varchar(40) NOT NULL REFERENCES "payment_providers" ("code") ON DELETE RESTRICT,
  "direction" varchar(10) NOT NULL,
  "method" varchar(10) NOT NULL,
  "path" varchar(512) NOT NULL,
  "request_body" text,
  -- The HTTP status: the provider's answer (outbound) or ours (inbound). Null: no answer came.
  "status" integer,
  "response_body" text,
  "error" varchar(500),
  "duration_ms" integer,
  -- Ours, when the caller knew it: the deposit's OX- reference, the withdrawal's id, an invoice.
  "reference" varchar(128),
  "occurred_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "payment_provider_exchanges_direction_ck" CHECK ("direction" IN ('outbound', 'inbound'))
);--> statement-breakpoint
-- The provider page pages the log newest first by id; the daily prune finds rows by age.
CREATE INDEX IF NOT EXISTS "payment_provider_exchanges_provider_id_idx"
  ON "payment_provider_exchanges" ("provider_code", "id" DESC);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "payment_provider_exchanges_occurred_at_idx"
  ON "payment_provider_exchanges" ("occurred_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "payment_provider_exchanges_reference_idx"
  ON "payment_provider_exchanges" ("reference") WHERE "reference" IS NOT NULL;--> statement-breakpoint

-- Evidence is never edited, and never removed before its 90 days are up — not even by a
-- superuser (the ledger's lesson, 0120). The daily prune removes only older rows.
CREATE OR REPLACE FUNCTION "payment_provider_exchanges_guard"() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'UPDATE' THEN
    RAISE EXCEPTION 'payment_provider_exchanges is append-only: an exchange is never edited';
  END IF;
  IF OLD."occurred_at" > now() - interval '90 days' THEN
    RAISE EXCEPTION 'payment_provider_exchanges keeps every exchange for 90 days';
  END IF;
  RETURN OLD;
END;
$$;--> statement-breakpoint
DROP TRIGGER IF EXISTS "payment_provider_exchanges_guard" ON "payment_provider_exchanges";--> statement-breakpoint
CREATE TRIGGER "payment_provider_exchanges_guard"
  BEFORE UPDATE OR DELETE ON "payment_provider_exchanges"
  FOR EACH ROW EXECUTE FUNCTION "payment_provider_exchanges_guard"();--> statement-breakpoint

-- ── 2. The provider's balance against our books ──────────────────────────────
-- Our books start from a BASELINE: the provider's balance, read at a moment when nothing was
-- travelling (no deposit link unchecked, no payout between the provider and its final word),
-- so nothing on either side of that moment can be counted twice. A person's reset clears it,
-- and the next such moment starts the books again. From the baseline, what the balance SHOULD
-- be is the baseline, plus the net of every deposit the provider confirmed since, minus every
-- payout sent since that it did not return, plus what came back of one sent before, plus every
-- movement its records hold that no transaction here explains. The last comparison is kept for
-- the provider page.
ALTER TABLE "payment_providers"
  ADD COLUMN IF NOT EXISTS "books_asset" varchar(40),
  ADD COLUMN IF NOT EXISTS "books_baseline" numeric(28, 8),
  ADD COLUMN IF NOT EXISTS "books_baseline_at" timestamptz,
  ADD COLUMN IF NOT EXISTS "books_checked_at" timestamptz,
  ADD COLUMN IF NOT EXISTS "books_available" numeric(28, 8),
  ADD COLUMN IF NOT EXISTS "books_expected" numeric(28, 8),
  ADD COLUMN IF NOT EXISTS "books_drift_since" timestamptz,
  ADD COLUMN IF NOT EXISTS "books_alerted_at" timestamptz;--> statement-breakpoint

-- What a payout's provider last SAID about the money, in the core's words — the books need to
-- know whether it left (completed), is leaving (pending), or came back (returned: refused,
-- failed or cancelled at the provider) — and WHEN that last changed, so money that comes back
-- after the baseline is counted once. The raw word stays in `provider_status`.
ALTER TABLE "transactions" ADD COLUMN IF NOT EXISTS "provider_outcome" varchar(10);--> statement-breakpoint
ALTER TABLE "transactions" ADD COLUMN IF NOT EXISTS "provider_outcome_at" timestamptz;--> statement-breakpoint
ALTER TABLE "transactions" DROP CONSTRAINT IF EXISTS "transactions_provider_outcome_ck";--> statement-breakpoint
ALTER TABLE "transactions" ADD CONSTRAINT "transactions_provider_outcome_ck"
  CHECK ("provider_outcome" IS NULL OR "provider_outcome" IN ('pending', 'completed', 'returned'));--> statement-breakpoint

-- When this side first saw the provider CONFIRM a deposit's money — whatever was then decided
-- about it (credited, flagged, closed). The provider's balance moved at that confirmation, so
-- the books count it from here, not from when (or whether) a wallet was credited.
ALTER TABLE "transactions" ADD COLUMN IF NOT EXISTS "provider_paid_at" timestamptz;--> statement-breakpoint

-- An unexplained deposit at the provider adds its NET to the balance (the provider keeps its
-- fee), and moves the balance when it is CONFIRMED, not when it was created; the books need
-- both, so the audit keeps both.
ALTER TABLE "payment_provider_unmatched_records"
  ADD COLUMN IF NOT EXISTS "net_amount" numeric(28, 8),
  ADD COLUMN IF NOT EXISTS "moved_at" timestamptz;
