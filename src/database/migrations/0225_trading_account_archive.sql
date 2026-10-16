-- 0225: an administrator ARCHIVES a client's trading account (16 Oct 2026).
--
-- A client lost in the portal opened ten live accounts and will use one or two.
-- The desk asked to hide the rest. Archiving decides who SEES an account, not
-- whether it trades, so it is its own column rather than a `status`: `closed`
-- would claim something MT5 does not reflect (the login still works in the
-- terminal; nothing here can disable it).
--
-- An archived account is absent from every client read (list, detail, the
-- transfer picker, the dashboard counts) and takes no money from either side.
-- It still counts toward a product's per-client cap, or archiving would become a
-- way round it. Archiving is refused while MT5 says the account holds anything.
--
-- Grants the new `trading.archive` key to the system (Administrator) role, so the
-- release is self-contained. Hand-written (see 0040's header). Re-runnable.

ALTER TABLE trading_accounts
  ADD COLUMN IF NOT EXISTS archived_at timestamptz,
  ADD COLUMN IF NOT EXISTS archived_by_admin_id uuid REFERENCES admins(id) ON DELETE SET NULL;

UPDATE roles
   SET permissions = (
     SELECT COALESCE(jsonb_agg(DISTINCT k ORDER BY k), '[]'::jsonb)
       FROM (
         SELECT e.v AS k FROM jsonb_array_elements_text(COALESCE(permissions, '[]'::jsonb)) e(v)
         UNION SELECT 'trading.archive'
       ) keys(k)
   )
 WHERE is_system = true;
