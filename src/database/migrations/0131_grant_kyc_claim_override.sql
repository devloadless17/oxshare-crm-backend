-- Give the `Administrator` role the new `kyc.claim.override` key.
--
-- ── What the key is for ────────────────────────────────────────────────────
--
-- `approve` and `reject` refuse a submission another reviewer is HOLDING, and
-- `release` did not — so the claim those two enforce could be removed by
-- anybody with `kyc.review`: hand the colleague's submission back to the queue,
-- then claim and decide it. The lock was on the door and the hinges were loose.
--
-- Release is now holder-only, with `kyc.claim.override` as the deliberate way
-- to take back a claim nobody is coming back to. That escape is NOT optional:
-- approve and reject are already holder-only, so release is the only route back
-- to the queue, and locking it without an override would turn a reviewer who
-- leaves mid-claim into a client who can never be verified.
--
-- ── Why only `Administrator`, and not everyone holding `kyc.review` ────────
--
-- Granting it alongside `kyc.review` would restore exactly the behaviour being
-- removed: every reviewer able to drop every other reviewer's claim, which is
-- the reported bug with a permission key painted on it. It is a supervisory
-- action, so it goes to the full-access role and is granted onward from the
-- Roles screen by somebody who means it.
--
-- ── Why a migration and not the seed ───────────────────────────────────────
--
-- Unchanged from 0075, 0085, 0087 and 0128, whose headers carry the full
-- reasoning. `ALL_PERMISSIONS` is computed from `config/permissions.json`, so a
-- FRESH database gets this key with no help — but the seed's
-- `onConflictDoNothing({ target: roles.name })` deliberately refuses to
-- re-widen an existing role, because a boot must never undo a narrowing an
-- operator performed on purpose. Permissions are a stored SNAPSHOT, so on every
-- already-deployed database a new key reaches NOBODY until a migration puts it
-- there, and `assertGrantable` then stops anyone granting what they do not hold.

UPDATE roles
   SET permissions = (
     SELECT COALESCE(jsonb_agg(DISTINCT k ORDER BY k), '[]'::jsonb)
       FROM (
         SELECT e.v AS k FROM jsonb_array_elements_text(COALESCE(permissions, '[]'::jsonb)) e(v)
         UNION SELECT 'kyc.claim.override'
       ) keys(k)
   )
 WHERE name = 'Administrator';

UPDATE admins
   SET permissions = (
     SELECT COALESCE(jsonb_agg(DISTINCT k ORDER BY k), '[]'::jsonb)
       FROM (
         SELECT e.v AS k FROM jsonb_array_elements_text(COALESCE(permissions, '[]'::jsonb)) e(v)
         UNION SELECT 'kyc.claim.override'
       ) keys(k)
   )
 WHERE email IN ('admin@oxshare.com', 'e2e-admin@oxshare.com');

/*
 * ⚠️ NO `pg_temp` HELPER FUNCTION — 0068's warning, repeated by 0075, 0085 and
 * 0128. `pg_temp` is session-local and the runner does not guarantee every
 * statement lands on the same session, so a factored-out helper can vanish
 * between its creation and the UPDATEs that use it, each of which then succeeds
 * against zero rows rather than failing loudly.
 *
 * PENDING INVITES ARE NOT INCLUDED: an invite carries a `roleId`, so an invitee
 * joining `Administrator` resolves from the row corrected above.
 *
 * API KEYS ARE NOT INCLUDED. Nothing about an integration needs the power to
 * take a human reviewer's claim away from them.
 */
