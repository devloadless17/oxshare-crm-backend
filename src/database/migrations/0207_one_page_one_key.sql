-- 0207 — ONE PAGE, ONE KEY (the Oct 2026 roles & permissions audit)
--
-- The buyer gave his Sales role "View Partners, Applications & Commission
-- Levels" (`ib.view`) and it opened FIVE pages, Commission types and Partner
-- levels among them; `trading.view` opened MT5 groups too, and `settings.view`
-- opened Products and Agencies. A tick showed menu items nobody chose.
--
-- The rule now: every sidebar page has exactly ONE view key, and every other key
-- is an action on that page that `requires` it (config/permissions.json).
--
-- What this migration does to every stored permission set (roles, admins,
-- pending invites, API keys):
--
--   1. WORK pages carry over from the key that used to open them:
--        ib.view  -> ib.partners.view, ib.applications.view, ib.referrals.view,
--                    ib.commissions.view
--        kyc.create / kyc.edit / kyc.delete -> rejection_reasons.view and the
--                    matching rejection_reasons.* action (the Rejection reasons
--                    page rode on the KYC builder's keys).
--   2. `ib.view` is removed. API keys are rewritten too, because this is a
--      RENAME for them: a key holding `ib.view` would otherwise lose its IB access.
--   3. Every set is closed over `requires`: a set holding `deposits.approve`
--      gains `deposits.view`. Each one added is a page the holder could already
--      act on and simply could not open, so nothing widens in substance.
--   4. CONFIGURATION pages start with the Administrator role only (the owner's
--      decision): partner levels, commission types, products, agencies, MT5
--      groups and the bridge diagnostics. Everyone else gets them only when
--      somebody ticks them on the Roles screen. `permission-drift.ts` would top
--      Administrator up at boot anyway; the grant is stated here so the release
--      is self-contained.
--
-- `trading.view` and `settings.view` are untouched keys: they simply open fewer
-- pages now. Hand-written (see 0040's header). Re-runnable: every step is a
-- set union or a removal.

CREATE OR REPLACE FUNCTION pg_temp.oxshare_0207_remap(p jsonb) RETURNS jsonb
LANGUAGE plpgsql AS $$
DECLARE
  keys text[] := ARRAY(SELECT jsonb_array_elements_text(COALESCE(p, '[]'::jsonb)));
  before int;
BEGIN
  IF 'ib.view' = ANY(keys) THEN
    keys := keys || ARRAY['ib.partners.view', 'ib.applications.view', 'ib.referrals.view',
                          'ib.commissions.view'];
  END IF;
  IF keys && ARRAY['kyc.create', 'kyc.edit', 'kyc.delete'] THEN
    keys := keys || ARRAY['rejection_reasons.view'];
  END IF;
  IF 'kyc.create' = ANY(keys) THEN keys := keys || ARRAY['rejection_reasons.create']; END IF;
  IF 'kyc.edit' = ANY(keys) THEN keys := keys || ARRAY['rejection_reasons.edit']; END IF;
  IF 'kyc.delete' = ANY(keys) THEN keys := keys || ARRAY['rejection_reasons.delete']; END IF;
  keys := array_remove(keys, 'ib.view');

  -- Close over `requires`, generated from config/permissions.json.
  LOOP
    before := cardinality(ARRAY(SELECT DISTINCT unnest(keys)));
    keys := keys || ARRAY(
      SELECT r.needs FROM (VALUES
      ('clients.edit', 'clients.view'),
      ('clients.email', 'clients.view'),
      ('clients.referrer.set', 'clients.view'),
      ('clients.suspend', 'clients.view'),
      ('clients.tag', 'clients.view'),
      ('clients.bulk', 'clients.tag'),
      ('kyc.documents.view', 'kyc.view'),
      ('kyc.review', 'kyc.view'),
      ('kyc.claim.override', 'kyc.review'),
      ('kyc.identity.correct', 'kyc.view'),
      ('trading.create', 'trading.view'),
      ('trading.deposit', 'trading.view'),
      ('trading.withdraw', 'trading.view'),
      ('ib.partners.edit', 'ib.partners.view'),
      ('ib.partners.suspend', 'ib.partners.view'),
      ('ib.approve', 'ib.applications.view'),
      ('ib.reject', 'ib.applications.view'),
      ('ib.commissions.reverse', 'ib.commissions.view'),
      ('ib.commission_types.create', 'ib.commission_types.view'),
      ('ib.commission_types.edit', 'ib.commission_types.view'),
      ('ib.commission_types.delete', 'ib.commission_types.view'),
      ('ib.levels.create', 'ib.levels.view'),
      ('ib.levels.edit', 'ib.levels.view'),
      ('ib.levels.delete', 'ib.levels.view'),
      ('agencies.create', 'agencies.view'),
      ('agencies.edit', 'agencies.view'),
      ('agencies.delete', 'agencies.view'),
      ('transfers.abandon', 'transactions.view'),
      ('deposits.proofs.view', 'deposits.view'),
      ('deposits.approve', 'deposits.view'),
      ('deposits.reject', 'deposits.view'),
      ('withdrawals.settle', 'withdrawals.view'),
      ('withdrawals.approve', 'withdrawals.view'),
      ('wallets.create', 'wallets.view'),
      ('wallets.credit', 'wallets.view'),
      ('wallets.debit', 'wallets.view'),
      ('wallets.delete', 'wallets.view'),
      ('currencies.create', 'currencies.view'),
      ('currencies.edit', 'currencies.view'),
      ('currencies.delete', 'currencies.view'),
      ('products.create', 'products.view'),
      ('products.edit', 'products.view'),
      ('products.delete', 'products.view'),
      ('leverages.create', 'leverages.view'),
      ('leverages.edit', 'leverages.view'),
      ('leverages.delete', 'leverages.view'),
      ('settings.edit', 'settings.view'),
      ('settings.smtp.view', 'settings.view'),
      ('settings.smtp.edit', 'settings.smtp.view'),
      ('admins.create', 'admins.view'),
      ('admins.edit', 'admins.view'),
      ('admins.suspend', 'admins.view'),
      ('admins.scope', 'admins.view'),
      ('admins.reset', 'admins.view'),
      ('roles.create', 'roles.view'),
      ('roles.edit', 'roles.view'),
      ('roles.delete', 'roles.view'),
      ('payments.providers.edit', 'payments.providers.view'),
      ('payments.create', 'payments.view'),
      ('payments.edit', 'payments.view'),
      ('kyc.create', 'kyc.edit'),
      ('kyc.delete', 'kyc.edit'),
      ('rejection_reasons.create', 'rejection_reasons.view'),
      ('rejection_reasons.edit', 'rejection_reasons.view'),
      ('rejection_reasons.delete', 'rejection_reasons.view'),
      ('tags.create', 'tags.view'),
      ('tags.edit', 'tags.view'),
      ('tags.delete', 'tags.view'),
      ('externallinks.create', 'externallinks.view'),
      ('externallinks.edit', 'externallinks.view'),
      ('externallinks.delete', 'externallinks.view'),
      ('apikeys.create', 'apikeys.view'),
      ('apikeys.revoke', 'apikeys.view'),
      ('settings.security.edit', 'settings.security.view')
      ) AS r(key, needs)
      WHERE r.key = ANY(keys));
    EXIT WHEN cardinality(ARRAY(SELECT DISTINCT unnest(keys))) = before;
  END LOOP;

  RETURN (SELECT COALESCE(jsonb_agg(DISTINCT k ORDER BY k), '[]'::jsonb) FROM unnest(keys) k);
END;
$$;

UPDATE roles SET permissions = pg_temp.oxshare_0207_remap(permissions);
UPDATE admins SET permissions = pg_temp.oxshare_0207_remap(permissions);
UPDATE admin_invites SET permissions = pg_temp.oxshare_0207_remap(permissions)
 WHERE accepted = false;
UPDATE api_keys SET permissions = pg_temp.oxshare_0207_remap(permissions);

UPDATE roles
   SET permissions = (
     SELECT COALESCE(jsonb_agg(DISTINCT k ORDER BY k), '[]'::jsonb)
       FROM (
         SELECT e.v AS k FROM jsonb_array_elements_text(COALESCE(permissions, '[]'::jsonb)) e(v)
         UNION SELECT jsonb_array_elements_text('["ib.levels.view", "ib.commission_types.view", "products.view", "products.create", "products.edit", "products.delete", "agencies.view", "agencies.create", "agencies.edit", "agencies.delete", "mt5.groups.view", "mt5.bridge.view"]'::jsonb)
       ) keys(k)
   )
 WHERE is_system = true;

DROP FUNCTION pg_temp.oxshare_0207_remap(jsonb);
