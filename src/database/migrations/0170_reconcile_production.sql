-- 0170 — RECONCILE main AND production (29 Sep 2026). Re-runnable; changes nothing
-- on a database that is already right.
--
-- Two migrations were both numbered 0168 on the same day: `0168_payment_providers`
-- (on main) and `0168_drop_max_admin_credit` (committed straight to production).
-- drizzle applies only migrations whose journal `when` is ABOVE the newest one a
-- database has run (backend CLAUDE.md, "A RENUMBERED migration poisons…"), and
-- the drop's `when` is the later of the two. So:
--
--  * a database that ran production's 0168_drop first would SKIP 0168_payment_providers
--    for ever — section 1 below is that migration again, verbatim, and every
--    statement in it is idempotent (IF NOT EXISTS, ON CONFLICT, WHERE … IS NULL,
--    DROP … IF EXISTS before CREATE);
--  * a database that ran 0169 before the drop existed on main SKIPS the drop —
--    section 2 drops `max_admin_credit` again, IF EXISTS;
--  * either way the four-limit CHECK of 0169 is rebuilt last (section 3), so every
--    database ends with the same shape: deposit and withdrawal ranges only.
--
-- ⚠️ A database that skipped one of the two 0168s records ONE FEWER row in
-- `drizzle.__drizzle_migrations` than the journal has entries, for ever. That is
-- this repair working, not the renumbering trap: check that 0170 is recorded.
--
-- ══ 1. 0168_payment_providers, again ════════════════════════════════════════

-- 0168 — PAYMENT PROVIDERS: EVERY METHOD AND TRANSACTION NAMES THE ROUTE IT TAKES (29 Sep 2026).
--
-- Until now the CRM had no notion of a payment provider. The string `whish`
-- carried every link to Rival — the deposit dispatch, the payout decision, the
-- webhook matcher, the poller — and a method was "Rival" only because its key
-- happened to equal it. The owner could not tell which method ran on which
-- integration, and a second provider (USDT, next) would have meant copying every
-- special case.
--
-- The model, in three layers:
--   * PROVIDER — a system that moves money: `manual` (built in: the desk), `rival`,
--     later the USDT provider. Its adapter lives in code; its configuration lives
--     HERE, one row each: on/off, live or sandbox, declared settings, encrypted
--     secrets, and what the platform last heard from it.
--   * CHANNEL — one way a provider moves money (Rival's `whish`, Manual's
--     `offline`/`desk`/`cash`), DECLARED by the adapter, never typed by anybody.
--   * METHOD — what a client picks, bound to exactly one (provider, channel),
--     fixed at creation like its key: a new route is a new method, so history
--     never lies.
--
-- A TRANSACTION records the route it was filed on — provider, channel and the
-- provider's environment — as a snapshot nothing may change afterwards. Who
-- actually moved the money (Rival, or the desk covering for it) is in the event
-- log, `payment_provider_events`, beside every webhook and poll result.
--
-- ⚠️ Rollback safety (the stance 0153 takes): an OLDER build still inserts
-- methods and transactions knowing nothing of these columns, so a BEFORE INSERT
-- trigger derives the route from what that build does write (`key`, `provider`).
-- `rival_settings` stays, mirrored BOTH WAYS by triggers, until a contract
-- migration drops it.
--
-- Written for both migration modes (backend CLAUDE.md): every statement stands
-- alone and is re-runnable.

-- ── Providers ───────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS "payment_providers" (
  "code" varchar(40) PRIMARY KEY,
  "enabled" boolean NOT NULL DEFAULT false,
  "environment" varchar(10) NOT NULL DEFAULT 'live',
  "config" jsonb NOT NULL DEFAULT '{}'::jsonb,
  "secrets" jsonb NOT NULL DEFAULT '{}'::jsonb,
  "last_event_at" timestamptz,
  "last_check_at" timestamptz,
  "last_check_ok" boolean,
  "last_check_message" varchar(500),
  "updated_by" uuid,
  "updated_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "payment_providers_environment_ck" CHECK ("environment" IN ('live', 'sandbox')),
  CONSTRAINT "payment_providers_config_object_ck" CHECK (jsonb_typeof("config") = 'object'),
  CONSTRAINT "payment_providers_secrets_object_ck" CHECK (jsonb_typeof("secrets") = 'object')
);--> statement-breakpoint
-- Manual is built in and always on: it is the desk.
INSERT INTO "payment_providers" ("code", "enabled") VALUES ('manual', true)
ON CONFLICT ("code") DO NOTHING;--> statement-breakpoint
-- Rival's configuration moves here from `rival_settings`, as it stood. The
-- ciphertexts are copied verbatim — same key, same format — so nothing is
-- decrypted by a migration.
INSERT INTO "payment_providers"
  ("code", "enabled", "config", "secrets", "last_event_at", "updated_by", "updated_at")
