-- One permission per action, per screen — and no role above any other.
--
-- ── The problem ─────────────────────────────────────────────────────────────
--
-- Three faults, and they compound:
--
--   1. THREE keys were enforced by the API and listed in no catalog, so no role
--      could ever hold them: `wallets.credit`, `wallets.manage` and
--      `settings.security`. The entire wallets WRITE surface was ungrantable —
--      opening a wallet, adding funds and closing one were master-admin-only by
--      accident rather than by decision, and nobody could be given "add funds"
--      however much anyone wanted to.
--
--      (An earlier count of eleven was wrong and is recorded here so the
--      correction outlives the conversation. The other eight — `kyc.approve`,
--      `kyc.reject`, `kyc.claim`, `kyc.document.view`, `kyc.submission.view`,
--      `ib.suspend`, `settings.general.update`, `settings.smtp.update` — are
--      AUDIT ACTION names passed to `audit.record()`, not permission keys. They
--      are absent from the catalog because they were never meant to be in it.)
--
--   2. `manage` keys bundled create, edit and delete, so "may configure IB
--      levels" also meant "may delete them", and "may rename a tag" also meant
--      "may delete the tag an administrator is scoped to" — which is a privilege
--      change, because an empty scope means unrestricted.
--
--   3. `users.*` covered clients AND administrators. `users.view` opened both
--      the client list and the admin directory, so the two could not be granted
--      apart.
--
-- ── What this does ──────────────────────────────────────────────────────────
--
-- Rewrites every stored grant onto the new catalog, in all four places
-- permissions are stored: `roles`, `admins` (the per-admin snapshot),
-- `admin_invites` (grants chosen for somebody who has not accepted yet) and
-- `api_keys`. Missing any one of those would leave a credential holding keys
-- that no longer mean anything — which for an API key is silent and lasts until
-- somebody notices a nightly job 403ing.
--
-- Each `manage` expands to ALL THREE verbs. Nobody loses access on deploy;
-- roles are narrowed afterwards, deliberately, by somebody who can see what they
-- are narrowing.
--
-- ── The wildcard is EXPANDED, then it is gone ───────────────────────────────
--
-- `*` used to mean "everything", and `isMaster()` honoured it alongside the
-- `master_admin` enum. Both are removed: there is no role above another any
-- more, so full access has to be a real list of real keys.
--
-- Expanding rather than keeping it is the load-bearing decision here. A `*` that
-- survived would mean "every key that will ever exist", so any permission added
-- next year would be granted retroactively to whoever held it — the same class
-- of accident as the eleven ungrantable keys, pointing the other way.
--
-- ── What this deliberately does NOT do ──────────────────────────────────────
--
-- It does not drop `master_admin` from the `admin_role` enum. Postgres cannot
-- DROP an enum value without rewriting the type, and `rejection_context` already
-- carries a dead value for that reason. The column stops being READ — no guard,
-- no service and no screen branches on it after this migration — and the value
-- is left in place rather than rewriting a type under a live table.

--> statement-breakpoint

-- Every key in config/permissions.json, as the expansion target for `*`.
-- Kept in step with that file BY HAND: this migration is a snapshot of the
-- catalog on the day it ran, and it must stay a snapshot. A later key must NOT
-- be added here — doing so would retroactively grant it, which is the exact
-- behaviour dropping the wildcard exists to prevent.
CREATE TEMPORARY TABLE _perm_all (key text PRIMARY KEY);

--> statement-breakpoint

