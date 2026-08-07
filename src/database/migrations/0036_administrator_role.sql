-- Make "unrestricted admin" an assignable ROLE rather than an enum value.
--
-- ── The problem ─────────────────────────────────────────────────────────────
--
-- Full access existed in exactly one form: `admins.role = 'master_admin'`, a
-- value of the `admin_role` Postgres enum set by the seed on the bootstrap
-- account. It corresponded to no row in `roles`, so:
--
--   * The admin directory rendered the raw string `master_admin` in the Role
--     column — a value an operator cannot choose, edit or explain.
--   * There was no way to create a SECOND unrestricted administrator except by
--     UPDATE-ing the database by hand.
--   * The Role dropdown on that screen lists assignable roles, so the one role
--     the most privileged accounts held was the one it could not show.
--
-- ── What this does ──────────────────────────────────────────────────────────
--
-- Seeds an `Administrator` role carrying `["*"]` — the same wildcard
-- `PermissionsGuard` and `isMaster()` already honour, so no new privilege level
-- is created here — and points every existing master admin at it.
--
-- ── What it deliberately does NOT do ────────────────────────────────────────
--
-- It does not clear `admins.role`, and it does not remove `master_admin` from
-- the `admin_role` enum.
--
-- Postgres can ADD a value to an enum but cannot DROP one without rewriting the
-- type, and `rejection_context` in schema.ts already carries a dead value for
-- precisely that reason. More importantly the column is still load-bearing:
-- `MasterAdminGuard`, `admin-rbac.service.ts` (which refuses to suspend or
-- de-privilege a master) and `admin-reset.ts` all read it. Clearing it here
-- would strip those protections from the bootstrap account in the same
-- migration that is supposed to be cosmetic.
--
-- So the enum stays as the marker of the ROOT account, and the role becomes how
-- access is described and granted. `MasterAdminGuard` was widened in the same
-- change to accept the `*` wildcard as well as the enum, so an administrator
-- holding this role reaches the audit log, reconciliation, SMTP and the
-- security settings — before that widening they would have passed every
-- permission check and then been refused by those twelve routes alone.
--
-- Idempotent: safe to re-run, and does nothing on a database that already has
-- the role.

-- The role itself. ON CONFLICT so this agrees with seed.ts, which inserts the
-- same row on every non-production boot; whichever runs first wins and the
-- other is a no-op.
INSERT INTO "roles" ("name", "description", "permissions", "masked_fields", "is_system")
VALUES (
  'Administrator',
  'Unrestricted access to every part of the console.',
  '["*"]'::jsonb,
  '[]'::jsonb,
  false
)
ON CONFLICT ("name") DO NOTHING;

-- Point existing master admins at it, so the directory shows a role name
-- instead of an enum value.
--
-- `role_id IS NULL` guard: an administrator who has already been given a
-- specific role keeps it. This migration is about the accounts that had no role
-- at all, not about overwriting a deliberate assignment.
UPDATE "admins"
SET "role_id" = (SELECT "id" FROM "roles" WHERE "name" = 'Administrator')
WHERE "role" = 'master_admin'
  AND "role_id" IS NULL;
