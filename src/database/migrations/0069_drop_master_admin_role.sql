-- Remove the leftover `Master Admin` role, and give its one unique key away
-- first.
--
-- Hand-written rather than generated, matching 0027 onwards.
--
-- ── What this row was, and why it is still here ─────────────────────────────
--
-- `seed.ts` already says it does not exist: "There is no 'Master Admin' role any
-- more, and no `isSystem` role at all. It carried `['*']` and was hidden from
-- the roles screen, which made 'full access' a thing the console could neither
-- show nor hand out."
--
-- The seed stopped creating it. Databases seeded BEFORE that still have it,
-- because seeds are ON CONFLICT DO NOTHING and nothing removed the old row. So
-- the comment and the data disagreed, which is the state this fixes.
--
-- ── The deadlock it caused ──────────────────────────────────────────────────
--
-- `reconciliation.view` ended up held by that role and NOTHING else. Zero
-- admins were assigned to it, so no logged-in operator held the key — and
-- `assertGrantable` refused to let anybody grant a permission they did not
-- hold. The result was a key that existed in the catalog, appeared on the roles
-- screen, and could never be granted to anyone by anyone.
--
-- The tempting fix is to relax that guard for the ROLES path — let anybody with
-- `roles.edit` grant anything in the catalog. It was tried and reverted: a role
-- editor could then write themselves a role holding `wallets.credit`, which is
-- the self-promotion path `REGRESSION C1` in `rbac.spec.ts` exists to stop.
--
-- The cause was the DATA, so this fixes the data. With the key held by a role
-- that real admins are actually on, granting it requires holding it — and
-- somebody does.
--
-- ── `Administrator` inherits the key, because that is what it claims to be ──
--
-- Its description is "Every permission in the catalog." and it holds 66 of 67.
-- The missing one is `reconciliation.view`, and the gap is an accident of
-- ordering — the key was added after that role was seeded — rather than a
-- decision to withhold it.
--
-- This is NOT a general "top up Administrator with every new key" rule. The
-- seed argues explicitly against that: keys are listed out rather than
-- wildcarded so "a new permission has to be ticked deliberately, like any
-- other". One named key, one migration, for a documented gap.
UPDATE roles
   SET permissions = (
     SELECT COALESCE(jsonb_agg(DISTINCT k ORDER BY k), '[]'::jsonb)
       FROM (
         SELECT e.v AS k FROM jsonb_array_elements_text(COALESCE(permissions, '[]'::jsonb)) e(v)
         UNION SELECT 'reconciliation.view'
       ) keys(k)
   )
 WHERE name = 'Administrator';
--> statement-breakpoint

-- Same for the admins whose own snapshot is used when they hold no role.
UPDATE admins
   SET permissions = (
     SELECT COALESCE(jsonb_agg(DISTINCT k ORDER BY k), '[]'::jsonb)
       FROM (
         SELECT e.v AS k FROM jsonb_array_elements_text(COALESCE(permissions, '[]'::jsonb)) e(v)
         UNION SELECT 'reconciliation.view'
       ) keys(k)
   )
 WHERE permissions @> '["audit.view"]';
--> statement-breakpoint

/*
 * MOVE ANYBODY OFF IT BEFORE DELETING IT.
 *
 * `admins.role_id` references `roles.id`, so a DELETE with somebody still
 * assigned either fails on the constraint or — worse, depending on how it was
 * declared — nulls their role and silently drops them to their own stored
 * snapshot. Nobody is on this role in any database we have seen, but "seen" is
 * not "all", and the reassignment is free when the set is empty.
 */
UPDATE admins
   SET role_id = (SELECT id FROM roles WHERE name = 'Administrator' LIMIT 1)
 WHERE role_id = (SELECT id FROM roles WHERE name = 'Master Admin' AND is_system LIMIT 1)
   AND EXISTS (SELECT 1 FROM roles WHERE name = 'Administrator');
--> statement-breakpoint

-- Scoped to the SYSTEM row. An operator who has since created their own role
-- called "Master Admin" owns it, and this is not the migration to delete it.
DELETE FROM roles WHERE name = 'Master Admin' AND is_system = true;
