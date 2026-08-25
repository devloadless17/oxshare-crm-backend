-- One instance runs each scheduled job.
--
-- ── The problem ────────────────────────────────────────────────────────────
--
-- `@Cron` fires on EVERY instance. Correctness survives that — every money job
-- here is idempotent by construction and each says so in its own docblock: the
-- accrual is guarded by `ib_accruals_source_earner_uq`, the confirm credit by
-- `ledger_entries_wallet_reference_uq`, a transfer resume by the transfer id
-- being the bridge's own idempotency key. Two instances racing reach one result.
--
-- The cost does not survive it. Four replicas are four drains of the same
-- commission queue, contending on the same rows, doing four times the work for
-- one outcome — and the drain budgets make each run long enough to overlap the
-- next. "Correct but quadruple" is what stops a platform scaling horizontally,
-- which is the only way it reaches 100k clients.
--
-- ── Why a LEASE ROW and not an advisory lock ───────────────────────────────
--
-- `pg_try_advisory_lock` is SESSION-scoped. Behind a connection pool the unlock
-- can be issued on a different pooled connection than the lock, which leaves the
-- lock held until that connection recycles — a hang whose cause is invisible in
-- every application log.
--
-- A row with an expiry has no such coupling. It is one SELECT to inspect, it
-- names its holder, and it heals itself: an instance that dies mid-job stops
-- renewing and the lease expires.
--
-- ── expires_at is a CRASH BACKSTOP, not the normal path ────────────────────
--
-- A job that ends releases immediately by setting `expires_at = now()`, so the
-- next tick is never blocked by work that already finished. The expiry only
-- decides anything when nothing ever releases, and it must exceed the job's own
-- time budget — otherwise a second instance starts while the first is still
-- draining, which is the duplicate work this exists to remove.
--
-- Idempotent, and therefore re-runnable if it is ever renumbered — the trap
-- CLAUDE.md documents, where a renumbered migration leaves a watermark ahead of
-- the journal and every later migration is skipped in silence.
CREATE TABLE IF NOT EXISTS job_leases (
  name        varchar(100) PRIMARY KEY,
  holder      varchar(160) NOT NULL,
  acquired_at timestamptz  NOT NULL DEFAULT now(),
  expires_at  timestamptz  NOT NULL
);

COMMENT ON TABLE job_leases IS
  'One row per scheduled job. The holder is the only instance that runs it this tick; expires_at is the crash backstop, not the normal release path.';
