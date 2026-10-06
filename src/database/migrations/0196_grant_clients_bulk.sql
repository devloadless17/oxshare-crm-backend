-- 0196 — `clients.bulk`: change many clients at once (6 Oct 2026).
--
-- The clients list now selects many rows — or every client matching a filter —
-- and adds, removes or replaces tags on all of them in one step. A tag is a
-- territory, so one bulk change can move a whole book between desks: the same
-- act as `clients.tag`, a thousand times over. It gets its own key, held by the
-- Administrator role and the two bootstrap accounts like every key before it
-- (0122's recipe), and needs `clients.tag` beside it.
UPDATE roles
   SET permissions = (
     SELECT COALESCE(jsonb_agg(DISTINCT k ORDER BY k), '[]'::jsonb)
       FROM (
         SELECT e.v AS k FROM jsonb_array_elements_text(COALESCE(permissions, '[]'::jsonb)) e(v)
         UNION SELECT 'clients.bulk'
       ) keys(k)
   )
 WHERE name = 'Administrator';--> statement-breakpoint
UPDATE admins
   SET permissions = (
     SELECT COALESCE(jsonb_agg(DISTINCT k ORDER BY k), '[]'::jsonb)
       FROM (
         SELECT e.v AS k FROM jsonb_array_elements_text(COALESCE(permissions, '[]'::jsonb)) e(v)
         UNION SELECT 'clients.bulk'
       ) keys(k)
   )
 WHERE email IN ('admin@oxshare.com', 'e2e-admin@oxshare.com');
