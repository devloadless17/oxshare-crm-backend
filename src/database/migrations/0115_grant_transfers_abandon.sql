-- ============================================================================
-- Grant `transfers.abandon` to the roles that already settle money
-- ============================================================================
--
-- A client moved $1,000 to their trading account, the MT5 bridge lost its
-- session four seconds later, and the transfer sat "Processing" indefinitely
-- with the money held and unspendable. Nothing expires a hold, the resume job
-- only ever RETRIES, and no route existed to release one — the repair was
-- hand-written SQL against a money table.
--
-- `POST /admin/transfers/:id/abandon` is that route. This grant is what makes it
-- reachable on a database that already exists: `ALL_PERMISSIONS` is computed
-- from `config/permissions.json`, so a FRESH database gets the key with no help,
-- while the seed's `onConflictDoNothing` deliberately refuses to re-widen an
-- existing role. Permissions are a STORED SNAPSHOT, and that is the whole reason
-- migrations like 0075, 0085 and 0087 exist.
--
-- ── WHO GETS IT, AND WHY NOT EVERYONE ───────────────────────────────────────
--
-- Whoever already holds `withdrawals.settle`. That is the permission for
-- "decide that money did or did not move, on evidence outside this system" —
-- exactly the judgement this needs, made by reading MT5's own record. An
-- operator trusted to mark a withdrawal paid is trusted to say a transfer never
-- reached the trading server.
--
-- NOT granted with `withdrawals.approve` or `trading.view`. Approving is a
-- decision about whether money SHOULD move; this is a statement about whether it
-- DID, and the failure mode is worse: release a transfer MT5 actually applied
-- and the client can spend the same money twice.
--
-- ⚠️ API KEYS ARE NOT GRANTED THIS, and that asymmetry is deliberate — 0087 and
-- 0104 both made the same call. Nobody asked an integration to decide that a
-- movement did not happen, and a machine credential that quietly gains a power
-- is found during an incident rather than during a review.
--
-- ⚠️ NO `pg_temp` HELPER. 0068 earned that warning and every migration since has
-- repeated it: `pg_temp` is session-local and the runner does not guarantee one
-- session per migration, so a factored-out helper can vanish between its
-- creation and the statements using it — each of which then succeeds against
-- zero rows rather than failing loudly. The expression is repeated in full.

BEGIN;

UPDATE roles
   SET permissions = (
     SELECT COALESCE(jsonb_agg(DISTINCT k ORDER BY k), '[]'::jsonb)
       FROM (
         SELECT e.v AS k
           FROM jsonb_array_elements_text(COALESCE(permissions, '[]'::jsonb)) e(v)
         UNION SELECT 'transfers.abandon'
       ) keys(k)
   )
 WHERE permissions ? 'withdrawals.settle';

UPDATE admins
   SET permissions = (
     SELECT COALESCE(jsonb_agg(DISTINCT k ORDER BY k), '[]'::jsonb)
       FROM (
         SELECT e.v AS k
           FROM jsonb_array_elements_text(COALESCE(permissions, '[]'::jsonb)) e(v)
         UNION SELECT 'transfers.abandon'
       ) keys(k)
   )
 WHERE permissions ? 'withdrawals.settle';

UPDATE admin_invites
   SET permissions = (
     SELECT COALESCE(jsonb_agg(DISTINCT k ORDER BY k), '[]'::jsonb)
       FROM (
         SELECT e.v AS k
           FROM jsonb_array_elements_text(COALESCE(permissions, '[]'::jsonb)) e(v)
         UNION SELECT 'transfers.abandon'
       ) keys(k)
   )
 WHERE permissions ? 'withdrawals.settle';

COMMIT;
