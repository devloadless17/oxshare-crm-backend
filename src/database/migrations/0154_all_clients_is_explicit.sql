-- ============================================================================
-- "All clients" is an explicit grant — an empty territory no longer means everyone
-- ============================================================================
--
-- An administrator's client scope was DERIVED: no rows in
-- admin_client_tag_scopes meant UNRESTRICTED (D-10, D-45). The widest sight in
-- the system was therefore the result of an ABSENCE. Clearing an admin's last
-- territory tag — in the scope panel or through the API — silently promoted
-- them to every client, and an admin who should see ONLY new clients (D-60's
-- intake pool) could not be expressed at all: "no tags + new clients" also
-- resolved to everyone.
--
-- `sees_all_clients` states the grant on the row. Resolution
-- (common/security/client-scope.ts `scopeOf`):
--
--   territory tags present          → only those tags (+ new clients if granted)
--   no tags,  sees_all_clients      → every client
--   no tags, !sees_all_clients      → new clients only if granted, otherwise none
--
-- Tags RESTRICT and only the flag GRANTS, so a row carrying tags is restricted
-- whatever the flag says: nothing widens by accident.
--
-- ## Why the column defaults to TRUE
--
-- The owner's rule (D-60 addendum): restriction is the explicit act. Every app
-- path that creates or edits an administrator, invite or key writes this column
-- explicitly; the default speaks only for a raw INSERT (seeds, fixtures, a
-- hand-written SQL), which behaves exactly as it did — and tags still restrict
-- such a row.
--
-- ## Nobody's sight changes on deploy
--
-- Every admin, invite and API key that is restricted TODAY — it carries
-- territory tags — gets `false`; the rest keep `true`. The same resolution,
-- stated instead of inferred. Re-runnable (IF NOT EXISTS, idempotent updates).

ALTER TABLE "admins" ADD COLUMN IF NOT EXISTS "sees_all_clients" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "admin_invites" ADD COLUMN IF NOT EXISTS "sees_all_clients" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "api_keys" ADD COLUMN IF NOT EXISTS "sees_all_clients" boolean DEFAULT true NOT NULL;--> statement-breakpoint
UPDATE "admins" a SET "sees_all_clients" = false
  WHERE EXISTS (SELECT 1 FROM "admin_client_tag_scopes" s WHERE s."admin_id" = a."id");--> statement-breakpoint
UPDATE "admin_invites" SET "sees_all_clients" = false
  WHERE jsonb_typeof("scoped_tag_ids") = 'array' AND jsonb_array_length("scoped_tag_ids") > 0;--> statement-breakpoint
UPDATE "api_keys" SET "sees_all_clients" = false
  WHERE jsonb_typeof("scoped_tag_ids") = 'array' AND jsonb_array_length("scoped_tag_ids") > 0;
