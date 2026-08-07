-- The money surface, rebuilt.
--
-- Migration 0028 dropped wallets, ledger_entries, transactions, transfers and
-- trading_accounts, and said in as many words what left with them:
--
--   "`ledger_entries` held the unique constraint that `WalletService.post()`
--    used with ON CONFLICT to make a replayed deposit a no-op. Nothing replaces
--    it yet, and the rebuild must, before any payment provider is connected."
--
-- This is that rebuild. `ledger_entries_wallet_reference_uq` is back, and so is
-- the §6.4 rule that was previously only a comment.
--
-- The commission tables (deals, ib_programs, ib_profiles, commission_accruals)
-- are NOT restored — the engine never processed a real deal and returns with
-- the MT5 bridge. referral_attributions is not coming back at all: it became
-- users.referred_by_ib_user_id in 0032.
--
-- ── Order ───────────────────────────────────────────────────────────────────
--
-- payment_methods → trading_accounts → (wallets already exists, altered) →
-- ledger_entries → transactions → transfers. Every FK points backwards.

CREATE TYPE "public"."ledger_entry_type" AS ENUM('deposit', 'withdrawal', 'commission', 'rebate', 'payout', 'adjustment', 'transfer');--> statement-breakpoint
CREATE TYPE "public"."transaction_direction" AS ENUM('deposit', 'withdrawal');--> statement-breakpoint
CREATE TYPE "public"."transaction_state" AS ENUM('pending', 'approved', 'success', 'failure', 'rejected');--> statement-breakpoint
CREATE TYPE "public"."transfer_direction" AS ENUM('wallet_to_account', 'account_to_wallet');--> statement-breakpoint
CREATE TYPE "public"."transfer_state" AS ENUM('pending', 'settled', 'failed');--> statement-breakpoint
CREATE TYPE "public"."trading_environment" AS ENUM('live', 'demo');--> statement-breakpoint
CREATE TYPE "public"."trading_account_status" AS ENUM('active', 'suspended', 'closed');--> statement-breakpoint
CREATE TYPE "public"."payment_method_kind" AS ENUM('manual', 'gateway', 'crypto');--> statement-breakpoint

