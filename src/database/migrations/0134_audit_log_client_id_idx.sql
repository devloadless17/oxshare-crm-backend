-- 0134 · audit_log: an index on the CLIENT each row concerns.
--
-- ## Why
--
-- The audit log's search box takes a Portal ID (0133) and answers "every row
-- about this client". A row names its client in one of three places — the
-- subject, `details.clientId` or `details.userId` — so the store asks through
-- ONE expression, `auditRowClientId()` in `store/audit-log.store.ts`, the same
-- expression the client-scope filter already uses. Without an index on it that
-- search is a sequential scan over the append-only table guaranteed to become
-- the largest in the system, and it gets slower every day it is used.
--
-- ## ⚠️ This expression must stay IDENTICAL to `auditRowClientId()`
--
-- An expression index is used only when the query's expression is the same
-- TREE (0125 is the record of what happens otherwise: an index that exists and
-- is never chosen). Change one, change both — `test/search-at-scale.spec.ts`
-- asks the planner whether they still agree.
--
-- Every function in it is IMMUTABLE (`~*`, `->>`, the text→uuid cast), which is
-- what lets Postgres index it at all. Each branch guards the uuid shape, so a
-- malformed id yields NULL rather than failing the INSERT that writes the row —
-- an audit write must never be refused because of what an index thinks of it.
CREATE INDEX IF NOT EXISTS "audit_log_client_id_idx" ON "audit_log" ((CASE
    WHEN "subject_type" IN ('user', 'kyc_submission', 'ib_account')
         AND "subject_id" ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN "subject_id"::uuid
    WHEN "subject_type" = 'trading_account'
         AND COALESCE("details"->>'clientId', "details"->>'userId') ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
         THEN COALESCE("details"->>'clientId', "details"->>'userId')::uuid
    WHEN "subject_type" IN ('transaction', 'wallet', 'ib_application', 'transfer')
         AND "details"->>'userId' ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
         THEN ("details"->>'userId')::uuid
  END));
