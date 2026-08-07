-- Machine credentials for the admin API — ADM API keys.
--
-- Hand-written rather than generated, matching 0027 onwards: the committed
-- drizzle snapshots stop at 0026, so `drizzle-kit generate` diffs against a
-- baseline twelve migrations stale and proposes renaming a dozen unrelated
-- enums. The DDL here is the same shape `schema.ts` declares.
--
-- ── What a key IS, and what it deliberately is not ──────────────────────────
--
-- It is a credential belonging to the PLATFORM, carrying its own permission
-- list. It is NOT a stand-in for the administrator who created it. A key that
-- inherited its creator's permissions would silently gain power when they were
-- promoted, and would either die or keep a departed employee's authority when
-- they left — neither of which an integration pulling a nightly report should
-- ever experience.
--
-- ── The secret is a SHA-256 hash, not argon2id ─────────────────────────────
--
-- `admins.password_hash` uses argon2id because a password is low-entropy and
-- human-chosen, so it must survive an offline crack. This is 32 bytes from
-- `randomBytes`: brute force is not a threat, and the value is presented on
-- EVERY request, where a deliberately slow hash would be a self-inflicted
-- denial of service. High entropy pairs with a fast hash; the two decisions are
-- one decision.
--
-- The plaintext is shown once at creation and never stored, so a database dump
-- yields nothing usable. `prefix` is the non-secret leading characters, which
-- is what lets an operator tell two keys apart on screen — and match a leaked
-- key to a row — without this system ever holding a credential it could leak.

CREATE TABLE IF NOT EXISTS "api_keys" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "name" varchar(100) NOT NULL,
  -- UNIQUE so authentication is one indexed equality. Scanning rows to compare
  -- hashes would put an O(n) loop on the hot path of every request.
  "secret_hash" varchar(64) NOT NULL,
  "prefix" varchar(24) NOT NULL,
  -- Never nullable and never defaulted to '["*"]': a key created with no
  -- permissions can do nothing, which is the safe direction for a field
  -- somebody might forget to fill in.
  "permissions" jsonb DEFAULT '[]'::jsonb NOT NULL,
  -- SET NULL, not CASCADE. Deleting an administrator must not silently delete
  -- the still-live credentials they issued; an orphaned key is something an
  -- operator can see and revoke.
  "created_by" uuid,
  -- NULL means no expiry, stated rather than defaulted to a date: a key that
  -- silently stops working at 3am is worse than one an operator chose to make
  -- permanent.
  "expires_at" timestamp with time zone,
  -- Set on revocation instead of deleting the row, because the audit trail
  -- points at this id. Checked on every request, so revocation is immediate.
  "revoked_at" timestamp with time zone,
  -- Best-effort and written on a throttled schedule — an UPDATE per
  -- authenticated call would put a write on the hot path of a read-only
  -- integration, and "used within the hour" answers the real question.
  "last_used_at" timestamp with time zone,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "api_keys_secret_hash_unique" UNIQUE("secret_hash")
);
--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "api_keys" ADD CONSTRAINT "api_keys_created_by_admins_id_fk"
    FOREIGN KEY ("created_by") REFERENCES "public"."admins"("id")
    ON DELETE set null ON UPDATE no action;
EXCEPTION
  WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
-- The authentication path: hash → row. PARTIAL, because a revoked key is never
-- a hit and there is no reason to carry dead rows in the hot index.
CREATE INDEX IF NOT EXISTS "api_keys_active_idx"
  ON "api_keys" USING btree ("secret_hash") WHERE "revoked_at" IS NULL;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "api_keys_created_at_idx"
  ON "api_keys" USING btree ("created_at");
