-- 0222 — the exchange log held a credential; it is removed, once, on purpose (12 Oct 2026).
--
-- 3pay's account reply (`GET /getMerchantDetails`) carries the account's WEBHOOK SECRET in
-- clear, with its owner's name, email and phone, and the exchange log (0175) stored every
-- reply as it came. The log is read unmasked by whoever may view payment providers, so a
-- credential had been sitting in it since the first connection test. From this release the
-- adapter never records it (`loggableBody`, threepay-json.ts): the account reply is cut down
-- to the figures the platform reads, and a field named like a credential is blanked anywhere.
--
-- That fixes new rows. This removes it from the rows already written.
--
-- The log is append-only by trigger, "not even by a superuser" (0175) — which is right, and
-- is why this is the ONE edit it will ever get, made here in the open rather than by hand on
-- a server: the trigger is switched off for these two statements and back on, and nothing
-- else is touched. What a row loses is a reply that was never evidence of a money movement
-- (a balance read); every call that created or reported a payment keeps its body.
--
-- Re-runnable: both statements match nothing the second time. Written without relying on
-- transaction scope (a fresh database runs each statement on its own).

ALTER TABLE "payment_provider_exchanges" DISABLE TRIGGER "payment_provider_exchanges_guard";--> statement-breakpoint

UPDATE "payment_provider_exchanges"
   SET "response_body" = '{"note":"3pay account reply removed by migration 0222: it carried the account''s webhook secret and its owner''s contact details"}'
 WHERE "provider_code" = 'threepay'
   AND "direction" = 'outbound'
   AND "path" LIKE '/getMerchantDetails%'
   AND "response_body" IS NOT NULL
   AND "response_body" NOT LIKE '%"note":"cut down for the log"%'
   AND "response_body" NOT LIKE '%removed by migration 0222%';--> statement-breakpoint

UPDATE "payment_provider_exchanges"
   SET "response_body" = regexp_replace(
         "response_body",
         '"([A-Za-z0-9_]*(secret|password|privatekey|private_key|mnemonic)[A-Za-z0-9_]*)"\s*:\s*"[^"]*"',
         '"\1":"[removed]"',
         'gi')
 WHERE "response_body" ~* '"[A-Za-z0-9_]*(secret|password|privatekey|private_key|mnemonic)[A-Za-z0-9_]*"\s*:\s*"[^"\[]';--> statement-breakpoint

ALTER TABLE "payment_provider_exchanges" ENABLE TRIGGER "payment_provider_exchanges_guard";
