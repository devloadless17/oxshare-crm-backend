-- A territory's money totals, kept per TAG (12 Oct 2026).
--
-- An administrator who holds ONE tag (a salesperson's book, a desk) had their
-- tabs and summary added up from every client carrying it, on every page: 8 ms
-- for 2,000 clients, 190 ms for 200,000, growing with the book. Now the figure
-- is kept, and costs the same for any book.
--
--   movement_tag_totals         per tag: the sum of its FOLDED members' client totals.
--   movement_tag_members        who those folded members are.
--   movement_tag_member_events  APPEND-ONLY: a client joined (+1) or left (-1) a
--                               tag. Written by a trigger on client_tag_assignments
--                               as a plain insert, so tagging never waits on a lock.
--
-- The invariant: tag_totals(T) = sum of movement_client_totals over
-- movement_tag_members(T). Only fold_movement_totals() changes either side, in
-- one transaction under its advisory lock:
--   1. movement deltas go to the day, the client, and every tag the client is a
--      FOLDED member of;
--   2. membership events then add or remove that client's whole client total,
--      and the member list follows.
--
-- A read is exact at every instant, folded or not, in one statement:
--   tag_totals(T)
--   + the client totals of members who joined or left since the last fold
--   + the movement deltas of everyone carrying the tag NOW.
--
-- Several tags cannot be added together (a client carrying two would count
-- twice), so a territory of more than one tag keeps reading per client.

CREATE TABLE IF NOT EXISTS movement_tag_totals (
  tag_id     uuid          NOT NULL,
  kind       text          NOT NULL,
  direction  text          NOT NULL,
  state      text          NOT NULL,
  currency   varchar(10)   NOT NULL,
  count      bigint        NOT NULL,
  total      numeric(28,8) NOT NULL,
  PRIMARY KEY (tag_id, kind, direction, state, currency)
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS movement_tag_members (
  user_id integer NOT NULL,
  tag_id  uuid    NOT NULL,
  PRIMARY KEY (user_id, tag_id)
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS movement_tag_member_events (
  id      bigint   GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  user_id integer  NOT NULL,
  tag_id  uuid     NOT NULL,
  sign    smallint NOT NULL CHECK (sign IN (1, -1))
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS movement_tag_member_events_tag_idx
  ON movement_tag_member_events (tag_id);
--> statement-breakpoint
CREATE OR REPLACE FUNCTION client_tag_assignments_member_event() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'UPDATE' AND NEW.user_id = OLD.user_id AND NEW.tag_id = OLD.tag_id THEN
    RETURN NULL;
  END IF;
  IF TG_OP <> 'INSERT' THEN
    INSERT INTO movement_tag_member_events (user_id, tag_id, sign)
    VALUES (OLD.user_id, OLD.tag_id, -1);
  END IF;
  IF TG_OP <> 'DELETE' THEN
    INSERT INTO movement_tag_member_events (user_id, tag_id, sign)
    VALUES (NEW.user_id, NEW.tag_id, 1);
  END IF;
  RETURN NULL;
END $$ LANGUAGE plpgsql;
--> statement-breakpoint
-- TRUNCATE fires no row trigger: nobody carries a tag any more.
CREATE OR REPLACE FUNCTION client_tag_assignments_member_truncate() RETURNS trigger AS $$
BEGIN
  TRUNCATE movement_tag_totals, movement_tag_members, movement_tag_member_events;
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
  )
  SELECT count(*)::int INTO moved_members FROM events;

  DELETE FROM movement_daily_totals WHERE count = 0 AND total = 0;
  DELETE FROM movement_client_totals WHERE count = 0 AND total = 0;
  DELETE FROM movement_tag_totals WHERE count = 0 AND total = 0;
  RETURN folded;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint
-- The starting figures and the triggers in ONE statement, with folds and tag
-- changes held for its length, so nothing is counted twice or missed.
-- Re-runnable.
DO $$
BEGIN
  PERFORM pg_advisory_xact_lock(hashtext('fold_movement_totals'));
  LOCK TABLE client_tag_assignments IN SHARE ROW EXCLUSIVE MODE;
  DROP TRIGGER IF EXISTS client_tag_assignments_member_event_trg ON client_tag_assignments;
  DROP TRIGGER IF EXISTS client_tag_assignments_member_truncate_trg ON client_tag_assignments;
  DELETE FROM movement_tag_member_events;
  DELETE FROM movement_tag_members;
  DELETE FROM movement_tag_totals;
  INSERT INTO movement_tag_members (user_id, tag_id)
  SELECT user_id, tag_id FROM client_tag_assignments;
  INSERT INTO movement_tag_totals (tag_id, kind, direction, state, currency, count, total)
  SELECT g.tag_id, c.kind, c.direction, c.state, c.currency, sum(c.count), sum(c.total)
    FROM movement_tag_members g JOIN movement_client_totals c ON c.user_id = g.user_id
   GROUP BY g.tag_id, c.kind, c.direction, c.state, c.currency;
  CREATE TRIGGER client_tag_assignments_member_event_trg
    AFTER INSERT OR UPDATE OR DELETE ON client_tag_assignments
    FOR EACH ROW EXECUTE FUNCTION client_tag_assignments_member_event();
  CREATE TRIGGER client_tag_assignments_member_truncate_trg
    AFTER TRUNCATE ON client_tag_assignments
    FOR EACH STATEMENT EXECUTE FUNCTION client_tag_assignments_member_truncate();
END $$;
