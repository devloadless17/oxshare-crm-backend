-- IB applications, found by their client (12 Oct 2026).
--
-- A small territory is read starting from its clients (clientScopePredicate's
-- compact form), entering each list through its per-client index. Every other
-- client list had one; this table had only the partial "one pending per
-- client" index, so the same question read every application (2.7 s at
-- 250,000). On a table that is already large, build it by hand first with
-- CREATE INDEX CONCURRENTLY under the same name; IF NOT EXISTS then skips it.

CREATE INDEX IF NOT EXISTS "ib_applications_user_submitted_id_idx"
  ON "ib_applications" ("user_id", "submitted_at" DESC, "id" DESC);
