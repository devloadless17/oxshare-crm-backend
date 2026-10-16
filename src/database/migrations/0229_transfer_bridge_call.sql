-- 0229 — a transfer records when it last asked MT5 to move its money (16 Oct 2026, audit R1-1).
--
-- "Release the hold" (abandon) and the resume job could cross: the job reads `pending`, calls the
-- bridge, MT5 posts the deal; meanwhile a desk member abandons, the hold is released, and the
-- client holds the money twice (wallet → account) or loses it (account → wallet). Abandon now
-- refuses while a call is recent enough that its deal may still be arriving, and refuses outright
-- once MT5 shows the deal (`mt5_deals`). Additive and re-runnable.
SET lock_timeout = '10s';
--> statement-breakpoint
ALTER TABLE transfers ADD COLUMN IF NOT EXISTS bridge_called_at timestamptz;
