-- Repairs two things 0044 got wrong, and gives the seeded admin a real role.
--
-- ── 1. The wildcard expansion was missing three keys ────────────────────────
--
-- 0044's `_perm_all` is the list every `*` grant expanded into. It carries 55
-- keys; `config/permissions.json` defines 58. The three absentees are
-- `payments.view`, `payments.create` and `payments.edit` — the payment-methods
-- module, in the catalog on the day 0044 was written and simply left out of the
-- table.
--
-- The effect is narrow and total: anyone who held `*` — which is every
-- unrestricted account, including the seeded `admin@oxshare.com` — came out of
-- 0044 with no payment-methods access at all, while a role that had held
-- `payments.view` or `payments.manage` kept it through `_perm_map`. So the
-- MOST privileged accounts were the only ones locked out of that screen.
--
-- 0044 is left alone rather than corrected in place. It has run, and editing an
-- applied migration means the same file describes two different outcomes
-- depending on when it was read. Its own comment is also right that `_perm_all`
-- must stay a SNAPSHOT: adding a key to it later would retroactively grant
-- that key to every wildcard holder, which is the behaviour dropping the
-- wildcard exists to prevent. These three are not later keys — they existed
-- then — so repairing forward is both correct and the only honest option.
--
-- ── 2. The seeded admin held permissions but no ROLE ────────────────────────
--
-- `admin@oxshare.com` carried its access as a per-admin snapshot with
-- `role_id` NULL, because it never needed one: `isMaster()` answered first.
-- With that gone, the account is an ordinary administrator whose access happens
-- to be stored in the wrong place — the catalog says roles are the only source
-- of access, and an admin off every role cannot have their access changed by
-- editing a role.
--
-- It is attached to the Administrator role here. The per-admin snapshot is left
-- in place rather than cleared: `resolvePermissions` falls back to it, and
-- emptying it would make this migration the single point of failure for the one
-- account that can fix everything else.

--> statement-breakpoint

-- Only rows that came out of the wildcard expansion, identified by holding the
-- whole 55-key result. A role that was narrowed by hand since 0044 ran will not
-- match, and must not — this repairs an expansion, it does not grant access.
UPDATE roles
SET permissions = permissions || '["payments.view","payments.create","payments.edit"]'::jsonb
WHERE permissions @> '["clients.view","admins.view","roles.delete","kyc.delete","wallets.credit","withdrawals.settle","trading.view","ib.commissions.view","tags.delete","currencies.delete","apikeys.revoke","settings.security.edit","audit.view","reconciliation.view"]'::jsonb
  AND NOT permissions @> '["payments.view"]'::jsonb;

--> statement-breakpoint

UPDATE admins
SET permissions = permissions || '["payments.view","payments.create","payments.edit"]'::jsonb
WHERE permissions @> '["clients.view","admins.view","roles.delete","kyc.delete","wallets.credit","withdrawals.settle","trading.view","ib.commissions.view","tags.delete","currencies.delete","apikeys.revoke","settings.security.edit","audit.view","reconciliation.view"]'::jsonb
  AND NOT permissions @> '["payments.view"]'::jsonb;

--> statement-breakpoint

UPDATE admin_invites
SET permissions = permissions || '["payments.view","payments.create","payments.edit"]'::jsonb
WHERE permissions IS NOT NULL
  AND permissions @> '["clients.view","admins.view","roles.delete","kyc.delete","wallets.credit","withdrawals.settle","trading.view","ib.commissions.view","tags.delete","currencies.delete","apikeys.revoke","settings.security.edit","audit.view","reconciliation.view"]'::jsonb
  AND NOT permissions @> '["payments.view"]'::jsonb;

--> statement-breakpoint

-- API keys are the quiet one: no human notices a machine credential losing a
-- permission until an integration fails.
UPDATE api_keys
SET permissions = permissions || '["payments.view","payments.create","payments.edit"]'::jsonb
WHERE permissions @> '["clients.view","admins.view","roles.delete","kyc.delete","wallets.credit","withdrawals.settle","trading.view","ib.commissions.view","tags.delete","currencies.delete","apikeys.revoke","settings.security.edit","audit.view","reconciliation.view"]'::jsonb
  AND NOT permissions @> '["payments.view"]'::jsonb;

--> statement-breakpoint

-- Every administrator who is on no role at all is put on Administrator. In
-- practice that is the seeded account and anything created the same way — a
-- roleless admin is not a state the console can produce, because the invite
-- flow requires a role.
UPDATE admins
SET role_id = (SELECT id FROM roles WHERE name = 'Administrator' LIMIT 1)
WHERE role_id IS NULL
  AND EXISTS (SELECT 1 FROM roles WHERE name = 'Administrator');
