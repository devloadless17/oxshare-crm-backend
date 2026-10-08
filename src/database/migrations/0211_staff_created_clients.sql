-- 0211 — STAFF CREATE A CLIENT FROM ZERO ("New client", 8 Oct 2026)
--
-- For people who cannot sign up themselves (elderly people, anyone who
-- struggles): an administrator creates the client, completes their KYC for them
-- ("Complete KYC", 0210) and the client receives a welcome email to choose their
-- own password. The client is created by the SAME checks a sign-up passes
-- (`ClientCreation`), so a staff-made client is identical to a self-made one.
-- Two facts that path needs, and nothing else:
--
-- 1. `users.created_by_admin_id` — WHO created them. Separate from
--    `signed_up_via_admin_id`, which keeps its meaning (whose sign-up LINK
--    brought them). Written once and never changed (trigger), like that one,
--    and `ON DELETE RESTRICT` for the same reason: attribution is history, and
--    an administrator who created clients is suspended, not deleted.
--
-- 2. `users.password_set_at` — WHEN the client last chose their password. NULL
--    for a staff-created client until they use the welcome link: that is what
--    "has this client ever chosen a password?" means, exactly, and it decides
--    whether a welcome email can be (re)sent and what changing the email sends.
--    Every existing client chose one at sign-up, so they are backfilled with
--    their creation time.
--
-- Also grants the new `clients.create` key to the system (Administrator) role,
-- so the release is self-contained (`permission-drift.ts` would top it up at
-- boot anyway). Hand-written (see 0040's header). Re-runnable.

ALTER TABLE users
  ADD COLUMN IF NOT EXISTS created_by_admin_id uuid REFERENCES admins(id) ON DELETE RESTRICT;

CREATE INDEX IF NOT EXISTS users_created_by_admin_id_idx
  ON users (created_by_admin_id)
  WHERE created_by_admin_id IS NOT NULL;

CREATE OR REPLACE FUNCTION users_created_by_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.created_by_admin_id IS DISTINCT FROM OLD.created_by_admin_id THEN
    RAISE EXCEPTION 'Which administrator created a client is history and cannot change'
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS users_created_by_immutable ON users;
CREATE TRIGGER users_created_by_immutable BEFORE UPDATE OF created_by_admin_id ON users
  FOR EACH ROW EXECUTE FUNCTION users_created_by_immutable();

ALTER TABLE users ADD COLUMN IF NOT EXISTS password_set_at timestamptz;

-- Every client who signed up THEMSELVES chose a password when they did. Never a
-- staff-created one: their NULL means "not chosen yet", and a re-run of this
-- migration must not invent a choice they never made.
UPDATE users SET password_set_at = created_at
 WHERE password_set_at IS NULL AND created_by_admin_id IS NULL;

UPDATE roles
   SET permissions = (
     SELECT COALESCE(jsonb_agg(DISTINCT k ORDER BY k), '[]'::jsonb)
       FROM (
         SELECT e.v AS k FROM jsonb_array_elements_text(COALESCE(permissions, '[]'::jsonb)) e(v)
         UNION SELECT 'clients.create'
       ) keys(k)
   )
 WHERE is_system = true;