SELECT 'rival',
       rs.enabled,
       jsonb_strip_nulls(jsonb_build_object(
         'baseUrl', rs.base_url,
         'webhookKeyFingerprint', rs.webhook_key_fingerprint)),
       jsonb_strip_nulls(jsonb_build_object(
         'apiKey', rs.api_key_ciphertext,
         'webhookKey', rs.webhook_key_ciphertext)),
       rs.last_event_at, rs.updated_by, rs.updated_at
FROM "rival_settings" rs
ON CONFLICT ("code") DO NOTHING;--> statement-breakpoint
-- No settings row: Rival was configured from the environment, or not at all.
-- An empty row keeps that meaning (the adapter falls back to the environment
-- while nothing has been saved), and gives the console a row to show.
INSERT INTO "payment_providers" ("code", "enabled") VALUES ('rival', false)
ON CONFLICT ("code") DO NOTHING;--> statement-breakpoint

-- ── `rival_settings` ⇄ the `rival` row, while an older build could run ───────
-- An older build — the one a rollback returns to — reads and writes
-- `rival_settings`. So each table copies its writes to the other, in the
-- database rather than in either build: a key rotated on the new console still
-- verifies webhooks after a rollback, and one rotated during the rollback is
-- still there after the roll forward. Only the top-level write is copied
-- (`pg_trigger_depth`), so the copy does not bounce back.
CREATE OR REPLACE FUNCTION payment_providers_mirror_rival() RETURNS trigger AS $$
BEGIN
  IF pg_trigger_depth() > 1 THEN
    RETURN NULL;
  END IF;
  -- Nothing saved yet: no `rival_settings` row is what tells an older build to
  -- read Rival from the environment, so an untouched row must not create one.
  IF NOT EXISTS (SELECT 1 FROM "rival_settings")
     AND NEW."updated_by" IS NULL
     AND NEW."config"->>'baseUrl' IS NULL
     AND NEW."secrets"->>'apiKey' IS NULL
     AND NEW."secrets"->>'webhookKey' IS NULL THEN
    RETURN NULL;
  END IF;
  INSERT INTO "rival_settings"
    ("id", "base_url", "api_key_ciphertext", "webhook_key_ciphertext",
     "webhook_key_fingerprint", "enabled", "last_event_at", "updated_by", "updated_at")
  VALUES
    (true, NEW."config"->>'baseUrl', NEW."secrets"->>'apiKey', NEW."secrets"->>'webhookKey',
     NEW."config"->>'webhookKeyFingerprint', NEW."enabled", NEW."last_event_at",
     NEW."updated_by", NEW."updated_at")
  ON CONFLICT ("id") DO UPDATE SET
    "base_url" = EXCLUDED."base_url",
    "api_key_ciphertext" = EXCLUDED."api_key_ciphertext",
    "webhook_key_ciphertext" = EXCLUDED."webhook_key_ciphertext",
    "webhook_key_fingerprint" = EXCLUDED."webhook_key_fingerprint",
    "enabled" = EXCLUDED."enabled",
    "last_event_at" = EXCLUDED."last_event_at",
    "updated_by" = EXCLUDED."updated_by",
    "updated_at" = EXCLUDED."updated_at";
  RETURN NULL;
END $$ LANGUAGE plpgsql;--> statement-breakpoint
DROP TRIGGER IF EXISTS "payment_providers_mirror_rival" ON "payment_providers";--> statement-breakpoint
CREATE TRIGGER "payment_providers_mirror_rival" AFTER INSERT OR UPDATE ON "payment_providers"
  FOR EACH ROW WHEN (NEW."code" = 'rival') EXECUTE FUNCTION payment_providers_mirror_rival();--> statement-breakpoint