INSERT INTO _perm_all (key) VALUES
  ('clients.view'), ('clients.edit'), ('clients.suspend'), ('clients.tag'),
  ('admins.view'), ('admins.create'), ('admins.edit'), ('admins.suspend'),
  ('admins.scope'), ('admins.reset'),
  ('roles.view'), ('roles.create'), ('roles.edit'), ('roles.delete'),
  ('kyc.view'), ('kyc.documents.view'), ('kyc.review'), ('kyc.create'),
  ('kyc.edit'), ('kyc.delete'),
  ('wallets.view'), ('wallets.create'), ('wallets.credit'), ('wallets.delete'),
  ('withdrawals.view'), ('withdrawals.approve'), ('withdrawals.settle'),
  ('trading.view'),
  ('ib.view'), ('ib.approve'), ('ib.reject'), ('ib.levels.create'),
  ('ib.levels.edit'), ('ib.levels.delete'), ('ib.partners.edit'),
  ('ib.partners.suspend'), ('ib.commissions.view'),
  ('tags.view'), ('tags.create'), ('tags.edit'), ('tags.delete'),
  ('currencies.view'), ('currencies.create'), ('currencies.edit'), ('currencies.delete'),
  ('payments.view'), ('payments.create'), ('payments.edit'), ('payments.delete'),
  ('apikeys.view'), ('apikeys.create'), ('apikeys.revoke'),
  ('settings.view'), ('settings.edit'), ('settings.smtp.view'),
  ('settings.smtp.edit'), ('settings.security.view'), ('settings.security.edit'),
  ('audit.view'), ('reconciliation.view');

--> statement-breakpoint

-- Old key → new key. One row per resulting key, so a one-to-many split is just
-- several rows. An old key absent from this table is DROPPED, which is correct
-- for the retired `manage` keys and for the eleven that never resolved to
-- anything grantable in the first place.
CREATE TEMPORARY TABLE _perm_map (old text, new text);

--> statement-breakpoint

INSERT INTO _perm_map (old, new) VALUES
  -- users.* split into the two directories it conflated. `users.view` also
  -- yields `trading.view`: the trading-accounts endpoints check `users.view`
  -- today, so anyone who can reach that screen keeps reaching it.
  ('users.view', 'clients.view'),
  ('users.view', 'admins.view'),
  ('users.view', 'trading.view'),
  ('users.edit', 'clients.edit'),
  ('users.edit', 'admins.edit'),
  ('users.suspend', 'clients.suspend'),
  ('users.suspend', 'admins.suspend'),
  -- D-44: sending a reset link was gated on `users.create` alongside inviting.
  -- Both are preserved so neither ability disappears on deploy.
  ('users.create', 'admins.create'),
  ('users.create', 'admins.reset'),
  ('users.scope', 'admins.scope'),

  ('roles.view', 'roles.view'),
  ('roles.manage', 'roles.create'),
  ('roles.manage', 'roles.edit'),
  ('roles.manage', 'roles.delete'),

  -- KYC was already split correctly; the orphan spellings collapse into the
  -- keys that actually exist.
  ('kyc.view', 'kyc.view'),
  ('kyc.submission.view', 'kyc.view'),
  ('kyc.documents.view', 'kyc.documents.view'),
  ('kyc.document.view', 'kyc.documents.view'),
  ('kyc.review', 'kyc.review'),
  ('kyc.approve', 'kyc.review'),
  ('kyc.reject', 'kyc.review'),
  ('kyc.claim', 'kyc.review'),
  ('kyc.create', 'kyc.create'),
  ('kyc.edit', 'kyc.edit'),
  ('kyc.delete', 'kyc.delete'),

  -- The wallets module was entirely ungrantable, so nothing can be carried
  -- forward from a role: `withdrawals.view` is what the holdings endpoints
  -- checked, and it is what becomes the read key.
  ('withdrawals.view', 'withdrawals.view'),
  ('withdrawals.view', 'wallets.view'),
  ('withdrawals.approve', 'withdrawals.approve'),
  ('withdrawals.settle', 'withdrawals.settle'),

  ('ib.view', 'ib.view'),
  ('ib.view', 'ib.commissions.view'),
  ('ib.approve', 'ib.approve'),
  ('ib.reject', 'ib.reject'),
  ('ib.manage', 'ib.levels.create'),
  ('ib.manage', 'ib.levels.edit'),
  ('ib.manage', 'ib.levels.delete'),
  ('ib.manage', 'ib.partners.edit'),
  ('ib.manage', 'ib.partners.suspend'),

  ('tags.view', 'tags.view'),
  ('tags.manage', 'tags.create'),
  ('tags.manage', 'tags.edit'),
  ('tags.manage', 'tags.delete'),
  ('tags.assign', 'clients.tag'),

  ('payments.view', 'payments.view'),
  ('payments.manage', 'payments.create'),
  ('payments.manage', 'payments.edit'),
  ('payments.manage', 'payments.delete'),

  -- Currencies lived under settings.*, which is why the support-email grant also
  -- carried the power to delete a currency.
  ('settings.view', 'settings.view'),
  ('settings.view', 'currencies.view'),
  ('settings.manage', 'settings.edit'),
  ('settings.manage', 'currencies.create'),
  ('settings.manage', 'currencies.edit'),
  ('settings.manage', 'currencies.delete'),
  ('settings.general.update', 'settings.edit'),
  ('settings.smtp.update', 'settings.smtp.edit'),
  ('settings.security', 'settings.security.edit');

