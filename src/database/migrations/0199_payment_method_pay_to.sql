-- 0199 — WHERE THE CLIENT PAYS AN OFFLINE DEPOSIT (6 Oct 2026).
--
-- An offline method could ASK the client for details (0163) but could not TELL
-- them where to send the money. The buyer asked for read-only details the admin
-- sets per method — the phone a Whish transfer goes to, an account name, an IBAN
-- — shown to the client, with a Copy button, on the deposit screen. They are what
-- `pay_to` / `instructions` were until 0042 dropped them; the note on
-- `payment_methods` in `schema.ts` said they would return with manual deposits.
--
-- `payment_methods.pay_to_fields` — an ordered array of
--   {id, label, type: text|phone, value, enabled, hint?, labelAr?, hintAr?}.
--   The rules live in `common/payments/pay-to-fields.ts`; this guarantees the shape.
--   Shown only while the method's deposit channel is paid outside the platform.
-- `transactions.pay_to_details` — what the client was SHOWN when they filed, an
--   array of {fieldId, label, labelAr?, type, value}. The admin may change the
--   number tomorrow; the desk must still see which number THIS deposit was sent
--   to. NULL for everything that is not an offline deposit filed while the method
--   showed something.
--
-- What a deposit was shown never changes: a trigger refuses it, for every writer
-- (the ledger lesson, 0120 — a guarantee stated in a doc is not a guarantee).
--
-- Written for both migration modes (backend CLAUDE.md): every statement stands
-- alone and is re-runnable.

ALTER TABLE "payment_methods" ADD COLUMN IF NOT EXISTS "pay_to_fields" jsonb NOT NULL DEFAULT '[]'::jsonb;--> statement-breakpoint
ALTER TABLE "payment_methods" DROP CONSTRAINT IF EXISTS "payment_methods_pay_to_fields_array";--> statement-breakpoint
ALTER TABLE "payment_methods" ADD CONSTRAINT "payment_methods_pay_to_fields_array"
  CHECK (jsonb_typeof("pay_to_fields") = 'array');--> statement-breakpoint
ALTER TABLE "transactions" ADD COLUMN IF NOT EXISTS "pay_to_details" jsonb;--> statement-breakpoint
ALTER TABLE "transactions" DROP CONSTRAINT IF EXISTS "transactions_pay_to_details_array";--> statement-breakpoint
ALTER TABLE "transactions" ADD CONSTRAINT "transactions_pay_to_details_array"
  CHECK ("pay_to_details" IS NULL OR jsonb_typeof("pay_to_details") = 'array');--> statement-breakpoint
CREATE OR REPLACE FUNCTION transactions_pay_to_details_immutable() RETURNS trigger AS $$
BEGIN
  IF NEW.pay_to_details IS DISTINCT FROM OLD.pay_to_details THEN
    RAISE EXCEPTION 'transactions.pay_to_details records what the client was shown and never changes (transaction %)', OLD.id
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$$ LANGUAGE plpgsql;--> statement-breakpoint
DROP TRIGGER IF EXISTS "transactions_pay_to_details_immutable" ON "transactions";--> statement-breakpoint
CREATE TRIGGER "transactions_pay_to_details_immutable" BEFORE UPDATE OF "pay_to_details" ON "transactions"
  FOR EACH ROW EXECUTE FUNCTION transactions_pay_to_details_immutable();
