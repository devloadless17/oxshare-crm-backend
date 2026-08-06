ALTER TABLE "admins" ADD COLUMN "password_reset_token_hash" varchar(64);--> statement-breakpoint
ALTER TABLE "admins" ADD COLUMN "password_reset_expiry" timestamp with time zone;