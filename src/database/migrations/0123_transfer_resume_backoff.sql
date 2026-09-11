-- A stuck transfer must leave the FRONT of the resume queue.
--
-- `TransferResumeScheduler` selects pending transfers oldest-first with
-- LIMIT 10 and re-runs the executor on each, every minute, for ever. A transfer
-- that can never be resumed therefore keeps its place at the head of that queue
-- permanently, and newer pending transfers are never examined at all — not
-- slowly, never. Ten such rows starve the entire rail.
--
-- The commission engine met this exact shape and its own docblock calls it "the
-- worst shape a money job can have", noting that it gets WORSE the busier the
-- platform is. Migration 0092 solved it there with attempts / retry_after /
-- last_error and an exponential backoff, and that mechanism has been running in
-- production since. This copies it rather than inventing a second one.
--
-- What it does NOT do is fail anything. Age is not evidence that money did not
-- move: a transfer pending for a day may have credited MT5 on its first attempt
-- and lost the response, and auto-failing it would release the hold and hand the
-- client their money twice. The backoff changes only HOW OFTEN a stuck row is
-- retried, never what happens to it. A human still decides.
--
-- Re-runnable on purpose (see the repo's note on renumbered migrations): every
-- statement is guarded, so applying it twice is a no-op rather than an error.

ALTER TABLE "transfers" ADD COLUMN IF NOT EXISTS "resume_attempts" integer DEFAULT 0 NOT NULL;
ALTER TABLE "transfers" ADD COLUMN IF NOT EXISTS "resume_after" timestamp with time zone;
ALTER TABLE "transfers" ADD COLUMN IF NOT EXISTS "resume_last_error" text;

-- The scheduler's own query: pending rows whose backoff has elapsed, oldest
-- first. Without this it is a sequential scan of every transfer ever made, once
-- a minute, for ever.
CREATE INDEX IF NOT EXISTS "transfers_resume_queue_idx"
  ON "transfers" ("created_at")
  WHERE "state" = 'pending';
