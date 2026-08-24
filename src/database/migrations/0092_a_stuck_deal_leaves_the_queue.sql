-- A deal that cannot be accrued stops blocking the ones that can.
--
-- The accrual queue is drained oldest-first, a bounded batch at a time. Open
-- legs were taken out of it in SQL for that reason (0079's note), but two other
-- kinds of row were still SKIPPED INSIDE THE LOOP and left unmarked:
--
--   * a deal whose login no trading_accounts row claims — and the scheduler's
--     own docblock concedes some logins (a manager's, a broker-side test
--     account) are never going to be linked at all;
--   * a deal the engine REFUSED — a settings mistake, which by definition fails
--     identically on every future run until a human changes a rate.
--
-- Both stay at the FRONT of the queue for as long as they are stuck. One
-- batch's worth of either and no payable deal is ever reached again: commission
-- stops for everybody, with nothing to show for it but an ordinary log line.
-- The failure gets worse the busier the platform is.
--
-- Orphans need no column — they are excluded by the join, and re-enter the
-- queue by themselves the moment the account is linked. A REFUSAL has nothing
-- in the row to recognise it by, so it gets one here.
--
-- Hand-written, like every migration from 0027 on: the committed drizzle
-- snapshots stop at 0026, so `drizzle-kit generate` would diff against a stale
-- baseline and prompt to rename a dozen unrelated enums.

-- How many times the engine has tried and failed. Drives the backoff, and is
-- the number that says "this one is not going to fix itself".
ALTER TABLE mt5_deals
  ADD COLUMN IF NOT EXISTS commission_attempts integer NOT NULL DEFAULT 0;

-- NULL means eligible now, which is what every existing row is and must stay:
-- this migration must not delay a single queued deal.
--
-- Deliberately NOT a "give up" flag. A refused deal is still owed, so it comes
-- back forever — just slowly enough that it can never crowd out a payable one.
ALTER TABLE mt5_deals
  ADD COLUMN IF NOT EXISTS commission_retry_after timestamptz;

-- Why it last failed, so a stuck row is diagnosable from the row rather than
-- from a log line that has already rotated away. Never a credential and never a
-- client detail — the engine's refusals name rates and feeds.
ALTER TABLE mt5_deals
  ADD COLUMN IF NOT EXISTS commission_last_error text;

ALTER TABLE mt5_deals
  DROP CONSTRAINT IF EXISTS mt5_deals_commission_attempts_ck;

ALTER TABLE mt5_deals
  ADD CONSTRAINT mt5_deals_commission_attempts_ck
  CHECK (commission_attempts >= 0);

-- The queue's index is deliberately UNCHANGED.
--
-- Leading it with `commission_retry_after` was the obvious move and is the
-- wrong one. The gate is `retry_after IS NULL OR retry_after <= now()`, and two
-- ranges of one index is a bitmap scan followed by a SORT — where the existing
-- `(dealt_at)` partial index gives an ordered scan that stops at `limit`, which
-- is the whole reason a bounded oldest-first batch is cheap.
--
-- It would not have bought anything either way: the dominant cost is orphans,
-- and orphan-ness lives in `trading_accounts`, not in a column any index here
-- can carry. The retry gate is a cheap row filter over a partial index that
-- covers only unprocessed deals.
