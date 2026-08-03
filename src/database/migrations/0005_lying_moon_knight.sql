CREATE TYPE "public"."accrual_status" AS ENUM('accrued', 'confirmed');--> statement-breakpoint
CREATE TYPE "public"."ib_status" AS ENUM('pending', 'approved', 'rejected', 'suspended');--> statement-breakpoint
CREATE TYPE "public"."trading_environment" AS ENUM('live', 'demo');--> statement-breakpoint
CREATE TABLE "commission_accruals" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"deal_id" uuid NOT NULL,
	"ib_user_id" uuid NOT NULL,
	"level" integer NOT NULL,
	"program_id" uuid,
	"amount" numeric(28, 8) NOT NULL,
	"currency" "currency" DEFAULT 'USD' NOT NULL,
	"status" "accrual_status" DEFAULT 'accrued' NOT NULL,
	"available_at" timestamp with time zone NOT NULL,
	"confirmed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "deals" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"mt5_ticket" varchar(50) NOT NULL,
	"trading_account_id" uuid NOT NULL,
	"symbol" varchar(30) NOT NULL,
	"volume" numeric(28, 8) NOT NULL,
	"spread" numeric(28, 8) NOT NULL,
	"profit" numeric(28, 8) DEFAULT '0' NOT NULL,
	"opened_at" timestamp with time zone,
	"closed_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "deals_mt5_ticket_unique" UNIQUE("mt5_ticket")
);
--> statement-breakpoint
CREATE TABLE "ib_profiles" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"parent_ib_id" uuid,
	"program_id" uuid,
	"status" "ib_status" DEFAULT 'pending' NOT NULL,
	"referral_code" varchar(50),
	"approved_by" uuid,
	"approved_at" timestamp with time zone,
	"rejection_reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "ib_profiles_user_id_unique" UNIQUE("user_id"),
	CONSTRAINT "ib_profiles_referral_code_unique" UNIQUE("referral_code")
);
--> statement-breakpoint
CREATE TABLE "referral_attributions" (
	"client_user_id" uuid PRIMARY KEY NOT NULL,
	"ib_user_id" uuid NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "trading_accounts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"mt5_login" varchar(50) NOT NULL,
	"mt5_group" varchar(100),
	"environment" "trading_environment" DEFAULT 'live' NOT NULL,
	"tier" varchar(50),
	"leverage" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "trading_accounts_mt5_login_unique" UNIQUE("mt5_login")
);
--> statement-breakpoint
ALTER TABLE "commission_accruals" ADD CONSTRAINT "commission_accruals_deal_id_deals_id_fk" FOREIGN KEY ("deal_id") REFERENCES "public"."deals"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "commission_accruals" ADD CONSTRAINT "commission_accruals_ib_user_id_users_id_fk" FOREIGN KEY ("ib_user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "commission_accruals" ADD CONSTRAINT "commission_accruals_program_id_ib_programs_id_fk" FOREIGN KEY ("program_id") REFERENCES "public"."ib_programs"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "deals" ADD CONSTRAINT "deals_trading_account_id_trading_accounts_id_fk" FOREIGN KEY ("trading_account_id") REFERENCES "public"."trading_accounts"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ib_profiles" ADD CONSTRAINT "ib_profiles_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ib_profiles" ADD CONSTRAINT "ib_profiles_program_id_ib_programs_id_fk" FOREIGN KEY ("program_id") REFERENCES "public"."ib_programs"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "referral_attributions" ADD CONSTRAINT "referral_attributions_client_user_id_users_id_fk" FOREIGN KEY ("client_user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "referral_attributions" ADD CONSTRAINT "referral_attributions_ib_user_id_users_id_fk" FOREIGN KEY ("ib_user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "trading_accounts" ADD CONSTRAINT "trading_accounts_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "commission_accruals_deal_ib_level_uq" ON "commission_accruals" USING btree ("deal_id","ib_user_id","level");--> statement-breakpoint
CREATE INDEX "commission_accruals_status_available_idx" ON "commission_accruals" USING btree ("status","available_at");--> statement-breakpoint
CREATE INDEX "deals_closed_at_idx" ON "deals" USING btree ("closed_at");--> statement-breakpoint
CREATE INDEX "ib_profiles_parent_idx" ON "ib_profiles" USING btree ("parent_ib_id");--> statement-breakpoint
CREATE INDEX "ib_profiles_status_idx" ON "ib_profiles" USING btree ("status");--> statement-breakpoint
CREATE INDEX "trading_accounts_user_idx" ON "trading_accounts" USING btree ("user_id");