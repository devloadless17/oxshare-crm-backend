-- 0191 — GOOGLE AUTHENTICATOR (TOTP) REPLACES "SIGN IN WITH GOOGLE" (5 Oct 2026).
--
-- The owner asked for a second FACTOR, not a second way in: 0180 let an
-- administrator sign in with a Google account INSTEAD of a password. That is
-- withdrawn (owner, 5 Oct 2026), and every admin sign-in now takes a password
-- AND a 6-digit code from an authenticator app (Google Authenticator or any
-- RFC 6238 app). Required for every administrator, no opt-out.
--
-- 1. 0180's columns, constraint, trigger and function are dropped. A Google
--    link is no longer a credential, so keeping the subject ids would be
--    holding identifiers for a feature that no longer exists.
--
-- 2. admins.totp_secret          sealed (secret-box, APP_ENCRYPTION_KEY) secret
--                                of the CONFIRMED authenticator. NULL = not set
--                                up: that admin's next sign-in is enrolment.
--    admins.totp_pending_secret  sealed secret shown as a QR code during
--                                enrolment, promoted once a code from it is
--                                confirmed.
--    admins.totp_enabled_at      when the authenticator was confirmed.
--    admins.totp_last_step       the 30-second step of the last code accepted;
--                                a code at or below it is refused (replay).
--
-- 3. Every live admin session ends. A session minted before this migration
--    was minted on a password alone, and "required for everyone" would not be
--    true for the thirty days such a refresh token lasts. Revoking the family
--    also stops its access token at the guard (it carries `fam`). Every
--    administrator signs in once more and sets up the app. Portal sessions are
--    untouched.
--
-- Idempotent (IF EXISTS / IF NOT EXISTS; the UPDATE only touches live rows),
-- and it relies on no transaction scope — see the "fresh database" gotcha in
-- CLAUDE.md.

DROP TRIGGER IF EXISTS admins_clear_google_on_email_change ON admins;
--> statement-breakpoint
DROP FUNCTION IF EXISTS admins_clear_google_on_email_change();
--> statement-breakpoint
ALTER TABLE admins DROP CONSTRAINT IF EXISTS admins_google_sub_unique;
--> statement-breakpoint
ALTER TABLE admins DROP COLUMN IF EXISTS google_sub;
--> statement-breakpoint
ALTER TABLE admins DROP COLUMN IF EXISTS google_email;
--> statement-breakpoint
ALTER TABLE admins DROP COLUMN IF EXISTS google_linked_at;
--> statement-breakpoint
ALTER TABLE admins ADD COLUMN IF NOT EXISTS totp_secret text;
--> statement-breakpoint
ALTER TABLE admins ADD COLUMN IF NOT EXISTS totp_pending_secret text;
--> statement-breakpoint
ALTER TABLE admins ADD COLUMN IF NOT EXISTS totp_enabled_at timestamptz;
--> statement-breakpoint
ALTER TABLE admins ADD COLUMN IF NOT EXISTS totp_last_step bigint;
--> statement-breakpoint
UPDATE refresh_tokens SET revoked_at = now()
  WHERE surface = 'admin' AND revoked_at IS NULL;