CREATE OR REPLACE FUNCTION rival_settings_mirror_provider() RETURNS trigger AS $$
BEGIN
  IF pg_trigger_depth() > 1 THEN
    RETURN NULL;
  END IF;
  -- The keys `rival_settings` holds are replaced; any other key is the new
  -- build's own and is kept.
  UPDATE "payment_providers" SET
    "enabled" = NEW."enabled",
    "config" = ("config" - 'baseUrl' - 'webhookKeyFingerprint') || jsonb_strip_nulls(jsonb_build_object(
      'baseUrl', NEW."base_url",
      'webhookKeyFingerprint', NEW."webhook_key_fingerprint")),
    "secrets" = ("secrets" - 'apiKey' - 'webhookKey') || jsonb_strip_nulls(jsonb_build_object(
      'apiKey', NEW."api_key_ciphertext",
      'webhookKey', NEW."webhook_key_ciphertext")),
    "last_event_at" = NEW."last_event_at",
    "updated_by" = NEW."updated_by",
    "updated_at" = NEW."updated_at"
  WHERE "code" = 'rival';
  RETURN NULL;
END $$ LANGUAGE plpgsql;--> statement-breakpoint
DROP TRIGGER IF EXISTS "rival_settings_mirror_provider" ON "rival_settings";--> statement-breakpoint
CREATE TRIGGER "rival_settings_mirror_provider" AFTER INSERT OR UPDATE ON "rival_settings"
  FOR EACH ROW EXECUTE FUNCTION rival_settings_mirror_provider();--> statement-breakpoint

-- ── Methods name their route ────────────────────────────────────────────────
ALTER TABLE "payment_methods" ADD COLUMN IF NOT EXISTS "provider_code" varchar(40);--> statement-breakpoint
ALTER TABLE "payment_methods" ADD COLUMN IF NOT EXISTS "channel_code" varchar(40);--> statement-breakpoint
ALTER TABLE "withdrawal_payment_methods" ADD COLUMN IF NOT EXISTS "provider_code" varchar(40);--> statement-breakpoint
ALTER TABLE "withdrawal_payment_methods" ADD COLUMN IF NOT EXISTS "channel_code" varchar(40);--> statement-breakpoint
-- The route each method ALREADY took: `whish` went through Rival (the only key
-- `PaymentGateways.isImplemented` answered); every other deposit method was paid
-- outside the platform and confirmed by the desk; every other withdrawal method
-- was paid by the desk.
UPDATE "payment_methods"
SET "provider_code" = CASE WHEN "key" = 'whish' THEN 'rival' ELSE 'manual' END,
    "channel_code"  = CASE WHEN "key" = 'whish' THEN 'whish' ELSE 'offline' END
WHERE "provider_code" IS NULL;--> statement-breakpoint
UPDATE "withdrawal_payment_methods"
SET "provider_code" = CASE WHEN "key" = 'whish' THEN 'rival' ELSE 'manual' END,
    "channel_code"  = CASE WHEN "key" = 'whish' THEN 'whish' ELSE 'desk' END
WHERE "provider_code" IS NULL;--> statement-breakpoint

-- ── Transactions record the route they were filed on ────────────────────────
ALTER TABLE "transactions" ADD COLUMN IF NOT EXISTS "provider_code" varchar(40);--> statement-breakpoint
ALTER TABLE "transactions" ADD COLUMN IF NOT EXISTS "channel_code" varchar(40);--> statement-breakpoint
ALTER TABLE "transactions" ADD COLUMN IF NOT EXISTS "provider_environment" varchar(10);--> statement-breakpoint
-- From `provider` and `direction`, the only fields that ever said which way
-- money went:
--   `whish`               → Rival's Whish channel (its deposit or its payout)
--   any other withdrawal  → paid by the desk (its provider is the method key)
--   `manual_admin`        → the desk's own adjustment (not a method)
--   any other deposit     → paid outside the platform, confirmed by the desk
-- History is recorded as `live`: sandbox did not exist as a concept before now.
UPDATE "transactions"
SET "provider_code" = CASE WHEN "provider" = 'whish' THEN 'rival' ELSE 'manual' END,
    "channel_code" = CASE
      WHEN "provider" = 'whish' THEN 'whish'
      WHEN "direction" = 'withdrawal' THEN 'desk'
      WHEN "provider" = 'manual_admin' THEN 'adjustment'
      ELSE 'offline'
    END,
    "provider_environment" = 'live'
