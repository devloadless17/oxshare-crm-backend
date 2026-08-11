-- Give existing full-access holders the three new trading write keys.
--
-- ⚠️ IF YOU HAND-WRITE A JOURNAL ENTRY, CHECK ITS `when` AGAINST THE DATABASE.
--
-- This migration was written, registered, applied, and did nothing. `npm run
-- db:migrate` printed "migrations applied successfully" and not one row
-- changed.
--
-- drizzle applies a migration only when its journal `when` is LATER than the
-- newest `created_at` in `drizzle.__drizzle_migrations`. This machine's clock
-- had been ahead when earlier migrations ran, so the table's newest row was
-- stamped 18 Aug while a freshly written entry was stamped 12 Aug — six days in
-- the past as far as the migrator was concerned, and silently skipped.
--
-- There is no error for this. The only symptom is data that did not change, and
-- the natural next move is to doubt the WHERE clause — which was correct and
-- cost an hour to re-verify. If a hand-added entry appears not to run:
--
--     SELECT MAX(created_at) FROM drizzle.__drizzle_migrations;
--
-- and make the journal's `when` larger. Prefer `npm run db:generate`, which
-- stamps it from the clock at generation time and mostly avoids this.
--
-- ── The bug this fixes, which is worth stating exactly ──────────────────────
--
-- `trading.create`, `trading.deposit` and `trading.withdraw` were added to
-- config/permissions.json when the MT5 bridge landed. Nobody held them, and
-- that broke something unrelated-looking straight away:
--
--     PUT /admin/roles/:id -> 403
--     "You cannot grant permissions you do not hold:
--      trading.withdraw, trading.create, trading.deposit."
--
-- `AdminRbacService.assertGrantable` refuses to let an administrator grant a
-- key they do not themselves hold — the anti-escalation rule, and it is right.
-- But the role being edited had been given the new keys by the catalog, so
-- SAVING THAT ROLE AT ALL re-sent them, and the editor was refused for trying
-- to grant something they had never been given.
--
-- The symptom is the confusing part: an administrator with every permission in
-- the system could no longer edit any role, and the message named three keys
-- they had never heard of and had not touched.
--
-- ── Who gets them ───────────────────────────────────────────────────────────
--
-- Only rows that already hold EVERY key the catalog had before this change.
-- That is the definition of a full-access role, so a key added to the catalog
-- belongs in it — the alternative is that "full access" quietly stops meaning
-- what it says every time the product grows.
--
-- A role narrowed by hand does NOT match and must not. These are write keys on
-- a money path: `trading.deposit` credits a live trading account, and nobody
-- acquires that by having been granted "view trading accounts" last year.
--
-- The probe below is the same shape 0045 used, extended with `payments.view`
-- so it identifies rows as they exist AFTER that migration rather than before.

--> statement-breakpoint

UPDATE roles
SET permissions = permissions || '["trading.create","trading.deposit","trading.withdraw"]'::jsonb
WHERE permissions @> '["clients.view","admins.view","roles.delete","kyc.delete","wallets.credit","withdrawals.settle","trading.view","ib.commissions.view","tags.delete","currencies.delete","apikeys.revoke","settings.security.edit","audit.view","reconciliation.view","payments.view"]'::jsonb
  AND NOT permissions @> '["trading.create"]'::jsonb;

--> statement-breakpoint

-- The per-admin snapshot as well as the role.
--
-- `resolvePermissions` falls back to it when an admin is on no role, and the
-- seeded account still carries one — 0045 attached it to the Administrator role
-- but deliberately left the snapshot in place rather than making that migration
-- the single point of failure for the one account that can repair everything
-- else. Updating only `roles` would leave that account short of exactly the
-- keys this migration exists to hand out.
UPDATE admins
SET permissions = permissions || '["trading.create","trading.deposit","trading.withdraw"]'::jsonb
WHERE permissions @> '["clients.view","admins.view","roles.delete","kyc.delete","wallets.credit","withdrawals.settle","trading.view","ib.commissions.view","tags.delete","currencies.delete","apikeys.revoke","settings.security.edit","audit.view","reconciliation.view","payments.view"]'::jsonb
  AND NOT permissions @> '["trading.create"]'::jsonb;

--> statement-breakpoint

-- Outstanding invites, so an administrator invited before this migration and
-- accepting after it arrives with the same access as one invited today.
UPDATE admin_invites
SET permissions = permissions || '["trading.create","trading.deposit","trading.withdraw"]'::jsonb
WHERE permissions IS NOT NULL
  AND permissions @> '["clients.view","admins.view","roles.delete","kyc.delete","wallets.credit","withdrawals.settle","trading.view","ib.commissions.view","tags.delete","currencies.delete","apikeys.revoke","settings.security.edit","audit.view","reconciliation.view","payments.view"]'::jsonb
  AND NOT permissions @> '["trading.create"]'::jsonb;

--> statement-breakpoint

-- API KEYS ARE DELIBERATELY NOT TOUCHED.
--
-- 0044 rewrote grants in all four places including `api_keys`, and this one
-- stops at three. The difference is that a key is a standing credential with no
-- login and no session lifetime, issued for a stated purpose by somebody who
-- chose its permissions at the time. Widening one silently would hand a
-- nightly-report integration the ability to credit a trading account, and
-- nobody would be told.
--
-- A key that needs these is reissued, which is a decision with an audit row.
