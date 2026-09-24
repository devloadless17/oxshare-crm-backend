-- 0135 · The Portal ID sequence is usable by the API's own role, if it has one.
--
-- 0133 made `users.portal_id` default to `nextval('users_portal_id_seq')` — the
-- first SEQUENCE this schema has ever had; every other key is a uuid from
-- `gen_random_uuid()`. So every client registration now calls `nextval`, and
-- `nextval` needs USAGE on the sequence.
--
-- Today that is free: production connects as the role that runs migrations and
-- therefore owns the sequence. 0033 records the hardening that would change it
-- — the API connecting as a role that does NOT own the schema (`app`), so the
-- ledger's REVOKE becomes a real wall. On that day this sequence is the one
-- grant nobody would think to add, and the symptom would be every new client
-- failing to register with "permission denied for sequence".
--
-- Conditional, exactly like 0033's REVOKE: the role name is deployment-specific
-- and a fresh clone has none, and a missing role must not fail the migration.
-- ⚠️ If the `app` role is created AFTER this has run, this is a no-op and the
-- grant has to be made with the role: `GRANT USAGE, SELECT ON SEQUENCE
-- users_portal_id_seq TO app;`
DO $$
BEGIN
	IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app') THEN
		GRANT USAGE, SELECT ON SEQUENCE "users_portal_id_seq" TO "app";
	END IF;
END
$$;
