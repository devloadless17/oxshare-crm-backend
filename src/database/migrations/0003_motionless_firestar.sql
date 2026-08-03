CREATE TYPE "public"."transaction_direction" AS ENUM('deposit', 'withdrawal');--> statement-breakpoint
CREATE TYPE "public"."transaction_state" AS ENUM('pending', 'approved', 'success', 'failure', 'rejected');--> statement-breakpoint
CREATE TABLE "transactions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"wallet_id" uuid NOT NULL,
	"direction" "transaction_direction" NOT NULL,
	"amount" numeric(28, 8) NOT NULL,
	"currency" "currency" NOT NULL,
	"state" "transaction_state" DEFAULT 'pending' NOT NULL,
	"provider" varchar(50) NOT NULL,
	"provider_ref" varchar(255),
	"destination" varchar(255),
	"rejection_reason" text,
	"reviewed_by" uuid,
	"reviewed_at" timestamp with time zone,
	"settled_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "transactions" ADD CONSTRAINT "transactions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "transactions" ADD CONSTRAINT "transactions_wallet_id_wallets_id_fk" FOREIGN KEY ("wallet_id") REFERENCES "public"."wallets"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "transactions_user_idx" ON "transactions" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "transactions_state_idx" ON "transactions" USING btree ("state");--> statement-breakpoint
CREATE INDEX "transactions_created_at_idx" ON "transactions" USING btree ("created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "transactions_provider_ref_uq" ON "transactions" USING btree ("provider","provider_ref");