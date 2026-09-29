-- 0165 — THE FINANCIAL LIST AT ANY SIZE: money-movement totals kept by the database,
-- and an index for every tab and sort (29 Sep 2026).
--
-- The admin list (`GET /admin/transactions`) and its summary counted and summed the
-- WHOLE union of movements — transactions, MT5 transfers, commission transfers — on
-- every request, and a status tab or sort read the union through no index. Measured
-- 29 Sep 2026 on 160,000 transactions: ~200 ms for the tab counts, ~450 ms for the
-- summary, ~1 s to sort by status, and ~0.9 s for one page seen by a desk admin who
-- also sees new clients — every figure growing with the table.
--
-- ── Totals: three tables, and the split keeps money writes as fast as they were ──
--
--   movement_total_deltas   APPEND-ONLY. Every insert, delete, or change of a
--                           movement's day/kind/direction/state/currency/amount writes
--                           one (+) and/or one (−) row here, from a trigger, in the
--                           money transaction itself. Inserts take no lock another
--                           writer waits on — a shared counter row would have
--                           serialised every deposit of the day on it and, taken in
--                           a different order from the wallet locks, deadlocked.
--   movement_daily_totals   per UTC day — read by an admin who sees every client.
--   movement_client_totals  per CLIENT — read by a desk admin (a territory) and by any
--                           read about one client. A territory is a set of clients
--                           that changes whenever a tag does, so it cannot key a
--                           stored total; a client can, and the territory is applied
--                           when the totals are read.
--
-- `fold_movement_totals()` moves every delta into both compact tables in ONE statement
-- (DELETE … RETURNING feeding two upserts), run every minute by the API. A reader sums
-- a compact table + the deltas not yet folded in a single statement, so it sees one
-- snapshot of both and the answer is exact at every instant.
--
-- The mapping of each source row onto (kind, direction, state) is the admin union's
-- (`TransactionsService.movementsCte`), stated once here for the triggers and pinned
-- against the live union by `test/movement-totals.spec.ts`. A DAY is a UTC day, and
-- the service compares date filters in UTC on both paths.
--
-- Backfilled in the same transaction that creates the triggers: CREATE TRIGGER locks
-- each table against writes until this commits, so no movement lands between the
-- two. On a fresh database there is nothing to backfill.

