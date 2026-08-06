CREATE TABLE "general_settings" (
	"id" boolean PRIMARY KEY NOT NULL,
	"brand_name" varchar(120) DEFAULT 'OxShare' NOT NULL,
	"support_email" varchar(320),
	"support_url" varchar(2048),
	"maintenance_notice" text,
	"updated_by" uuid,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "general_settings_singleton" CHECK ("general_settings"."id")
);
--> statement-breakpoint
CREATE TABLE "smtp_settings" (
	"id" boolean PRIMARY KEY NOT NULL,
	"host" varchar(255) NOT NULL,
	"port" integer DEFAULT 587 NOT NULL,
	"username" varchar(255),
	"password_ciphertext" text,
	"from_address" varchar(320) NOT NULL,
	"secure" boolean DEFAULT false NOT NULL,
	"updated_by" uuid,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "smtp_settings_singleton" CHECK ("smtp_settings"."id")
);
