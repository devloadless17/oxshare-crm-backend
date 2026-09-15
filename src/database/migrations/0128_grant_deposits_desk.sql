-- Give `Administrator` — and the two seeded accounts — the four `deposits.*`
-- keys the offline deposit desk introduces.
--
-- Shaped after 0085, which is shaped after 0075 and 0068. The reasoning is
-- theirs and is worth restating in one line, because it is the reason this file
-- exists at all: role permissions are a STORED SNAPSHOT, not a reference to
-- `config/permissions.json`. `ALL_PERMISSIONS` in seed.ts is computed from the
-- catalog, so a FRESH database gets the new keys with no help — but the seed's
-- insert is `onConflictDoNothing`, deliberately, so an existing `Administrator`
-- row is frozen at whatever the catalog held the day it was created. Without
-- this statement the new keys reach nobody, the Deposits queue is invisible to
-- every role, and `assertGrantable` refuses to let an operator hand out a key
-- they do not themselves hold — so the gap cannot be closed from inside the
-- console either.
--
-- ── Scope: this role, by name, and nothing else ────────────────────────────
--
-- `Administrator` is the seeded row whose stated contract is "every permission
-- in the catalog". A role somebody built by hand that happens to hold most keys
-- is THEIR role; widening it would be exactly the re-widening
-- `onConflictDoNothing` exists to prevent. If your full-access role is named
-- something else, grant the four keys on the Roles screen instead.
--
-- Idempotent: `UNION` + `jsonb_agg(DISTINCT …)` cannot produce a duplicate.
UPDATE roles
   SET permissions = (
     SELECT COALESCE(jsonb_agg(DISTINCT k ORDER BY k), '[]'::jsonb)
       FROM (
         SELECT e.v AS k FROM jsonb_array_elements_text(COALESCE(permissions, '[]'::jsonb)) e(v)
         UNION SELECT 'deposits.view'
         UNION SELECT 'deposits.approve'
         UNION SELECT 'deposits.reject'
         UNION SELECT 'deposits.proofs.view'
       ) keys(k)
   )
 WHERE name = 'Administrator';
--> statement-breakpoint

-- The per-admin SNAPSHOT on the two seeded accounts, for 0085's reason:
-- `resolvePermissions` prefers the ROLE and falls back to the snapshot only when
-- no role is attached, so this covers the account seeded with a full-access
-- snapshot that was never attached to one.
--
-- Restricted to the two SEEDED addresses. A human administrator's snapshot is
-- their own and is not a place this migration may write.
UPDATE admins
   SET permissions = (
     SELECT COALESCE(jsonb_agg(DISTINCT k ORDER BY k), '[]'::jsonb)
       FROM (
         SELECT e.v AS k FROM jsonb_array_elements_text(COALESCE(permissions, '[]'::jsonb)) e(v)
         UNION SELECT 'deposits.view'
         UNION SELECT 'deposits.approve'
         UNION SELECT 'deposits.reject'
         UNION SELECT 'deposits.proofs.view'
       ) keys(k)
   )
 WHERE email IN ('admin@oxshare.com', 'e2e-admin@oxshare.com');

/*
 * ⚠️ NO `pg_temp` HELPER FUNCTION — 0068's warning, repeated by 0075 and 0085.
 * `pg_temp` is session-local and the runner does not guarantee every statement
 * lands on the same session, so a factored-out helper can vanish between its
 * creation and the UPDATEs that use it, each of which then succeeds against zero
 * rows rather than failing loudly.
 *
 * PENDING INVITES ARE NOT INCLUDED: an invite carries a `roleId`, so an invitee
 * joining `Administrator` resolves from the row corrected above.
 *
 * API KEYS ARE NOT INCLUDED. Nobody asked an integration for the power to credit
 * a client's wallet.
 */
