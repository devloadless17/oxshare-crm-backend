-- 0167 — EVERY BACKGROUND JOB'S TIMING, EDITED IN SETTINGS (owner, 29 Sep 2026).
--
-- "Instead of having them within the .env file … the admin can edit them." One
-- row per job (common/scheduling/scheduled-jobs.catalog.ts): how often it runs and
-- what its last run did. ScheduledJobsRunner starts each CRM job when its interval
-- has passed, claiming the run with a conditional UPDATE so one instance starts it;
-- the MT5 bridge reads `bridge.sweep` from GET /webhooks/mt5/settings once a minute.
--
-- Seeded with the timings the jobs had as fixed @Cron expressions (and the
-- defaults of the env vars that overrode three of them — MT5_GROUP_SYNC_CRON,
-- TRANSFER_RESUME_CRON, MT5_ACCOUNT_SYNC_CRON — which are no longer read). The
-- commission pair keeps its interval in trading_settings (it is also the hold
-- window); their rows are seeded from it and record runs.

CREATE TABLE IF NOT EXISTS "scheduled_jobs" (
  "key" varchar(64) PRIMARY KEY,
  "interval_seconds" integer NOT NULL CHECK ("interval_seconds" >= 10),
  "last_started_at" timestamptz,
  "last_finished_at" timestamptz,
  "last_duration_ms" integer,
  "last_error" text,
  "last_error_at" timestamptz,
  "external_read_at" timestamptz,
  "updated_by" uuid,
  "updated_at" timestamptz NOT NULL DEFAULT now()
);
--> statement-breakpoint
INSERT INTO "scheduled_jobs" ("key", "interval_seconds") VALUES
  ('bridge.sweep', 300),
  ('mt5.syncAccounts', 600),
  ('mt5.syncGroups', 3600),
  ('payments.resumeTransfers', 60),
  ('rival.reconcile', 300),
  ('payments.foldMovementTotals', 60),
  ('wallet.reconcile', 3600),
  ('security.sweep', 3600),
  ('notifications.prune', 86400)
ON CONFLICT ("key") DO NOTHING;
--> statement-breakpoint
INSERT INTO "scheduled_jobs" ("key", "interval_seconds")
SELECT k, COALESCE((SELECT ib_commission_interval_seconds FROM trading_settings LIMIT 1), 3600)
  FROM (VALUES ('ib.accrueDeals'), ('ib.confirmAccruals')) AS v(k)
ON CONFLICT ("key") DO NOTHING;
