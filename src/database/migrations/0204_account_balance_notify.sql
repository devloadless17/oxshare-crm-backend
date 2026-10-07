-- 0204 — a trading account's balance changing is ANNOUNCED (7 Oct 2026).
--
-- A client closed a position, went to withdraw, and saw the balance from before
-- the trade. Part of that was the bridge (fixed there: a change feed now finds a
-- closed trade within seconds); the rest was here — nothing told an open screen
-- that the mirror had moved, so it showed the old figure until it happened to
-- refetch.
--
-- A trigger on the TABLE rather than a call in each writer, for the reason 0047
-- gave: the mirror has several writers (the sweep's single and batch ingest,
-- `recordFromOperation`, `TransfersService.settle`, the live path, account
-- creation and assignment), and a writer added later announces itself for
-- free. Delivered at COMMIT, so a rolled-back write is never announced.
--
-- ONLY A REAL CHANGE, ONLY AN OWNED ACCOUNT. The sweep re-writes figures that
-- did not move (a fresher read of the same balance), and an account nobody owns
-- has no screen to tell; both are filtered in the WHEN clause, so neither costs
-- a notification. The payload is tiny — who and which account — and the
-- portal re-reads through its authenticated endpoint, so nothing about the
-- money travels outside a permission-checked read.

CREATE OR REPLACE FUNCTION notify_account_balance_changed() RETURNS trigger AS $$
BEGIN
  PERFORM pg_notify(
    'account_balance',
    json_build_object(
      'userId', NEW.user_id,
      'accountId', NEW.id
    )::text
  );
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint

DROP TRIGGER IF EXISTS trading_accounts_notify_balance ON "trading_accounts";
--> statement-breakpoint

CREATE TRIGGER trading_accounts_notify_balance
  AFTER UPDATE OF balance, credit, user_id ON "trading_accounts"
  FOR EACH ROW
  WHEN (
    NEW.user_id IS NOT NULL
    AND (
      OLD.balance IS DISTINCT FROM NEW.balance
      OR OLD.credit IS DISTINCT FROM NEW.credit
      OR OLD.user_id IS DISTINCT FROM NEW.user_id
    )
  )
  EXECUTE FUNCTION notify_account_balance_changed();
--> statement-breakpoint

DROP TRIGGER IF EXISTS trading_accounts_notify_created ON "trading_accounts";
--> statement-breakpoint

-- A NEW owned account is announced too, so the client's account list shows it
-- the moment it exists rather than on the next refetch.
CREATE TRIGGER trading_accounts_notify_created
  AFTER INSERT ON "trading_accounts"
  FOR EACH ROW
  WHEN (NEW.user_id IS NOT NULL)
  EXECUTE FUNCTION notify_account_balance_changed();
