-- Currencies become operator data, and wallet <-> trading-account transfers exist.
--
-- HAND-WRITTEN rather than generated, because drizzle-kit's diff for
-- "pgEnum column becomes a FK to a new table" is a drop-and-recreate of the
-- column. On `wallets.currency` that is not a schema change, it is data loss:
-- every balance in the system is keyed by it. The conversion below is in place
-- and preserves every row.
--
-- The order matters and is not rearrangeable:
--   1. create `currencies` and populate it from the enum's own labels, so the
--      foreign keys added in (3) are satisfiable the moment they exist;
--   2. convert the columns from the enum type to varchar — `USING x::text`
--      keeps the stored label verbatim, so 'USD' stays 'USD';
--   3. add the foreign keys, which now validate against real rows;
--   4. drop the enum type, which is only droppable once nothing references it.

CREATE TABLE "currencies" (
	"code" varchar(10) PRIMARY KEY NOT NULL,
	"name" varchar(80) NOT NULL,
	"symbol" varchar(8) NOT NULL,
	"decimals" integer DEFAULT 2 NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"is_default" boolean DEFAULT false NOT NULL,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint

-- The two the enum already allowed, so no existing row is orphaned by step (3).
-- USD is the default because it is what `commission_accruals.currency` already
-- defaults to — picking anything else here would silently change the currency
-- of every future accrual.
INSERT INTO "currencies" ("code", "name", "symbol", "decimals", "enabled", "is_default", "sort_order") VALUES
	('USD', 'US Dollar', '$', 2, true, true, 1),
	('USDT', 'Tether', 'USDT', 2, true, false, 2);
--> statement-breakpoint

CREATE INDEX "currencies_enabled_sort_idx" ON "currencies" USING btree ("enabled","sort_order");--> statement-breakpoint
-- "At most one default", expressed as a partial unique index over a constant.
-- A CHECK cannot see other rows and a trigger would be a second place to look;
-- this makes a second default a constraint violation at write time.
CREATE UNIQUE INDEX "currencies_one_default_uq" ON "currencies" USING btree ((1)) WHERE "currencies"."is_default";--> statement-breakpoint

-- The default has to go before the type change and come back after: Postgres
-- will not cast an existing DEFAULT across a type change.
ALTER TABLE "commission_accruals" ALTER COLUMN "currency" DROP DEFAULT;--> statement-breakpoint
ALTER TABLE "wallets" ALTER COLUMN "currency" SET DATA TYPE varchar(10) USING "currency"::text;--> statement-breakpoint
ALTER TABLE "transactions" ALTER COLUMN "currency" SET DATA TYPE varchar(10) USING "currency"::text;--> statement-breakpoint
ALTER TABLE "commission_accruals" ALTER COLUMN "currency" SET DATA TYPE varchar(10) USING "currency"::text;--> statement-breakpoint
ALTER TABLE "commission_accruals" ALTER COLUMN "currency" SET DEFAULT 'USD';--> statement-breakpoint

-- RESTRICT everywhere: a currency holding balances must not be deletable. The
-- operator disables it instead, which stops new wallets while leaving the
-- existing money readable. See the `currencies` comment in schema.ts.
ALTER TABLE "wallets" ADD CONSTRAINT "wallets_currency_currencies_code_fk" FOREIGN KEY ("currency") REFERENCES "public"."currencies"("code") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "transactions" ADD CONSTRAINT "transactions_currency_currencies_code_fk" FOREIGN KEY ("currency") REFERENCES "public"."currencies"("code") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "commission_accruals" ADD CONSTRAINT "commission_accruals_currency_currencies_code_fk" FOREIGN KEY ("currency") REFERENCES "public"."currencies"("code") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint

DROP TYPE "public"."currency";--> statement-breakpoint

-- An internal move is neither a deposit nor a withdrawal. Counting it as either
-- would overstate both totals in every report that sums the ledger by type.
--
-- `ADD VALUE` is legal inside a transaction on PG12+ (this schema already needs
-- PG13 for `gen_random_uuid()` without pgcrypto), with one rule: the new label
-- cannot be USED until the transaction commits. Nothing below writes a ledger
-- row, so that rule holds here — but it is the reason a future migration must
-- not add an enum value and insert rows using it in the same file.
ALTER TYPE "public"."ledger_entry_type" ADD VALUE 'transfer';--> statement-breakpoint

-- What the client asked to FUND. The money still lands in the wallet — that is
-- the CRM's ledger — and settlement chains a transfer to move it on.
ALTER TABLE "transactions" ADD COLUMN "destination_trading_account_id" uuid;--> statement-breakpoint

CREATE TYPE "public"."transfer_direction" AS ENUM('wallet_to_account', 'account_to_wallet');--> statement-breakpoint
CREATE TYPE "public"."transfer_state" AS ENUM('pending', 'settled', 'failed');--> statement-breakpoint

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

ALTER TABLE "transfers" ADD CONSTRAINT "transfers_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "transfers" ADD CONSTRAINT "transfers_wallet_id_wallets_id_fk" FOREIGN KEY ("wallet_id") REFERENCES "public"."wallets"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "transfers" ADD CONSTRAINT "transfers_trading_account_id_trading_accounts_id_fk" FOREIGN KEY ("trading_account_id") REFERENCES "public"."trading_accounts"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "transfers" ADD CONSTRAINT "transfers_currency_currencies_code_fk" FOREIGN KEY ("currency") REFERENCES "public"."currencies"("code") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint

CREATE INDEX "transfers_user_idx" ON "transfers" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "transfers_state_idx" ON "transfers" USING btree ("state");--> statement-breakpoint
CREATE INDEX "transfers_created_at_idx" ON "transfers" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "transfers_trading_account_idx" ON "transfers" USING btree ("trading_account_id");