-- ── payment_methods ─────────────────────────────────────────────────────────
--
-- Rows rather than a hardcoded list. The deleted deposit page carried a
-- two-element METHODS array inside the component, so adding a payment option
-- was a deploy and an operator could not disable one when a provider went down.
--
-- `kind` decides the flow, not the key. A screen branching on `key = 'whish'`
-- has to be edited every time a method is added, which is what making these
-- rows data was meant to avoid.
CREATE TABLE "payment_methods" (
	"key" varchar(40) PRIMARY KEY NOT NULL,
	"name" varchar(80) NOT NULL,
	"kind" "payment_method_kind" NOT NULL,
	"currency" varchar(10) NOT NULL,
	"logo_url" varchar(2048),
	-- What the client must do, in the operator's words, shown verbatim.
	"instructions" text,
	-- The Whish number, IBAN or wallet address the client sends to.
	"pay_to" varchar(255),
	-- NULL means "no bound beyond the platform's own", not zero. A NOT NULL
	-- DEFAULT '0' would have given every row a method that accepts nothing.
	"min_amount" numeric(28, 8),
	"max_amount" numeric(28, 8),
	"enabled" boolean DEFAULT true NOT NULL,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"updated_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint

-- ── trading_accounts ────────────────────────────────────────────────────────
--
-- ⚠️ `balance` REVERSES A DELIBERATE DECISION. The deleted table had no balance
-- column and its DTO said why: "Those live in MT5, not in this database … a
-- fabricated figure beside a real MT5 login is the most expensive kind of wrong
-- number on a trading product."
--
-- That was right and it depended on MT5 existing. It does not — there is no
-- bridge service (ARCHITECTURE open decision #1) — so nothing else can hold the
-- number and a transfer would have nowhere to land.
--
-- WHEN THE BRIDGE LANDS this becomes a mirror written only by the sync, or it
-- is dropped and the terminal is the only source. What it must not do is remain
-- a CRM-owned number that MT5 also has an opinion about.
--
-- `login` is nullable and renamed from `mt5_login`: a CRM-side account has no
-- login until there is an MT5 to issue one. Unique WHERE NOT NULL, so two
-- unassigned accounts do not collide.
CREATE TABLE "trading_accounts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"login" varchar(50),
	"mt5_group" varchar(100),
	"environment" "trading_environment" DEFAULT 'live' NOT NULL,
	"currency" varchar(10) NOT NULL,
	"balance" numeric(28, 8) DEFAULT '0' NOT NULL,
	"tier" varchar(50),
	"leverage" integer,
	"status" "trading_account_status" DEFAULT 'active' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "trading_accounts_balance_non_negative" CHECK ("trading_accounts"."balance" >= 0)
);
--> statement-breakpoint

-- ── wallets — ALTER, not CREATE ─────────────────────────────────────────────
--
-- The table came back in 0030 as a balance holder with no ledger behind it.
-- This adds the hold column and the constraint the deleted service enforced in
-- application code.
-- `updated_at` is NOT added here: 0030 already created it with the table.
ALTER TABLE "wallets" ADD COLUMN "on_hold" numeric(28, 8) DEFAULT '0' NOT NULL;--> statement-breakpoint
ALTER TABLE "wallets" ADD CONSTRAINT "wallets_on_hold_non_negative" CHECK ("wallets"."on_hold" >= 0);--> statement-breakpoint

-- A hold may not exceed the balance it is held against.
--
-- The deleted `releaseWithin` clamped on_hold at zero in application code with
-- a comment saying never let it go negative. This says the same to the database
-- and adds the other half: `available = balance - on_hold` is the number every
-- money decision reads, and a hold larger than the balance makes it negative —
-- a state from which every later calculation is wrong in a way no single query
-- looks wrong.
ALTER TABLE "wallets" ADD CONSTRAINT "wallets_hold_within_balance" CHECK ("wallets"."on_hold" <= "wallets"."balance");--> statement-breakpoint

-- ── ledger_entries ──────────────────────────────────────────────────────────
CREATE TABLE "ledger_entries" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"wallet_id" uuid NOT NULL,
	-- Signed: credits positive, debits negative. Sum per wallet == balance.
	"amount" numeric(28, 8) NOT NULL,
	-- The running balance AFTER this entry (FSD requirement, §6.2). This is why
	-- the wallet row is locked FOR UPDATE before every write: two concurrent
	-- credits without it both read the same prior balance and one is lost.
	"balance_after" numeric(28, 8) NOT NULL,
	"entry_type" "ledger_entry_type" NOT NULL,
	-- What caused this row. Every movement traces back to its cause.
	"reference_type" varchar(50) NOT NULL,
	"reference_id" varchar(255) NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint

-- ── transactions ────────────────────────────────────────────────────────────
CREATE TABLE "transactions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"wallet_id" uuid NOT NULL,
	"direction" "transaction_direction" NOT NULL,
	"amount" numeric(28, 8) NOT NULL,
	"currency" varchar(10) NOT NULL,
	"state" "transaction_state" DEFAULT 'pending' NOT NULL,
	"method_key" varchar(40),
	"provider" varchar(50) NOT NULL,
	"provider_ref" varchar(255),
	"destination" varchar(255),
	"destination_trading_account_id" uuid,
	"rejection_reason" text,
	"reviewed_by" uuid,
	"reviewed_at" timestamp with time zone,
	"settled_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint

-- ── transfers ───────────────────────────────────────────────────────────────
CREATE TABLE "transfers" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"wallet_id" uuid NOT NULL,
	"trading_account_id" uuid NOT NULL,
	"direction" "transfer_direction" NOT NULL,
	"amount" numeric(28, 8) NOT NULL,
	"currency" varchar(10) NOT NULL,
	"state" "transfer_state" DEFAULT 'pending' NOT NULL,
	"failure_reason" text,
	"settled_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint

-- ── Foreign keys ────────────────────────────────────────────────────────────
--
-- RESTRICT throughout: a DELETE that would take a balance or a movement with it
-- should fail loudly rather than succeed quietly.

ALTER TABLE "payment_methods" ADD CONSTRAINT "payment_methods_currency_currencies_code_fk"
	FOREIGN KEY ("currency") REFERENCES "public"."currencies"("code") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint

ALTER TABLE "trading_accounts" ADD CONSTRAINT "trading_accounts_user_id_users_id_fk"
	FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "trading_accounts" ADD CONSTRAINT "trading_accounts_currency_currencies_code_fk"
	FOREIGN KEY ("currency") REFERENCES "public"."currencies"("code") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint

ALTER TABLE "ledger_entries" ADD CONSTRAINT "ledger_entries_wallet_id_wallets_id_fk"
	FOREIGN KEY ("wallet_id") REFERENCES "public"."wallets"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint

ALTER TABLE "transactions" ADD CONSTRAINT "transactions_user_id_users_id_fk"
	FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "transactions" ADD CONSTRAINT "transactions_wallet_id_wallets_id_fk"
	FOREIGN KEY ("wallet_id") REFERENCES "public"."wallets"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "transactions" ADD CONSTRAINT "transactions_currency_currencies_code_fk"
	FOREIGN KEY ("currency") REFERENCES "public"."currencies"("code") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "transactions" ADD CONSTRAINT "transactions_method_key_payment_methods_key_fk"
	FOREIGN KEY ("method_key") REFERENCES "public"."payment_methods"("key") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
-- A REAL constraint this time; the deleted column was a bare uuid, so a deposit
-- could name a trading account that had never existed.
ALTER TABLE "transactions" ADD CONSTRAINT "transactions_destination_trading_account_id_fk"
	FOREIGN KEY ("destination_trading_account_id") REFERENCES "public"."trading_accounts"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint

ALTER TABLE "transfers" ADD CONSTRAINT "transfers_user_id_users_id_fk"
	FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "transfers" ADD CONSTRAINT "transfers_wallet_id_wallets_id_fk"
	FOREIGN KEY ("wallet_id") REFERENCES "public"."wallets"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "transfers" ADD CONSTRAINT "transfers_trading_account_id_fk"
	FOREIGN KEY ("trading_account_id") REFERENCES "public"."trading_accounts"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "transfers" ADD CONSTRAINT "transfers_currency_currencies_code_fk"
	FOREIGN KEY ("currency") REFERENCES "public"."currencies"("code") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint

-- ── Indexes ─────────────────────────────────────────────────────────────────

CREATE INDEX "payment_methods_enabled_sort_idx" ON "payment_methods" ("enabled","sort_order");--> statement-breakpoint

CREATE INDEX "trading_accounts_user_idx" ON "trading_accounts" ("user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "trading_accounts_login_uq" ON "trading_accounts" ("login") WHERE "trading_accounts"."login" IS NOT NULL;--> statement-breakpoint

CREATE INDEX "ledger_entries_wallet_idx" ON "ledger_entries" ("wallet_id");--> statement-breakpoint
CREATE INDEX "ledger_entries_created_at_idx" ON "ledger_entries" ("created_at");--> statement-breakpoint

-- ⚠️ THE IDEMPOTENCY GUARANTEE, restored.
--
-- This is the constraint 0028 removed and promised back. WalletService.post()
-- inserts with ON CONFLICT on these three columns and returns the ORIGINAL
-- entry when it fires, leaving the balance untouched — so a replayed deposit or
-- a retried provider webhook is a no-op instead of a second credit.
--
-- A service-level "have I seen this reference?" is not a substitute. That is a
-- check-then-insert, and every check-then-insert loses under concurrency (§6.3).
CREATE UNIQUE INDEX "ledger_entries_wallet_reference_uq" ON "ledger_entries" ("wallet_id","reference_type","reference_id");--> statement-breakpoint

CREATE INDEX "transactions_user_idx" ON "transactions" ("user_id");--> statement-breakpoint
CREATE INDEX "transactions_state_idx" ON "transactions" ("state");--> statement-breakpoint
CREATE INDEX "transactions_created_at_idx" ON "transactions" ("created_at");--> statement-breakpoint
-- §6.3: the idempotency guarantee for replayed payment callbacks.
CREATE UNIQUE INDEX "transactions_provider_ref_uq" ON "transactions" ("provider","provider_ref");--> statement-breakpoint

CREATE INDEX "transfers_user_idx" ON "transfers" ("user_id");--> statement-breakpoint
CREATE INDEX "transfers_state_idx" ON "transfers" ("state");--> statement-breakpoint
CREATE INDEX "transfers_created_at_idx" ON "transfers" ("created_at");--> statement-breakpoint
CREATE INDEX "transfers_trading_account_idx" ON "transfers" ("trading_account_id");--> statement-breakpoint

-- ── §6.4 — corrections are compensating entries ─────────────────────────────
--
-- "No UPDATE, no DELETE on ledger_entries. Enforce it — revoke those grants
--  from the application database role. If a balance is wrong, write a new
--  offsetting row."
--
-- That rule has lived as a comment since the ledger was first written. This is
-- the enforcement ARCHITECTURE actually asks for: with the grants gone, code
-- that tries to rewrite history fails at the database rather than succeeding
-- and leaving a ledger whose sum no longer explains its own balance.
--
-- ⚠️ A SPEED BUMP, NOT A WALL, and worth being honest about. `app` OWNS these
-- tables in every environment this runs in, and an owner can grant itself back
-- what it revoked. So this stops ordinary code — an accidental
-- `UPDATE ledger_entries SET …`, a well-meant "fix the balance" script — and
-- stops nothing determined to bypass it.
--
-- Making it a real wall means the API connecting as a role that does not own
-- the schema, with migrations run as a separate owner. That is a deployment
-- change, not a migration, and it is not made here.
--
-- Wrapped in a DO block because the role name is deployment-specific and a
-- fresh clone may not have it. A missing role must not fail the migration —
-- the check is a hardening step, not a schema requirement.
DO $$
BEGIN
	IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app') THEN
		REVOKE UPDATE, DELETE ON TABLE "ledger_entries" FROM "app";
	END IF;
END
$$;--> statement-breakpoint

-- ── Whish Money ─────────────────────────────────────────────────────────────
--
-- Lebanon's mobile wallet, and the payment method the client asked for by name.
--
-- Seeded as `manual`, NOT `gateway`. Whish does have a collect API — sandbox at
-- lb.sandbox.whish.money/itel-service/api/, authenticated with channel/secret/
-- websiteurl headers — but its credentials are ARCHITECTURE open decision #5
-- ("Whish + USDT sandbox credentials — Client — Blocks: Money layer") and
-- nobody has them. A gateway method wired to credentials that do not exist is a
-- deposit button that fails for every client.
--
-- So: the client is shown the operator's Whish number and instructions, sends
-- the money in the Whish app, and submits the reference. An admin confirms it
-- on the transactions screen. When credentials arrive, a WhishProvider
-- implements the same interface, this row's `kind` becomes 'gateway', and the
-- deposit screen does not change.
--
-- `instructions` and `pay_to` are deliberately NULL. The deleted deposit page
-- recorded why: "Inventing an IBAN is the same failure as the fake $0.00
-- balances, with a worse outcome: the money leaves and does not arrive." The
-- method is not offered to clients until an operator fills them in.
INSERT INTO "payment_methods" ("key", "name", "kind", "currency", "logo_url", "enabled", "sort_order")
VALUES (
	'whish',
	'Whish Money',
	'manual',
	'USD',
	'https://cdn.prod.website-files.com/6762f4acf0dd8a6b998dfa16/676d32a11708f11b333c681b_Whish%20Logo.svg',
	false,
	1
)
ON CONFLICT ("key") DO NOTHING;
