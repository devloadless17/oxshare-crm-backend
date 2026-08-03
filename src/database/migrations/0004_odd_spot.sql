CREATE TYPE "public"."commission_method" AS ENUM('spread_share', 'per_lot', 'fixed_per_deal');--> statement-breakpoint
CREATE TYPE "public"."commission_mode" AS ENUM('commission', 'rebate', 'hybrid');--> statement-breakpoint
CREATE TABLE "ib_programs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" varchar(120) NOT NULL,
	"description" text,
	"position" integer DEFAULT 1 NOT NULL,
	"mode" "commission_mode" DEFAULT 'commission' NOT NULL,
	"method" "commission_method" DEFAULT 'spread_share' NOT NULL,
	"commission_value" numeric(28, 8) DEFAULT '0' NOT NULL,
	"rebate_value" numeric(28, 8) DEFAULT '0' NOT NULL,
	"l1_share" numeric(5, 2) DEFAULT '0' NOT NULL,
	"l2_share" numeric(5, 2) DEFAULT '0' NOT NULL,
	"settlement_window_hours" integer DEFAULT 24 NOT NULL,
	"rebate_on_close" boolean DEFAULT false NOT NULL,
	"selectable" boolean DEFAULT true NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "ib_programs_name_unique" UNIQUE("name")
);
--> statement-breakpoint
CREATE INDEX "ib_programs_position_idx" ON "ib_programs" USING btree ("position");