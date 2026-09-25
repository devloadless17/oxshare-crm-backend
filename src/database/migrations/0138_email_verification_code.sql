-- 0138 · A 6-digit code, emailed beside the verification link.
--
-- Registration now ends on a screen that asks for the code from the email; the
-- right code confirms the address and signs the client straight in (asked for
-- by the client, 25 Sep 2026). The link stays in the same email as the
-- fallback for a different device.
--
-- Four columns, all described in schema.ts. None is on the `User` object — the
-- store strips them — and only the store's code methods read or write them.
--
-- Re-runnable: every statement is IF NOT EXISTS.
ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "email_verification_code_hash" varchar(64);
ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "email_verification_code_expires_at" timestamp with time zone;
ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "email_verification_code_attempts" integer DEFAULT 0 NOT NULL;
ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "email_verification_code_sent_at" timestamp with time zone;
