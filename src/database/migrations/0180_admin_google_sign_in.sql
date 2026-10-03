-- 0180 — "SIGN IN WITH GOOGLE" FOR THE ADMIN CONSOLE (3 Oct 2026).
--
-- An administrator may link ONE Google account and sign in with it instead of
-- a password. The portal is untouched: clients do not get this.
--
-- admins.google_sub        Google's stable subject id (`sub`), the IDENTITY
--                          the link is keyed on — never the address, which a
--                          Google account can change. UNIQUE, so one Google
--                          account can never sign in as two administrators.
--                          NULL = not linked (every existing row).
-- admins.google_email      the Google address at link time / last sign-in,
--                          for the console to show "linked as …". Display
--                          only; nothing authenticates on it.
-- admins.google_linked_at  when the link was made.
--
-- A link is made on the first Google sign-in whose VERIFIED address equals the
-- administrator's own. If the administrator's EMAIL later changes, the link
-- was made against an identity they no longer hold, so the trigger below
-- clears it — whichever code path (or hand-written SQL) changes the address.
-- No application path edits an admin's email today; the trigger is what makes
-- that true of the next one too, rather than a rule somebody must remember.
--
-- Idempotent (IF NOT EXISTS / OR REPLACE / DROP ... IF EXISTS), and it relies
-- on no transaction scope — see the "fresh database" gotcha in CLAUDE.md.

ALTER TABLE admins ADD COLUMN IF NOT EXISTS google_sub varchar(255);
--> statement-breakpoint
ALTER TABLE admins ADD COLUMN IF NOT EXISTS google_email varchar(255);
--> statement-breakpoint
ALTER TABLE admins ADD COLUMN IF NOT EXISTS google_linked_at timestamptz;
--> statement-breakpoint
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'admins_google_sub_unique') THEN
    ALTER TABLE admins ADD CONSTRAINT admins_google_sub_unique UNIQUE (google_sub);
  END IF;
END $$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION admins_clear_google_on_email_change() RETURNS trigger AS $$
BEGIN
  IF NEW.email IS DISTINCT FROM OLD.email THEN
    NEW.google_sub := NULL;
    NEW.google_email := NULL;
    NEW.google_linked_at := NULL;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint
DROP TRIGGER IF EXISTS admins_clear_google_on_email_change ON admins;
--> statement-breakpoint
CREATE TRIGGER admins_clear_google_on_email_change
  BEFORE UPDATE OF email ON admins
  FOR EACH ROW EXECUTE FUNCTION admins_clear_google_on_email_change();
