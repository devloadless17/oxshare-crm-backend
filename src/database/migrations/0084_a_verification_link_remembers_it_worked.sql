-- UX-01 — a verified account is told "Verification Failed".
--
-- `verifyEmail` deleted the token from the row the instant it worked, which made
-- "this token was redeemed a minute ago" and "this token never existed" the same
-- state. The backend could only answer the second, so a refresh, the Back
-- button, a restored tab, or a corporate mail scanner prefetching the link
-- produced a red "Verification Failed" on an account that was verified.
--
-- Redemption becomes a TIMESTAMP rather than an absence, so the token's row
-- survives being used and a second click can be answered honestly.
--
-- Keeping a redeemed PLAINTEXT token would reinstate exactly what the 6 Aug change
-- removed: a bearer credential outliving its own expiry, and the last plaintext
-- single-use credential in this schema. So the column becomes a SHA-256 HASH —
-- the same treatment `password_reset_token_hash` has always had, and for the
-- same reason. A hash is not a usable credential, which is what makes keeping
-- it indefinitely safe.

ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "email_verification_token_hash" varchar(64);
--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "email_verification_consumed_at" timestamp with time zone;
--> statement-breakpoint

-- Every OUTSTANDING link keeps working across this deploy.
--
-- Hashing the tokens in place rather than dropping the column and letting them
-- fail is the difference between a silent migration and a support queue: at any
-- moment some clients registered in the last 24 hours are holding an unclicked
-- link, and it is the only route into their account.
--
-- `sha256()` and `convert_to()` are built in (PG 11+), so this needs no
-- extension — and it must produce byte-identical output to
-- `hashEmailedToken()` in src/common/security/emailed-token.ts, which is
-- `createHash('sha256').update(token, 'utf8').digest('hex')`.
-- Guarded so this migration is re-runnable: the column it reads is dropped
-- eight lines down, and a migration that errors on a second application is one
-- nobody can safely replay against a restored backup.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_name = 'users' AND column_name = 'email_verification_token'
  ) THEN
    UPDATE "users"
       SET "email_verification_token_hash" =
           encode(sha256(convert_to("email_verification_token", 'UTF8')), 'hex')
     WHERE "email_verification_token" IS NOT NULL;
  END IF;
END $$;
--> statement-breakpoint

-- Accounts already verified before today get NO redemption marker, and cannot:
-- their token was destroyed by the old code and there is nothing left to match a
-- returning link against. They keep the old behaviour — an old link answers
-- "invalid" — while every link issued from here on answers "already verified".
-- Stated rather than discovered.

ALTER TABLE "users" DROP COLUMN IF EXISTS "email_verification_token";
--> statement-breakpoint

-- The verification lookup is a by-token seek over the whole table and had no
-- index while the column was plaintext, which it got away with because it was
-- rare. The hash now OUTLIVES redemption, so every repeat click, refresh and
-- scanner prefetch is another seek — and ARCHITECTURE §5 sizes this table at
-- ~219,000 rows.
--
-- UNIQUE for CORRECTNESS, not speed. `findByVerificationTokenHash` takes
-- `limit 1`; two rows sharing a hash would verify an arbitrary one of them,
-- silently, on the control that gates KYC and therefore withdrawals. Tokens are
-- `randomUUID` so it cannot happen by chance — the constraint is here so that if
-- it ever does it is an insert failure somebody has to look at. Nulls do not
-- collide in Postgres, so rows with no outstanding token are unaffected.
CREATE UNIQUE INDEX IF NOT EXISTS "users_email_verification_token_hash_idx"
  ON "users" ("email_verification_token_hash");
