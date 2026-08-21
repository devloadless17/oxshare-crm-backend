-- Give the `Administrator` role the five keys it is missing from the catalog.
--
-- Shaped after 0085, which repaired the same class of gap for `ledger.view`,
-- and 0075 before it for four others. The comments there explain every choice
-- repeated here; this header records only what is new.
--
-- ── Found by the code, not by a person ─────────────────────────────────────
--
-- `permission-drift.ts` reports the gap on every boot, and named these five on
-- the first start after 0086 deployed:
--
--   clients.edit  clients.email
--   ib.programs.create  ib.programs.edit  ib.programs.delete
--
-- The last three are the reason this cannot wait. 0086 created `ib_programs`
-- and placed every partner on a Default programme, so the feature is live in
-- the database and unreachable from the console: the role whose stated contract
-- is "every permission in the catalog" gets 403 on the programmes screens.
--
-- ── Why the console cannot close this gap ──────────────────────────────────
--
-- `assertRoleNotSelf` refuses an edit to the role the actor is assigned to, and
-- on a bootstrap deployment every administrator sits on `Administrator`. The
-- ordinary route — "grant it on the Roles screen" — therefore needs a second
-- role holding `roles.edit` and an admin assigned to it, created by somebody who
-- is already locked out of half the screens. A migration is the shorter path and
-- the one 0075 and 0085 both took.
--
-- There is no longer an account that bypasses this. `MasterAdminGuard` and
-- `isMaster()` were removed in 0044 precisely because they answered "who is
-- asking" instead of "what do they hold"; `admins.role` still carries
-- `master_admin` but nothing has read it since. A key reaches an administrator
-- through a role or it does not reach them at all.
--
-- ── Why a migration and not the seed ───────────────────────────────────────
--
-- Unchanged from 0085: `ALL_PERMISSIONS` is computed from
-- `config/permissions.json`, so a FRESH database gets all five with no help,
-- but the seed's `onConflictDoNothing({ target: roles.name })` deliberately
-- refuses to re-widen an existing role. Permissions are a STORED SNAPSHOT, not
-- a live reference to the catalog. `main.ts` calls `runSeeds()` only when
-- NODE_ENV is not production, so on a deployed database a migration is the only
-- thing that can carry a new key.
--
-- ── Scope: this role, by name, and nothing else ────────────────────────────
--
-- A role somebody built by hand is THEIR role and is not touched. If your
-- full-access role is named something else, grant these on the Roles screen
-- instead — the ordinary way a new power is handed out.
--
-- Idempotent: `UNION` + `jsonb_agg(DISTINCT …)` cannot produce a duplicate, so
-- re-running is a no-op on a row that already holds the keys.
UPDATE roles
   SET permissions = (
     SELECT COALESCE(jsonb_agg(DISTINCT k ORDER BY k), '[]'::jsonb)
       FROM (
         SELECT e.v AS k FROM jsonb_array_elements_text(COALESCE(permissions, '[]'::jsonb)) e(v)
         UNION SELECT * FROM unnest(ARRAY[
           'clients.edit',
           'clients.email',
           'ib.programs.create',
           'ib.programs.edit',
           'ib.programs.delete'
         ])
       ) keys(k)
   )
 WHERE name = 'Administrator';
--> statement-breakpoint

-- The per-admin SNAPSHOT on the two seeded accounts, for the reason 0075 gives.
--
-- `RolesStore.resolvePermissions(roleId, snapshot)` prefers the ROLE and falls
-- back to the snapshot only when no role is attached, so on a correctly seeded
-- database the statement above is already sufficient. This covers the case
-- seed.ts documents at its `WHERE roleId IS NULL` backfill: an account seeded
-- with a full-access snapshot and never attached to a role resolves through the
-- snapshot, and would otherwise keep the gap the role row had.
--
-- Restricted to the two SEEDED addresses. A human administrator's snapshot is
-- their own and is not a place this migration may write.
UPDATE admins
   SET permissions = (
     SELECT COALESCE(jsonb_agg(DISTINCT k ORDER BY k), '[]'::jsonb)
       FROM (
         SELECT e.v AS k FROM jsonb_array_elements_text(COALESCE(permissions, '[]'::jsonb)) e(v)
         UNION SELECT * FROM unnest(ARRAY[
           'clients.edit',
           'clients.email',
           'ib.programs.create',
           'ib.programs.edit',
           'ib.programs.delete'
         ])
       ) keys(k)
   )
 WHERE email IN ('admin@oxshare.com', 'e2e-admin@oxshare.com');

/*
 * ⚠️ NO `pg_temp` HELPER FUNCTION — the warning 0068 earned the hard way and
 * 0075 and 0085 both repeat. `pg_temp` is session-local and the migration
 * runner does not guarantee every statement lands on the same session, so a
 * factored-out helper can vanish between its creation and the UPDATEs that
 * reference it, each of which then succeeds against zero rows rather than
 * failing loudly. The array is repeated in full for that reason.
 *
 * PENDING INVITES ARE NOT INCLUDED, for 0075's reason: an invite carries a
 * `roleId`, so an invitee joining `Administrator` resolves from the row
 * corrected above and receives the keys with no rewrite. An invite carrying a
 * hand-picked permission list is somebody's deliberate choice.
 *
 * API KEYS ARE NOT INCLUDED. Nobody asked an integration to edit clients, mail
 * them, or rewrite partner economics, and a machine credential that quietly
 * gains a power is the kind of thing found during an incident rather than a
 * review.
 */
