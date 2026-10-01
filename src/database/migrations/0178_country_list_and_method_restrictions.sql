-- 0178 — THE COUNTRIES A BROKER OFFERS, AND COUNTRY RULES ON PAYMENT METHODS
-- (the owner, 1 Oct 2026, from OxShare's old back-office).
--
-- 1. `offered_countries`: one row. `codes` are ISO 3166 alpha-2 codes, in the
--    admin's order; NULL = every country the platform knows (the behaviour
--    before this migration, so nothing changes until an admin saves a list).
--    Country AND nationality dropdowns follow it. A client's saved value is
--    always kept, whatever the list says.
CREATE TABLE IF NOT EXISTS "offered_countries" (
  "id" boolean PRIMARY KEY DEFAULT true,
  "codes" text[],
  "updated_by" uuid,
  "updated_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "offered_countries_singleton" CHECK ("id"),
  CONSTRAINT "offered_countries_codes_ck" CHECK ("codes" IS NULL OR cardinality("codes") > 0)
);--> statement-breakpoint
INSERT INTO "offered_countries" ("id") VALUES (true) ON CONFLICT ("id") DO NOTHING;--> statement-breakpoint

-- 2. A method may be offered ONLY to some countries (`allow`) or to every
--    country BUT some (`deny`), judged by the client's country of residence.
--    No rule = every client, as before. Money already moving is never stopped.
ALTER TABLE "payment_methods"
  ADD COLUMN IF NOT EXISTS "country_rule" varchar(5),
  ADD COLUMN IF NOT EXISTS "country_codes" text[] NOT NULL DEFAULT '{}';--> statement-breakpoint
ALTER TABLE "payment_methods" DROP CONSTRAINT IF EXISTS "payment_methods_country_rule_ck";--> statement-breakpoint
ALTER TABLE "payment_methods" ADD CONSTRAINT "payment_methods_country_rule_ck" CHECK (
  ("country_rule" IS NULL AND cardinality("country_codes") = 0)
  OR ("country_rule" IN ('allow', 'deny') AND cardinality("country_codes") > 0));--> statement-breakpoint
ALTER TABLE "withdrawal_payment_methods"
  ADD COLUMN IF NOT EXISTS "country_rule" varchar(5),
  ADD COLUMN IF NOT EXISTS "country_codes" text[] NOT NULL DEFAULT '{}';--> statement-breakpoint
ALTER TABLE "withdrawal_payment_methods" DROP CONSTRAINT IF EXISTS "withdrawal_payment_methods_country_rule_ck";--> statement-breakpoint
ALTER TABLE "withdrawal_payment_methods" ADD CONSTRAINT "withdrawal_payment_methods_country_rule_ck" CHECK (
  ("country_rule" IS NULL AND cardinality("country_codes") = 0)
  OR ("country_rule" IN ('allow', 'deny') AND cardinality("country_codes") > 0));
