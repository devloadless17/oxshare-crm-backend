-- 0161 — A METHOD IS NAMED BY THE DESK, AND ITS KEY IS AN ID NOBODY SEES (29 Sep 2026).
--
-- The owner's request: the desk must read something it recognises on every
-- transaction and be able to rename it — and the method's key (`extr`) was what
-- it saw. Renaming the key was built and measured first, and rejected: the key
-- is the primary key every transaction references, it is spelled into
-- `transactions.provider` (`manual_<key>`, half of the UNIQUE(provider,
-- provider_ref) idempotency guard), and code dispatches on it (`whish`). A
-- rename rewrote settled history — 17 s holding locks on 100,000 rows, past the
-- 30 s statement timeout at about 250,000 — and moved the idempotency namespace.
--
-- So the key becomes what it always should have been: a permanent identifier
-- the console no longer shows (new methods get a generated one). The foreign
-- keys keep `ON UPDATE NO ACTION`, so the database itself refuses to change a key
-- any transaction references. What the desk sees, types and renames is
-- `internal_label`: REQUIRED and UNIQUE (case-insensitive) per table, because it
-- is how a person tells two methods apart on a transaction list. Every admin
-- screen, export and bell joins or carries it; clients keep seeing `name`, and
-- the label must never reach them — the client routes pick their fields by name.
--
-- Backfilled from the display name, so no screen reads differently the day this
-- ships; a name two methods share gets the key appended to all but the first,
-- which keeps the backfill unique by construction.
--
-- Written for both migration modes (backend CLAUDE.md): every statement stands
-- alone and is re-runnable.

ALTER TABLE "payment_methods" ADD COLUMN IF NOT EXISTS "internal_label" varchar(80);--> statement-breakpoint
ALTER TABLE "withdrawal_payment_methods" ADD COLUMN IF NOT EXISTS "internal_label" varchar(80);--> statement-breakpoint
UPDATE "payment_methods" AS m
SET "internal_label" = CASE
  WHEN d.rn = 1 THEN left(btrim(m.name), 80)
  ELSE left(btrim(m.name), 77 - length(m.key)) || ' (' || m.key || ')'
END
FROM (
  SELECT key, row_number() OVER (PARTITION BY lower(btrim(name)) ORDER BY sort_order, key) AS rn
  FROM "payment_methods"
) AS d
WHERE d.key = m.key AND m.internal_label IS NULL;--> statement-breakpoint
UPDATE "withdrawal_payment_methods" AS m
SET "internal_label" = CASE
  WHEN d.rn = 1 THEN left(btrim(m.name), 80)
  ELSE left(btrim(m.name), 77 - length(m.key)) || ' (' || m.key || ')'
END
FROM (
  SELECT key, row_number() OVER (PARTITION BY lower(btrim(name)) ORDER BY sort_order, key) AS rn
  FROM "withdrawal_payment_methods"
) AS d
WHERE d.key = m.key AND m.internal_label IS NULL;--> statement-breakpoint
ALTER TABLE "payment_methods" ALTER COLUMN "internal_label" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "withdrawal_payment_methods" ALTER COLUMN "internal_label" SET NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "payment_methods_internal_label_uq" ON "payment_methods" (lower("internal_label"));--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "withdrawal_payment_methods_internal_label_uq" ON "withdrawal_payment_methods" (lower("internal_label"));--> statement-breakpoint
-- EVERY writer gets a label, not only this build: an OLDER build after a
-- rollback, raw SQL and test fixtures insert rows knowing nothing of the column,
-- and NOT NULL alone would refuse them. The same stance 0153's triggers take. A
-- blank label is refused outright: a method nobody can identify is the defect.
-- A name another method already carries as its label gets the key appended,
-- as the backfill does, so a writer that knows nothing of the label cannot be
-- refused by its uniqueness either.
CREATE OR REPLACE FUNCTION method_internal_label_default() RETURNS trigger AS $$
DECLARE
  taken boolean;
BEGIN
  IF NEW.internal_label IS NULL OR btrim(NEW.internal_label) = '' THEN
    NEW.internal_label := left(btrim(NEW.name), 80);
    EXECUTE format('SELECT EXISTS (SELECT 1 FROM %I WHERE lower(internal_label) = lower($1))', TG_TABLE_NAME)
      INTO taken USING NEW.internal_label;
    IF taken THEN
      NEW.internal_label := left(btrim(NEW.name), 77 - length(NEW.key)) || ' (' || NEW.key || ')';
    END IF;
  END IF;
  RETURN NEW;
END
$$ LANGUAGE plpgsql;--> statement-breakpoint
DROP TRIGGER IF EXISTS "payment_methods_internal_label_default" ON "payment_methods";--> statement-breakpoint
CREATE TRIGGER "payment_methods_internal_label_default" BEFORE INSERT ON "payment_methods"
  FOR EACH ROW EXECUTE FUNCTION method_internal_label_default();--> statement-breakpoint
DROP TRIGGER IF EXISTS "withdrawal_payment_methods_internal_label_default" ON "withdrawal_payment_methods";--> statement-breakpoint
CREATE TRIGGER "withdrawal_payment_methods_internal_label_default" BEFORE INSERT ON "withdrawal_payment_methods"
  FOR EACH ROW EXECUTE FUNCTION method_internal_label_default();--> statement-breakpoint
ALTER TABLE "payment_methods" DROP CONSTRAINT IF EXISTS "payment_methods_internal_label_not_blank";--> statement-breakpoint
ALTER TABLE "payment_methods" ADD CONSTRAINT "payment_methods_internal_label_not_blank"
  CHECK (btrim("internal_label") <> '');--> statement-breakpoint
ALTER TABLE "withdrawal_payment_methods" DROP CONSTRAINT IF EXISTS "withdrawal_payment_methods_internal_label_not_blank";--> statement-breakpoint
ALTER TABLE "withdrawal_payment_methods" ADD CONSTRAINT "withdrawal_payment_methods_internal_label_not_blank"
  CHECK (btrim("internal_label") <> '');--> statement-breakpoint
-- The console's "in use" flag and a delete's RESTRICT check look transactions
-- up BY method key; neither column had an index.
CREATE INDEX IF NOT EXISTS "transactions_method_key_idx" ON "transactions" ("method_key");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "transactions_withdrawal_method_key_idx" ON "transactions" ("withdrawal_method_key");
