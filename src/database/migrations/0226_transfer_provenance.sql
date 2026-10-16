-- 0226 — a transfer records WHERE ITS MONEY CAME FROM, written when the money moves (16 Oct 2026).
--
-- The buyer's admins asked, for accounting, which account every transfer moved money from and to,
-- and where the money on a trading account came from. The data did not exist: five code paths
-- create a transfer, and nothing on the row said which one. A deposit the client sent straight to
-- a trading account chained a transfer with no link to the deposit, so it read exactly like the
-- client moving money themselves; the desk member and the reason behind a desk transfer lived only
-- in audit_log (and the trading.* audit rows are fire-and-forget).
--
--   origin                 client | deposit | desk_credit | desk_wallet | desk_debit
--                          ('commission' exists in the enum for the money union's commission arm
--                          only, and is refused on this table)
--   source_transaction_id  the deposit (or the desk's credit) whose money this transfer moves.
--                          UNIQUE: one deposit funds at most one transfer — a database rule now,
--                          not a code comment.
--   requested_by_admin_id  the desk member, for desk_*. No FK: transactions.reviewed_by's reasoning.
--   desk_reason(_ar)       why, as the desk typed it.
--
-- A BEFORE INSERT trigger fills origin for a writer that states none (the previous build after a
-- rollback, raw SQL), from the request_ref it writes, and REFUSES a source that is not this client's
-- settled deposit of the same currency and amount. Provenance is frozen once written.
--
-- Hand-written (see 0040's header). Re-runnable: every step is guarded or idempotent. Run at a
-- quiet hour: it takes ACCESS EXCLUSIVE on transfers briefly.

SET lock_timeout = '10s';
--> statement-breakpoint
DO $$ BEGIN
  CREATE TYPE transfer_origin AS ENUM
    ('client', 'deposit', 'desk_credit', 'desk_wallet', 'desk_debit', 'commission');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
--> statement-breakpoint
-- A constant default adds the column without rewriting the table; dropped after the backfill.
ALTER TABLE transfers ADD COLUMN IF NOT EXISTS origin transfer_origin NOT NULL DEFAULT 'client';
--> statement-breakpoint
ALTER TABLE transfers ADD COLUMN IF NOT EXISTS source_transaction_id uuid
  REFERENCES transactions(id) ON DELETE RESTRICT;
--> statement-breakpoint
ALTER TABLE transfers ADD COLUMN IF NOT EXISTS requested_by_admin_id uuid;
--> statement-breakpoint
ALTER TABLE transfers ADD COLUMN IF NOT EXISTS desk_reason text;
--> statement-breakpoint
ALTER TABLE transfers ADD COLUMN IF NOT EXISTS desk_reason_ar text;
--> statement-breakpoint
-- Re-runnable: the guards come off while the backfill writes, and go back on below.
DROP TRIGGER IF EXISTS transfers_provenance_immutable ON transfers;
--> statement-breakpoint
DROP TRIGGER IF EXISTS transfers_provenance_fill ON transfers;
--> statement-breakpoint
ALTER TABLE transfers
  DROP CONSTRAINT IF EXISTS transfers_origin_ck,
  DROP CONSTRAINT IF EXISTS transfers_origin_direction_ck,
  DROP CONSTRAINT IF EXISTS transfers_origin_source_ck,
  DROP CONSTRAINT IF EXISTS transfers_origin_admin_ck;
--> statement-breakpoint
ALTER TABLE transfers ALTER COLUMN origin SET DEFAULT 'client';
--> statement-breakpoint

-- 1. Desk origins from the ref the desk writes (every production desk transfer: 0184 predates go-live).
UPDATE transfers
   SET origin = (CASE
       WHEN request_ref LIKE 'admin-fund:%' THEN 'desk_credit'
       WHEN request_ref LIKE 'admin-move:%' THEN 'desk_wallet'
       ELSE 'desk_debit' END)::transfer_origin
 WHERE origin = 'client'
   AND (request_ref LIKE 'admin-fund:%' OR request_ref LIKE 'admin-move:%'
        OR request_ref LIKE 'admin-debit:%');
--> statement-breakpoint
-- 2. Ref-less desk transfers (before 0184), from the audit row that names them.
UPDATE transfers t
   SET origin = a.o::transfer_origin
  FROM (
    SELECT DISTINCT ON (details->>'transferId')
           (details->>'transferId')::uuid AS tid,
           CASE WHEN action = 'trading.withdraw' THEN 'desk_debit'
                WHEN details->>'source' = 'wallet' THEN 'desk_wallet'
                ELSE 'desk_credit' END AS o
      FROM audit_log
     WHERE action IN ('trading.deposit', 'trading.withdraw')
       AND details->>'transferId' ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
     ORDER BY details->>'transferId', created_at
  ) a
 WHERE t.id = a.tid AND t.request_ref IS NULL AND t.origin = 'client';
--> statement-breakpoint
-- 3. The credit behind each desk credit: the same idempotency key, client, currency and amount.
UPDATE transfers t
   SET source_transaction_id = c.id
  FROM transactions c
 WHERE t.origin = 'desk_credit' AND t.source_transaction_id IS NULL
   AND t.request_ref LIKE 'admin-fund:%'
   AND c.provider = 'manual_admin' AND c.provider_ref = substr(t.request_ref, 12)
   AND c.user_id = t.user_id AND c.currency = t.currency AND c.amount = t.amount
   AND c.direction = 'deposit' AND c.state = 'success'
   AND NOT EXISTS (SELECT 1 FROM transfers x WHERE x.source_transaction_id = c.id);
--> statement-breakpoint
-- 3b. A ref-less desk credit: its audit row names the credit (details.transactionId).
UPDATE transfers t
   SET source_transaction_id = c.id
  FROM audit_log a, transactions c
 WHERE t.origin = 'desk_credit' AND t.source_transaction_id IS NULL AND t.request_ref IS NULL
   AND a.action = 'trading.deposit' AND a.details->>'transferId' = t.id::text
   AND a.details->>'transactionId' ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
   AND c.id = (a.details->>'transactionId')::uuid
   AND c.provider = 'manual_admin' AND c.user_id = t.user_id AND c.currency = t.currency
   AND c.amount = t.amount AND c.direction = 'deposit' AND c.state = 'success'
   AND NOT EXISTS (SELECT 1 FROM transfers x WHERE x.source_transaction_id = c.id);
--> statement-breakpoint
-- 4. Deposit chains. A deposit aimed at an account is settled, THEN its transfer is created; the two
--    clocks (app vs database) may skew, so the window opens 2 minutes early. The closest match is
--    chosen from BOTH sides, so each deposit claims one transfer and each transfer one deposit;
--    anything left ambiguous stays 'client'.
WITH cand AS (
  SELECT t.id AS tid, d.id AS did,
         abs(extract(epoch FROM t.created_at - d.settled_at)) AS gap
    FROM transfers t
    JOIN transactions d
      ON d.user_id = t.user_id
     AND d.destination_trading_account_id = t.trading_account_id
     AND d.currency = t.currency AND d.amount = t.amount
     AND d.direction = 'deposit' AND d.state = 'success'
     AND d.provider <> 'manual_admin'
     AND d.settled_at IS NOT NULL
     AND t.created_at BETWEEN d.settled_at - interval '2 minutes'
                          AND d.settled_at + interval '10 minutes'
   WHERE t.origin = 'client' AND t.request_ref IS NULL AND t.source_transaction_id IS NULL
     AND t.direction = 'wallet_to_account'
     AND NOT EXISTS (SELECT 1 FROM transfers x WHERE x.source_transaction_id = d.id)
), ranked AS (
  SELECT tid, did,
         row_number() OVER (PARTITION BY tid ORDER BY gap, did) AS by_transfer,
         row_number() OVER (PARTITION BY did ORDER BY gap, tid) AS by_deposit
    FROM cand
)
UPDATE transfers t
   SET origin = 'deposit', source_transaction_id = r.did
  FROM ranked r
 WHERE t.id = r.tid AND r.by_transfer = 1 AND r.by_deposit = 1;
--> statement-breakpoint
-- 5a. Who and why, for a desk credit: the wallet.credit row written INSIDE the credit's transaction.
UPDATE transfers t
   SET requested_by_admin_id = a.actor_id::uuid,
       desk_reason = COALESCE(t.desk_reason, a.details->>'reason'),
       desk_reason_ar = COALESCE(t.desk_reason_ar, a.details->>'reasonAr')
  FROM (
    SELECT DISTINCT ON (subject_id) subject_id, actor_id, details
      FROM audit_log
     WHERE action = 'wallet.credit' AND subject_type = 'transaction' AND actor_kind = 'admin'
       AND actor_id ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
     ORDER BY subject_id, created_at
  ) a
 WHERE t.origin = 'desk_credit' AND t.requested_by_admin_id IS NULL
   AND a.subject_id = t.source_transaction_id::text;
--> statement-breakpoint
-- 5b. Every desk transfer still without one: the trading.* row that names it.
UPDATE transfers t
   SET requested_by_admin_id = a.actor_id::uuid,
       desk_reason = COALESCE(t.desk_reason, a.details->>'reason'),
       desk_reason_ar = COALESCE(t.desk_reason_ar, a.details->>'reasonAr')
  FROM (
    SELECT DISTINCT ON (details->>'transferId') details->>'transferId' AS tid, actor_id, details
      FROM audit_log
     WHERE action IN ('trading.deposit', 'trading.withdraw') AND actor_kind = 'admin'
       AND actor_id ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
       AND details ? 'transferId'
     ORDER BY details->>'transferId', created_at
  ) a
 WHERE t.origin IN ('desk_credit', 'desk_wallet', 'desk_debit')
   AND t.requested_by_admin_id IS NULL
   AND a.tid = t.id::text;
--> statement-breakpoint
-- 6. Refuse to finish with a readable message rather than a bare CHECK failure.
DO $$ DECLARE bad text; BEGIN
  SELECT string_agg(id::text, ', ') INTO bad FROM transfers
   WHERE origin IN ('deposit', 'desk_credit') AND source_transaction_id IS NULL;
  IF bad IS NOT NULL THEN
    RAISE EXCEPTION '0226: no funding transaction found for transfer(s) %', bad;
  END IF;
END $$;
--> statement-breakpoint

ALTER TABLE transfers
  ADD CONSTRAINT transfers_origin_ck CHECK (origin <> 'commission'),
  ADD CONSTRAINT transfers_origin_direction_ck CHECK (
    origin = 'client'
    OR (origin = 'desk_debit' AND direction = 'account_to_wallet')
    OR (origin IN ('deposit', 'desk_credit', 'desk_wallet') AND direction = 'wallet_to_account')
  ),
  ADD CONSTRAINT transfers_origin_source_ck CHECK (
    (origin IN ('deposit', 'desk_credit')) = (source_transaction_id IS NOT NULL)
  ),
  ADD CONSTRAINT transfers_origin_admin_ck CHECK (
    (requested_by_admin_id IS NULL AND desk_reason IS NULL AND desk_reason_ar IS NULL)
    OR origin IN ('desk_credit', 'desk_wallet', 'desk_debit')
  );
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS transfers_source_transaction_uq
  ON transfers (source_transaction_id) WHERE source_transaction_id IS NOT NULL;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS transfers_origin_created_at_id_idx
  ON transfers (origin, created_at DESC, id DESC) WHERE origin <> 'client';
--> statement-breakpoint
-- One account's transfers, newest first (the Transfers page's account filter). It also serves the
-- trading_accounts foreign-key check, so the single-column index it replaces goes after it exists.
CREATE INDEX IF NOT EXISTS transfers_trading_account_created_at_id_idx
  ON transfers (trading_account_id, created_at DESC, id DESC);
--> statement-breakpoint
DROP INDEX IF EXISTS transfers_trading_account_idx;
--> statement-breakpoint
-- From here an omitted origin is NULL, for the trigger below to work out.
ALTER TABLE transfers ALTER COLUMN origin DROP DEFAULT;
--> statement-breakpoint

CREATE OR REPLACE FUNCTION transfers_provenance_fill() RETURNS trigger AS $$
DECLARE s record;
BEGIN
  IF NEW.origin IS NULL THEN
    -- A writer that states no origin (the previous build, raw SQL): read it off the ref it writes.
    NEW.origin := (CASE
      WHEN NEW.request_ref LIKE 'admin-fund:%' THEN 'desk_credit'
      WHEN NEW.request_ref LIKE 'admin-move:%' THEN 'desk_wallet'
      WHEN NEW.request_ref LIKE 'admin-debit:%' THEN 'desk_debit'
      WHEN NEW.request_ref LIKE 'deposit:%' THEN 'deposit'
      ELSE 'client' END)::transfer_origin;
    IF NEW.source_transaction_id IS NULL AND NEW.origin = 'desk_credit' THEN
      NEW.source_transaction_id := (SELECT id FROM transactions
        WHERE provider = 'manual_admin' AND provider_ref = substr(NEW.request_ref, 12));
    ELSIF NEW.source_transaction_id IS NULL AND NEW.origin = 'deposit'
      AND substr(NEW.request_ref, 9) ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN
      NEW.source_transaction_id := substr(NEW.request_ref, 9)::uuid;
    END IF;
  END IF;
  IF NEW.source_transaction_id IS NOT NULL THEN
    -- Whoever wrote it: the source must be THIS movement's money. Otherwise a wrong link would print
    -- another client's deposit on this row, past every territory check.
    SELECT user_id, direction, state, currency, amount, provider, destination_trading_account_id
      INTO s FROM transactions WHERE id = NEW.source_transaction_id;
    IF NOT FOUND
       OR s.user_id <> NEW.user_id
       OR s.direction <> 'deposit'
       OR s.state <> 'success'
       OR s.currency <> NEW.currency
       OR s.amount <> NEW.amount
       OR (s.provider = 'manual_admin') <> (NEW.origin = 'desk_credit')
       OR (NEW.origin = 'deposit'
           AND s.destination_trading_account_id IS DISTINCT FROM NEW.trading_account_id) THEN
      RAISE EXCEPTION 'transfer source % is not this client''s settled deposit of the same amount',
        NEW.source_transaction_id
        USING ERRCODE = '23514', CONSTRAINT = 'transfers_source_matches';
    END IF;
  END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;
--> statement-breakpoint
CREATE TRIGGER transfers_provenance_fill BEFORE INSERT ON transfers
  FOR EACH ROW EXECUTE FUNCTION transfers_provenance_fill();
--> statement-breakpoint
CREATE OR REPLACE FUNCTION transfers_provenance_immutable() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'a transfer''s provenance is written once (transfer %)', OLD.id
    USING ERRCODE = '23514', CONSTRAINT = 'transfers_provenance_immutable';
END $$ LANGUAGE plpgsql;
--> statement-breakpoint
-- Only the provenance is frozen, and only when a value actually changes: ordinary state updates pay
-- nothing for this.
CREATE TRIGGER transfers_provenance_immutable
  BEFORE UPDATE OF origin, source_transaction_id, requested_by_admin_id, desk_reason, desk_reason_ar,
                   request_ref
  ON transfers FOR EACH ROW
  WHEN (OLD.origin IS DISTINCT FROM NEW.origin
     OR OLD.source_transaction_id IS DISTINCT FROM NEW.source_transaction_id
     OR OLD.requested_by_admin_id IS DISTINCT FROM NEW.requested_by_admin_id
     OR OLD.desk_reason IS DISTINCT FROM NEW.desk_reason
     OR OLD.desk_reason_ar IS DISTINCT FROM NEW.desk_reason_ar
     OR OLD.request_ref IS DISTINCT FROM NEW.request_ref)
  EXECUTE FUNCTION transfers_provenance_immutable();
--> statement-breakpoint
RESET lock_timeout;
