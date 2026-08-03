CREATE TYPE "public"."currency" AS ENUM('USD', 'USDT');--> statement-breakpoint
CREATE TYPE "public"."ledger_entry_type" AS ENUM('deposit', 'withdrawal', 'commission', 'rebate', 'payout', 'adjustment');--> statement-breakpoint
CREATE TABLE "ledger_entries" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"wallet_id" uuid NOT NULL,
	"amount" numeric(28, 8) NOT NULL,
	"balance_after" numeric(28, 8) NOT NULL,
	"entry_type" "ledger_entry_type" NOT NULL,
	"reference_type" varchar(50) NOT NULL,
	"reference_id" varchar(255) NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "wallets" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"currency" "currency" NOT NULL,
	"balance" numeric(28, 8) DEFAULT '0' NOT NULL,
	"on_hold" numeric(28, 8) DEFAULT '0' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "ledger_entries" ADD CONSTRAINT "ledger_entries_wallet_id_wallets_id_fk" FOREIGN KEY ("wallet_id") REFERENCES "public"."wallets"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wallets" ADD CONSTRAINT "wallets_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "ledger_entries_wallet_idx" ON "ledger_entries" USING btree ("wallet_id");--> statement-breakpoint
CREATE INDEX "ledger_entries_created_at_idx" ON "ledger_entries" USING btree ("created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "ledger_entries_wallet_reference_uq" ON "ledger_entries" USING btree ("wallet_id","reference_type","reference_id");--> statement-breakpoint
CREATE UNIQUE INDEX "wallets_user_currency_uq" ON "wallets" USING btree ("user_id","currency");--> statement-breakpoint
-- ARCHITECTURE §6.4: "No UPDATE, no DELETE on ledger_entries. Ever."
-- The spec says revoke the grants from the application role; a trigger is
-- strictly stronger — it holds even for a superuser connection, which is what
-- local dev and migrations run as. Corrections are compensating rows.
CREATE OR REPLACE FUNCTION ledger_entries_append_only() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'ledger_entries is append-only (ARCHITECTURE §6.4): % is forbidden. Write a compensating entry instead.', TG_OP;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint
CREATE TRIGGER ledger_entries_no_update
  BEFORE UPDATE ON ledger_entries
  FOR EACH ROW EXECUTE FUNCTION ledger_entries_append_only();
--> statement-breakpoint
CREATE TRIGGER ledger_entries_no_delete
  BEFORE DELETE ON ledger_entries
  FOR EACH ROW EXECUTE FUNCTION ledger_entries_append_only();
