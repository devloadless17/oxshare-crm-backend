-- Give the `Administrator` role the `ib.commissions.reverse` key.
--
-- Shaped after 0085, which is itself shaped after 0075 — down to the
-- deduplicating aggregate and the `pg_temp` warning both inherit from 0068. The
-- reasoning is recorded in full there and is not repeated here; what follows is
-- only what is specific to THIS key.
--
-- ── Why a migration and not the seed ───────────────────────────────────────
--
-- `ALL_PERMISSIONS` in seed.ts is computed from `config/permissions.json`, so a
-- FRESH database gets the key with no help. An EXISTING role does not: the seed
-- insert is guarded by `onConflictDoNothing`, deliberately, so that re-running
-- it can never re-widen a role an operator narrowed on purpose. Permissions are
-- a STORED SNAPSHOT rather than a reference to the catalog, so a new key reaches
-- nobody until something writes it into the rows. Seeds do not run in production
-- at all (`main.ts` calls `runSeeds()` only when NODE_ENV is not production), so
-- a migration is the only thing that can carry it there.
--
-- It compounds through `assertGrantable`, which refuses to hand out a key the
-- granter does not hold: without this, an operator on `Administrator` could not
-- even grant the key to somebody else, so the gap is unfixable from inside the
-- console.
--
-- ── What this key actually authorises ──────────────────────────────────────
--
-- `POST /admin/ib/accruals/:id/reverse` — the only IB operation that can take
-- money OUT of a wallet somebody has already been paid into.
--
-- Deliberately a NEW key rather than an extension of `ib.commissions.view` or
-- `ib.partners.edit`. Reading what a partner earned and clawing it back are
-- different authorities, and rolling them together would hand the second to
-- everyone who was only ever meant to have the first — including, on this
-- platform, support staff whose job is to answer "what did I earn" questions.
--
-- Granting it to `Administrator` alone follows 0075's narrow rule: that is the
-- seeded row whose stated contract is "every permission in the catalog". A role
-- somebody built by hand is THEIR role, and widening it here would be exactly
-- the re-widening `onConflictDoNothing` exists to prevent. If your full-access
-- role is named something else this migration will not reach it — grant
-- "Reverse an accrual (claw back commission)" on the Roles screen instead,
-- which is the ordinary way a new power is handed out, and the right moment to
-- decide who should hold this one.
--
-- Idempotent: `UNION` + `jsonb_agg(DISTINCT …)` cannot produce a duplicate, so
-- re-running is a no-op on a row that already holds the key. That also makes it
-- safe to re-apply if this migration is ever renumbered — the trap the repo
-- CLAUDE.md documents, where a renumbered migration leaves a watermark ahead of
-- the journal and every later migration is skipped in silence.
UPDATE roles
   SET permissions = (
     SELECT COALESCE(jsonb_agg(DISTINCT k ORDER BY k), '[]'::jsonb)
       FROM (
         SELECT e.v AS k FROM jsonb_array_elements_text(COALESCE(permissions, '[]'::jsonb)) e(v)
         UNION SELECT 'ib.commissions.reverse'
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
         UNION SELECT 'ib.commissions.reverse'
       ) keys(k)
   )
 WHERE email IN ('admin@oxshare.com', 'e2e-admin@oxshare.com');

/*
 * ⚠️ NO `pg_temp` HELPER FUNCTION — the warning 0068 earned the hard way and
 * 0075 and 0085 both repeat. `pg_temp` is session-local and the migration runner
 * does not guarantee every statement lands on the same session, so a factored-out
 * helper can vanish between its creation and the UPDATEs that reference it, each
 * of which then succeeds against zero rows rather than failing loudly.
 *
 * PENDING INVITES ARE NOT INCLUDED, for 0075's reason: an invite carries a
 * `roleId`, so an invitee joining `Administrator` resolves from the row corrected
 * above and receives the key with no rewrite. An invite carrying a hand-picked
 * permission list is somebody's deliberate choice.
 *
 * API KEYS ARE NOT INCLUDED, and here that is stronger than a default. This key
 * debits wallets. Nobody asked an integration for the power to claw back a
 * partner's commission, and a machine credential that quietly gains it is the
 * kind of thing found during an incident rather than a review.
 */
