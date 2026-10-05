-- 0189 — An admin task stays in the Inbox until somebody HANDLES it (the
-- owner's rule, 5 Oct 2026, from the buyer's old CRM). Until now reading a
-- task took it out of the reader's Inbox: clicking a deposit filed it under
-- History although nobody had approved it. The Inbox and the badge are now
-- every unresolved task, seen or not; read_at only marks a task as no longer
-- new. History is the resolved ones.
--
-- So the inbox index loses "read_at IS NULL" from its predicate, or the badge
-- poll and the Inbox would stop using it. No data changes: a task somebody
-- read but nobody handled comes back into the Inbox, which is the point.
DROP INDEX IF EXISTS "notifications_admin_inbox_idx";
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "notifications_admin_inbox_idx"
  ON "notifications" ("recipient_id", "created_at" DESC, "id" DESC)
  WHERE "recipient_kind" = 'admin' AND "resolved_at" IS NULL;
