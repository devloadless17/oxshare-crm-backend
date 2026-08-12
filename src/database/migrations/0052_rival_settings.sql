-- The Rival integration's config substrate — settings row + transaction columns.
--
-- ⚠️ Hand-written, like every migration since 0027 (snapshots stop at 0026).
-- Journal `when` must exceed MAX(created_at) in drizzle.__drizzle_migrations —
-- see the header of 0049 for the hour that lesson cost.
--
-- ── Why the CRM stops talking to Whish ──────────────────────────────────────
--
-- Loadless (the operator's company) runs Rival, its own payments platform, and
-- Whish is integrated ONCE inside it. Merchant systems — the OxShare PSP portal
-- before this CRM — are Rival "companies" holding a `tsk_…` API key. Deposits
-- are created at Rival (`POST /v1/integrations/whish/payments`), the client pays
-- on the hosted page Rival mints, and settlement is announced by Rival's signed
-- CRM webhooks. Whish credentials never live here; only a Rival key does.
--
-- ── rival_settings: same singleton shape as smtp_settings ───────────────────
--
-- One row forever, enforced by the same `CHECK (id)` trick: `id` is boolean,
-- always true, and the primary key — a second row would need a second distinct
-- boolean-true, which does not exist.
--
-- Two ciphertexts, one deliberate asymmetry between them:
--
--   * `api_key_ciphertext`  — OUR credential AT Rival. Write-only: sealed on
--     save, opened only by RivalConfigService on the way to an outbound call,
--     never returned by any endpoint.
--   * `webhook_key_ciphertext` — the credential Rival presents TO US. It is
--     SEALED, NOT HASHED, and that is a decision: this key is the HMAC secret
--     for inbound webhook signatures, and verifying an HMAC requires the
--     plaintext. An argon2 hash (the treatment login credentials get) would
--     make verification impossible. AES-256-GCM at rest via secret-box is the
--     strongest storage that still leaves the key usable.

CREATE TABLE "rival_settings" (
	"id" boolean PRIMARY KEY DEFAULT true NOT NULL,
	"base_url" varchar(2048),
	"api_key_ciphertext" text,
	"webhook_key_ciphertext" text,
	-- sha256(key)[:8]: enough for an operator to tell "wrong key pasted" from
	-- "corrupt signature" in a log line, and useless for recovering the key.
	"webhook_key_fingerprint" varchar(8),
	"enabled" boolean DEFAULT false NOT NULL,
	-- Liveness, not ordering: bumped on every verified inbound event so the
	-- settings screen can answer "is the pipe alive". Event ordering is carried
	-- by the transaction state machine's conditional updates, never by this.
	"last_event_at" timestamp with time zone,
	"updated_by" uuid,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "rival_settings_singleton" CHECK ("rival_settings"."id")
);
--> statement-breakpoint

-- ── transactions: the four Rival columns ────────────────────────────────────
--
-- `provider_ref` stays OURS (the OX-… reference): the portal's status endpoint
-- settles by (provider, provider_ref) with that value, and it doubles as the
-- idempotencyKey sent to Rival so a retried create converges on one payment.
-- Rival's identifiers therefore get their own columns rather than overwriting
-- a reference two existing code paths match on.
--
--   * rival_external_id   — Rival's numeric externalId for a whish DEPOSIT.
--     The webhook's `reference` is "whish:<externalId>", and the event's
--     `transaction.id` is NULL on pending/failed — so this column is the ONLY
--     reliable join key for inbound deposit events.
--   * rival_withdrawal_id — Rival's withdrawal UUID once submitted.
--   * rival_submitted_at  — the double-create CLAIM. Rival's withdrawal create
--     has NO idempotency key, so the claim is taken with a conditional UPDATE
--     (…WHERE rival_submitted_at IS NULL) BEFORE calling out; a crash between
--     claim and create fails safe (reconciler clears), a crash between create
--     and record is recovered by matching our `crm:<txId>` note on Rival's
--     pending list (reconciler adopts).
--   * rival_needs_attention — a human-reconciliation flag: money PAID at Rival
--     against a terminally-failed row, a reversal of settled funds, states
--     that disagree. Never cleared by an event; an operator clears it by
--     resolving the row.

ALTER TABLE "transactions" ADD COLUMN "rival_external_id" varchar(40);
--> statement-breakpoint
ALTER TABLE "transactions" ADD COLUMN "rival_withdrawal_id" varchar(64);
--> statement-breakpoint
ALTER TABLE "transactions" ADD COLUMN "rival_submitted_at" timestamp with time zone;
--> statement-breakpoint
ALTER TABLE "transactions" ADD COLUMN "rival_needs_attention" boolean DEFAULT false NOT NULL;
--> statement-breakpoint

-- Partial UNIQUE: one CRM row per Rival payment / withdrawal. This is the §6.3
-- constraint form of "an event can never credit two rows", and partial because
-- most rows (manual methods, pre-Rival history) have no Rival identifier.
CREATE UNIQUE INDEX "transactions_rival_external_id_uq" ON "transactions" ("rival_external_id") WHERE "transactions"."rival_external_id" IS NOT NULL;
--> statement-breakpoint
CREATE UNIQUE INDEX "transactions_rival_withdrawal_id_uq" ON "transactions" ("rival_withdrawal_id") WHERE "transactions"."rival_withdrawal_id" IS NOT NULL;
--> statement-breakpoint

-- The poller's two scans: pending deposits awaiting settlement, approved
-- withdrawals awaiting Rival's decision. Partial, so the index holds only the
-- handful of in-flight rows rather than the whole history.
CREATE INDEX "transactions_rival_pending_idx" ON "transactions" ("state") WHERE "transactions"."rival_external_id" IS NOT NULL AND "transactions"."state" = 'pending';
--> statement-breakpoint
CREATE INDEX "transactions_rival_approved_idx" ON "transactions" ("state") WHERE "transactions"."state" = 'approved' AND "transactions"."rival_submitted_at" IS NOT NULL;
--> statement-breakpoint

-- ── Grant the two new settings keys to full-access holders ──────────────────
--
-- The 0049 lesson, applied on the day it was learned rather than re-learned:
-- a catalog key nobody holds breaks role editing, because `assertGrantable`
-- refuses to let an editor re-send a key they were never given — so an
-- administrator with every permission could no longer save any role.
--
-- Same probe shape as 0049 (a fingerprint of "holds every key the catalog had
-- before this change", now including the trading write keys it added), same
-- both-tables treatment: `roles` for role-holders, `admins` for the per-admin
-- snapshot `resolvePermissions` falls back to.
--
-- A role narrowed by hand does not match and must not: these keys configure
-- where every payout instruction goes.

UPDATE roles
SET permissions = permissions || '["settings.rival.view","settings.rival.edit"]'::jsonb
WHERE permissions @> '["clients.view","admins.view","roles.delete","kyc.delete","wallets.credit","withdrawals.settle","trading.view","trading.create","ib.commissions.view","tags.delete","currencies.delete","apikeys.revoke","settings.security.edit","audit.view","reconciliation.view","payments.view"]'::jsonb
  AND NOT permissions @> '["settings.rival.view"]'::jsonb;
--> statement-breakpoint

UPDATE admins
SET permissions = permissions || '["settings.rival.view","settings.rival.edit"]'::jsonb
WHERE permissions @> '["clients.view","admins.view","roles.delete","kyc.delete","wallets.credit","withdrawals.settle","trading.view","trading.create","ib.commissions.view","tags.delete","currencies.delete","apikeys.revoke","settings.security.edit","audit.view","reconciliation.view","payments.view"]'::jsonb
  AND NOT permissions @> '["settings.rival.view"]'::jsonb;
