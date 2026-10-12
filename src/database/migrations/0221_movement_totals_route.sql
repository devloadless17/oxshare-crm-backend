-- The kept money totals know which ROUTE a payment took (12 Oct 2026).
--
-- A desk (Deposits, Withdrawals) shows only what a person decides: a list of
-- (direction, provider, channel) routes. The kept totals (0165, 0218) had no
-- route, so a desk's tab counts were counted from the live rows on every page,
-- stopped at 10,000: 22 ms for a reader who sees everyone, 300 ms for a large
-- territory, and never an exact figure past the cap. With the route kept, a
-- desk's tabs are read from the totals like every other screen's: exact, and
-- the same cost at any size.
--
-- `route` is 'provider:channel' on a payment and '' on a transfer. It joins the
-- key of the deltas and of all three totals, so they are rebuilt here, once,
-- from the movements themselves.

ALTER TABLE movement_total_deltas ADD COLUMN IF NOT EXISTS route text NOT NULL DEFAULT '';
--> statement-breakpoint
ALTER TABLE movement_daily_totals ADD COLUMN IF NOT EXISTS route text NOT NULL DEFAULT '';
--> statement-breakpoint
ALTER TABLE movement_client_totals ADD COLUMN IF NOT EXISTS route text NOT NULL DEFAULT '';
--> statement-breakpoint
ALTER TABLE movement_tag_totals ADD COLUMN IF NOT EXISTS route text NOT NULL DEFAULT '';
--> statement-breakpoint
DROP FUNCTION IF EXISTS movement_delta(integer, integer, timestamptz, text, text, text, text, numeric);
--> statement-breakpoint
CREATE OR REPLACE FUNCTION movement_delta(
  p_sign integer, p_user integer, p_at timestamptz, p_kind text, p_direction text,
  p_state text, p_currency text, p_amount numeric, p_route text DEFAULT ''
) RETURNS void AS $$
  INSERT INTO movement_total_deltas
    (user_id, day, kind, direction, state, currency, route, count, total)
  VALUES (p_user, (p_at AT TIME ZONE 'UTC')::date, p_kind, p_direction, p_state, p_currency,
          p_route, p_sign, p_sign * p_amount);
$$ LANGUAGE sql;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION movement_route(p_provider text, p_channel text) RETURNS text AS $$
  SELECT coalesce(p_provider, '') || ':' || coalesce(p_channel, '');
$$ LANGUAGE sql IMMUTABLE;
--> statement-breakpoint
-- A transaction's route is fixed at filing (0168's trigger), so the trigger's
-- own column list needs no addition.
CREATE OR REPLACE FUNCTION transactions_movement_totals() RETURNS trigger AS $$
BEGIN
  IF TG_OP IN ('UPDATE', 'DELETE') THEN
    PERFORM movement_delta(-1, OLD.user_id, OLD.created_at, 'payment', OLD.direction::text,
                           OLD.state::text, OLD.currency, OLD.amount,
                           movement_route(OLD.provider_code, OLD.channel_code));
  END IF;
  IF TG_OP IN ('INSERT', 'UPDATE') THEN
    PERFORM movement_delta(1, NEW.user_id, NEW.created_at, 'payment', NEW.direction::text,
                           NEW.state::text, NEW.currency, NEW.amount,
                           movement_route(NEW.provider_code, NEW.channel_code));
  END IF;
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION fold_movement_totals() RETURNS integer AS $$
DECLARE folded integer;
DECLARE moved_members integer;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtext('fold_movement_totals'));
  -- 1. The movement deltas: to the day, the client, and the client's folded tags.
  WITH moved AS (
    DELETE FROM movement_total_deltas
    RETURNING user_id, day, kind, direction, state, currency, route, count, total
  ), by_day AS (
    INSERT INTO movement_daily_totals AS m (day, kind, direction, state, currency, route, count, total)
    SELECT day, kind, direction, state, currency, route, sum(count), sum(total)
      FROM moved GROUP BY day, kind, direction, state, currency, route
    ON CONFLICT (day, kind, direction, state, currency, route) DO UPDATE
      SET count = m.count + excluded.count, total = m.total + excluded.total
  ), by_client AS (
    INSERT INTO movement_client_totals AS m (user_id, kind, direction, state, currency, route, count, total)
    SELECT user_id, kind, direction, state, currency, route, sum(count), sum(total)
      FROM moved GROUP BY user_id, kind, direction, state, currency, route
    ON CONFLICT (user_id, kind, direction, state, currency, route) DO UPDATE
      SET count = m.count + excluded.count, total = m.total + excluded.total
  ), by_tag AS (
    INSERT INTO movement_tag_totals AS m (tag_id, kind, direction, state, currency, route, count, total)
    SELECT g.tag_id, d.kind, d.direction, d.state, d.currency, d.route, sum(d.count), sum(d.total)
      FROM moved d JOIN movement_tag_members g ON g.user_id = d.user_id
     GROUP BY g.tag_id, d.kind, d.direction, d.state, d.currency, d.route
    ON CONFLICT (tag_id, kind, direction, state, currency, route) DO UPDATE
      SET count = m.count + excluded.count, total = m.total + excluded.total
  )
  SELECT count(*)::int INTO folded FROM moved;

  -- 2. Who joined or left a tag: their whole client total follows them. A new
  --    statement, so it reads the client totals step 1 just wrote.
  WITH events AS (
    DELETE FROM movement_tag_member_events RETURNING user_id, tag_id, sign
  ), net AS (
    SELECT user_id, tag_id, sum(sign)::int AS sign
      FROM events GROUP BY user_id, tag_id HAVING sum(sign) <> 0
  ), applied AS (
    INSERT INTO movement_tag_totals AS m (tag_id, kind, direction, state, currency, route, count, total)
    SELECT n.tag_id, c.kind, c.direction, c.state, c.currency, c.route,
           sum(n.sign * c.count), sum(n.sign * c.total)
      FROM net n JOIN movement_client_totals c ON c.user_id = n.user_id
     GROUP BY n.tag_id, c.kind, c.direction, c.state, c.currency, c.route
    ON CONFLICT (tag_id, kind, direction, state, currency, route) DO UPDATE
      SET count = m.count + excluded.count, total = m.total + excluded.total
  ), joined AS (
    INSERT INTO movement_tag_members (user_id, tag_id)
    SELECT user_id, tag_id FROM net WHERE sign > 0
    ON CONFLICT DO NOTHING
  ), departed AS (
    DELETE FROM movement_tag_members g USING net n
     WHERE n.sign < 0 AND g.user_id = n.user_id AND g.tag_id = n.tag_id
  ), counted AS (
    INSERT INTO client_tag_member_counts AS m (tag_id, members)
    SELECT tag_id, sum(sign) FROM net GROUP BY tag_id
    ON CONFLICT (tag_id) DO UPDATE SET members = m.members + excluded.members
  )
  SELECT count(*)::int INTO moved_members FROM events;

  DELETE FROM movement_daily_totals WHERE count = 0 AND total = 0;
  DELETE FROM movement_client_totals WHERE count = 0 AND total = 0;
  DELETE FROM movement_tag_totals WHERE count = 0 AND total = 0;
  DELETE FROM client_tag_member_counts WHERE members = 0;
  RETURN folded;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint
