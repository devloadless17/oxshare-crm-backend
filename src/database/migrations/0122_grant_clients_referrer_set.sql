-- Give the `Administrator` role the `clients.referrer.set` key.
--
-- Shaped after 0121 and 0085. A permission is not shipped by DEFINING it: the
-- seed computes `ALL_PERMISSIONS` from `config/permissions.json` so a FRESH
-- database gets it, but the role insert is `onConflictDoNothing` — deliberately,
-- so a boot cannot re-widen a role an operator narrowed — and permissions are a
-- stored SNAPSHOT per role rather than a reference to the catalogue. So without
-- this the key reaches NOBODY on any database that already exists, and
-- `assertGrantable` refuses to hand out a key the granter does not hold, making
-- the gap unfixable from inside the console. Repaired by hand four times before
-- (0068, 0075, 0085, 0087), twice in production.
--
-- ── What the key is, so a reviewer can judge the grant ─────────────────────
--
-- `PATCH /admin/clients/:id/referrer` — recording the partner who introduced a
-- client, WHEN NONE IS RECORDED. Attribution was captured only from `?ref=` on
-- the registration screen, and both portal auth cross-links dropped it: a client
-- who followed a partner link, clicked "Sign in", then "Create an account"
-- registered attributed to nobody, permanently.
--
-- It is NULL -> A only. A client who already has a referrer answers 409, refused
-- in the service rather than in a screen, so this cannot become the
-- "change my IB" flow `docs/` forbids. It does not backdate: commission reads
-- attribution at accrual time, so it pays on deals not yet accrued and restates
-- nothing already credited.
--
-- Its own key rather than `clients.edit`: recording who gets paid is not the
-- same power as fixing a surname, and the route moves money on every future
-- trade that client makes.
--
-- Granted to `Administrator` by name and to nothing else, for 0075's reason: a
-- role somebody built by hand is theirs, and widening it is the re-widening
-- `onConflictDoNothing` exists to prevent. If your full-access role is named
-- something else, grant "Record a Missing Referring Partner" on the Roles
-- screen.
--
-- Idempotent: `UNION` + `jsonb_agg(DISTINCT …)` cannot duplicate a key.
UPDATE roles
   SET permissions = (
     SELECT COALESCE(jsonb_agg(DISTINCT k ORDER BY k), '[]'::jsonb)
       FROM (
         SELECT e.v AS k FROM jsonb_array_elements_text(COALESCE(permissions, '[]'::jsonb)) e(v)
         UNION SELECT 'clients.referrer.set'
       ) keys(k)
   )
 WHERE name = 'Administrator';
--> statement-breakpoint

-- The per-admin SNAPSHOT on the two seeded accounts, for 0085's reason:
-- `resolvePermissions` prefers the ROLE and falls back to the snapshot only when
-- no role is attached. Restricted to the seeded addresses — a human
-- administrator's snapshot is their own.
UPDATE admins
   SET permissions = (
     SELECT COALESCE(jsonb_agg(DISTINCT k ORDER BY k), '[]'::jsonb)
       FROM (
         SELECT e.v AS k FROM jsonb_array_elements_text(COALESCE(permissions, '[]'::jsonb)) e(v)
         UNION SELECT 'clients.referrer.set'
       ) keys(k)
   )
 WHERE email IN ('admin@oxshare.com', 'e2e-admin@oxshare.com');

/*
 * ⚠️ NO `pg_temp` HELPER — 0068's warning, repeated by 0075, 0085 and 0121.
 * `pg_temp` is session-local and the runner does not guarantee one session, so a
 * factored-out helper can vanish between its creation and the UPDATEs, each of
 * which then succeeds against zero rows rather than failing loudly.
 *
 * PENDING INVITES AND API KEYS ARE NOT INCLUDED: an invite carries a roleId and
 * resolves from the row above, and nobody asked an integration for the power to
 * decide which partner a client belongs to.
 */
