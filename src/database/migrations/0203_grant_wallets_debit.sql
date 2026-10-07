-- `wallets.debit` (7 Oct 2026): the desk's hand withdrawal from a client wallet,
-- the mirror of `wallets.credit` — money leaves the platform as a completed
-- manual withdrawal. Its OWN key, as crediting has its own: taking money out
-- is not a power anybody acquires by being able to view wallets.
--
-- Granted to every role and admin that already holds `wallets.credit` (and the
-- Administrator role), so whoever may correct a balance upward may correct it
-- downward. Without this, saving such a role would re-send a key its editor
-- does not hold and be refused (0049's anti-escalation note).
--
-- No `pg_temp` helper — 0068's warning.

UPDATE roles
   SET permissions = (
     SELECT COALESCE(jsonb_agg(DISTINCT k ORDER BY k), '[]'::jsonb)
       FROM (
         SELECT e.v AS k FROM jsonb_array_elements_text(COALESCE(permissions, '[]'::jsonb)) e(v)
         UNION SELECT 'wallets.debit'
       ) keys(k)
   )
 WHERE name = 'Administrator' OR COALESCE(permissions, '[]'::jsonb) ? 'wallets.credit';--> statement-breakpoint
UPDATE admins
   SET permissions = (
     SELECT COALESCE(jsonb_agg(DISTINCT k ORDER BY k), '[]'::jsonb)
       FROM (
         SELECT e.v AS k FROM jsonb_array_elements_text(COALESCE(permissions, '[]'::jsonb)) e(v)
         UNION SELECT 'wallets.debit'
       ) keys(k)
   )
 WHERE email IN ('admin@oxshare.com', 'e2e-admin@oxshare.com')
    OR COALESCE(permissions, '[]'::jsonb) ? 'wallets.credit';