-- The keys, then every total rebuilt from the movements, in ONE statement with
-- folds and writes to the movements held for its length. Re-runnable.
DO $$
BEGIN
  PERFORM pg_advisory_xact_lock(hashtext('fold_movement_totals'));
  LOCK TABLE transactions, transfers, ib_wallet_transfers, client_tag_assignments
    IN SHARE ROW EXCLUSIVE MODE;

  ALTER TABLE movement_daily_totals DROP CONSTRAINT IF EXISTS movement_daily_totals_pkey;
  ALTER TABLE movement_client_totals DROP CONSTRAINT IF EXISTS movement_client_totals_pkey;
  ALTER TABLE movement_tag_totals DROP CONSTRAINT IF EXISTS movement_tag_totals_pkey;
  DELETE FROM movement_total_deltas;
  DELETE FROM movement_daily_totals;
  DELETE FROM movement_client_totals;
  DELETE FROM movement_tag_totals;
  ALTER TABLE movement_daily_totals
    ADD CONSTRAINT movement_daily_totals_pkey PRIMARY KEY (day, kind, direction, state, currency, route);
  ALTER TABLE movement_client_totals
    ADD CONSTRAINT movement_client_totals_pkey PRIMARY KEY (user_id, kind, direction, state, currency, route);
  ALTER TABLE movement_tag_totals
    ADD CONSTRAINT movement_tag_totals_pkey PRIMARY KEY (tag_id, kind, direction, state, currency, route);

  CREATE TEMP TABLE movement_rebuild AS
    SELECT user_id, (created_at AT TIME ZONE 'UTC')::date AS day, 'payment'::text AS kind,
           direction::text AS direction, state::text AS state, currency,
           movement_route(provider_code, channel_code) AS route, amount
      FROM transactions
    UNION ALL
    SELECT user_id, (created_at AT TIME ZONE 'UTC')::date, 'transfer',
           transfer_movement_direction(direction::text), transfer_movement_state(state::text),
           currency, '', amount
      FROM transfers
    UNION ALL
    SELECT user_id, (created_at AT TIME ZONE 'UTC')::date, 'commission_transfer', 'deposit',
           'success', currency, '', amount
      FROM ib_wallet_transfers;
  INSERT INTO movement_daily_totals (day, kind, direction, state, currency, route, count, total)
  SELECT day, kind, direction, state, currency, route, count(*), sum(amount)
    FROM movement_rebuild GROUP BY day, kind, direction, state, currency, route;
  INSERT INTO movement_client_totals (user_id, kind, direction, state, currency, route, count, total)
  SELECT user_id, kind, direction, state, currency, route, count(*), sum(amount)
    FROM movement_rebuild GROUP BY user_id, kind, direction, state, currency, route;
  INSERT INTO movement_tag_totals (tag_id, kind, direction, state, currency, route, count, total)
  SELECT g.tag_id, c.kind, c.direction, c.state, c.currency, c.route, sum(c.count), sum(c.total)
    FROM movement_tag_members g JOIN movement_client_totals c ON c.user_id = g.user_id
   GROUP BY g.tag_id, c.kind, c.direction, c.state, c.currency, c.route;
  DROP TABLE movement_rebuild;
END $$;