WHERE "provider_code" IS NULL;--> statement-breakpoint

-- ── An older build still inserts rows without a route: derive it ───────────
CREATE OR REPLACE FUNCTION payment_route_default() RETURNS trigger AS $$
BEGIN
  IF TG_TABLE_NAME = 'payment_methods' THEN
    IF NEW.provider_code IS NULL THEN
      NEW.provider_code := CASE WHEN NEW.key = 'whish' THEN 'rival' ELSE 'manual' END;
      NEW.channel_code := CASE WHEN NEW.key = 'whish' THEN 'whish' ELSE 'offline' END;
    END IF;
  ELSIF TG_TABLE_NAME = 'withdrawal_payment_methods' THEN
    IF NEW.provider_code IS NULL THEN
      NEW.provider_code := CASE WHEN NEW.key = 'whish' THEN 'rival' ELSE 'manual' END;
      NEW.channel_code := CASE WHEN NEW.key = 'whish' THEN 'whish' ELSE 'desk' END;
    END IF;
  ELSIF TG_TABLE_NAME = 'transactions' THEN
    IF NEW.provider_code IS NULL THEN
      NEW.provider_code := CASE WHEN NEW.provider = 'whish' THEN 'rival' ELSE 'manual' END;
      NEW.channel_code := CASE
        WHEN NEW.provider = 'whish' THEN 'whish'
        WHEN NEW.direction = 'withdrawal' THEN 'desk'
        WHEN NEW.provider = 'manual_admin' THEN 'adjustment'
        ELSE 'offline'
      END;
    END IF;
    IF NEW.provider_environment IS NULL THEN
      SELECT environment INTO NEW.provider_environment
      FROM payment_providers WHERE code = NEW.provider_code;
      NEW.provider_environment := coalesce(NEW.provider_environment, 'live');
    END IF;
  END IF;
  RETURN NEW;
END
$$ LANGUAGE plpgsql;--> statement-breakpoint
DROP TRIGGER IF EXISTS "payment_methods_route_default" ON "payment_methods";--> statement-breakpoint
CREATE TRIGGER "payment_methods_route_default" BEFORE INSERT ON "payment_methods"
  FOR EACH ROW EXECUTE FUNCTION payment_route_default();--> statement-breakpoint
DROP TRIGGER IF EXISTS "withdrawal_payment_methods_route_default" ON "withdrawal_payment_methods";--> statement-breakpoint
CREATE TRIGGER "withdrawal_payment_methods_route_default" BEFORE INSERT ON "withdrawal_payment_methods"
  FOR EACH ROW EXECUTE FUNCTION payment_route_default();--> statement-breakpoint
DROP TRIGGER IF EXISTS "transactions_route_default" ON "transactions";--> statement-breakpoint
CREATE TRIGGER "transactions_route_default" BEFORE INSERT ON "transactions"
  FOR EACH ROW EXECUTE FUNCTION payment_route_default();--> statement-breakpoint

-- ── A route, once set, never changes ────────────────────────────────────────
CREATE OR REPLACE FUNCTION payment_route_immutable() RETURNS trigger AS $$
BEGIN
  IF NEW.provider_code IS DISTINCT FROM OLD.provider_code
     OR NEW.channel_code IS DISTINCT FROM OLD.channel_code THEN
    RAISE EXCEPTION '% keeps the route it was created with (%·%); a new route is a new record',
      TG_TABLE_NAME, OLD.provider_code, OLD.channel_code
      USING ERRCODE = 'check_violation';
  END IF;
  IF TG_TABLE_NAME = 'transactions'
     AND NEW.provider_environment IS DISTINCT FROM OLD.provider_environment THEN
    RAISE EXCEPTION 'transactions.provider_environment is recorded once and never changes'
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$$ LANGUAGE plpgsql;--> statement-breakpoint
DROP TRIGGER IF EXISTS "payment_methods_route_immutable" ON "payment_methods";--> statement-breakpoint
CREATE TRIGGER "payment_methods_route_immutable"
  BEFORE UPDATE OF "provider_code", "channel_code" ON "payment_methods"
  FOR EACH ROW EXECUTE FUNCTION payment_route_immutable();--> statement-breakpoint
