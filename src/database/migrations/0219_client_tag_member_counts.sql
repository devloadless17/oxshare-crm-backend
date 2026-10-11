-- How many clients carry each tag, kept (12 Oct 2026).
--
-- The tag list is read on the Clients page, a client's page, Referrals, Admin
-- users and Tags, and it counted every tag assignment on the platform each
-- time: 51 ms at 270,000 assignments for a reader who sees everyone, 517 ms for
-- a territory, growing with every client tagged. Now each tag's size is kept:
--
--   client_tag_member_counts(tag_id, members) = the tag's FOLDED members
--   (movement_tag_members, 0218), moved by the same fold, from the same events.
--
-- A read adds the membership events not yet folded, so it is exact at every
-- instant and costs the number of TAGS, not of clients.

CREATE TABLE IF NOT EXISTS client_tag_member_counts (
  tag_id  uuid   PRIMARY KEY,
  members bigint NOT NULL
);
--> statement-breakpoint
CREATE OR REPLACE FUNCTION client_tag_assignments_member_truncate() RETURNS trigger AS $$
BEGIN
  TRUNCATE movement_tag_totals, movement_tag_members, movement_tag_member_events,
           client_tag_member_counts;
  RETURN NULL;
END $$ LANGUAGE plpgsql;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION fold_movement_totals() RETURNS integer AS $$
DECLARE folded integer;
DECLARE moved_members integer;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtext('fold_movement_totals'));
  -- 1. The movement deltas: to the day, the client, and the client's folded tags.
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
  ), by_tag AS (
    INSERT INTO movement_tag_totals AS m (tag_id, kind, direction, state, currency, count, total)
    SELECT g.tag_id, d.kind, d.direction, d.state, d.currency, sum(d.count), sum(d.total)
      FROM moved d JOIN movement_tag_members g ON g.user_id = d.user_id
     GROUP BY g.tag_id, d.kind, d.direction, d.state, d.currency
    ON CONFLICT (tag_id, kind, direction, state, currency) DO UPDATE
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
    INSERT INTO movement_tag_totals AS m (tag_id, kind, direction, state, currency, count, total)
    SELECT n.tag_id, c.kind, c.direction, c.state, c.currency,
           sum(n.sign * c.count), sum(n.sign * c.total)
      FROM net n JOIN movement_client_totals c ON c.user_id = n.user_id
     GROUP BY n.tag_id, c.kind, c.direction, c.state, c.currency
    ON CONFLICT (tag_id, kind, direction, state, currency) DO UPDATE
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
-- The starting counts, with folds held: exactly the folded members. Re-runnable.
DO $$
BEGIN
  PERFORM pg_advisory_xact_lock(hashtext('fold_movement_totals'));
  DELETE FROM client_tag_member_counts;
  INSERT INTO client_tag_member_counts (tag_id, members)
  SELECT tag_id, count(*) FROM movement_tag_members GROUP BY tag_id;
END $$;
--> statement-breakpoint
-- Legacy rebates paid to a client (before 0209), found by their client: the
-- commissions list asks a territory whether it holds any, and without this the
-- question read every accrual. A handful of rows, or none.
CREATE INDEX IF NOT EXISTS ib_accruals_paid_to_client_idx
  ON ib_accruals (client_user_id) WHERE paid_to_client;
