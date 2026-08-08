-- Trades on a trading account — open, or closed with a realised result.
--
-- Hand-written rather than generated, matching 0027 onwards: the committed
-- drizzle snapshots stop at 0026, so `drizzle-kit generate` diffs against a
-- stale baseline and prompts to rename a dozen unrelated enums.
--
-- ── ⚠️ THIS TABLE IS CREATED EMPTY AND STAYS EMPTY ──────────────────────────
--
-- Nothing writes to it. There is no MT5 bridge (ARCHITECTURE open decision #1),
-- so no ingestion path exists and no row can appear by any route the application
-- offers today.
--
-- It is created NOW so the shape is agreed and the portal renders against a REAL
-- query returning zero rows, rather than against a hardcoded empty state that
-- would have to be rewritten the day the feed lands.
--
-- That distinction has already cost this codebase twice. A screen showing a
-- fixed "nothing here" is indistinguishable from one whose query genuinely found
-- nothing: the accounts page once told a client holding three live accounts they
-- had none, and the wallet showed $0.00 to somebody holding $700. A real table
-- means "no open positions" is an answer the database gave.
--
-- WHEN THE BRIDGE LANDS it owns the INSERT and the UPDATE, and it owes this
-- table the same idempotency `transactions` has — `positions_account_ticket_uq`
-- below is what makes a redelivered tick or a restarted sync a no-op rather than
-- a duplicated trade.
--
-- ── Why the close columns are nullable ─────────────────────────────────────
--
-- `close_price`, `closed_at` and `profit` are NULL while a position is open,
-- because they do not exist yet. Defaulting them to zero would make an open
-- trade look like a closed one that broke even — the most expensive possible
-- misreading on a trading screen.
--
-- `profit` is the REALISED result, written only at close. Unrealised P/L is
-- deliberately absent: it changes on every tick and belongs to whatever streams
-- prices, never to a stored row somebody may read an hour later and believe.

CREATE TYPE "public"."position_side" AS ENUM('buy', 'sell');
--> statement-breakpoint
CREATE TYPE "public"."position_status" AS ENUM('open', 'closed');
--> statement-breakpoint

CREATE TABLE "positions" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  -- `user_id` is denormalised alongside `trading_account_id` on purpose: every
  -- read is "this client's positions", and routing that through a join on the
  -- hot path buys nothing. The account reference keeps the row attributable to
  -- the specific login it was traded on.
  "user_id" uuid NOT NULL,
  "trading_account_id" uuid NOT NULL,
  -- A STRING, like `trading_accounts.login`: leading zeros are significant to
  -- the bridge and a numeric type would eat them.
  "ticket" varchar(50) NOT NULL,
  "symbol" varchar(40) NOT NULL,
  "side" "position_side" NOT NULL,
  -- Lots. NUMERIC, not a float — 0.01 is a valid size, and binary floating point
  -- is wrong here for exactly the reason it is wrong for money.
  "volume" numeric(18, 4) NOT NULL,
  -- Prices carry more decimals than money: JPY pairs quote to 3 places, most
  -- others to 5. 28,10 leaves room without forcing a rounding decision the
  -- bridge has not made yet.
  "open_price" numeric(28, 10) NOT NULL,
  "close_price" numeric(28, 10),
  "stop_loss" numeric(28, 10),
  "take_profit" numeric(28, 10),
  -- §6.1 scale: this settles against the account balance and must round-trip
  -- identically to every other monetary value. Signed — a loss is negative.
  "profit" numeric(28, 8),
  "swap" numeric(28, 8),
  "commission" numeric(28, 8),
  "currency" varchar(10) NOT NULL,
  "status" "position_status" DEFAULT 'open' NOT NULL,
  "opened_at" timestamp with time zone NOT NULL,
  "closed_at" timestamp with time zone,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  -- A closed position has BOTH a close price and a close time, or it is not
  -- closed. The two are written by the same event, and a row carrying one
  -- without the other is a trade nobody can reconcile.
  CONSTRAINT "positions_closed_has_close_data" CHECK (
    ("status" = 'open' AND "closed_at" IS NULL)
    OR ("status" = 'closed' AND "closed_at" IS NOT NULL AND "close_price" IS NOT NULL)
  ),
  CONSTRAINT "positions_volume_positive" CHECK ("volume" > 0)
);
--> statement-breakpoint

-- RESTRICT on both, matching every other FK that references a client with
-- financial history: a person is never deleted out from under the rows that
-- explain their account.
ALTER TABLE "positions" ADD CONSTRAINT "positions_user_id_users_id_fk"
  FOREIGN KEY ("user_id") REFERENCES "public"."users"("id")
  ON DELETE restrict ON UPDATE no action;
--> statement-breakpoint

ALTER TABLE "positions" ADD CONSTRAINT "positions_trading_account_id_trading_accounts_id_fk"
  FOREIGN KEY ("trading_account_id") REFERENCES "public"."trading_accounts"("id")
  ON DELETE restrict ON UPDATE no action;
--> statement-breakpoint

ALTER TABLE "positions" ADD CONSTRAINT "positions_currency_currencies_code_fk"
  FOREIGN KEY ("currency") REFERENCES "public"."currencies"("code")
  ON DELETE restrict ON UPDATE no action;
--> statement-breakpoint

-- ⚠️ The idempotency guarantee this table needs on its first day.
--
-- A sync that redelivers a trade, or a bridge restarted mid-batch, must UPDATE
-- the existing row rather than insert a second copy. Scoped to the ACCOUNT
-- rather than global, because a ticket number is only unique within the server
-- that issued it.
CREATE UNIQUE INDEX "positions_account_ticket_uq"
  ON "positions" USING btree ("trading_account_id", "ticket");
--> statement-breakpoint

-- "This client's open positions" — the dashboard's own query. PARTIAL, because
-- the open set is small and hot while the closed history grows without bound.
CREATE INDEX "positions_user_open_idx"
  ON "positions" USING btree ("user_id", "opened_at") WHERE "status" = 'open';
--> statement-breakpoint

CREATE INDEX "positions_user_closed_idx"
  ON "positions" USING btree ("user_id", "closed_at");
--> statement-breakpoint

CREATE INDEX "positions_account_idx"
  ON "positions" USING btree ("trading_account_id");