--> statement-breakpoint

-- The rewrite itself, as a function so all four tables get the SAME logic. A
-- copy-pasted expression per table is how one of them ends up subtly different
-- and nobody notices until an API key stops working.
CREATE OR REPLACE FUNCTION pg_temp._migrate_perms(old_perms jsonb) RETURNS jsonb AS $$
  SELECT COALESCE(jsonb_agg(DISTINCT k ORDER BY k), '[]'::jsonb)
  FROM (
    -- The wildcard becomes every key in the catalog as it stands today.
    SELECT a.key AS k
    FROM _perm_all a
    WHERE EXISTS (
      SELECT 1 FROM jsonb_array_elements_text(COALESCE(old_perms, '[]'::jsonb)) e(v)
      WHERE e.v = '*'
    )
    UNION
    -- Everything else maps through the table above. An unmapped key is dropped:
    -- keeping it would leave a grant that no guard reads, which looks like
    -- access and is not.
    SELECT m.new AS k
    FROM jsonb_array_elements_text(COALESCE(old_perms, '[]'::jsonb)) e(v)
    JOIN _perm_map m ON m.old = e.v
  ) mapped;
$$ LANGUAGE sql IMMUTABLE;

--> statement-breakpoint

UPDATE roles SET permissions = pg_temp._migrate_perms(permissions);

--> statement-breakpoint

-- The per-admin snapshot. It is what an admin on no role holds, and what
-- `resolvePermissions` falls back to, so leaving it on the old vocabulary would
-- silently strip every roleless administrator.
UPDATE admins SET permissions = pg_temp._migrate_perms(permissions);

--> statement-breakpoint

-- Invites carry the grants chosen for somebody who has not accepted yet. An
-- unmigrated invite would mint an account holding keys nothing reads — a new
-- administrator who can see nothing, on their first login.
UPDATE admin_invites SET permissions = pg_temp._migrate_perms(permissions)
WHERE permissions IS NOT NULL;

--> statement-breakpoint

-- API keys are the quiet one: no human notices a machine credential losing its
-- permissions until an integration fails.
UPDATE api_keys SET permissions = pg_temp._migrate_perms(permissions);

--> statement-breakpoint

-- The seeded unrestricted role stops being a wildcard and becomes an ordinary
-- role holding every key explicitly — editable and deletable like any other,
-- which is the point. It is named here rather than matched on `["*"]` because
-- the UPDATE above has already expanded it.
UPDATE roles
SET permissions = (SELECT jsonb_agg(key ORDER BY key) FROM _perm_all)
WHERE name = 'Administrator';

--> statement-breakpoint

-- `is_system` is what marks a role as unassignable and undeletable. With no
-- role above another, the Administrator role is an ordinary one: it can be
-- assigned, renamed, narrowed and deleted. The API refuses only the single write
-- that would leave nobody able to manage roles or administrators — see
-- `assertNotLastManager` in admin-rbac.service.ts.
UPDATE roles SET is_system = false WHERE name = 'Administrator';
