-- Password reset (FR-CORE-09 · PLATFORM-CONVENTIONS R-3.5).
--
-- The portal has had a working reset UI for months with no endpoint behind it:
-- both calls 404'd, so a client who forgot their password had no recovery path
-- and no explanation. This is the column that half of the flow was missing.
--
-- A HASH, not the token. The emailed token can take over an account, so storing
-- it verbatim would mean a database dump, a leaked backup or a read-only
-- injection hands an attacker a working reset link for every user with one
-- outstanding. SHA-256 is the right choice here rather than argon2: the token is
-- high-entropy random rather than a guessable secret, so there is nothing to
-- slow down a brute force against — and a slow hash would add latency to a
-- lookup on every reset attempt.
--
-- Nullable, because most users have no reset in flight at any moment. Both
-- columns are cleared on use, so a consumed token cannot be replayed.
ALTER TABLE "users" ADD COLUMN "password_reset_token_hash" varchar(64);--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "password_reset_expiry" timestamp with time zone;--> statement-breakpoint

-- Looked up by hash on every reset attempt, and that lookup is unauthenticated:
-- without an index it is a sequential scan an attacker can trigger at will.
CREATE INDEX "users_password_reset_token_idx" ON "users" USING btree ("password_reset_token_hash");
