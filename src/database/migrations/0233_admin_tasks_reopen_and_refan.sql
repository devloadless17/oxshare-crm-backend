-- 0233 — admin tasks: a re-raised item gets a NEW task, and open tasks reach today's holders
-- (17 Oct 2026, audit R3-7/R3-8).
--
-- The dedupe key was unique per recipient for ever, RESOLVED rows included, so an item flagged a
-- second time (a payout the provider reports again, a deposit flagged twice for the same reason)
-- inserted nothing and reached no Inbox. Unique only among OPEN rows now: one open task per
-- recipient and item, as before, and a fresh one once the last was handled.
--
-- `notifications.refan` re-offers every open admin task to the admins who hold its permission
-- NOW — an admin granted it later, or one replacing an admin who left, sees the work already
-- waiting. The existing rows are absorbed by this same index.
SET lock_timeout = '10s';
--> statement-breakpoint
DROP INDEX IF EXISTS notifications_recipient_dedupe_uq;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS notifications_recipient_dedupe_uq
  ON notifications (recipient_kind, recipient_id, dedupe_key)
  WHERE dedupe_key IS NOT NULL AND resolved_at IS NULL;
--> statement-breakpoint
INSERT INTO scheduled_jobs (key, interval_seconds) VALUES ('notifications.refan', 900)
ON CONFLICT (key) DO NOTHING;