DROP TRIGGER IF EXISTS "withdrawal_payment_methods_route_immutable" ON "withdrawal_payment_methods";--> statement-breakpoint
CREATE TRIGGER "withdrawal_payment_methods_route_immutable"
  BEFORE UPDATE OF "provider_code", "channel_code" ON "withdrawal_payment_methods"
  FOR EACH ROW EXECUTE FUNCTION payment_route_immutable();--> statement-breakpoint
DROP TRIGGER IF EXISTS "transactions_route_immutable" ON "transactions";--> statement-breakpoint
CREATE TRIGGER "transactions_route_immutable"
  BEFORE UPDATE OF "provider_code", "channel_code", "provider_environment" ON "transactions"
  FOR EACH ROW EXECUTE FUNCTION payment_route_immutable();--> statement-breakpoint

-- ── Required from here, and pointing at a real provider ─────────────────────
ALTER TABLE "payment_methods" ALTER COLUMN "provider_code" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "payment_methods" ALTER COLUMN "channel_code" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "withdrawal_payment_methods" ALTER COLUMN "provider_code" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "withdrawal_payment_methods" ALTER COLUMN "channel_code" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "transactions" ALTER COLUMN "provider_code" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "transactions" ALTER COLUMN "channel_code" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "transactions" ALTER COLUMN "provider_environment" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "payment_methods" DROP CONSTRAINT IF EXISTS "payment_methods_provider_fk";--> statement-breakpoint
ALTER TABLE "payment_methods" ADD CONSTRAINT "payment_methods_provider_fk"
  FOREIGN KEY ("provider_code") REFERENCES "payment_providers"("code") ON DELETE RESTRICT;--> statement-breakpoint
ALTER TABLE "withdrawal_payment_methods" DROP CONSTRAINT IF EXISTS "withdrawal_payment_methods_provider_fk";--> statement-breakpoint
ALTER TABLE "withdrawal_payment_methods" ADD CONSTRAINT "withdrawal_payment_methods_provider_fk"
  FOREIGN KEY ("provider_code") REFERENCES "payment_providers"("code") ON DELETE RESTRICT;--> statement-breakpoint
ALTER TABLE "transactions" DROP CONSTRAINT IF EXISTS "transactions_provider_fk";--> statement-breakpoint
ALTER TABLE "transactions" ADD CONSTRAINT "transactions_provider_fk"
  FOREIGN KEY ("provider_code") REFERENCES "payment_providers"("code") ON DELETE RESTRICT;--> statement-breakpoint
ALTER TABLE "transactions" DROP CONSTRAINT IF EXISTS "transactions_provider_environment_ck";--> statement-breakpoint
ALTER TABLE "transactions" ADD CONSTRAINT "transactions_provider_environment_ck"
  CHECK ("provider_environment" IN ('live', 'sandbox'));--> statement-breakpoint
-- The console filters and counts by route.
CREATE INDEX IF NOT EXISTS "transactions_route_idx"
  ON "transactions" ("provider_code", "channel_code", "created_at");--> statement-breakpoint

-- ── What every provider told us, kept ───────────────────────────────────────
-- Every webhook and poll result, normalised to one vocabulary
-- (`payment.pending|succeeded|failed|reversed`,
--  `payout.submitted|completed|rejected|cancelled`), with what the platform did
-- about it. A transaction's timeline and a provider's recent activity both read
-- it. The same provider event delivered twice is one row, by constraint.
CREATE TABLE IF NOT EXISTS "payment_provider_events" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "provider_code" varchar(40) NOT NULL REFERENCES "payment_providers"("code") ON DELETE RESTRICT,
  "event_key" varchar(200) NOT NULL,
  "event_type" varchar(40) NOT NULL,
  "provider_type" varchar(100),
  "source" varchar(10) NOT NULL,
  -- CASCADE: a transaction is never deleted in production (money history); only
  -- fixtures are, and their events go with them.
  "transaction_id" uuid REFERENCES "transactions"("id") ON DELETE CASCADE,
  "outcome" varchar(10) NOT NULL,
  "reason" varchar(500),
  "received_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "payment_provider_events_source_ck" CHECK ("source" IN ('webhook', 'poll', 'desk')),
  CONSTRAINT "payment_provider_events_outcome_ck"
    CHECK ("outcome" IN ('applied', 'ignored', 'rejected', 'failed')),
  CONSTRAINT "payment_provider_events_key_uq" UNIQUE ("provider_code", "event_key")
);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "payment_provider_events_transaction_idx"
  ON "payment_provider_events" ("transaction_id", "received_at")
  WHERE "transaction_id" IS NOT NULL;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "payment_provider_events_recent_idx"
  ON "payment_provider_events" ("provider_code", "received_at" DESC);--> statement-breakpoint

