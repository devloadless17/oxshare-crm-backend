-- 0174 — 3PAY, the USDT provider, and the audit of what a provider holds (30 Sep 2026).
--
-- 3pay (api.3pa-y.com, its guide is docs/integration-guide.pdf) moves USDT on
-- Tron (TRC20) and Ethereum (ERC20): hosted payment links in, payouts to any
-- wallet out. It runs on the payments core (0173); its adapter lives in
-- `modules/payments/providers/threepay/`. This migration adds what the
-- database must hold for it.
--
-- ── 1. Its configuration row, switched off and empty ──────────────────────
-- The operator enters the base URL, the API key and secret and the two payout
-- fees in System → Payment providers → 3pay, then switches it on. Nothing is
-- offered to a client until a method is bound to one of its channels.
INSERT INTO "payment_providers" ("code", "enabled") VALUES ('threepay', false)
ON CONFLICT ("code") DO NOTHING;--> statement-breakpoint

-- ── 2. The UNMATCHED-RECORDS audit ───────────────────────────────────────
-- Every movement a provider records must be explained by a transaction here:
-- a payout somebody made by hand in 3pay's dashboard, a deposit on a link this
-- platform never made, or a payout this platform gave up on that appeared at
-- 3pay after all — each is money the books do not show. The core reads the
-- provider's records (`listRecords`) window by window, two hours behind now so
-- every movement of ours has had time to be recorded, and files what nothing
-- explains here. A person either finds the transaction it belongs to or
-- acknowledges it as a company movement, with a note (the owner, 30 Sep 2026:
-- manual moves in 3pay's dashboard are "mostly no" — so each one is raised).
--
-- The cursor: records up to here have been judged. Null until the audit first
-- runs, when it starts from that moment — what the account held before this
-- platform used it is not this platform's to explain.
ALTER TABLE "payment_providers"
  ADD COLUMN IF NOT EXISTS "records_audited_until" timestamptz;--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "payment_provider_unmatched_records" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "provider_code" varchar(40) NOT NULL REFERENCES "payment_providers" ("code") ON DELETE RESTRICT,
  -- `payment` (money in) or `payout` (money out).
  "subject" varchar(10) NOT NULL,
  -- The provider's id — what a transaction would hold as provider_payment_id
  -- or provider_payout_id.
  "provider_id" varchar(128) NOT NULL,
  "raw_status" varchar(40) NOT NULL,
  "amount" numeric(28, 8),
  "asset" varchar(40),
  -- The address paid or paid from, as the provider reported it.
  "counterparty" varchar(255),
  -- Our reference, when the provider echoes one (3pay's clientReference).
  "reference" varchar(255),
  "occurred_at" timestamptz NOT NULL,
  "found_at" timestamptz NOT NULL DEFAULT now(),
  -- A transaction that holds it since (the record is then explained).
  "matched_transaction_id" uuid REFERENCES "transactions" ("id") ON DELETE RESTRICT,
  "matched_at" timestamptz,
  -- A person's acknowledgement: a company movement, with why.
  "acknowledged_by" uuid,
  "acknowledged_at" timestamptz,
  "acknowledgement" text,
  CONSTRAINT "payment_provider_unmatched_records_subject_ck"
    CHECK ("subject" IN ('payment', 'payout')),
  CONSTRAINT "payment_provider_unmatched_records_uq" UNIQUE ("provider_code", "subject", "provider_id"),
  CONSTRAINT "payment_provider_unmatched_records_ack_ck" CHECK (
    ("acknowledged_at" IS NULL AND "acknowledged_by" IS NULL AND "acknowledgement" IS NULL)
    OR ("acknowledged_at" IS NOT NULL AND "acknowledged_by" IS NOT NULL
        AND length(btrim(coalesce("acknowledgement", ''))) > 0)
  ),
  CONSTRAINT "payment_provider_unmatched_records_match_ck"
    CHECK (("matched_transaction_id" IS NULL) = ("matched_at" IS NULL))
);--> statement-breakpoint

-- What the provider page lists: the ones nobody has explained yet.
CREATE INDEX IF NOT EXISTS "payment_provider_unmatched_records_open_idx"
  ON "payment_provider_unmatched_records" ("provider_code", "occurred_at" DESC)
  WHERE "acknowledged_at" IS NULL AND "matched_transaction_id" IS NULL;
