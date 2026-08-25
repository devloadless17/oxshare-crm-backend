-- Mirror MT5's CREDIT beside the balance.
--
-- ── Why this is storable when equity is not ────────────────────────────────
--
-- Credit moves on a DISCRETE event — a dealer granting or removing bonus — in
-- exactly the way balance does. Equity, margin and floating P/L are recomputed
-- from live prices on every tick, which is why they are deliberately absent from
-- this table and available only through `/accounts/:id/live`. The line is not
-- "how useful is it" but "does a stored copy stop being true a second later".
--
-- ── It was already arriving, and being thrown away ─────────────────────────
--
-- The bridge reads credit on every account snapshot, the live endpoint returns
-- it, and `floating` is defined as equity minus balance minus CREDIT. Without a
-- column, showing a client's tradeable position on a LIST meant one live MT5
-- call per row — the exact read the balance mirror exists to avoid, and the one
-- that once made the admin account list the reason the estate could not
-- reconnect.
--
-- ── NOT part of any total ──────────────────────────────────────────────────
--
-- Credit is not the client's money to withdraw. Nothing sums it into `balance`,
-- and nothing should: a balance that quietly included bonus credit would
-- overstate what a withdrawal can pay out, which is a money bug that looks like
-- a rounding difference until somebody tries to take it out.
--
-- DEFAULT 0 and NOT NULL, so every existing row is immediately valid and no read
-- has to reason about a null. Zero is also the truth for an account nobody has
-- granted credit on, which is almost all of them.
--
-- Idempotent, and therefore re-runnable if renumbered — the trap CLAUDE.md
-- documents, where a renumbered migration leaves a watermark ahead of the
-- journal and every later migration is skipped in silence.
ALTER TABLE trading_accounts
  ADD COLUMN IF NOT EXISTS credit numeric(28, 8) NOT NULL DEFAULT 0;

COMMENT ON COLUMN trading_accounts.credit IS
  'MT5 bonus credit, mirrored on the same read as balance. NOT withdrawable and never summed into balance.';
