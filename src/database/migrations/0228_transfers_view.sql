-- 0228 — the Transfers page gets its own key, `transfers.view` (16 Oct 2026).
--
-- One page, one key (0207): Finance → Transfers lists every move between a client's own accounts
-- (wallet ⇄ trading account, commission → wallet) with where its money came from (0226). It opens
-- on `transfers.view`; `transfers.abandon` (release a stuck transfer) moves under it and now
-- `requires` it (config/permissions.json).
--
-- Carried to every stored permission set — roles, admins, pending invites, API keys — that holds
-- `transactions.view` (it could already see every one of these rows on All transactions) or
-- `transfers.abandon` (it acts on them), and to the Administrator role. Nobody else: a
-- `trading.view` holder does not gain sight of money moving. Re-runnable: a set union.
-- No `pg_temp` helper (0068's warning).

UPDATE roles
   SET permissions = (
     SELECT COALESCE(jsonb_agg(DISTINCT k ORDER BY k), '[]'::jsonb)
       FROM (
         SELECT e.v AS k FROM jsonb_array_elements_text(COALESCE(permissions, '[]'::jsonb)) e(v)
         UNION SELECT 'transfers.view'
       ) keys(k)
   )
 WHERE is_system = true
    OR COALESCE(permissions, '[]'::jsonb) ?| ARRAY['transactions.view', 'transfers.abandon'];
--> statement-breakpoint
UPDATE admins
   SET permissions = (
     SELECT COALESCE(jsonb_agg(DISTINCT k ORDER BY k), '[]'::jsonb)
       FROM (
         SELECT e.v AS k FROM jsonb_array_elements_text(COALESCE(permissions, '[]'::jsonb)) e(v)
         UNION SELECT 'transfers.view'
       ) keys(k)
   )
 WHERE COALESCE(permissions, '[]'::jsonb) ?| ARRAY['transactions.view', 'transfers.abandon'];
--> statement-breakpoint
UPDATE admin_invites
   SET permissions = (
     SELECT COALESCE(jsonb_agg(DISTINCT k ORDER BY k), '[]'::jsonb)
       FROM (
         SELECT e.v AS k FROM jsonb_array_elements_text(COALESCE(permissions, '[]'::jsonb)) e(v)
         UNION SELECT 'transfers.view'
       ) keys(k)
   )
 WHERE accepted = false
   AND COALESCE(permissions, '[]'::jsonb) ?| ARRAY['transactions.view', 'transfers.abandon'];
--> statement-breakpoint
UPDATE api_keys
   SET permissions = (
     SELECT COALESCE(jsonb_agg(DISTINCT k ORDER BY k), '[]'::jsonb)
       FROM (
         SELECT e.v AS k FROM jsonb_array_elements_text(COALESCE(permissions, '[]'::jsonb)) e(v)
         UNION SELECT 'transfers.view'
       ) keys(k)
   )
 WHERE COALESCE(permissions, '[]'::jsonb) ?| ARRAY['transactions.view', 'transfers.abandon'];