-- ── Who may manage payment providers ────────────────────────────────────────
-- `payments.providers.view` / `.edit` gate System → Payment providers, which
-- replaces the Rival tab on Settings. Whoever could see or change Rival there
-- can see or change it here — the same power under its new name, so the grant
-- follows the old keys (0112's remap, in one direction): view to anybody who
-- held either Rival key, edit to whoever held `settings.rival.edit`.
--
-- The old keys STAY until the console no longer calls `/admin/settings/rival`
-- (expand/contract): an admin console one release behind still gates the Rival
-- tab on them. They leave, with those routes, in the contract migration.
--
-- Roles, per-admin snapshots and pending invites — all three, for 0044's
-- reason. API keys are NOT widened (0087): nobody asked an integration to
-- repoint where payouts go.
--
-- ⚠️ No `pg_temp` helper (0068): each statement stands alone.
UPDATE "roles"
   SET "permissions" = (
     SELECT COALESCE(jsonb_agg(DISTINCT k ORDER BY k), '[]'::jsonb)
       FROM (
         SELECT e.v AS k
           FROM jsonb_array_elements_text(COALESCE("permissions", '[]'::jsonb)) e(v)
         UNION SELECT 'payments.providers.view'
         UNION SELECT 'payments.providers.edit' WHERE "permissions" ? 'settings.rival.edit'
       ) keys(k)
   )
 WHERE "permissions" ?| ARRAY['settings.rival.view', 'settings.rival.edit'];
--> statement-breakpoint
UPDATE "admins"
   SET "permissions" = (
     SELECT COALESCE(jsonb_agg(DISTINCT k ORDER BY k), '[]'::jsonb)
       FROM (
         SELECT e.v AS k
           FROM jsonb_array_elements_text(COALESCE("permissions", '[]'::jsonb)) e(v)
         UNION SELECT 'payments.providers.view'
         UNION SELECT 'payments.providers.edit' WHERE "permissions" ? 'settings.rival.edit'
       ) keys(k)
   )
 WHERE "permissions" ?| ARRAY['settings.rival.view', 'settings.rival.edit'];
--> statement-breakpoint
UPDATE "admin_invites"
   SET "permissions" = (
     SELECT COALESCE(jsonb_agg(DISTINCT k ORDER BY k), '[]'::jsonb)
       FROM (
         SELECT e.v AS k
           FROM jsonb_array_elements_text(COALESCE("permissions", '[]'::jsonb)) e(v)
         UNION SELECT 'payments.providers.view'
         UNION SELECT 'payments.providers.edit' WHERE "permissions" ? 'settings.rival.edit'
       ) keys(k)
   )
 WHERE "permissions" ?| ARRAY['settings.rival.view', 'settings.rival.edit'];
--> statement-breakpoint
-- ══ 2. 0168_drop_max_admin_credit, again ═══════════════════════════════════
ALTER TABLE "currencies" DROP CONSTRAINT IF EXISTS "currencies_money_limits_ck";--> statement-breakpoint
ALTER TABLE "currencies" DROP COLUMN IF EXISTS "max_admin_credit";--> statement-breakpoint
-- ══ 3. The four limits (0169) ══════════════════════════════════════════════
ALTER TABLE "currencies" ADD CONSTRAINT "currencies_money_limits_ck" CHECK (
  "min_deposit" > 0
  AND "max_deposit" >= "min_deposit"
  AND "min_withdrawal" > 0
  AND "max_withdrawal" >= "min_withdrawal"
);
