-- Give the new `leverages.*` keys to whoever already held the equivalent power.
--
-- Hand-written rather than generated, matching 0027 onwards.
--
-- ── Why a migration and not just a catalog entry ────────────────────────────
--
-- Permissions are a STORED SNAPSHOT per admin, role, invite and API key — not a
-- reference to the catalog. So adding `leverages.view` to
-- `config/permissions.json` gives it to nobody, including the master admin, and
-- `AdminRbacService.assertGrantable` then refuses to hand it out:
--
--   "You cannot grant permissions you do not hold: leverages.view, …"
--
-- That guard is right and deliberate — the account with every key can grant
-- every key BECAUSE it holds them, not because it is exempt from the check.
-- The consequence is that a NEW key is unreachable until something writes it
-- into the rows, and that something has to be a migration.
--
-- ── Who gets them, and why that is not "everybody" ──────────────────────────
--
-- The ladder lived on Settings → Trading (migration 0067 moved it out), edited
-- through `settings.edit` and read through `settings.view`. So the grant
-- follows the power that already existed:
--
--   settings.view  →  leverages.view
--   settings.edit  →  leverages.create, leverages.edit, leverages.delete
--
-- Nobody gains an ability they did not have yesterday: an operator who could
-- change the leverage CSV can change the ladder, and one who could only read
-- the settings screen can only read it. What they gain is the ability to be
-- granted leverage control WITHOUT also being handed the SMTP password and the
-- rest of `settings.*` — the same correction currencies made in 0044.
--
-- ── ⚠️ NO `pg_temp` HELPER FUNCTION ─────────────────────────────────────────
--
-- The first version of this factored the rewrite into `pg_temp._grant_…()`, the
-- way 0044 does. It applied cleanly and granted NOTHING.
--
-- `pg_temp` is session-local, and the migration runner does not guarantee that
-- every statement in a file lands on the same session — so the function was
-- created and then gone before the UPDATEs that referenced it, and each UPDATE
-- succeeded against zero rows rather than failing loudly. A migration that
-- reports success while doing nothing is the worst shape available.
--
-- Inlined instead. It is three near-identical statements, which is the cost of
-- not depending on session scope, and the deduplicating aggregate is what keeps
-- each one safe to re-run.
UPDATE roles
   SET permissions = (
     SELECT COALESCE(jsonb_agg(DISTINCT k ORDER BY k), '[]'::jsonb)
       FROM (
         SELECT e.v AS k FROM jsonb_array_elements_text(COALESCE(permissions, '[]'::jsonb)) e(v)
         UNION SELECT 'leverages.view'   WHERE permissions @> '["settings.view"]'
         UNION SELECT 'leverages.create' WHERE permissions @> '["settings.edit"]'
         UNION SELECT 'leverages.edit'   WHERE permissions @> '["settings.edit"]'
         UNION SELECT 'leverages.delete' WHERE permissions @> '["settings.edit"]'
       ) keys(k)
   )
 WHERE permissions @> '["settings.view"]' OR permissions @> '["settings.edit"]';
--> statement-breakpoint

UPDATE admins
   SET permissions = (
     SELECT COALESCE(jsonb_agg(DISTINCT k ORDER BY k), '[]'::jsonb)
       FROM (
         SELECT e.v AS k FROM jsonb_array_elements_text(COALESCE(permissions, '[]'::jsonb)) e(v)
         UNION SELECT 'leverages.view'   WHERE permissions @> '["settings.view"]'
         UNION SELECT 'leverages.create' WHERE permissions @> '["settings.edit"]'
         UNION SELECT 'leverages.edit'   WHERE permissions @> '["settings.edit"]'
         UNION SELECT 'leverages.delete' WHERE permissions @> '["settings.edit"]'
       ) keys(k)
   )
 WHERE permissions @> '["settings.view"]' OR permissions @> '["settings.edit"]';
--> statement-breakpoint

-- Pending invites too. An invite carries its own permission set and is checked
-- by the same `assertGrantable`, so one issued before this migration would
-- otherwise create an admin who cannot see a screen their role implies.
UPDATE admin_invites
   SET permissions = (
     SELECT COALESCE(jsonb_agg(DISTINCT k ORDER BY k), '[]'::jsonb)
       FROM (
         SELECT e.v AS k FROM jsonb_array_elements_text(COALESCE(permissions, '[]'::jsonb)) e(v)
         UNION SELECT 'leverages.view'   WHERE permissions @> '["settings.view"]'
         UNION SELECT 'leverages.create' WHERE permissions @> '["settings.edit"]'
         UNION SELECT 'leverages.edit'   WHERE permissions @> '["settings.edit"]'
         UNION SELECT 'leverages.delete' WHERE permissions @> '["settings.edit"]'
       ) keys(k)
   )
 WHERE (permissions @> '["settings.view"]' OR permissions @> '["settings.edit"]')
   AND accepted = false;

/*
 * API KEYS ARE DELIBERATELY NOT INCLUDED.
 *
 * 0044 rewrote them because it was RENAMING keys — an untouched key would have
 * left an integration calling an endpoint whose guard no longer recognised its
 * grant. This migration renames nothing: every existing key keeps working
 * exactly as it does today.
 *
 * Widening a machine credential's scope is a different act from preserving an
 * operator's. Nobody asked for these integrations to manage the leverage
 * ladder, and a key that quietly gains a power is the kind of thing found
 * during an incident rather than a review.
 */
