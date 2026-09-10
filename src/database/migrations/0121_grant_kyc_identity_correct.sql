-- Give the `Administrator` role the `kyc.identity.correct` key CORE-18 added.
--
-- Shaped after 0085, which repaired the same class of gap for `ledger.view`,
-- down to the deduplicating aggregate and the `pg_temp` warning it inherited
-- from 0068 via 0075.
--
-- ── Why a migration and not the seed ───────────────────────────────────────
--
-- `ALL_PERMISSIONS` in seed.ts is computed from `config/permissions.json`, so a
-- FRESH database gets this key with no help. The insert is guarded by
-- `onConflictDoNothing({ target: roles.name })`, deliberately: re-running the
-- seed must never re-widen a role an operator narrowed on purpose. An existing
-- `Administrator` row is therefore frozen at whatever the catalog held the day
-- it was created, permissions being a STORED SNAPSHOT rather than a reference
-- to the catalog. Seeds do not run in production at all.
--
-- Without this, the key reaches NOBODY on any database that already exists, and
-- it compounds through `assertGrantable`, which refuses to hand out a key the
-- granter does not hold — so nobody could grant it to anyone else either and the
-- gap would be unfixable from inside the console. That has been repaired by hand
-- four times (0068, 0075, 0085, 0087), twice after somebody hit it in
-- production; `permission-catalog-baseline.spec.ts` is what makes this the
-- boring path instead.
--
-- ── What the key is, so a reviewer can judge the grant ─────────────────────
--
-- `PATCH /admin/kyc/:userId/personal-info` — correcting a date of birth or an
-- address on an APPROVED submission. It is deliberately NOT `kyc.review`:
-- approving or rejecting is a decision about what the client claimed, and this
-- REWRITES the claim. It is not `kyc.edit` either, which is the step BUILDER.
--
-- Granting it to `Administrator` matches that role's stated contract — every
-- permission in the catalog — and to nothing else, for 0075's reason: a role
-- somebody built by hand is THEIRS, and widening it is precisely the re-widening
-- `onConflictDoNothing` exists to prevent. If your full-access role is named
-- something else, grant "Correct Identity Details on an Approved Submission" on
-- the Roles screen instead.
--
-- Idempotent: `UNION` + `jsonb_agg(DISTINCT …)` cannot produce a duplicate, so
-- re-running is a no-op on a row that already holds the key.
UPDATE roles
   SET permissions = (
     SELECT COALESCE(jsonb_agg(DISTINCT k ORDER BY k), '[]'::jsonb)
       FROM (
         SELECT e.v AS k FROM jsonb_array_elements_text(COALESCE(permissions, '[]'::jsonb)) e(v)
         UNION SELECT 'kyc.identity.correct'
       ) keys(k)
   )
 WHERE name = 'Administrator';
--> statement-breakpoint

-- The per-admin SNAPSHOT on the two seeded accounts, for 0085's reason:
-- `resolvePermissions` prefers the ROLE and falls back to the snapshot only when
-- no role is attached, so this covers the account seeded with a full-access
-- snapshot and never attached to a role. Restricted to the two SEEDED
-- addresses — a human administrator's snapshot is their own.
UPDATE admins
   SET permissions = (
     SELECT COALESCE(jsonb_agg(DISTINCT k ORDER BY k), '[]'::jsonb)
       FROM (
         SELECT e.v AS k FROM jsonb_array_elements_text(COALESCE(permissions, '[]'::jsonb)) e(v)
         UNION SELECT 'kyc.identity.correct'
       ) keys(k)
   )
 WHERE email IN ('admin@oxshare.com', 'e2e-admin@oxshare.com');

/*
 * ⚠️ NO `pg_temp` HELPER FUNCTION — the warning 0068 earned and 0075 and 0085
 * repeat. `pg_temp` is session-local and the runner does not guarantee every
 * statement lands on the same session, so a factored-out helper can vanish
 * between its creation and the UPDATEs that reference it, each of which then
 * succeeds against zero rows rather than failing loudly.
 *
 * PENDING INVITES AND API KEYS ARE NOT INCLUDED, for 0085's reasons: an invite
 * carries a roleId and resolves from the row corrected above, and nobody asked
 * an integration for the power to rewrite an identity on a compliance record.
 */
