-- 0205 — the demo ceiling is REMOVED (owner, 7 Oct 2026).
--
-- `trading_settings.max_demo_deposit` clamped how much practice money a client
-- could give a demo account, from Settings → Trading. The owner asked for the
-- setting, its checks and its column to go: demo money is the client's to
-- choose. The Trading tab went with it — its only other field, the commission
-- cadence, is edited from Scheduled jobs.
--
-- IF EXISTS, so a re-run (and a database that never had the column) is a no-op.

ALTER TABLE "trading_settings" DROP COLUMN IF EXISTS "max_demo_deposit";
