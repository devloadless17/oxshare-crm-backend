-- ============================================================================
-- `Administrator` is a SYSTEM role, and the flag is what keeps it complete
-- ============================================================================
--
-- `permission-drift.ts` brings the top role up to `config/permissions.json` on
-- every boot, so a permission added to the catalog needs no migration. It used
-- to find that role by MAGIC STRING — `WHERE name = 'Administrator'` — against a
-- row that said `is_system = false`.
--
-- So the role was special in fact and ordinary in the data, and two things
-- followed. Renaming it in the console silently stopped the top-up, with the
-- symptom arriving weeks later as a 403 on a screen the full-access account
-- plainly ought to reach. And nothing in the schema recorded which role the rule
-- was about, which is why the reasoning had to live in a comment that said, in
-- as many words, that the code could not derive it.
--
-- The flag now carries the rule. `is_system = true` means "the backend maintains
-- this role's permissions against the catalog", `permission-drift.ts` matches on
-- it, and the magic string is gone.
--
-- ── This is NOT `Master Admin` returning ────────────────────────────────────
--
-- That role carried `['*']` and was HIDDEN from the roles screen and from every
-- assignment control, which made full access something the console could neither
-- show nor hand out. `isSystem` was the flag doing the hiding.
--
-- It no longer hides anything. The admin console ships in the same release with
-- the three filters removed, so a system role is listed (badged, with no action
-- menu) and remains assignable from both the admin directory and the invite
-- modal. What the API refuses is EDITING and DELETING it — never holding it.
--
-- ⚠️ ORDER: the console change must be live BEFORE or WITH this. A database
-- carrying the flag under the old frontend is one where `Administrator` cannot
-- be seen or granted to anybody, which is the failure above, reintroduced.
--
-- ── Why one role and not a set ──────────────────────────────────────────────
--
-- Only the row named `Administrator`, and only if it is not already flagged.
-- Every other role is left exactly as it is: the whole point of the other eleven
-- is that they are narrow, and flagging one would both freeze it against editing
-- and widen it to the entire catalog on the next boot. `Support Agent` lacking
-- `payments.edit` is not drift, it is the role.
--
-- Idempotent: the WHERE clause matches nothing on a second run. Re-runnable by
-- construction, which the header of 0091 explains is required of any migration
-- that might be renumbered upstream.
--
-- A FRESH database never reaches this — `seed.ts` now seeds the role with
-- `isSystem: true` directly, and `scripts/bootstrap-admin.mjs` does the same.
-- This exists for the databases that already have the row.

BEGIN;

UPDATE roles
   SET is_system = true
 WHERE name = 'Administrator'
   AND is_system = false;

COMMIT;
