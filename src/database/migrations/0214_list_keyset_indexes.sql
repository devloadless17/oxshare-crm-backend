-- Lists at any size (9 Oct 2026): the indexes the cursor-paged lists walk.
--
-- A keyset page reads `limit + 1` rows from an index already in the list's
-- order, so it costs the same on page one and page forty thousand. These are
-- the orders that had no such index:
--
--  * mt5_deals (login, dealt_at, id) — a client's Positions tab walks each of
--    their MT5 logins newest-first and merges them. Without it a heavy trader's
--    page sorted every deal they ever made.
--  * kyc_submissions (coalesce(submitted_at, created_at), user_id) — the KYC
--    queue's "submitted" order, which is now this never-null expression (the
--    same instant its period filter reads) so a cursor can seek on it; and the
--    same per status, for each tab.
--  * audit_log (client_id, created_at, id) — the trail for one client (a
--    Portal ID search, the client's own history) newest-first, instead of
--    walking the whole log filtering for them.
--
-- Plain CREATE INDEX: production's tables are small today. On a table that is
-- already large, build it first by hand with CREATE INDEX CONCURRENTLY under
-- the same name; IF NOT EXISTS then makes this a no-op.

CREATE INDEX IF NOT EXISTS "mt5_deals_login_dealt_id_idx"
  ON "mt5_deals" ("login", "dealt_at" DESC, "id" DESC);

CREATE INDEX IF NOT EXISTS "audit_log_client_created_id_idx"
  ON "audit_log" ("client_id", "created_at" DESC, "id" DESC)
  WHERE "client_id" IS NOT NULL;

CREATE INDEX IF NOT EXISTS "kyc_submissions_submitted_or_started_user_idx"
  ON "kyc_submissions" ((coalesce("submitted_at", "created_at")) DESC, "user_id" DESC);

CREATE INDEX IF NOT EXISTS "kyc_submissions_status_submitted_or_started_user_idx"
  ON "kyc_submissions" ("status", (coalesce("submitted_at", "created_at")) DESC, "user_id" DESC);
