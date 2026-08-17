-- Give the `Administrator` role the four catalog keys it never received.
--
-- Hand-written rather than generated, matching 0027 onwards, and shaped after
-- 0068 — the closest precedent, down to the deduplicating aggregate and the
-- `pg_temp` warning repeated at the bottom of this file.
--
-- ── The gap ────────────────────────────────────────────────────────────────
--
-- `config/permissions.json` defines 67 keys. The seeded `Administrator` role —
-- described in seed.ts as "Every permission in the catalog" — holds 63:
--
--   clients.view
--   clients.suspend
--   clients.tag
--   reconciliation.view
--
-- are absent. The whole `clients` module plus `reconciliation.view` were added
-- to the catalog after the role row already existed.
--
-- ── Why the seed cannot fix it ─────────────────────────────────────────────
--
-- `ALL_PERMISSIONS` in seed.ts is computed from this very catalog, so the
-- INSERT is correct. The insert is guarded by
--
--   .onConflictDoNothing({ target: roles.name })
--
-- which is deliberate and must stay: re-running the seed must never re-widen a
-- role an operator has narrowed on purpose. The consequence is that an existing
-- `Administrator` row is frozen at whatever the catalog held the day it was
-- first created, and no boot will ever repair it. That is what a migration is
-- for — the same reasoning 0068 records: permissions are a STORED SNAPSHOT, not
-- a reference to the catalog, so a new key reaches nobody until something
-- writes it into the rows.
--
-- It compounds through `assertGrantable`, which refuses to hand out a key the
-- granter does not hold. An operator on `Administrator` could not grant
-- `reconciliation.view` to anyone, because they did not hold it themselves —
-- so the gap was not merely their own missing access, it was unfixable from
-- inside the console.
--
-- ── Scope: this role, by name, and nothing else ────────────────────────────
--
-- 0068 keyed its grant off an existing power (`settings.view` → `leverages.*`)
-- because it was widening a capability that already had an owner. This
-- migration is narrower: it repairs ONE role whose stated contract is "every
-- permission in the catalog", so it matches that role by name and touches no
-- other row.
--
-- Deliberately NOT keyed off "holds most of the catalog" or similar: a role
-- somebody built by hand that happens to hold 63 keys is THEIR role, and
-- widening it would be exactly the re-widening `onConflictDoNothing` exists to
-- prevent. `Administrator` is the seeded row whose definition promises the full
-- set; only it is repaired.
--
-- Idempotent: the `UNION` + `jsonb_agg(DISTINCT …)` cannot produce a duplicate,
-- so re-running is a no-op on a row that already holds the keys.
UPDATE roles
   SET permissions = (
     SELECT COALESCE(jsonb_agg(DISTINCT k ORDER BY k), '[]'::jsonb)
       FROM (
         SELECT e.v AS k FROM jsonb_array_elements_text(COALESCE(permissions, '[]'::jsonb)) e(v)
         UNION SELECT 'clients.view'
         UNION SELECT 'clients.suspend'
         UNION SELECT 'clients.tag'
         UNION SELECT 'reconciliation.view'
       ) keys(k)
   )
 WHERE name = 'Administrator';
--> statement-breakpoint

-- The per-admin SNAPSHOT on the two seeded accounts, for the same reason.
--
-- `RolesStore.resolvePermissions(roleId, snapshot)` prefers the ROLE and falls
-- back to the snapshot only when there is no role attached, so on a correctly
-- seeded database the statement above is already sufficient. This one exists
-- for the case seed.ts documents at its `WHERE roleId IS NULL` backfill: an
-- account that was seeded with a full-access snapshot and never attached to a
-- role resolves through the snapshot, and would otherwise keep the same gap the
-- role row had.
--
-- Restricted to the two SEEDED addresses. A human administrator's snapshot is
-- their own and is not a place this migration may write — see the API-keys note
-- at the bottom for the same distinction.
UPDATE admins
   SET permissions = (
     SELECT COALESCE(jsonb_agg(DISTINCT k ORDER BY k), '[]'::jsonb)
       FROM (
         SELECT e.v AS k FROM jsonb_array_elements_text(COALESCE(permissions, '[]'::jsonb)) e(v)
         UNION SELECT 'clients.view'
         UNION SELECT 'clients.suspend'
         UNION SELECT 'clients.tag'
         UNION SELECT 'reconciliation.view'
       ) keys(k)
   )
 WHERE email IN ('admin@oxshare.com', 'e2e-admin@oxshare.com');

/*
 * ⚠️ NO `pg_temp` HELPER FUNCTION — the warning 0068 earned the hard way.
 *
 * `pg_temp` is session-local and the migration runner does not guarantee every
 * statement in a file lands on the same session, so a factored-out helper can
 * vanish between its creation and the UPDATEs that reference it — each of which
 * then succeeds against zero rows rather than failing loudly. The statements
 * above are inlined for that reason.
 *
 * PENDING INVITES ARE NOT INCLUDED, unlike 0068.
 *
 * That migration rewrote them because it was widening a power invitees already
 * held through `settings.*`, and an invite issued beforehand would have created
 * an admin missing a screen their role implied. Here the repair is to a ROLE,
 * and an invite carries a `roleId`: an invitee joining the `Administrator` role
 * resolves their permissions from the row corrected above, so they receive the
 * four keys with no rewrite. An invite carrying a hand-picked permission list
 * is somebody's deliberate choice and is left alone.
 *
 * API KEYS ARE NOT INCLUDED, for the reason 0068 states: nobody asked these
 * integrations to read the reconciliation report or suspend a client, and a
 * machine credential that quietly gains a power is the kind of thing found
 * during an incident rather than a review. This migration renames nothing, so
 * every existing key keeps working exactly as it does today.
 */
