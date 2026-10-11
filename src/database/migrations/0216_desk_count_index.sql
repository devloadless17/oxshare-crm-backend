-- The Deposits and Withdrawals desks' tab counts, read from one index (11 Oct 2026).
--
-- A desk shows only movements a person decides: a list of (direction, provider,
-- channel) routes. Its tab counts each stop at 10,001 rows, but with only
-- (state) indexed Postgres first built a bitmap of EVERY row in that state to
-- find them: 20-30 ms per tab at 3M movements, seven tabs a page, and 2 s for
-- the page with 25 administrators working. With the route beside the state the
-- count is an index-only read of the rows it needs (118 ms -> 11 ms).
-- On a table that is already large, build it by hand first with
-- CREATE INDEX CONCURRENTLY under the same name; IF NOT EXISTS then skips it.

CREATE INDEX IF NOT EXISTS "transactions_state_route_idx"
  ON "transactions" ("state", "direction", "provider_code", "channel_code");
