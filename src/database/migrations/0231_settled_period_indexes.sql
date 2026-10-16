-- 0231 — the SETTLED period (16 Oct 2026, audit R4-1): month-end figures by when money settled,
-- not when it was requested. `?settledFrom=&settledTo=` range-scans these, in the union's own
-- order (settled_at DESC, id DESC is not needed: the page still sorts by created_at). Partial: an
-- unsettled row has no settled_at.
SET lock_timeout = '10s';
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS transactions_settled_at_idx ON transactions (settled_at)
  WHERE settled_at IS NOT NULL;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS transfers_settled_at_idx ON transfers (settled_at)
  WHERE settled_at IS NOT NULL;
