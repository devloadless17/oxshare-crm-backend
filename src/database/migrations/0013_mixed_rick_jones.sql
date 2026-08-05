CREATE TABLE "login_attempts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"surface" varchar(16) NOT NULL,
	"identifier" varchar(255) NOT NULL,
	"failures" integer DEFAULT 0 NOT NULL,
	"locked_until" timestamp with time zone,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "admin_invites" ADD COLUMN "token_hash" varchar(64);--> statement-breakpoint
ALTER TABLE "admins" ADD COLUMN "status" "user_status" DEFAULT 'active' NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "login_attempts_surface_identifier_idx" ON "login_attempts" USING btree ("surface","identifier");--> statement-breakpoint
CREATE INDEX "login_attempts_locked_until_idx" ON "login_attempts" USING btree ("locked_until");--> statement-breakpoint
ALTER TABLE "admin_invites" ADD CONSTRAINT "admin_invites_token_hash_unique" UNIQUE("token_hash");