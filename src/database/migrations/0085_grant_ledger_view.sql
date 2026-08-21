-- Give the `Administrator` role the `ledger.view` key ADM-13 added.
--
-- Shaped after 0075, which repaired the same class of gap for four other keys,
-- down to the deduplicating aggregate and the `pg_temp` warning it inherited
-- from 0068.
--
-- ── Why a migration and not the seed ───────────────────────────────────────
--
-- `ALL_PERMISSIONS` in seed.ts is computed from `config/permissions.json`, so a
-- FRESH database gets `ledger.view` with no help. The insert is guarded by
--
--   .onConflictDoNothing({ target: roles.name })
--
-- which 0075 records as deliberate and required: re-running the seed must never
-- re-widen a role an operator narrowed on purpose. An existing `Administrator`
-- row is therefore frozen at whatever the catalog held the day it was created,
-- and no boot repairs it. Permissions are a STORED SNAPSHOT, not a reference to
-- the catalog — a new key reaches nobody until something writes it into the rows.
--
-- Found on PRODUCTION, not in a test: the deployed console showed "Access
-- denied" on /ledger to the account that holds everything else, because the
-- role predates the key. Seeds do not run there at all (`main.ts` calls
-- `runSeeds()` only when NODE_ENV is not production), so a migration is the
-- only thing that can carry it.
--
-- It compounds through `assertGrantable`, which refuses to hand out a key the
-- granter does not hold: without this, an operator on `Administrator` could not
-- even grant `ledger.view` to somebody else, so the gap is unfixable from
-- inside the console.
--
-- ── Scope: this role, by name, and nothing else ────────────────────────────
--
-- The same narrow rule 0075 sets. `Administrator` is the seeded row whose
-- stated contract is "every permission in the catalog"; a role somebody built by
-- hand that happens to hold most keys is THEIR role, and widening it would be
-- precisely the re-widening `onConflictDoNothing` exists to prevent.
--
-- If your full-access role is named something else, this migration will not
-- reach it — grant "View the Ledger" on the Roles screen instead, which is the
-- ordinary way a new power is handed out.
--
-- Idempotent: `UNION` + `jsonb_agg(DISTINCT …)` cannot produce a duplicate, so
-- re-running is a no-op on a row that already holds the key.
UPDATE roles
   SET permissions = (
     SELECT COALESCE(jsonb_agg(DISTINCT k ORDER BY k), '[]'::jsonb)
       FROM (
         SELECT e.v AS k FROM jsonb_array_elements_text(COALESCE(permissions, '[]'::jsonb)) e(v)
         UNION SELECT 'ledger.view'
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
         UNION SELECT 'ledger.view'
       ) keys(k)
   )
 WHERE email IN ('admin@oxshare.com', 'e2e-admin@oxshare.com');

/*
 * ⚠️ NO `pg_temp` HELPER FUNCTION — the warning 0068 earned the hard way and
 * 0075 repeats. `pg_temp` is session-local and the migration runner does not
 * guarantee every statement lands on the same session, so a factored-out helper
 * can vanish between its creation and the UPDATEs that reference it, each of
 * which then succeeds against zero rows rather than failing loudly.
 *
 * PENDING INVITES ARE NOT INCLUDED, for 0075's reason: an invite carries a
 * `roleId`, so an invitee joining `Administrator` resolves from the row
 * corrected above and receives the key with no rewrite. An invite carrying a
 * hand-picked permission list is somebody's deliberate choice.
 *
 * API KEYS ARE NOT INCLUDED. Nobody asked an integration to read every money
 * movement on the platform, and a machine credential that quietly gains a power
 * is the kind of thing found during an incident rather than a review.
 */
