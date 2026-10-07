-- 0206 — the three MT5 jobs leave Settings → Scheduled jobs (owner, 7 Oct 2026).
--
-- Closed trades, balances, new accounts and new groups are picked up the moment
-- they happen now (the bridge's change feed and the webhooks behind it), so the
-- jobs that polled for them are not the admin's to tune:
--
--   bridge.sweep      REMOVED. The bridge chooses its own safety interval.
--   mt5.syncAccounts  hidden safety net, hourly, not editable.
--   mt5.syncGroups    hidden safety net, hourly, not editable.
--
-- The runner pins the two hidden jobs to their default on every boot as well;
-- this makes the stored rows say so from the start.

DELETE FROM "scheduled_jobs" WHERE "key" = 'bridge.sweep';
--> statement-breakpoint
UPDATE "scheduled_jobs" SET "interval_seconds" = 3600
 WHERE "key" IN ('mt5.syncAccounts', 'mt5.syncGroups');