CREATE TABLE IF NOT EXISTS movement_daily_totals (
  day        date          NOT NULL,
  kind       text          NOT NULL,
  direction  text          NOT NULL,
  state      text          NOT NULL,
  currency   varchar(10)   NOT NULL,
  count      bigint        NOT NULL,
  total      numeric(28,8) NOT NULL,
  PRIMARY KEY (day, kind, direction, state, currency)
);
--> statement-breakpoint
-- No foreign key to users, deliberately: this is a cache of the movement tables, and
-- a client's movements are deleted before the client — their (−) deltas empty the
-- buckets, and the fold removes empty buckets.
CREATE TABLE IF NOT EXISTS movement_client_totals (
  user_id    integer       NOT NULL,
  kind       text          NOT NULL,
  direction  text          NOT NULL,
  state      text          NOT NULL,
  currency   varchar(10)   NOT NULL,
  count      bigint        NOT NULL,
  total      numeric(28,8) NOT NULL,
  PRIMARY KEY (user_id, kind, direction, state, currency)
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS movement_total_deltas (
  id         bigint        GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  user_id    integer       NOT NULL,
  day        date          NOT NULL,
  kind       text          NOT NULL,
  direction  text          NOT NULL,
  state      text          NOT NULL,
  currency   varchar(10)   NOT NULL,
  count      integer       NOT NULL,
  total      numeric(28,8) NOT NULL
);
--> statement-breakpoint
-- A bucket every movement has left (a withdrawal no longer pending) is removed by the
-- fold; these make finding the empty ones a probe rather than a scan.
CREATE INDEX IF NOT EXISTS movement_daily_totals_empty_idx
  ON movement_daily_totals (day) WHERE count = 0 AND total = 0;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS movement_client_totals_empty_idx
  ON movement_client_totals (user_id) WHERE count = 0 AND total = 0;
--> statement-breakpoint

-- ── One delta per side of a change ──────────────────────────────────────────────
CREATE OR REPLACE FUNCTION movement_delta(
  p_sign integer, p_user integer, p_at timestamptz, p_kind text, p_direction text,
  p_state text, p_currency text, p_amount numeric
) RETURNS void AS $$
  INSERT INTO movement_total_deltas (user_id, day, kind, direction, state, currency, count, total)
  VALUES (p_user, (p_at AT TIME ZONE 'UTC')::date, p_kind, p_direction, p_state, p_currency,
          p_sign, p_sign * p_amount);
$$ LANGUAGE sql;
--> statement-breakpoint

CREATE OR REPLACE FUNCTION transactions_movement_totals() RETURNS trigger AS $$
BEGIN
  IF TG_OP IN ('UPDATE', 'DELETE') THEN
    PERFORM movement_delta(-1, OLD.user_id, OLD.created_at, 'payment', OLD.direction::text,
                           OLD.state::text, OLD.currency, OLD.amount);
  END IF;
  IF TG_OP IN ('INSERT', 'UPDATE') THEN
    PERFORM movement_delta(1, NEW.user_id, NEW.created_at, 'payment', NEW.direction::text,
                           NEW.state::text, NEW.currency, NEW.amount);
  END IF;
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint
DROP TRIGGER IF EXISTS transactions_movement_totals_trg ON transactions;
--> statement-breakpoint
CREATE TRIGGER transactions_movement_totals_trg
  AFTER INSERT OR DELETE OR UPDATE OF user_id, created_at, direction, state, currency, amount
  ON transactions FOR EACH ROW EXECUTE FUNCTION transactions_movement_totals();
--> statement-breakpoint

-- Transfers: the union states them from the MAIN wallet's side, and folds their
-- three states onto the movement vocabulary.
CREATE OR REPLACE FUNCTION transfer_movement_direction(p_direction text) RETURNS text AS $$
  SELECT CASE WHEN p_direction = 'account_to_wallet' THEN 'deposit' ELSE 'withdrawal' END;
$$ LANGUAGE sql IMMUTABLE;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION transfer_movement_state(p_state text) RETURNS text AS $$
  SELECT CASE p_state WHEN 'settled' THEN 'success' WHEN 'failed' THEN 'failure' ELSE 'pending' END;
$$ LANGUAGE sql IMMUTABLE;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION transfers_movement_totals() RETURNS trigger AS $$
BEGIN
  IF TG_OP IN ('UPDATE', 'DELETE') THEN
    PERFORM movement_delta(-1, OLD.user_id, OLD.created_at, 'transfer',
                           transfer_movement_direction(OLD.direction::text),
                           transfer_movement_state(OLD.state::text), OLD.currency, OLD.amount);
  END IF;
  IF TG_OP IN ('INSERT', 'UPDATE') THEN
    PERFORM movement_delta(1, NEW.user_id, NEW.created_at, 'transfer',
                           transfer_movement_direction(NEW.direction::text),
                           transfer_movement_state(NEW.state::text), NEW.currency, NEW.amount);
  END IF;
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint
DROP TRIGGER IF EXISTS transfers_movement_totals_trg ON transfers;
--> statement-breakpoint
CREATE TRIGGER transfers_movement_totals_trg
  AFTER INSERT OR DELETE OR UPDATE OF user_id, created_at, direction, state, currency, amount
  ON transfers FOR EACH ROW EXECUTE FUNCTION transfers_movement_totals();
--> statement-breakpoint

-- A commission transfer is always a settled deposit into the partner's main wallet.
CREATE OR REPLACE FUNCTION ib_wallet_transfers_movement_totals() RETURNS trigger AS $$
BEGIN
  IF TG_OP IN ('UPDATE', 'DELETE') THEN
    PERFORM movement_delta(-1, OLD.user_id, OLD.created_at, 'commission_transfer', 'deposit',
                           'success', OLD.currency, OLD.amount);
  END IF;
  IF TG_OP IN ('INSERT', 'UPDATE') THEN
    PERFORM movement_delta(1, NEW.user_id, NEW.created_at, 'commission_transfer', 'deposit',
                           'success', NEW.currency, NEW.amount);
  END IF;
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint
DROP TRIGGER IF EXISTS ib_wallet_transfers_movement_totals_trg ON ib_wallet_transfers;
--> statement-breakpoint
CREATE TRIGGER ib_wallet_transfers_movement_totals_trg
  AFTER INSERT OR DELETE OR UPDATE OF user_id, created_at, currency, amount
  ON ib_wallet_transfers FOR EACH ROW EXECUTE FUNCTION ib_wallet_transfers_movement_totals();
--> statement-breakpoint

-- ── Folding: every pending delta into both compact tables, atomically ───────────
-- One statement: the rows it deletes are exactly the rows it adds, and a reader in
-- another transaction sees either all of them in the deltas or all of them in the
-- totals. One fold at a time: two API instances upserting the same buckets in
-- different orders could deadlock each other (harmless — the loser's DELETE rolls
-- back with it — but noisy), so each takes the same advisory lock first.
CREATE OR REPLACE FUNCTION fold_movement_totals() RETURNS integer AS $$
DECLARE folded integer;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtext('fold_movement_totals'));
  WITH moved AS (
    DELETE FROM movement_total_deltas
    RETURNING user_id, day, kind, direction, state, currency, count, total
  ), by_day AS (
    INSERT INTO movement_daily_totals AS m (day, kind, direction, state, currency, count, total)
    SELECT day, kind, direction, state, currency, sum(count), sum(total)
      FROM moved GROUP BY day, kind, direction, state, currency
    ON CONFLICT (day, kind, direction, state, currency) DO UPDATE
      SET count = m.count + excluded.count, total = m.total + excluded.total
  ), by_client AS (
    INSERT INTO movement_client_totals AS m (user_id, kind, direction, state, currency, count, total)
    SELECT user_id, kind, direction, state, currency, sum(count), sum(total)
      FROM moved GROUP BY user_id, kind, direction, state, currency
    ON CONFLICT (user_id, kind, direction, state, currency) DO UPDATE
      SET count = m.count + excluded.count, total = m.total + excluded.total
  )
  SELECT count(*)::int INTO folded FROM moved;
  DELETE FROM movement_daily_totals WHERE count = 0 AND total = 0;
  DELETE FROM movement_client_totals WHERE count = 0 AND total = 0;
  RETURN folded;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint

