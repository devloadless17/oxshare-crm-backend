-- A partner's earnings get their OWN wallet, and a way back to the main one.
--
-- Hand-written rather than generated, matching 0027 onwards.
--
-- ── What was wrong with one wallet ─────────────────────────────────────────
--
-- `CommissionService.confirmPending` credited the partner's ordinary wallet
-- with `entry_type = 'commission'`. The ledger therefore knew which movements
-- were earnings, but the BALANCE did not: a partner looking at $700 could not
-- tell what part of it they had deposited and what part they had earned, and
-- reconciling their commission against their own records meant subtracting
-- their own deposits by hand.
--
-- Splitting the balance makes that a read. `wallets.kind` names what a wallet
-- is for; commissions land in the `commission` one; `ib_wallet_transfers`
-- records the partner moving money across to the `main` one, where the ordinary
-- withdrawal and trading-account rails already work and are untouched by this.
--
-- ── The default is `main`, and that IS the backfill ────────────────────────
--
-- Every wallet that exists today is a main wallet, so the column default
-- backfills them correctly with no UPDATE and no downtime. It also means any
-- caller that has not been taught about this column keeps writing main wallets
-- — a commission wallet must be asked for, never arrived at by omission.
--
-- Commission wallets are NOT opened here for existing partners. There is
-- nothing to put in one: past commissions are already in the main wallet's
-- balance and moving them would rewrite settled money. `getOrCreateWallet`
-- opens each partner's the first time they are actually paid.
--
-- ── The unique index GAINS a column rather than being replaced ─────────────
--
-- A partner legitimately holds a main USD wallet and a commission USD wallet,
-- which `wallets_user_currency_uq` refuses. Every `ON CONFLICT` that targeted
-- it had to grow the third column in the same change: a conflict target that
-- does not match a unique index is not a compile error, it is a runtime failure
-- on a money path.
DO $$ BEGIN
  CREATE TYPE "public"."wallet_kind" AS ENUM('main', 'commission');
EXCEPTION
  WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
ALTER TABLE "wallets" ADD COLUMN IF NOT EXISTS "kind" "wallet_kind" DEFAULT 'main' NOT NULL;
--> statement-breakpoint
DROP INDEX IF EXISTS "wallets_user_currency_uq";
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "wallets_user_currency_kind_uq" ON "wallets" ("user_id","currency","kind");
--> statement-breakpoint
-- Wallet-to-wallet, entirely inside this database, so there is no `state`
-- column: both legs are ledger posts in one transaction and it commits or it
-- does not exist. `transfers` carries a state machine because it crosses into
-- MT5; this does not, and modelling a pending state it can never occupy would
-- invite a screen to render one.
CREATE TABLE IF NOT EXISTS "ib_wallet_transfers" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "user_id" uuid NOT NULL,
  "from_wallet_id" uuid NOT NULL,
  "to_wallet_id" uuid NOT NULL,
  "amount" numeric(28, 8) NOT NULL,
  "currency" varchar(10) NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "ib_wallet_transfers_amount_positive" CHECK ("amount" > 0),
  CONSTRAINT "ib_wallet_transfers_distinct_wallets" CHECK ("from_wallet_id" <> "to_wallet_id")
);
--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "ib_wallet_transfers" ADD CONSTRAINT "ib_wallet_transfers_user_id_users_id_fk"
    FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;
EXCEPTION
  WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "ib_wallet_transfers" ADD CONSTRAINT "ib_wallet_transfers_from_wallet_id_wallets_id_fk"
    FOREIGN KEY ("from_wallet_id") REFERENCES "public"."wallets"("id") ON DELETE restrict ON UPDATE no action;
EXCEPTION
  WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "ib_wallet_transfers" ADD CONSTRAINT "ib_wallet_transfers_to_wallet_id_wallets_id_fk"
    FOREIGN KEY ("to_wallet_id") REFERENCES "public"."wallets"("id") ON DELETE restrict ON UPDATE no action;
EXCEPTION
  WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "ib_wallet_transfers" ADD CONSTRAINT "ib_wallet_transfers_currency_currencies_code_fk"
    FOREIGN KEY ("currency") REFERENCES "public"."currencies"("code") ON DELETE restrict ON UPDATE no action;
EXCEPTION
  WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "ib_wallet_transfers_user_idx" ON "ib_wallet_transfers" ("user_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "ib_wallet_transfers_created_at_idx" ON "ib_wallet_transfers" ("created_at");
