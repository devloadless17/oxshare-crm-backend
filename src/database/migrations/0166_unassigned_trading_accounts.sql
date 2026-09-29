-- 0166 — EVERY MT5 ACCOUNT IN THE CRM; the ones no client owns have NO client (owner, 29 Sep 2026).
--
-- The broker's server holds accounts the CRM never recorded — opened before it, by
-- another desk, by hand in the manager. Their deals waited in mt5_deals as orphans
-- and paid no partner. The MT5 account sync (Mt5AccountDirectoryService) now records
-- each such login in trading_accounts with user_id NULL; the Trading accounts screen
-- lists them as "No client", and assigning one to a client pays its waiting trades
-- from the next commission run.
--
-- In the SAME table, on the owner's instruction: an unowned account is an ordinary
-- account whose balance the bridge sweep keeps current like any other.
--
-- Every reader that takes user_id as a client was checked: the commission queue and
-- deal ingest require user_id (an unowned account's trades stay orphans), money and
-- the live feed refuse an unowned account, and a restricted admin never sees one
-- (the territory predicate's intake branch is true for a NULL, so the list states
-- user_id IS NOT NULL beside it).
--
-- Additive: no existing row changes. The foreign key stays (NULL satisfies it).

ALTER TABLE "trading_accounts" ALTER COLUMN "user_id" DROP NOT NULL;
--> statement-breakpoint
ALTER TABLE "trading_accounts" ADD COLUMN IF NOT EXISTS "mt5_holder_name" varchar(256);
--> statement-breakpoint
ALTER TABLE "trading_accounts" ADD COLUMN IF NOT EXISTS "mt5_holder_email" varchar(320);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "trading_accounts_unassigned_idx"
  ON "trading_accounts" ("created_at" DESC, "id" DESC)
  WHERE "user_id" IS NULL;
