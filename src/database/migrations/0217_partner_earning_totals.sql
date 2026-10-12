-- A partner's earnings, kept as running totals (11 Oct 2026).
--
-- The Partners list and a partner's page showed "confirmed" and "pending" by
-- summing every accrual the partner ever earned, on every page view: 90 ms for a
-- partner with 500,000 accruals, growing with their success. Now the figure is
-- kept, in 0165's pattern:
--
--   ib_partner_earning_deltas   APPEND-ONLY. Every insert, delete, or change of
--                               an accrual's status/amount writes what it adds
--                               and removes. Pure inserts, so the commission
--                               jobs never wait on one another for a shared row.
--   ib_partner_earning_totals   one row per (partner, currency, status).
--
-- A read sums both for the partners on the page in ONE statement, so it is exact
-- at every instant, folded or not. `fold_partner_earnings()` moves the deltas
-- into the totals in one statement, under an advisory lock; the scheduler that
-- folds the movement totals calls it every minute.
--
-- Only rows paid to the PARTNER count (paid_to_client = false): the same rule
-- IbStore.earningsByPartner states. Nothing here moves or decides money; the
-- wallets and the ledger are untouched.

CREATE TABLE IF NOT EXISTS ib_partner_earning_totals (
  ib_user_id integer NOT NULL,
  currency   varchar(10) NOT NULL,
  status     ib_accrual_status NOT NULL,
  total      numeric(28,8) NOT NULL DEFAULT 0,
  PRIMARY KEY (ib_user_id, currency, status)
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS ib_partner_earning_deltas (
  id         bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  ib_user_id integer NOT NULL,
  currency   varchar(10) NOT NULL,
  status     ib_accrual_status NOT NULL,
  total      numeric(28,8) NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS ib_partner_earning_deltas_partner_idx
  ON ib_partner_earning_deltas (ib_user_id);
--> statement-breakpoint
CREATE OR REPLACE FUNCTION ib_accruals_earning_delta() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'UPDATE'
     AND NEW.ib_user_id = OLD.ib_user_id AND NEW.currency = OLD.currency
     AND NEW.status = OLD.status AND NEW.amount = OLD.amount
     AND NEW.paid_to_client = OLD.paid_to_client THEN
    RETURN NULL;
  END IF;
  IF TG_OP <> 'INSERT' AND NOT OLD.paid_to_client THEN
    INSERT INTO ib_partner_earning_deltas (ib_user_id, currency, status, total)
    VALUES (OLD.ib_user_id, OLD.currency, OLD.status, -OLD.amount);
  END IF;
  IF TG_OP <> 'DELETE' AND NOT NEW.paid_to_client THEN
    INSERT INTO ib_partner_earning_deltas (ib_user_id, currency, status, total)
    VALUES (NEW.ib_user_id, NEW.currency, NEW.status, NEW.amount);
  END IF;
  RETURN NULL;
END $$ LANGUAGE plpgsql;
--> statement-breakpoint
-- TRUNCATE fires no row trigger, so it empties the totals with the accruals.
CREATE OR REPLACE FUNCTION ib_accruals_earning_truncate() RETURNS trigger AS $$
BEGIN
  TRUNCATE ib_partner_earning_totals, ib_partner_earning_deltas;
  RETURN NULL;
END $$ LANGUAGE plpgsql;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION fold_partner_earnings() RETURNS integer AS $$
DECLARE folded integer;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtext('fold_partner_earnings'));
  WITH moved AS (
    DELETE FROM ib_partner_earning_deltas
    RETURNING ib_user_id, currency, status, total
  ), kept AS (
    INSERT INTO ib_partner_earning_totals AS t (ib_user_id, currency, status, total)
    SELECT ib_user_id, currency, status, sum(total)
      FROM moved GROUP BY ib_user_id, currency, status
    ON CONFLICT (ib_user_id, currency, status) DO UPDATE
      SET total = t.total + excluded.total
  )
  SELECT count(*)::int INTO folded FROM moved;
  RETURN folded;
END $$ LANGUAGE plpgsql;
--> statement-breakpoint
-- The triggers and the starting figures in ONE statement, under a lock that
-- holds accrual writes for its length: an accrual written between the two would
-- otherwise be counted twice, or not at all. Re-runnable.
DO $$
BEGIN
  LOCK TABLE ib_accruals IN SHARE ROW EXCLUSIVE MODE;
  DROP TRIGGER IF EXISTS ib_accruals_earning_delta_trg ON ib_accruals;
  DROP TRIGGER IF EXISTS ib_accruals_earning_truncate_trg ON ib_accruals;
  DELETE FROM ib_partner_earning_deltas;
  DELETE FROM ib_partner_earning_totals;
  INSERT INTO ib_partner_earning_totals (ib_user_id, currency, status, total)
  SELECT ib_user_id, currency, status, sum(amount)
    FROM ib_accruals WHERE NOT paid_to_client
   GROUP BY ib_user_id, currency, status;
  CREATE TRIGGER ib_accruals_earning_delta_trg
    AFTER INSERT OR UPDATE OR DELETE ON ib_accruals
    FOR EACH ROW EXECUTE FUNCTION ib_accruals_earning_delta();
  CREATE TRIGGER ib_accruals_earning_truncate_trg
    AFTER TRUNCATE ON ib_accruals
    FOR EACH STATEMENT EXECUTE FUNCTION ib_accruals_earning_truncate();
END $$;