-- ── Backfill: what already exists, straight into the compact tables ─────────────
CREATE TEMP VIEW movement_backfill AS
  SELECT user_id, (created_at AT TIME ZONE 'UTC')::date AS day, 'payment' AS kind,
         direction::text AS direction, state::text AS state, currency, amount
    FROM transactions
  UNION ALL
  SELECT user_id, (created_at AT TIME ZONE 'UTC')::date, 'transfer',
         transfer_movement_direction(direction::text), transfer_movement_state(state::text),
         currency, amount
    FROM transfers
  UNION ALL
  SELECT user_id, (created_at AT TIME ZONE 'UTC')::date, 'commission_transfer', 'deposit',
         'success', currency, amount
    FROM ib_wallet_transfers;
--> statement-breakpoint
INSERT INTO movement_daily_totals (day, kind, direction, state, currency, count, total)
SELECT day, kind, direction, state, currency, count(*), sum(amount) FROM movement_backfill
 GROUP BY day, kind, direction, state, currency
ON CONFLICT (day, kind, direction, state, currency) DO NOTHING;
--> statement-breakpoint
INSERT INTO movement_client_totals (user_id, kind, direction, state, currency, count, total)
SELECT user_id, kind, direction, state, currency, count(*), sum(amount) FROM movement_backfill
 GROUP BY user_id, kind, direction, state, currency
ON CONFLICT (user_id, kind, direction, state, currency) DO NOTHING;
--> statement-breakpoint
DROP VIEW movement_backfill;
--> statement-breakpoint

-- ── Indexes: every tab and sort reads an index IN ORDER ─────────────────────────
-- The union exposes `state` as a transaction_state on every arm (the transfer arm
-- maps its three states with the CASE below), so a status tab or a sort by status is
-- an index range on each arm rather than a scan of the whole money history. The
-- CASE here must stay IDENTICAL to the transfer arm's in `movementsCte` — that is
-- how the planner matches the expression to the index.
CREATE INDEX IF NOT EXISTS transactions_state_created_at_id_idx
  ON transactions (state, created_at DESC, id DESC);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS transactions_currency_created_at_id_idx
  ON transactions (currency, created_at DESC, id DESC);
--> statement-breakpoint
-- "Needs attention" is rare by design; without this, its tab read every row to find none.
CREATE INDEX IF NOT EXISTS transactions_attention_created_at_id_idx
  ON transactions (created_at DESC, id DESC) WHERE rival_needs_attention;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS transfers_movement_state_id_idx
  ON transfers ((CASE state
                   WHEN 'settled' THEN 'success'::transaction_state
                   WHEN 'failed' THEN 'failure'::transaction_state
                   ELSE 'pending'::transaction_state
                 END) DESC, id DESC);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS transfers_movement_state_created_at_id_idx
  ON transfers ((CASE state
                   WHEN 'settled' THEN 'success'::transaction_state
                   WHEN 'failed' THEN 'failure'::transaction_state
                   ELSE 'pending'::transaction_state
                 END), created_at DESC, id DESC);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS transfers_currency_created_at_id_idx
  ON transfers (currency, created_at DESC, id DESC);
